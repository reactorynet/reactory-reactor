import { describe, it, expect } from "@jest/globals";
import ReactorConversationService from "../ReactorConversationService";

/**
 * The guard defect (D1), pinned directly.
 *
 * The reported incident: a conversation whose `maxTokens` sat at the hard-coded
 * fallback (`TOKEN_LIMITS.DEFAULT_MAX_TOKENS = 200000`) while its `tokenCount` had
 * grown well past it refused EVERY tool — including a 4-byte `echo ok` — with
 *
 *   "Macro shell result is too large. Max tokens: 200000, Token count: 573258"
 *
 * That message blames the macro. The condition is about the *conversation*, and a
 * 4-byte result being refused is itself the proof that the predicate cannot be
 * about the result's size. The old code had two guards; the second one —
 *
 *   tokenCount + conversation.tokenCount > conversation.maxTokens
 *
 * — is the one that fired, and it is a conversation-budget predicate wearing a
 * macro-failure message.
 *
 * `evaluateToolResultBudget` is `static` and pure precisely so the predicate can be
 * tested here without Mongo or a provider registry. That is what made the original
 * defect unreachable by unit tests: it was only observable through the whole
 * service, mid-tool-execution.
 */
describe("ReactorConversationService.evaluateToolResultBudget - the predicate", () => {
  const CHAT_ID = "6aa95e669bc8c4d41524985d";

  const evaluate = (input: Record<string, unknown>) =>
    (ReactorConversationService as any).evaluateToolResultBudget({
      macro: "shell",
      chatSessionId: CHAT_ID,
      ...input,
    });

  it("REPRODUCTION: refuses a 4-byte result when the conversation is over budget — and blames the conversation", () => {
    // The incident fixture: maxTokens stuck at the 200k default, conversation at ~573k.
    const decision = evaluate({
      resultTokens: 1, // "echo ok" ≈ 4 bytes / 4
      conversationTokens: 573258,
      conversationMaxTokens: 200000,
    });

    expect(decision.allowResult).toBe(false);
    // The defect was reporting this as "Macro shell result is too large".
    expect(decision.reason).toBe("conversation-over-budget");
    expect(decision.message).toContain(`Conversation ${CHAT_ID} is over its context budget`);
    expect(decision.message).toContain("not a macro failure");
    // The message must distinguish the two budgets rather than collapsing them into "Max tokens:".
    expect(decision.message).toContain("result tokens");
    expect(decision.message).toContain("conversation budget");
  });

  it("the result's own size cannot be the predicate: 1 token and 14k tokens are refused identically over budget", () => {
    const tiny = evaluate({ resultTokens: 1, conversationTokens: 573258, conversationMaxTokens: 200000 });
    const large = evaluate({ resultTokens: 14000, conversationTokens: 573258, conversationMaxTokens: 200000 });

    expect(tiny.reason).toBe("conversation-over-budget");
    expect(large.reason).toBe("conversation-over-budget");
  });

  it("ALLOWS a small result when the conversation fits — the fix for the reported wedge", () => {
    // Same conversation, cap correctly resolved to 1,000,000 (what actually happened
    // once the model was resolvable again).
    const decision = evaluate({
      resultTokens: 1,
      conversationTokens: 573258,
      conversationMaxTokens: 1000000,
    });

    expect(decision.allowResult).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("refuses a result that could never fit ANY conversation, and says so in result-budget terms", () => {
    const decision = evaluate({
      resultTokens: 500000,
      conversationTokens: 0,
      conversationMaxTokens: 200000,
    });

    expect(decision.allowResult).toBe(false);
    expect(decision.reason).toBe("result-exceeds-conversation");
    expect(decision.message).toContain("result budget");
    expect(decision.message).not.toContain("not a macro failure");
  });

  it("honours a separate, configurable result budget when one is supplied", () => {
    // The result fits the conversation window comfortably, but not its own tighter budget.
    const decision = evaluate({
      resultTokens: 90000,
      conversationTokens: 0,
      conversationMaxTokens: 1000000,
      resultMaxTokens: 50000,
    });

    expect(decision.allowResult).toBe(false);
    expect(decision.reason).toBe("result-exceeds-conversation");
  });

  it("allows a result that exactly reaches the budget, so the boundary is not off by one", () => {
    const decision = evaluate({
      resultTokens: 100,
      conversationTokens: 199900,
      conversationMaxTokens: 200000,
    });

    expect(decision.allowResult).toBe(true);
  });

  it("treats an absent budget as unbounded, so uncapped conversations are unaffected", () => {
    const decision = evaluate({
      resultTokens: 10 ** 9,
      conversationTokens: 10 ** 9,
      conversationMaxTokens: null,
    });

    expect(decision.allowResult).toBe(true);
  });

  it("the predicate itself never mutates anything — it is a decision, not a remedy", () => {
    // Recovery/truncation used to hang off this predicate. It must not: truncating from
    // inside tool execution can archive the assistant message that owns the in-flight
    // tool call (see the note on the guard in executeMacro). Pure function, pure decision.
    const decision = evaluate({
      resultTokens: 1,
      conversationTokens: 573258,
      conversationMaxTokens: 200000,
    });

    expect(Object.keys(decision).sort()).toEqual(
      [
        "allowResult",
        "conversationMaxTokens",
        "conversationTokens",
        "message",
        "reason",
        "resultTokens",
      ].sort()
    );
  });
});

/**
 * The rule that stops the cap from collapsing.
 *
 * `ReactorProviderService.resolveModelContextLength` answers in one of two ways: it
 * reads the model's **declared** `contextLength` (authoritative), or it reports a miss
 * and an invented fallback (a guess). Only declared answers may move a conversation's
 * budget freely. A guess may never SHRINK it — that is exactly how a real
 * 1 000 000 became 200 000 and silently disabled every tool.
 *
 * All three `maxTokens` writers share this rule.
 */
describe("ReactorConversationService.resolvePersistedMaxTokens - the rule every writer shares", () => {
  const service: any = Object.create(ReactorConversationService.prototype);
  const resolve = service.resolvePersistedMaxTokens.bind(service);

  /** A resolution shaped exactly as ReactorProviderService returns one. */
  const declared = (value: number) => ({
    value,
    source: "model-declared",
    authoritative: true,
    providerId: "deepseek",
    modelId: "deepseek-flash",
  });

  const invented = (value: number, source = "builtin-default") => ({
    value,
    source,
    authoritative: false,
    providerId: "deepseek",
    modelId: "deepseek-flash",
  });

  it("KEEPS a 1M budget when the invented platform default would shrink it to 200k", () => {
    // The incident, at its root.
    expect(resolve(1000000, invented(200000))).toBeUndefined();
  });

  it("KEEPS a budget when an operator-configured default would shrink it", () => {
    // `configured-default` is still a fallback — still a guess, not a measurement.
    expect(resolve(2000000, invented(131072, "configured-default"))).toBeUndefined();
  });

  it("APPLIES a declared downgrade, so switching to a genuinely smaller model still works", () => {
    expect(resolve(1000000, declared(200000))).toBe(200000);
  });

  it("APPLIES a declared window that shrinks the budget — the incident's own case", () => {
    // deepseek-flash declares 64 000. Going from 1M (a bogus cross-provider value)
    // down to the real 64 000 is correct, because the value is DECLARED.
    expect(resolve(1000000, declared(64000))).toBe(64000);
  });

  it("APPLIES an upgrade from any source, including a guess", () => {
    expect(resolve(200000, invented(1048576))).toBe(1048576);
    expect(resolve(200000, declared(64000))).toBe(64000);
  });

  it("APPLIES the resolved value when there is no existing budget to protect", () => {
    expect(resolve(undefined, invented(200000))).toBe(200000);
    expect(resolve(null, invented(200000))).toBe(200000);
    expect(resolve(0, invented(200000))).toBe(200000);
  });

  it("LEAVES the stored budget alone when nothing resolved at all", () => {
    expect(
      resolve(1000000, {
        value: null,
        source: "unresolved",
        authoritative: false,
        providerId: "deepseek",
        modelId: "deepseek-flash",
      })
    ).toBeUndefined();
    // …and sets nothing even when there was no prior budget.
    expect(
      resolve(undefined, {
        value: null,
        source: "unresolved",
        authoritative: false,
        providerId: null,
        modelId: null,
      })
    ).toBeUndefined();
  });

  it("does not protect a budget that is already at or below the resolved value", () => {
    // A guess may raise a budget (an over-large one fails loudly at the provider),
    // it just may not lower one.
    expect(resolve(100000, invented(200000))).toBe(200000);
    expect(resolve(200000, invented(200000))).toBe(200000);
  });
});
