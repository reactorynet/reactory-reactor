import { describe, it, expect, beforeEach, beforeAll, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import { StreamingMode } from "../../types/streaming.types";
import { ToolApprovalMode } from "../../../../ai/openai/types/chat";

/**
 * The tool-call closure invariant.
 *
 * A provider rejects a transcript in which an assistant message carries a `tool_call` that no
 * `tool` message answers — `400 … must be followed by tool messages responding to each
 * 'tool_call_id'` — and the error is **not retryable**, so one unanswered call makes every later
 * turn on the conversation fail permanently.
 *
 * These tests are about the guard in `OpenAIService.closeToolCallGaps`, which enforces that
 * invariant on the outgoing payload. Two things are asserted throughout, and the second is the one
 * that matters: that the *payload* is well-formed, and that the guard **did not touch the stored
 * transcript** — a guard that repaired the store would erase the evidence of the bug that produced
 * the gap. The service is exercised through minimal mocks; no store is involved.
 *
 * Every case below states what would make it fail, and the shared `expectClosureInvariant` helper
 * is deliberately written as a general check over the output rather than a restatement of the
 * expected array, so a guard that reorders or drops unrelated messages is caught too.
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

function createService() {
  const props: any = { apiKey: "test-key", streamingMode: StreamingMode.NONE, $services: {} };
  const svc = new OpenAIService(props, mockContext);
  svc.chatState = {
    id: "closure-session",
    personaId: "test-persona",
    modelId: "deepseek-flash",
    history: [],
    toolApprovalMode: ToolApprovalMode.PROMPT,
  };
  return svc;
}

const assistantWithCalls = (ids: string[], content = "") => ({
  role: "assistant",
  content: content || null,
  tool_calls: ids.map((id) => ({
    id,
    type: "function",
    function: { name: `tool_${id}`, arguments: "{}" },
  })),
});

const toolResult = (id: string, content = "ok") => ({
  role: "tool",
  tool_call_id: id,
  content,
});

/**
 * The invariant the provider enforces, checked structurally over the whole payload:
 * every assistant `tool_call` is answered by a `tool` message that appears after it, before the
 * next non-tool message; and no `tool` message answers nothing.
 */
const expectClosureInvariant = (messages: any[]) => {
  const answeredIds = new Set(
    messages.filter((m) => m?.role === "tool" && m.tool_call_id).map((m) => String(m.tool_call_id))
  );

  messages.forEach((message, index) => {
    if (message?.role === "tool") {
      expect(answeredIds.has(String(message.tool_call_id))).toBe(true);
      return;
    }

    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) return;

    for (const call of message.tool_calls) {
      // 1. answered somewhere at all
      expect(answeredIds.has(String(call.id))).toBe(true);

      // 2. answered *here* — the result must follow this assistant message and precede the next
      //    non-tool message. Position matters: a result placed after a later user turn is rejected
      //    just as firmly as a missing one.
      const following: any[] = [];
      for (let i = index + 1; i < messages.length; i += 1) {
        if (messages[i]?.role !== "tool") break;
        following.push(messages[i]);
      }
      expect(following.map((m) => String(m.tool_call_id))).toContain(String(call.id));
    }
  });
};

describe("OpenAIService – tool-call closure guard", () => {
  let svc: any;
  let guard: (messages: any[]) => any[];

  beforeEach(() => {
    jest.clearAllMocks();
    svc = createService();
    guard = (messages: any[]) => svc.closeToolCallGaps(messages);
  });

  it("closes an unanswered tool call, and places the result BEFORE a later user turn", () => {
    // The real shape from session 6aac7edc2d608d16c621e39f: an assistant message whose two tool
    // calls were never answered in the store, followed by the user's next message. This is the
    // transcript that produced the non-retryable 400.
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "do the thing" },
      assistantWithCalls(["call_close", "call_image"]),
      { role: "user", content: "Continue" },
    ];

    const out = guard(messages);
    expectClosureInvariant(out);

    // Order, not just presence — the whole point is that the results sit between the assistant
    // message and the user turn that followed it.
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);

    // The tool_call ids on the synthesised results must match, or the provider still 400s.
    expect(out[3].tool_call_id).toBe("call_close");
    expect(out[4].tool_call_id).toBe("call_image");

    // FAILS IF: the guard appends instead of inserting (roles would end [..., 'user', 'tool', 'tool'])
    // or synthesises with the wrong id.
  });

  it("tells the model no result was recorded, rather than inventing a plausible success", () => {
    const out = guard([assistantWithCalls(["call_a"]), { role: "user", content: "next" }]);

    expect(out[1].role).toBe("tool");
    expect(String(out[1].content)).toContain("No result was recorded");
    // A fabricated "success" would let the model reason from an output that never existed.
    expect(String(out[1].content).toLowerCase()).not.toContain("success");
  });

  it("warns with the call ids so the real gap is attributable", () => {
    guard([assistantWithCalls(["call_missing"]), { role: "user", content: "next" }]);

    expect(mockContext.warn).toHaveBeenCalledTimes(1);
    const [message, meta] = mockContext.warn.mock.calls[0] as [string, any];
    // The wording distinguishes "no result exists" from "the result is out of position", because
    // the two have different causes and different remedies. See the ordering test below.
    expect(String(message)).toMatch(/no result anywhere/i);
    expect(meta.count).toBe(1);
    expect(JSON.stringify(meta.toolCalls)).toContain("call_missing");

    // FAILS IF: the guard is silent. An in-payload repair with no log would hide the persistence
    // defect that caused the gap, which is the failure mode this whole change exists to prevent.
  });

  it("leaves a well-formed transcript untouched and silent", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      assistantWithCalls(["call_1"]),
      toolResult("call_1"),
      { role: "user", content: "again" },
    ];

    const out = guard(messages);

    expect(out).toEqual(messages);
    expect(mockContext.warn).not.toHaveBeenCalled();
    // FAILS IF: the guard rewrites or duplicates results that were already correct.
  });

  it("closes only the calls in a batch that were answered partially", () => {
    const out = guard([
      assistantWithCalls(["call_ok", "call_missing"]),
      toolResult("call_ok", "real result"),
      { role: "user", content: "next" },
    ]);

    expectClosureInvariant(out);

    const results = out.filter((m) => m.role === "tool");
    expect(results.map((m) => m.tool_call_id).sort()).toEqual(["call_missing", "call_ok"]);

    // The real result must survive verbatim — the guard fills gaps, it does not replace results.
    const real = results.find((m) => m.tool_call_id === "call_ok");
    expect(real.content).toBe("real result");

    // FAILS IF: the guard synthesises a placeholder for a call that already had a result.
    const placeholderCount = results.filter((m) =>
      String(m.content).includes("No result was recorded")
    ).length;
    expect(placeholderCount).toBe(1);
  });

  it("drops a tool result that answers no tool call", () => {
    const messages = [
      { role: "user", content: "go" },
      toolResult("call_orphan", "stale"),
      { role: "user", content: "next" },
    ];

    const out = guard(messages);

    expectClosureInvariant(out);
    expect(out.some((m) => m.role === "tool")).toBe(false);
    expect(mockContext.warn).toHaveBeenCalled();

    // FAILS IF: orphans are passed through — a result answering nothing is rejected by the
    // provider in exactly the same way as a missing one.
  });

  it("makes the payload valid for a transcript with many broken turns", () => {
    // Adjacent broken turns are the case a naive "insert after the first gap" implementation gets
    // wrong: the insert index moves for every synthesis.
    const messages = [
      assistantWithCalls(["a1", "a2"]),
      { role: "user", content: "u1" },
      assistantWithCalls(["b1"]),
      { role: "user", content: "u2" },
      assistantWithCalls(["c1", "c2", "c3"]),
      { role: "user", content: "u3" },
    ];

    const out = guard(messages);
    expectClosureInvariant(out);

    expect(out.map((m) => m.role)).toEqual([
      "assistant", "tool", "tool",
      "user",
      "assistant", "tool",
      "user",
      "assistant", "tool", "tool", "tool",
      "user",
    ]);
  });

  it("moves a result that sits LATER than its call back into position", () => {
    // THE REGRESSION THIS FILE DID NOT CATCH.
    //
    // Session 6aad3a01879ddde16cdac9f1 failed with the same 400 even though every call was
    // answered: `assistant(195)`'s result was at position 200, with another assistant message in
    // between. The provider requires the call to be *immediately followed* by its results, so
    // "answered somewhere" is not the invariant. The earlier guard keyed on "answered anywhere",
    // inserted nothing, and left the request invalid.
    const messages = [
      { role: "user", content: "go" },
      assistantWithCalls(["call_late"], "running a long command"),
      assistantWithCalls(["call_other"], "meanwhile, a different turn appended this"),
      toolResult("call_other", "the other turn's result"),
      toolResult("call_late", "the long command's result"),
      { role: "user", content: "continue" },
    ];

    const out = guard(messages);

    // The invariant is positional, so assert positions and not just membership.
    expectClosureInvariant(out);

    expect(out.map((m) => m.role)).toEqual([
      "user",
      "assistant", "tool",   // call_late's result moved up, next to its call
      "assistant", "tool",   // call_other keeps its own
      "user",
    ]);

    expect(out[2].tool_call_id).toBe("call_late");
    expect(out[4].tool_call_id).toBe("call_other");

    // FAILS IF: the guard treats "answered anywhere" as sufficient (roles would be
    // [user, assistant, assistant, tool, tool, user] and the leading assistant would be
    // unanswered by position).
  });

  it("relocates rather than duplicating — one result per call, never two", () => {
    const messages = [
      assistantWithCalls(["call_x"]),
      { role: "user", content: "next" },
      toolResult("call_x", "the real output"),
    ];

    const out = guard(messages);
    const results = out.filter((m) => m.role === "tool");

    // The real output must be used, not replaced by a placeholder, and must appear exactly once.
    expect(results).toHaveLength(1);
    expect(results[0].tool_call_id).toBe("call_x");
    expect(results[0].content).toBe("the real output");

    // FAILS IF: the guard synthesises a placeholder for a call that had a result (the model would
    // lose the tool's actual output), or emits the result twice (providers reject a duplicate).
    expect(out.filter((m) => String(m.content).includes("No result was recorded"))).toHaveLength(0);
  });

  it("reports an ordering move distinctly from a missing result", () => {
    // The two defects need different remedies — an ordering fault points at concurrent writes, a
    // missing result points at persistence — so they must not be collapsed into one message.
    guard([
      assistantWithCalls(["call_moved"]),
      { role: "user", content: "next" },
      toolResult("call_moved"),
      assistantWithCalls(["call_absent"]),
      { role: "user", content: "next again" },
    ]);

    const messages = (mockContext.warn.mock.calls as any[]).map((c) => String(c[0]));
    expect(messages.some((m) => /not adjacent to their tool call/i.test(m))).toBe(true);
    expect(messages.some((m) => /no result anywhere/i.test(m))).toBe(true);
  });

  it("keeps only the first of two results for the same call", () => {
    const messages = [
      assistantWithCalls(["call_dup"]),
      toolResult("call_dup", "first"),
      { role: "user", content: "next" },
      toolResult("call_dup", "second"),
    ];

    const out = guard(messages);
    const results = out.filter((m) => m.role === "tool");

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("first");

    // FAILS IF: both are emitted — the provider accepts exactly one result per tool_call_id.
  });

  it("never mutates the input transcript", () => {
    const messages = [
      assistantWithCalls(["call_late"]),
      { role: "user", content: "next" },
      toolResult("call_late"),
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));

    guard(messages);

    expect(messages).toEqual(snapshot);
    expect(messages.length).toBe(3);
    // FAILS IF: the guard repairs in place. The stored transcript must keep the malformation, so the
    // defect stays visible to the store's own checks rather than being papered over — for the
    // ordering case, writing back would silently rewrite conversation history on every request.
  });
});
