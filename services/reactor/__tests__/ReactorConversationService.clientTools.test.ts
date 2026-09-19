import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";

/**
 * Client-side tool durability.
 *
 * Two behaviours are under test, and both exist because a client-side tool has no
 * server-side execution path — so the server's only jobs are to *classify* the
 * call correctly and to *record* the result the browser reports back.
 *
 *  1. `syncClientCapabilities` — a client advertises its macros and tools once, at
 *     session creation. A reload or a reconnect never re-advertises, so the
 *     session can hold a set that no longer matches what the browser can run. This
 *     converges the recorded set on reality.
 *
 *  2. `getPendingClientToolCalls` — the replay surface. A completion that never
 *     reached the server leaves a `tool_call` nothing answers, so the transcript
 *     stays permanently malformed. This is how a reconnecting client finds out
 *     what is outstanding.
 */
describe("ReactorConversationService - client tool durability", () => {
  let service: any;
  let mockContext: any;

  const conversationId = new ObjectId().toString();

  /** Stub the Mongoose chain `findOne(...).exec()` / `.lean().exec()`. */
  const stubConversation = (conversation: any) => {
    jest.spyOn(ReactorConversationModel, "findOne").mockReturnValue({
      exec: async () => conversation,
      lean: () => ({ exec: async () => conversation }),
    } as any);
  };

  beforeEach(() => {
    mockContext = {
      getService: jest.fn(),
      user: { _id: new ObjectId(), id: "u1" },
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      hasAnyRole: jest.fn(() => true),
    };

    service = Object.create(ReactorConversationService.prototype);
    service.context = mockContext;
    service.sessionLog = jest.fn();
    service.validateChatSessionId = jest.fn();
  });

  describe("syncClientCapabilities", () => {
    it("records the client's macros as client-routed and preserves server macros", async () => {
      const conversation: any = {
        _id: conversationId,
        personaId: "ReactorAIPersona",
        save: jest.fn(async () => conversation),
        macros: [
          { name: "shell", alias: "shell", runat: "server" },
          { name: "StaleMacro", alias: "stale", runat: "client" },
        ],
        tools: [{ type: "function", runat: "server", function: { name: "readFile" } }],
      };
      stubConversation(conversation);

      const result = await service.syncClientCapabilities({
        chatSessionId: conversationId,
        macros: [
          { name: "ChartMacro", alias: "chart", nameSpace: "reactor-macros", version: "1.0.0" },
          { name: "D3Macro", alias: "d3", nameSpace: "reactor-macros", version: "1.0.0" },
        ],
        tools: [{ type: "function", function: { name: "chart" } }],
      });

      // Client entries are replaced wholesale: the stale client macro is gone
      // rather than lingering forever — which is what "replace" has to mean —
      // and the two advertised macros take its place.
      const aliases = conversation.macros.map((m: any) => m.alias || m.name);
      expect(aliases).not.toContain("stale");
      expect(aliases).toEqual(expect.arrayContaining(["chart", "d3"]));

      // The persona's server macro survives — the client has no authority over it.
      expect(conversation.macros).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "shell", runat: "server" })])
      );

      expect(result.synced).toBe(true);
      expect(result.clientMacros).toEqual(expect.arrayContaining(["chart", "d3"]));
      expect(conversation.save).toHaveBeenCalled();
    });

    it("preserves a macro's own tool definitions", async () => {
      // Dropping these was silently lossy: a macro that advertises its function
      // schema only through `tools` then had no server-side definition at all, so
      // the model's call could not be classified and failed the turn.
      const conversation: any = {
        _id: conversationId,
        personaId: "p",
        save: jest.fn(async () => conversation),
        macros: [],
        tools: [],
      };
      stubConversation(conversation);

      await service.syncClientCapabilities({
        chatSessionId: conversationId,
        macros: [
          {
            name: "ChartMacro",
            alias: "chart",
            tools: [{ type: "function", function: { name: "chart", description: "draw" } }],
          },
        ],
        tools: [],
      });

      const chart = conversation.macros.find((m: any) => m.alias === "chart");
      expect(chart.tools).toHaveLength(1);
      expect(chart.tools[0].function.name).toBe("chart");
    });

    it("never overwrites server-owned tools", async () => {
      const conversation: any = {
        _id: conversationId,
        personaId: "p",
        save: jest.fn(async () => conversation),
        macros: [],
        tools: [
          { type: "function", runat: "server", function: { name: "shell" } },
          { type: "function", runat: "client", function: { name: "chart" } },
        ],
      };
      stubConversation(conversation);

      await service.syncClientCapabilities({
        chatSessionId: conversationId,
        macros: [],
        tools: [{ type: "function", function: { name: "d3" } }],
      });

      const names = conversation.tools.map((t: any) => t.function.name);
      expect(names).toContain("shell");
      expect(names).toContain("d3");
      // The previously-recorded client tool is replaced, not merged.
      expect(names).not.toContain("chart");
    });

    it("treats an omitted macros/tools argument as no change, not as a wipe", async () => {
      // A caller that does not supply the field must not silently strip a session
      // of the tools it needs.
      const conversation: any = {
        _id: conversationId,
        personaId: "p",
        save: jest.fn(async () => conversation),
        macros: [{ name: "ChartMacro", alias: "chart", runat: "client" }],
        tools: [{ type: "function", runat: "client", function: { name: "chart" } }],
      };
      stubConversation(conversation);

      await service.syncClientCapabilities({ chatSessionId: conversationId });

      expect(conversation.tools).toHaveLength(1);
      expect(conversation.tools[0].function.name).toBe("chart");
    });

    it("treats an explicit empty array as clearing the client set", async () => {
      const conversation: any = {
        _id: conversationId,
        personaId: "p",
        save: jest.fn(async () => conversation),
        macros: [{ name: "ChartMacro", alias: "chart", runat: "client" }],
        tools: [
          { type: "function", runat: "client", function: { name: "chart" } },
          { type: "function", runat: "server", function: { name: "shell" } },
        ],
      };
      stubConversation(conversation);

      await service.syncClientCapabilities({
        chatSessionId: conversationId,
        macros: [],
        tools: [],
      });

      expect(conversation.macros).toHaveLength(0);
      // Only the client tool is cleared.
      expect(conversation.tools).toHaveLength(1);
      expect(conversation.tools[0].function.name).toBe("shell");
    });

    it("refuses a session the caller does not own", async () => {
      stubConversation(null);

      await expect(
        service.syncClientCapabilities({ chatSessionId: conversationId, macros: [], tools: [] })
      ).rejects.toThrow(/not found or you do not have permission/i);
    });
  });

  describe("getPendingClientToolCalls", () => {
    /** Stub the message store the pending scan reads from. */
    const stubStore = (messages: any[]) => {
      service.getMessageStore = () => ({
        getActiveMessages: async () => messages,
        toMessages: (rows: any[]) => rows,
      });
    };

    it("returns a client-routed call that has no result yet", async () => {
      const conversation: any = {
        _id: conversationId,
        tools: [{ type: "function", runat: "client", function: { name: "chart" } }],
        macros: [],
      };
      stubConversation(conversation);
      stubStore([
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "chart", arguments: '{"type":"bar"}' } }],
        },
      ]);

      const pending = await service.getPendingClientToolCalls({ chatSessionId: conversationId });

      expect(pending).toHaveLength(1);
      expect(pending[0].toolCallId).toBe("call_1");
      expect(pending[0].toolName).toBe("chart");
      expect(pending[0].args).toBe('{"type":"bar"}');
    });

    it("excludes a call that already has a tool result", async () => {
      // The answered case. Replaying it would duplicate work the server has
      // already recorded.
      const conversation: any = {
        _id: conversationId,
        tools: [{ type: "function", runat: "client", function: { name: "chart" } }],
        macros: [],
      };
      stubConversation(conversation);
      stubStore([
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "chart" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "rendered" },
      ]);

      const pending = await service.getPendingClientToolCalls({ chatSessionId: conversationId });
      expect(pending).toHaveLength(0);
    });

    it("excludes server-routed tools", async () => {
      // A server tool with no result is a different problem — it was never the
      // browser's to answer — and must not appear in a replay list.
      const conversation: any = {
        _id: conversationId,
        tools: [{ type: "function", runat: "server", function: { name: "shell" } }],
        macros: [],
      };
      stubConversation(conversation);
      stubStore([
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "shell" } }],
        },
      ]);

      const pending = await service.getPendingClientToolCalls({ chatSessionId: conversationId });
      expect(pending).toHaveLength(0);
    });

    it("treats a tool belonging to a client macro as client-routed", async () => {
      // The macro's own `tools` list is evidence of client routing even when the
      // session's `tools` array never recorded it — the stale-session case.
      const conversation: any = {
        _id: conversationId,
        tools: [],
        macros: [
          {
            name: "ChartMacro",
            alias: "chart",
            runat: "client",
            tools: [{ type: "function", function: { name: "chart" } }],
          },
        ],
      };
      stubConversation(conversation);
      stubStore([
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "chart" } }],
        },
      ]);

      const pending = await service.getPendingClientToolCalls({ chatSessionId: conversationId });
      expect(pending).toHaveLength(1);
      expect(pending[0].toolName).toBe("chart");
    });

    it("returns nothing when the transcript has no tool calls", async () => {
      stubConversation({ _id: conversationId, tools: [], macros: [] });
      stubStore([{ role: "user", content: "hello" }]);

      const pending = await service.getPendingClientToolCalls({ chatSessionId: conversationId });
      expect(pending).toEqual([]);
    });

    it("reports a still-pending call as pending rather than success", async () => {
      stubConversation({
        _id: conversationId,
        tools: [{ type: "function", runat: "client", function: { name: "chart" } }],
        macros: [],
      });
      stubStore([
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "chart" }, status: "running" },
          ],
        },
      ]);

      const pending = await service.getPendingClientToolCalls({ chatSessionId: conversationId });
      expect(pending[0].status).toBe("running");
    });
  });

  describe("collectClientRoutedToolNames", () => {
    it("unions session tools, client macros and their macro tools", () => {
      const names = service.collectClientRoutedToolNames({
        tools: [
          { type: "function", runat: "client", function: { name: "chart" } },
          { type: "function", runat: "server", function: { name: "shell" } },
        ],
        macros: [
          { name: "ImageMacro", alias: "image", runat: "client" },
          {
            name: "FormMacro",
            alias: "form",
            runat: "client",
            tools: [{ type: "function", function: { name: "form" } }],
          },
          { name: "ServerMacro", alias: "serverMacro", runat: "server" },
        ],
      });

      expect(names.has("chart")).toBe(true);
      expect(names.has("image")).toBe(true);
      expect(names.has("form")).toBe(true);
      // Server-routed entries are not client-routed.
      expect(names.has("shell")).toBe(false);
      expect(names.has("serverMacro")).toBe(false);
    });

    it("returns an empty set for an empty conversation", () => {
      const names = service.collectClientRoutedToolNames({});
      expect(names.size).toBe(0);
    });
  });
});
