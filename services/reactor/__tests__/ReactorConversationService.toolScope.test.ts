import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";
import { analyzeDelegationTranscript } from "../../../ai/orchestration/delegationHealth";

/**
 * Two related guarantees for client-side tools:
 *
 *  1. FLAGGING — a macro/tool's `runat` scope is carried through session assembly. It used to
 *     be dropped (persona macros were hardcoded to server), which mislabelled browser-only
 *     capabilities and let a headless agent be told it could run them.
 *
 *  2. HEADLESS REFUSAL — a client-routed call on a headless turn is answered immediately with
 *     an explanatory `tool` result and the loop continues. It must NOT pause awaiting
 *     `ReactorCompleteClientToolCalls`, because a delegated sub-agent has no browser to answer.
 */
describe("ReactorConversationService - client tool scope", () => {
  describe("collectMacrosAndTools - flagging", () => {
    const service: any = Object.create(ReactorConversationService.prototype);

    const collect = (persona: any, reportedMacros: any[] = [], reportedTools: any[] = []) =>
      service.collectMacrosAndTools({ macros: reportedMacros, tools: reportedTools, persona });

    it("preserves a persona macro's client scope (regression: it was forced to server)", () => {
      const { macros } = collect({
        macros: [{ name: "ImageMacro", alias: "image", runat: "client", tools: [] }],
        tools: [],
      });

      const imageMacro = macros.find((m: any) => (m.alias || m.name) === "image");
      expect(imageMacro.runat).toBe("client");
    });

    it("defaults a persona macro without runat to server", () => {
      const { macros } = collect({
        macros: [{ name: "ShellMacro", alias: "shell", tools: [] }],
        tools: [],
      });

      const shellMacro = macros.find((m: any) => (m.alias || m.name) === "shell");
      expect(shellMacro.runat).toBe("server");
    });

    it("inherits the owning macro's client scope onto a persona tool", () => {
      const { tools } = collect({
        macros: [
          {
            name: "ImageMacro",
            alias: "image",
            runat: "client",
            tools: [{ type: "function", function: { name: "image" } }],
          },
        ],
        // Persona tools are flattened from macros and lose `runat`.
        tools: [{ type: "function", function: { name: "image" } }],
      });

      const imageTool = tools.find((t: any) => t.function?.name === "image");
      expect(imageTool.runat).toBe("client");
    });

    it("keeps a server persona tool server-scoped", () => {
      const { tools } = collect({
        macros: [
          { name: "ShellMacro", alias: "shell", tools: [{ type: "function", function: { name: "shell" } }] },
        ],
        tools: [{ type: "function", function: { name: "shell" } }],
      });

      const shellTool = tools.find((t: any) => t.function?.name === "shell");
      expect(shellTool.runat).toBe("server");
    });

    it("marks client-reported macros and tools as client by default", () => {
      const { macros, tools } = collect(
        { macros: [], tools: [] },
        [{ name: "ChartMacro", alias: "chart" }],
        [{ type: "function", function: { name: "chart" } }]
      );

      expect(macros.find((m: any) => (m.alias || m.name) === "chart").runat).toBe("client");
      expect(tools.find((t: any) => t.function?.name === "chart").runat).toBe("client");
    });
  });

  describe("collectClientRoutedToolNames", () => {
    const service: any = Object.create(ReactorConversationService.prototype);
    const routed = (conversation: any) => service.collectClientRoutedToolNames(conversation);

    it("does NOT treat a server macro's tools as client-routed (regression)", () => {
      // This is the defect that stalled delegated sub-agents: `listWorkflows` is a
      // server macro, but its tool was swept into the client-routed set, so the first
      // tool call of a headless turn was forwarded-and-paused instead of executed.
      const conversation = {
        tools: [],
        macros: [
          {
            name: "listWorkflows",
            alias: "listWorkflows",
            // no runat -> server
            tools: [{ type: "function", function: { name: "listWorkflows" } }],
          },
        ],
      };

      const names = routed(conversation);
      expect(names.has("listWorkflows")).toBe(false);
      expect(names.size).toBe(0);
    });

    it("treats a client macro and the tools it declares as client-routed", () => {
      const conversation = {
        tools: [],
        macros: [
          {
            name: "ImageMacro",
            alias: "image",
            runat: "client",
            tools: [{ type: "function", function: { name: "image" } }],
          },
        ],
      };

      expect(routed(conversation).has("image")).toBe(true);
    });

    it("honours a tool that explicitly declares a client scope inside a server macro", () => {
      const conversation = {
        tools: [],
        macros: [
          {
            name: "MixedMacro",
            tools: [
              { type: "function", function: { name: "serverTool" } },
              { type: "function", function: { name: "clientTool" }, runat: "client" },
            ],
          },
        ],
      };

      const names = routed(conversation);
      expect(names.has("serverTool")).toBe(false);
      expect(names.has("clientTool")).toBe(true);
    });

    it("still picks up client-scoped session tools", () => {
      const conversation = {
        tools: [
          { type: "function", function: { name: "chart" }, runat: "client" },
          { type: "function", function: { name: "shell" }, runat: "server" },
        ],
        macros: [],
      };

      const names = routed(conversation);
      expect(names.has("chart")).toBe(true);
      expect(names.has("shell")).toBe(false);
    });
  });

  describe("persistHeadlessClientToolRefusal", () => {
    let service: any;
    let findOneAndUpdate: jest.Mock<any>;
    let persistedDoc: any;

    const conversationId = new ObjectId().toString();

    const toolCall = {
      id: "call_chart_1",
      type: "function",
      function: { name: "chart", arguments: '{"type":"bar"}' },
    };

    const build = () => {
      persistedDoc = { _id: conversationId, history: [] };

      findOneAndUpdate = jest.fn<any>(() => ({
        exec: async () => persistedDoc,
      }));
      jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockImplementation(findOneAndUpdate as any);

      service = Object.create(ReactorConversationService.prototype);
      service.sessionLog = jest.fn();
      service.mirrorPersistedAppend = jest.fn(async () => {});
      service.streamingTransportManager = {
        sendEventToSession: jest.fn(async () => {}),
      };

      return { conversationId, toolCall, toolName: "chart", personaId: "ReactorAIPersona" };
    };

    beforeEach(() => {
      jest.restoreAllMocks();
    });

    it("persists a tool-role result keyed on the tool call id so the transcript stays valid", async () => {
      const args = build();
      await service.persistHeadlessClientToolRefusal(args);

      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
      const entry = (findOneAndUpdate.mock.calls[0][1] as any).$push.history;

      expect(entry.role).toBe("tool");
      expect(entry.tool_call_id).toBe("call_chart_1");
      expect(entry.tool_name).toBe("chart");
      expect(entry.tool_results).toEqual([]);
    });

    it("flags the refusal with CLIENT_TOOL_UNAVAILABLE_HEADLESS", async () => {
      const args = build();
      await service.persistHeadlessClientToolRefusal(args);

      const entry = (findOneAndUpdate.mock.calls[0][1] as any).$push.history;
      expect(entry.tool_errors[0].code).toBe("CLIENT_TOOL_UNAVAILABLE_HEADLESS");
    });

    it("tells the model the tool is browser-only, not to retry, and to continue", async () => {
      const args = build();
      await service.persistHeadlessClientToolRefusal(args);

      const entry = (findOneAndUpdate.mock.calls[0][1] as any).$push.history;
      expect(entry.content).toContain("chart");
      expect(entry.content).toMatch(/browser/i);
      expect(entry.content).toMatch(/headless/i);
      expect(entry.content).toMatch(/do not call/i);
    });

    it("mirrors the pushed entry so store-backed reads see the refusal", async () => {
      const args = build();
      await service.persistHeadlessClientToolRefusal(args);

      const pushed = (findOneAndUpdate.mock.calls[0][1] as any).$push.history;
      expect(service.mirrorPersistedAppend).toHaveBeenCalledTimes(1);
      const [id, doc, fallback] = service.mirrorPersistedAppend.mock.calls[0] as any[];
      expect(id).toBe(conversationId);
      expect(doc).toBe(persistedDoc);
      expect(fallback).toBe(pushed);
    });

    it("emits no SSE event — there is no client to receive it", async () => {
      const args = build();
      await service.persistHeadlessClientToolRefusal(args);

      expect(service.streamingTransportManager.sendEventToSession).not.toHaveBeenCalled();
    });

    it("logs a line the delegation-health analyser reads as healthy (no pause signature)", async () => {
      const args = build();
      await service.persistHeadlessClientToolRefusal(args);

      const infoCall = service.sessionLog.mock.calls.find((c: any[]) => c[0] === "info");
      expect(infoCall).toBeDefined();
      const [, message] = infoCall as any[];
      expect(message).toMatch(/refusing client-side tool/i);

      // Cross-check with the existing detector: a refusal is not a skip-and-pause stall.
      const health = analyzeDelegationTranscript(`[INFO] ${message}`);
      expect(health.stalled).toBe(false);
      expect(health.healthy).toBe(true);
    });
  });
});
