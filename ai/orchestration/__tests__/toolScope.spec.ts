import { describe, it, expect } from "@jest/globals";
import {
  getToolScope,
  isClientScoped,
  isServerScoped,
  toolNameOf,
  isHeadlessConversation,
  isHeadlessTurn,
  partitionByScope,
  serverOnly,
  inheritToolScopes,
  resolveToolApprovalMode,
} from "../toolScope";
import { ToolApprovalMode } from "../../openai/types/chat";

/**
 * The server/client distinction is what decides whether a tool call can run in-process or
 * must be forwarded to a browser. Getting it wrong is not cosmetic: a client tool handed to
 * a headless delegated agent pauses the turn forever (no browser ever answers). These are
 * pure functions precisely so that policy can be pinned down here.
 */
describe("toolScope", () => {
  describe("getToolScope / isClientScoped / isServerScoped", () => {
    it("treats an absent runat as server (the codebase-wide default)", () => {
      expect(getToolScope({})).toBe("server");
      expect(getToolScope({ name: "shell" })).toBe("server");
      expect(getToolScope(undefined)).toBe("server");
      expect(isServerScoped({ name: "shell" })).toBe(true);
      expect(isClientScoped({ name: "shell" })).toBe(false);
    });

    it("honours an explicit client scope", () => {
      expect(getToolScope({ runat: "client" })).toBe("client");
      expect(isClientScoped({ runat: "client" })).toBe(true);
      expect(isServerScoped({ runat: "client" })).toBe(false);
    });

    it("treats anything that is not 'client' as server", () => {
      // Defensive: a typo or an unknown value must fail closed to server, never to client,
      // because forwarding a server tool to a browser hangs the turn.
      expect(getToolScope({ runat: "CLIENT" })).toBe("server");
      expect(getToolScope({ runat: "browser" })).toBe("server");
    });
  });

  describe("toolNameOf", () => {
    it("prefers function.name, then alias, then name", () => {
      expect(toolNameOf({ function: { name: "image" }, alias: "img", name: "ImageMacro" })).toBe("image");
      expect(toolNameOf({ alias: "img", name: "ImageMacro" })).toBe("img");
      expect(toolNameOf({ name: "ImageMacro" })).toBe("ImageMacro");
      expect(toolNameOf({})).toBeUndefined();
      expect(toolNameOf(null)).toBeUndefined();
    });
  });

  describe("isHeadlessConversation", () => {
    it("is true when a parent session is recorded (delegated sub-agent)", () => {
      expect(isHeadlessConversation({ parentSessionId: "abc" })).toBe(true);
    });

    it("is false for a top-level session", () => {
      expect(isHeadlessConversation({ parentSessionId: null })).toBe(false);
      expect(isHeadlessConversation({})).toBe(false);
      expect(isHeadlessConversation(undefined)).toBe(false);
    });
  });

  describe("isHeadlessTurn", () => {
    it("is always headless for a delegated conversation, whatever the mode", () => {
      expect(isHeadlessTurn({ parentSessionId: "abc" }, "SSE")).toBe(true);
      expect(isHeadlessTurn({ parentSessionId: "abc" }, "NONE")).toBe(true);
    });

    it("treats a non-SSE turn as headless even on a top-level session", () => {
      expect(isHeadlessTurn({ parentSessionId: null }, "NONE")).toBe(true);
      expect(isHeadlessTurn({ parentSessionId: null }, undefined)).toBe(true);
    });

    it("is only interactive for a top-level SSE turn", () => {
      expect(isHeadlessTurn({ parentSessionId: null }, "SSE")).toBe(false);
    });
  });

  describe("resolveToolApprovalMode", () => {
    it("pins a delegated/headless session to AUTO, whatever the parent requested", () => {
      // Only AUTO executes tool calls server-side. PROMPT/PLAN/SAFE_AUTO hand the
      // call to a browser that a delegated session does not have, so the turn ends
      // on the assistant's opening line and the caller is told it completed.
      expect(resolveToolApprovalMode({ parentSessionId: "parent", requested: ToolApprovalMode.PROMPT }))
        .toBe(ToolApprovalMode.AUTO);
      expect(resolveToolApprovalMode({ parentSessionId: "parent", requested: ToolApprovalMode.SAFE_AUTO }))
        .toBe(ToolApprovalMode.AUTO);
      expect(resolveToolApprovalMode({ parentSessionId: "parent", requested: ToolApprovalMode.PLAN }))
        .toBe(ToolApprovalMode.AUTO);
      expect(resolveToolApprovalMode({ parentSessionId: "parent" })).toBe(ToolApprovalMode.AUTO);
    });

    it("keeps the requested mode for an interactive session", () => {
      expect(resolveToolApprovalMode({ parentSessionId: null, requested: ToolApprovalMode.AUTO }))
        .toBe(ToolApprovalMode.AUTO);
      expect(resolveToolApprovalMode({ parentSessionId: null, requested: ToolApprovalMode.SAFE_AUTO }))
        .toBe(ToolApprovalMode.SAFE_AUTO);
    });

    it("falls back to the historical PROMPT default when an interactive session requests nothing", () => {
      expect(resolveToolApprovalMode({ parentSessionId: null })).toBe(ToolApprovalMode.PROMPT);
      expect(resolveToolApprovalMode({})).toBe(ToolApprovalMode.PROMPT);
    });
  });

  describe("partitionByScope / serverOnly", () => {
    const server = { name: "shell", runat: "server" };
    const client = { name: "chart", runat: "client" };
    const implicit = { name: "readFile" };

    it("splits by scope, preserving order", () => {
      const { server: s, client: c } = partitionByScope([server, client, implicit]);
      expect(s.map((d: any) => d.name)).toEqual(["shell", "readFile"]);
      expect(c.map((d: any) => d.name)).toEqual(["chart"]);
    });

    it("serverOnly keeps the server-runnable half", () => {
      expect(serverOnly([server, client, implicit]).map((d: any) => d.name)).toEqual(["shell", "readFile"]);
    });

    it("handles empty/undefined input", () => {
      expect(serverOnly(undefined)).toEqual([]);
      expect(serverOnly(null)).toEqual([]);
      expect(serverOnly([])).toEqual([]);
    });
  });

  describe("inheritToolScopes", () => {
    const clientMacro = {
      name: "ImageMacro",
      alias: "image",
      runat: "client",
      tools: [{ type: "function", function: { name: "image" } }],
    };
    const serverMacro = {
      name: "ShellMacro",
      alias: "shell",
      tools: [{ type: "function", function: { name: "shell" } }],
    };

    it("stamps a client scope onto a tool owned by a client macro", () => {
      const tools = [{ type: "function", function: { name: "image" } }];
      const out = inheritToolScopes([clientMacro], tools);
      expect((out[0] as any).runat).toBe("client");
    });

    it("leaves a tool owned by a server macro untouched (server is the default)", () => {
      const tools = [{ type: "function", function: { name: "shell" } }];
      const out = inheritToolScopes([serverMacro], tools);
      expect((out[0] as any).runat).toBeUndefined();
    });

    it("never overrides a tool's own explicit scope", () => {
      const tools = [{ type: "function", function: { name: "image" }, runat: "server" }];
      const out = inheritToolScopes([clientMacro], tools);
      expect((out[0] as any).runat).toBe("server");
    });

    it("does not mutate the input tool", () => {
      const tools = [{ type: "function", function: { name: "image" } }];
      inheritToolScopes([clientMacro], tools);
      expect((tools[0] as any).runat).toBeUndefined();
    });

    it("leaves tools that belong to no macro alone", () => {
      const tools = [{ type: "function", function: { name: "unknown" } }];
      const out = inheritToolScopes([clientMacro], tools);
      expect((out[0] as any).runat).toBeUndefined();
    });
  });
});
