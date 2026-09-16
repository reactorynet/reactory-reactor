import { describe, it, expect, beforeEach } from "@jest/globals";
import ReactorConversationService from "../ReactorConversationService";

/**
 * The conversation service must not own model limits.
 *
 * `IAIPersona.maxTokens` is deprecated — "Max tokens is determined by the model and
 * provider" — so the conversation service **delegates** to
 * `ReactorProviderService.resolveModelContextLength` and consults no other source.
 *
 * Two regressions this pins:
 *
 *  - The old resolver read `provider.models[]` itself *and* fell back to the persona.
 *    Both are gone: the registry is asked, and only the registry answers.
 *  - The old resolver scanned **every** provider for a matching model id. That is how
 *    a `deepseek-flash` conversation (declared 64 000) was recorded at 1 000 000 —
 *    a value borrowed from an unrelated vendor's model. Scoping is now the provider
 *    service's job and is asserted in `ReactorProviderService.contextLength.test.ts`.
 */
describe("ReactorConversationService.resolveModelContextLength - delegation only", () => {
  let service: any;
  let providerService: any;

  beforeEach(() => {
    providerService = {
      resolveModelContextLength: jest.fn(async () => ({
        value: 64000,
        source: "model-declared",
        authoritative: true,
        providerId: "deepseek",
        modelId: "deepseek-flash",
      })),
    };

    service = Object.create(ReactorConversationService.prototype);
    service.context = {
      getService: jest.fn().mockReturnValue(providerService),
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    service.providerService = providerService;
    service.sessionLog = jest.fn();
  });

  it("asks the provider service, with the model and the provider", async () => {
    const result = await service.resolveModelContextLength("deepseek-flash", "deepseek");

    expect(providerService.resolveModelContextLength).toHaveBeenCalledWith(
      "deepseek-flash",
      "deepseek"
    );
    // The incident's true window, surfaced as authoritative.
    expect(result.value).toBe(64000);
    expect(result.authoritative).toBe(true);
  });

  it("passes the resolution through unchanged, including source and provider", async () => {
    const expected = {
      value: 131072,
      source: "configured-default",
      authoritative: false,
      providerId: "ollama",
      modelId: "qwen3.5",
    };
    providerService.resolveModelContextLength = jest.fn(async () => expected);

    await expect(service.resolveModelContextLength("qwen3.5", "ollama")).resolves.toEqual(
      expected
    );
  });

  it("reports UNRESOLVED rather than inventing a limit when there is no provider service", async () => {
    // A second place that invents a number would be indistinguishable from a measured
    // one — which is the whole defect class. Refuse to answer instead.
    service.providerService = null;
    service.context.getService = jest.fn(() => {
      throw new Error("service registry unavailable");
    });

    const result = await service.resolveModelContextLength("deepseek-flash", "deepseek");

    expect(result).toEqual({
      value: null,
      source: "unresolved",
      authoritative: false,
      providerId: "deepseek",
      modelId: "deepseek-flash",
    });
  });

  it("reports UNRESOLVED when the provider service throws, instead of failing the call", async () => {
    providerService.resolveModelContextLength = jest.fn(async () => {
      throw new Error("registry read failed");
    });

    const result = await service.resolveModelContextLength("deepseek-flash", "deepseek");

    expect(result.value).toBeNull();
    expect(result.authoritative).toBe(false);
  });

  it("does not consult the persona — the persona carries no limit any more", async () => {
    // If a persona were consulted, this would be the call site. There is no persona
    // parameter, and the provider service is asked exactly once with two arguments.
    await service.resolveModelContextLength("deepseek-flash", "deepseek");

    expect(providerService.resolveModelContextLength).toHaveBeenCalledTimes(1);
    expect(providerService.resolveModelContextLength.mock.calls[0]).toHaveLength(2);
  });
});
