import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";

/**
 * The cap-reset defect (W1), pinned.
 *
 * `setChatModelProvider` is the writer the model selector calls. It used to persist
 * `TOKEN_LIMITS.DEFAULT_MAX_TOKENS` (200 000) whenever the resolver missed, over a
 * real, larger budget. The client adopts whatever the server returns, so the cap
 * visibly collapsed to "200k" and every subsequent tool result was refused by the
 * conversation-budget guard.
 *
 * The limit now comes from the provider registry alone. `IAIPersona.maxTokens` is
 * deprecated, so the persona is **not** a fallback here either — an earlier revision
 * of this very change added it to match the other writers, in the wrong direction.
 */
describe("ReactorConversationService.setChatModelProvider - limits come from the registry only", () => {
  let service: any;
  let chatSessionId: string;

  const stubFindOne = (existing: any) =>
    jest.spyOn(ReactorConversationModel, "findOne").mockReturnValue({
      select: () => ({ lean: () => ({ exec: async () => existing }) }),
    } as any);

  const stubFindOneAndUpdate = (result: any = {}) =>
    jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockReturnValue({
      exec: async () => result,
    } as any);

  /** The `$set` document handed to Mongo by setChatModelProvider. */
  const setDocFrom = (spy: any) => spy.mock.calls[0][1].$set;

  /** A resolution as ReactorProviderService returns it. */
  const resolution = (value: number, source = "model-declared") => ({
    value,
    source,
    authoritative: source === "model-declared",
    providerId: "deepseek",
    modelId: "deepseek-flash",
  });

  beforeEach(() => {
    chatSessionId = new ObjectId().toString();
    service = Object.create(ReactorConversationService.prototype);
    service.context = {
      user: { _id: new ObjectId() },
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    service.sessionLog = jest.fn();
    service.resolveModelContextLength = jest.fn(async () => resolution(64000));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("REFUSES to overwrite a real 1M budget with an invented default when the lookup misses", async () => {
    stubFindOne({ providerId: "deepseek", personaId: "ReactorAIPersona", maxTokens: 1000000 });
    const update = stubFindOneAndUpdate({ _id: chatSessionId, maxTokens: 1000000 });
    service.resolveModelContextLength = jest.fn(async () =>
      resolution(200000, "builtin-default")
    );

    await service.setChatModelProvider(chatSessionId, "deepseek-flash", "deepseek");

    const set = setDocFrom(update);
    // The model/provider override still applies …
    expect(set.modelId).toBe("deepseek-flash");
    expect(set.providerId).toBe("deepseek");
    // … but the budget is NOT clobbered by a guess.
    expect(set.maxTokens).toBeUndefined();
  });

  it("applies the declared window for the incident's model — 64 000, not 200 000 and not 1 000 000", async () => {
    stubFindOne({ providerId: "deepseek", personaId: "ReactorAIPersona", maxTokens: 1000000 });
    const update = stubFindOneAndUpdate({});

    await service.setChatModelProvider(chatSessionId, "deepseek-flash", "deepseek");

    expect(setDocFrom(update).maxTokens).toBe(64000);
  });

  it("applies a genuine provider-declared downgrade", async () => {
    stubFindOne({ providerId: "anthropic", personaId: "ReactorAIPersona", maxTokens: 1000000 });
    const update = stubFindOneAndUpdate({});
    service.resolveModelContextLength = jest.fn(async () => resolution(200000));

    await service.setChatModelProvider(chatSessionId, "claude-haiku-4-5", "anthropic");

    expect(setDocFrom(update).maxTokens).toBe(200000);
  });

  it("does not consult the persona, and asks the registry exactly once", async () => {
    stubFindOne({ providerId: "deepseek", personaId: "SecuritySamAIPersona", maxTokens: 1000000 });
    stubFindOneAndUpdate({});

    await service.setChatModelProvider(chatSessionId, "deepseek-flash", "deepseek");

    expect(service.resolveModelContextLength).toHaveBeenCalledTimes(1);
    expect(service.resolveModelContextLength).toHaveBeenCalledWith("deepseek-flash", "deepseek");
    // No persona service is resolved for limits any more.
    expect(service.context.getService).toBeUndefined();
  });

  it("falls back to the stored provider when none is supplied (the effectiveProviderId path)", async () => {
    stubFindOne({ providerId: "deepseek", personaId: "ReactorAIPersona", maxTokens: 1000000 });
    stubFindOneAndUpdate({});

    await service.setChatModelProvider(chatSessionId, "deepseek-flash", undefined);

    expect(service.resolveModelContextLength).toHaveBeenCalledWith("deepseek-flash", "deepseek");
  });

  it("leaves the budget alone when nothing resolves", async () => {
    stubFindOne({ providerId: "deepseek", personaId: "ReactorAIPersona", maxTokens: 64000 });
    const update = stubFindOneAndUpdate({});
    service.resolveModelContextLength = jest.fn(async () => ({
      value: null,
      source: "unresolved",
      authoritative: false,
      providerId: "deepseek",
      modelId: "deepseek-flash",
    }));

    await service.setChatModelProvider(chatSessionId, "deepseek-flash", "deepseek");

    expect(setDocFrom(update).maxTokens).toBeUndefined();
  });

  it("still rejects a call with neither modelId nor providerId", async () => {
    await expect(
      service.setChatModelProvider(chatSessionId, undefined, undefined)
    ).rejects.toThrow(/At least one of modelId or providerId/);
  });
});
