import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService, {
  didCompactionReduceTokens,
  resolveDelegationGrowthGuardMultiplier,
} from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";

/**
 * Creation-time context budget (ticket REACTORY-302016408/20261104/1630018038).
 *
 * Delegated (sub-agent) conversations were created with `maxTokens: null`, because
 * `maxTokens` was only ever written by `setChatModelProvider`. A null limit is not
 * enforced: `checkTokenLimit` called it "unlimited" while four consumers substituted
 * `TOKEN_LIMITS.DEFAULT_MAX_TOKENS` (200 000). The run therefore grew until the
 * provider's hard ceiling killed it — 203 485 and 271 810 tokens against a model
 * declaring 1 000 000.
 *
 * These tests pin the two halves of the contract:
 *   - a missing limit is resolved from the provider registry (and persisted), never
 *     reported as "unlimited"; and
 *   - governance helpers that decide whether a reduction actually happened.
 */
describe("ReactorConversationService - creation-time context budget", () => {
  let service: any;
  let conversationId: string;

  const resolution = (
    value: number | null,
    source: "model-declared" | "configured-default" | "builtin-default" | "unresolved",
  ) => ({
    value,
    source,
    authoritative: source === "model-declared",
    providerId: "deepseek",
    modelId: "deepseek-flash",
  });

  /** A mongoose-like query whose terminal call is `.exec()`. */
  const execable = (doc: any) => ({ exec: async () => doc });

  beforeEach(() => {
    conversationId = new ObjectId().toString();
    service = Object.create(ReactorConversationService.prototype);
    service.context = {
      user: { _id: new ObjectId() },
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    service.sessionLog = jest.fn();
    service.resolveModelContextLength = jest.fn(async () => resolution(1000000, "model-declared"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("resolveConversationBudget", () => {
    it("returns the model's declared window and does not warn", async () => {
      const budget = await service.resolveConversationBudget({
        conversationId,
        modelId: "deepseek-flash",
        providerId: "deepseek",
      });

      expect(budget).toEqual({
        maxTokens: 1000000,
        source: "model-declared",
        authoritative: true,
      });
      expect(service.sessionLog).not.toHaveBeenCalledWith(
        "warn",
        expect.anything(),
        expect.anything(),
        conversationId,
      );
    });

    it("WARNs with conversation, model and provider when the window is only a fallback", async () => {
      service.resolveModelContextLength = jest.fn(async () => resolution(200000, "builtin-default"));

      const budget = await service.resolveConversationBudget({
        conversationId,
        modelId: "unknown-model",
        providerId: "deepseek",
      });

      expect(budget.maxTokens).toBe(200000);
      expect(budget.authoritative).toBe(false);

      const warn = service.sessionLog.mock.calls.find((call: any[]) => call[0] === "warn");
      expect(warn).toBeDefined();
      expect(warn[2]).toMatchObject({
        conversationId,
        modelId: "unknown-model",
        providerId: "deepseek",
        source: "builtin-default",
      });
    });

    it("applies the documented conservative limit — and logs it — when nothing resolves at all", async () => {
      service.resolveModelContextLength = jest.fn(async () => resolution(null, "unresolved"));

      const budget = await service.resolveConversationBudget({
        conversationId,
        modelId: "deepseek-flash",
        providerId: "deepseek",
      });

      // The fallback is permitted, but never silently: the WARN names the identity of
      // the model that could not be measured.
      expect(budget.maxTokens).toBe(200000);
      expect(budget.source).toBe("unresolved");
      expect(budget.authoritative).toBe(false);

      const warn = service.sessionLog.mock.calls.find((call: any[]) => call[0] === "warn");
      expect(warn).toBeDefined();
      expect(warn[2]).toMatchObject({
        conversationId,
        modelId: "deepseek-flash",
        providerId: "deepseek",
        source: "unresolved",
      });
    });

    it("always returns a positive number, even for a zero/negative resolution", async () => {
      service.resolveModelContextLength = jest.fn(async () => resolution(0, "model-declared"));

      const budget = await service.resolveConversationBudget({
        conversationId,
        modelId: "deepseek-flash",
        providerId: "deepseek",
      });

      expect(budget.maxTokens).toBeGreaterThan(0);
    });
  });

  describe("checkTokenLimit - consistent with the fallback consumers", () => {
    const stubConversation = (doc: any) =>
      jest.spyOn(ReactorConversationModel, "findOne").mockReturnValue({
        populate: () => ({ exec: async () => doc }),
      } as any);

    it("backfills a null limit from the registry instead of answering 'unlimited'", async () => {
      stubConversation({
        _id: conversationId,
        tokenCount: 271810,
        maxTokens: null,
        modelId: "deepseek-flash",
        providerId: "deepseek",
      });
      const update = jest
        .spyOn(ReactorConversationModel, "findOneAndUpdate")
        .mockReturnValue(execable({}) as any);
      service.validateConversationDocument = jest.fn();

      const result = await service.checkTokenLimit(conversationId);

      // The model declares 1 000 000, so 271 810 is under budget — but it is judged
      // against 1 000 000, not against "no limit" and not against 200 000.
      expect(result.maxTokens).toBe(1000000);
      expect(result.currentTokens).toBe(271810);
      expect(result.exceedsLimit).toBe(false);
      expect(result.shouldTruncate).toBe(false);

      // The backfill is persisted so every consumer agrees with this answer.
      const persisted = update.mock.calls[0][1] as any;
      expect(persisted.$set.maxTokens).toBe(1000000);
    });

    it("reports truncation against the backfilled limit", async () => {
      stubConversation({
        _id: conversationId,
        tokenCount: 1300000, // 130% of the declared 1 000 000 → past the 120% threshold
        maxTokens: null,
        modelId: "deepseek-flash",
        providerId: "deepseek",
      });
      jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockReturnValue(execable({}) as any);
      service.validateConversationDocument = jest.fn();

      const result = await service.checkTokenLimit(conversationId);

      expect(result.maxTokens).toBe(1000000);
      expect(result.exceedsLimit).toBe(true);
      expect(result.shouldTruncate).toBe(true);
    });

    it("leaves an existing limit alone and does not re-resolve it", async () => {
      stubConversation({
        _id: conversationId,
        tokenCount: 10,
        maxTokens: 64000,
        modelId: "deepseek-flash",
        providerId: "deepseek",
      });
      const update = jest
        .spyOn(ReactorConversationModel, "findOneAndUpdate")
        .mockReturnValue(execable({}) as any);
      service.validateConversationDocument = jest.fn();

      const result = await service.checkTokenLimit(conversationId);

      expect(result.maxTokens).toBe(64000);
      expect(service.resolveModelContextLength).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe("didCompactionReduceTokens", () => {
    it("is false for a successful compaction that changed nothing", () => {
      // `compactConversationHistory` returns success:true for "nothing to archive"
      // and for "system messages exceed the target". The turn boundary used to read
      // that as a reduction and skip the truncation fallback.
      expect(
        didCompactionReduceTokens({ success: true, tokensBefore: 271810, tokensAfter: 271810 }),
      ).toBe(false);
    });

    it("is false for an unsuccessful compaction", () => {
      expect(
        didCompactionReduceTokens({ success: false, tokensBefore: 271810, tokensAfter: 271810 }),
      ).toBe(false);
      expect(didCompactionReduceTokens(null)).toBe(false);
    });

    it("is true only when the transcript actually shrank", () => {
      expect(
        didCompactionReduceTokens({ success: true, tokensBefore: 271810, tokensAfter: 130000 }),
      ).toBe(true);
    });
  });

  describe("resolveDelegationGrowthGuardMultiplier", () => {
    it("defaults to 1.5", () => {
      expect(resolveDelegationGrowthGuardMultiplier(undefined)).toBe(1.5);
      expect(resolveDelegationGrowthGuardMultiplier("")).toBe(1.5);
    });

    it("honours a configured multiple", () => {
      expect(resolveDelegationGrowthGuardMultiplier("2")).toBe(2);
    });

    it("falls back to the default rather than disabling the guard on garbage", () => {
      expect(resolveDelegationGrowthGuardMultiplier("not-a-number")).toBe(1.5);
      expect(resolveDelegationGrowthGuardMultiplier("0.5")).toBe(1.5);
    });
  });
});
