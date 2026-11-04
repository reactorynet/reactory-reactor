import { describe, it, expect, beforeEach, afterEach, beforeAll, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import { StreamingMode } from "../../types/streaming.types";
import { ToolApprovalMode } from "../../../../ai/openai/types/chat";
import { ChatSessionResourceManager } from "../../ChatSessionResourceManager";

/**
 * The synthetic "no result recorded" placeholder must be visible in `session.log`.
 *
 * THE GAP
 * -------
 * `closeToolCallGaps` already warned when it had to synthesise a result for a tool
 * call that had none anywhere in the transcript — including the tool names and ids.
 * It did so with `this.context.warn(...)`, which writes to the *server* log. The
 * per-conversation log
 * (`REACTORY_DATA/profiles/{userId}/chats/{personaId}/{conversationId}/session.log`)
 * is a different winston logger, owned by `ChatSessionResourceManager`, and nothing
 * bridged the two.
 *
 * That is exactly backwards for the failure this warning reports. A placeholder means
 * a tool call reached the provider with no result anywhere — the same shape as ticket
 * REACTORY-302016408/20261104/2715764250, where two `listSupportTickets` calls were
 * persisted and answered by nothing. The person investigating that opens the
 * conversation's `session.log`, and the one line that explains it was never in there.
 *
 * WHAT IS ASSERTED
 * ----------------
 *   - the placeholder is still synthesised, and the stored transcript is still left
 *     alone (routing the warning must not have quietly become "repair the store");
 *   - the warning reaches the session logger registered for `chatState.id`;
 *   - it still reaches the global context too, so nothing is lost by rerouting;
 *   - a session with no registered logger, or a logger that throws, cannot break the
 *     request.
 */
const mockContext: any = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  getService: jest.fn(),
  user: { _id: new ObjectId(), id: new ObjectId().toString() },
  partner: { _id: new ObjectId() },
};

jest.unstable_mockModule("openai", () => ({
  __esModule: true,
  default: class OpenAI {
    chat = { completions: { create: jest.fn() } };
  },
}));

let OpenAIService: any;

beforeAll(async () => {
  const mod = await import("../OpenAIService");
  OpenAIService = mod.default;
});

const SESSION_ID = "6adb0c56e695bd8de286f2ca";

function createService(sessionId: string = SESSION_ID) {
  const props: any = { apiKey: "test-key", streamingMode: StreamingMode.NONE, $services: {} };
  const svc = new OpenAIService(props, mockContext);
  svc.chatState = {
    id: sessionId,
    personaId: "reactor",
    modelId: "gpt-4",
    history: [],
    toolApprovalMode: ToolApprovalMode.AUTO,
  };
  return svc;
}

const assistantWithCalls = (ids: string[]) => ({
  role: "assistant",
  content: null,
  tool_calls: ids.map((id) => ({
    id,
    type: "function",
    function: { name: "listSupportTickets", arguments: "{}" },
  })),
});

describe("OpenAIService - closeToolCallGaps warnings reach the session log", () => {
  let sessionLogger: any;

  beforeEach(() => {
    jest.clearAllMocks();
    sessionLogger = { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() };
    ChatSessionResourceManager.register(SESSION_ID, sessionLogger as any);
  });

  afterEach(() => {
    ChatSessionResourceManager.unregister(SESSION_ID);
  });

  it("still synthesises the placeholder and leaves the transcript untouched", () => {
    const svc = createService();
    const input: any[] = [
      { role: "system", content: "sys" },
      // The 06:39:19.060 shape: one assistant message, two calls, no results.
      assistantWithCalls(["call_9f8a1", "call_9f8a2"]),
      { role: "user", content: "continue" },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));

    const out = svc.closeToolCallGaps(input);

    const toolMessages = out.filter((m: any) => m.role === "tool");
    expect(toolMessages.map((m: any) => m.tool_call_id)).toEqual(["call_9f8a1", "call_9f8a2"]);
    expect(toolMessages[0].content).toContain("No result was recorded for this tool call");

    // Routing a warning must not have become "repair the store".
    expect(input).toEqual(snapshot);
  });

  it("writes the warning to the conversation's session logger, naming tool and call id", () => {
    const svc = createService();

    svc.closeToolCallGaps([
      assistantWithCalls(["call_9f8a1", "call_9f8a2"]),
      { role: "user", content: "continue" },
    ]);

    expect(sessionLogger.warn).toHaveBeenCalledTimes(1);
    const [message, meta] = sessionLogger.warn.mock.calls[0] as [string, any];

    expect(message).toContain("no result anywhere in the transcript");
    expect(message).toContain("The stored transcript was NOT modified");
    // The actionable part: WHICH calls were unanswered.
    expect(meta.toolCalls).toEqual([
      "listSupportTickets(call_9f8a1)",
      "listSupportTickets(call_9f8a2)",
    ]);
    expect(meta.toolCallIds).toEqual(["call_9f8a1", "call_9f8a2"]);
    expect(meta.count).toBe(2);
    expect(meta.sessionId).toBe(SESSION_ID);
  });

  it("still writes to the global context, so rerouting loses nothing", () => {
    const svc = createService();

    svc.closeToolCallGaps([
      assistantWithCalls(["call_9f8a1"]),
      { role: "user", content: "continue" },
    ]);

    expect(mockContext.warn).toHaveBeenCalledTimes(1);
    expect(String(mockContext.warn.mock.calls[0][0])).toContain("no result anywhere in the transcript");
  });

  it("does not warn at all when every call is answered", () => {
    const svc = createService();

    svc.closeToolCallGaps([
      assistantWithCalls(["call_answered"]),
      { role: "tool", tool_call_id: "call_answered", content: "done" },
    ]);

    expect(sessionLogger.warn).not.toHaveBeenCalled();
    expect(mockContext.warn).not.toHaveBeenCalled();
  });

  it("cannot fail a request when no session logger is registered", () => {
    ChatSessionResourceManager.unregister(SESSION_ID);
    const svc = createService("a-session-with-no-logger");

    expect(() =>
      svc.closeToolCallGaps([assistantWithCalls(["call_x"]), { role: "user", content: "go" }])
    ).not.toThrow();
    // The global warning is still made — the session log is additive, not a replacement.
    expect(mockContext.warn).toHaveBeenCalledTimes(1);
  });

  it("cannot fail a request when the session logger itself throws", () => {
    sessionLogger.warn.mockImplementation(() => {
      throw new Error("disk full");
    });
    const svc = createService();

    expect(() =>
      svc.closeToolCallGaps([assistantWithCalls(["call_y"]), { role: "user", content: "go" }])
    ).not.toThrow();
  });
});
