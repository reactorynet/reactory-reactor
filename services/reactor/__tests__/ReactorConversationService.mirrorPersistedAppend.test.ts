import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";

/**
 * `mirrorPersistedAppend` — which item the store row is keyed on.
 *
 * WHY THIS FILE EXISTS
 *
 * This method had **no coverage at all**: every other test mocks it out. Its own docblock says the
 * *selection* is what matters, and the selection is precisely what was wrong — six call sites passed
 * no fallback, so a message whose `$push` had been stripped was silently never written. The visible
 * consequence was a session-ending, non-retryable provider 400 ("an assistant message with
 * 'tool_calls' must be followed by tool messages"), with nothing local pointing at the cause.
 *
 * A mocked-away method cannot fail, so the defect shipped. These tests exercise it for real against
 * an injected mirror, and cover the two cases its docblock insists must stay distinct:
 *
 *  - the push was **stripped** (existing document) → `updated.history` ends with the PREVIOUS
 *    message, so the fallback is the only description of what was written; and
 *  - the push **landed** (brand-new document, exempt from the policy) → the persisted item is ours
 *    and must win, because Mongo holds a different `_id` from any we would mint.
 *
 * Getting either case backwards is silent in opposite directions, which is why both are asserted.
 */
describe("ReactorConversationService - mirrorPersistedAppend", () => {
  let service: any;
  let appendMessage: jest.Mock<any>;
  let sessionLog: jest.Mock<any>;
  let conversationId: string;

  const makeItem = (overrides: Record<string, any> = {}) => ({
    id: new ObjectId(),
    role: "tool",
    content: "result",
    tool_call_id: "call_1",
    tool_name: "chart",
    timestamp: new Date(),
    tool_results: [] as any[],
    ...overrides,
  });

  beforeEach(() => {
    conversationId = new ObjectId().toString();
    appendMessage = jest.fn(async () => ({ seq: 1, id: "row-1" }));
    sessionLog = jest.fn();

    service = Object.create(ReactorConversationService.prototype);
    service.sessionLog = sessionLog;
    // Injected so the method runs its own logic rather than the lazy `new
    // ReactorConversationMessageService()` (which would need a live Postgres).
    service.messageMirror = { isAvailable: () => true, appendMessage };
  });

  const mirror = (updated: any, fallback: any, attribution?: any) =>
    (service as any).mirrorPersistedAppend(conversationId, updated, fallback, attribution);

  describe("when the $push was stripped (the normal case for an existing document)", () => {
    it("mirrors the fallback item and mints the identity Mongo did not assign", async () => {
      // The document Mongo returns carries the PREVIOUS message as its last history entry, because
      // the write-path policy removed `$push.history`. `updated.history` therefore cannot say what
      // was written — only the fallback can.
      const previous = makeItem({ content: "the previous message" });
      const pushed = makeItem({ content: "the lost tool result" });

      await mirror({ _id: conversationId, history: [previous] }, pushed);

      expect(appendMessage).toHaveBeenCalledTimes(1);
      const [calledId, mirroredItem] = appendMessage.mock.calls[0] as any[];

      expect(calledId).toBe(conversationId);
      expect(mirroredItem).toBe(pushed);

      // FAILS IF: the mirror re-mirrors the previous message — the exact defect this covers. The
      // row would collide on the unique key and the new message would never be written at all.
      expect(mirroredItem).not.toBe(previous);
      expect(mirroredItem.content).toBe("the lost tool result");

      // The row must be keyed on an id. Mongo assigned none (the push was stripped), so one is
      // minted and written onto the item, so a later in-place mutation keys on the same value.
      expect(mirroredItem._id).toBeDefined();
      expect(String(mirroredItem._id)).toMatch(/^[0-9a-f]{24}$/);
    });

    it("still writes a row when the returned document carries an EMPTY history array", async () => {
      // The shape the forwarded-client-tool fixture uses. An empty array yields no `persisted` item,
      // so the fallback is the only candidate — the branch that used to write nothing.
      const pushed = makeItem({ tool_call_id: "call_chart_1", tool_name: "chart" });

      await mirror({ _id: conversationId, history: [] }, pushed);

      expect(appendMessage).toHaveBeenCalledTimes(1);
      expect(appendMessage.mock.calls[0][1]).toBe(pushed);
    });
  });

  describe("when the push landed (a brand-new document, exempt from the policy)", () => {
    it("prefers the persisted item, because Mongo's _id is not one we would have minted", async () => {
      const pushed = makeItem();
      // Mongo assigned its own _id to the item it stored; the in-memory copy has a different one.
      const persisted = { ...pushed, _id: new ObjectId() };

      await mirror({ _id: conversationId, history: [persisted] }, pushed);

      expect(appendMessage).toHaveBeenCalledTimes(1);
      const mirroredItem = appendMessage.mock.calls[0][1] as any;

      // The persisted item must win: mirroring the fallback would key the row on an id no document
      // carries, and the row would be unreconcilable with Mongo.
      expect(mirroredItem).toBe(persisted);
      expect(String(mirroredItem._id)).toBe(String(persisted._id));
    });
  });

  describe("when no fallback is supplied (only reachable through `any`)", () => {
    it("refuses to guess, and says which message was lost", async () => {
      // The type is `Record<string, any>` now, so a caller cannot pass `undefined` without a cast.
      // The behaviour is still asserted, because this is the regression: if someone widens the type
      // back, the row silently disappears again — and the warn is the only local evidence.
      const previous = makeItem({ content: "the previous message" });

      await mirror({ _id: conversationId, history: [previous] }, undefined as any);

      expect(appendMessage).not.toHaveBeenCalled();

      expect(sessionLog).toHaveBeenCalledTimes(1);
      const [level, message, meta] = sessionLog.mock.calls[0] as any[];

      expect(level).toBe("warn");
      expect(String(message)).toMatch(/nothing to mirror/i);
      // It must identify what was lost. The original warn reported the conversation only, which is a
      // large part of why this took a session-ending 400 to find.
      expect(String(message)).toMatch(/NOT persisted/);
      expect(meta.conversationId).toBe(conversationId);
      expect(meta.hasPersistedItem).toBe(true);

      // FAILS IF: it silently returns without logging, or writes a row keyed on a guess.
    });
  });

  describe("pass-through of the attribution", () => {
    it("forwards usage attribution so the row is not reported as an unattributed gap", async () => {
      const pushed = makeItem();
      const attribution = { providerId: "deepseek", modelId: "deepseek-flash" };

      await mirror({ _id: conversationId, history: [] }, pushed, attribution);

      expect(appendMessage.mock.calls[0][2]).toBe(attribution);
    });
  });
});
