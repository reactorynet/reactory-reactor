import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import ReactorProviderService, { DEFAULT_CONTEXT_LENGTH } from "../ReactorProviderService";

/**
 * The provider registry is the single owner of model limits.
 *
 * `IAIPersona.maxTokens` is deprecated (`@deprecated Max tokens is determined by the
 * model and provider`), so this accessor is the only place a context window is
 * derived. Two properties matter and are pinned here:
 *
 *  1. **Scope is one provider.** A model id that exists under a *different* provider
 *     must never lend that provider's limit to a conversation served elsewhere. The
 *     previous implementation scanned every provider and returned the first match.
 *     That is how a `deepseek-flash` conversation — declared `contextLength: 64000` in
 *     `~/.reactor/providers.yaml` — could be recorded as having a 1,000,000 window
 *     borrowed from an unrelated vendor's model.
 *  2. **A miss is reported as a miss.** `contextLength` is optional per model, so the
 *     caller is told whether the number was declared or invented. An invented limit
 *     that looks measured is how a conversation sat at a cap matching no model.
 */
describe("ReactorProviderService.resolveModelContextLength", () => {
  let service: any;

  const providers = [
    {
      id: "deepseek",
      name: "DeepSeek",
      models: [{ id: "deepseek-flash", name: "DeepSeek Flash", contextLength: 64000 }],
      status: { available: true },
    },
    {
      id: "google",
      name: "Google Gemini",
      models: [
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextLength: 1048576 },
        // A model that exists here but declares no contextLength at all.
        { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
      ],
      status: { available: true },
    },
    {
      id: "anthropic",
      name: "Anthropic",
      models: [
        // Same id as the deepseek model in no way — but a *different* vendor's model
        // that the old cross-provider scan would happily match by name.
        { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
      ],
      status: { available: true },
    },
  ];

  beforeEach(() => {
    delete process.env.REACTORY_DEFAULT_CONTEXT_LENGTH;

    service = Object.create(ReactorProviderService.prototype);
    service.context = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    service.providers = new Map(providers.map((p) => [p.id, p]));
    // Pretend hydration already happened so ensureLoaded() early-returns.
    service.dbLoaded = true;
    service.loadPromise = null;
  });

  afterEach(() => {
    delete process.env.REACTORY_DEFAULT_CONTEXT_LENGTH;
  });

  it("returns the model's declared contextLength, marked authoritative", async () => {
    const result = await service.resolveModelContextLength("deepseek-flash", "deepseek");

    // The incident's true window. NOT 200000, and NOT 1000000.
    expect(result).toEqual({
      value: 64000,
      source: "model-declared",
      authoritative: true,
      providerId: "deepseek",
      modelId: "deepseek-flash",
    });
  });

  it("MUST NOT borrow another provider's limit for a model it does not serve", async () => {
    // `claude-sonnet-5` is served by anthropic (1000000). Asking about it *as if* it
    // were a deepseek model must not return anthropic's number.
    const result = await service.resolveModelContextLength("claude-sonnet-5", "deepseek");

    expect(result.authoritative).toBe(false);
    expect(result.value).not.toBe(1000000);
    expect(result.source).toBe("builtin-default");
  });

  it("MUST NOT resolve a limit for a model that is not in the registry at all", async () => {
    const result = await service.resolveModelContextLength("grok-4.5", "deepseek");

    expect(result.authoritative).toBe(false);
    expect(result.source).toBe("builtin-default");
    expect(result.value).toBe(DEFAULT_CONTEXT_LENGTH);
  });

  it("reports a miss when the model is present but declares no contextLength", async () => {
    const result = await service.resolveModelContextLength("gemini-3.6-flash", "google");

    // Found, but nothing declared — the silently common case.
    expect(result.authoritative).toBe(false);
    expect(result.source).toBe("builtin-default");
  });

  it("is case-insensitive about the provider id", async () => {
    const result = await service.resolveModelContextLength("gemini-2.5-pro", "GOOGLE");

    expect(result.authoritative).toBe(true);
    expect(result.value).toBe(1048576);
  });

  it("reports a miss when the provider is not in the registry", async () => {
    const result = await service.resolveModelContextLength("deepseek-flash", "nonexistent");

    expect(result.authoritative).toBe(false);
    expect(result.source).toBe("builtin-default");
    expect(result.providerId).toBe("nonexistent");
  });

  it("cannot resolve authoritatively without a provider, and says so", async () => {
    // Guessing here is the cross-provider leak by another name.
    const result = await service.resolveModelContextLength("gemini-2.5-pro");

    expect(result.authoritative).toBe(false);
    expect(result.source).toBe("builtin-default");
  });

  it("uses the operator's configured default when the model declares nothing", async () => {
    process.env.REACTORY_DEFAULT_CONTEXT_LENGTH = "131072";

    const result = await service.resolveModelContextLength("gemini-3.6-flash", "google");

    expect(result).toEqual({
      value: 131072,
      source: "configured-default",
      authoritative: false,
      providerId: "google",
      modelId: "gemini-3.6-flash",
    });
  });

  it("prefers a declared limit over the configured default", async () => {
    process.env.REACTORY_DEFAULT_CONTEXT_LENGTH = "999";

    const result = await service.resolveModelContextLength("deepseek-flash", "deepseek");

    expect(result.value).toBe(64000);
    expect(result.source).toBe("model-declared");
  });

  it("ignores a non-numeric or non-positive configured default", async () => {
    process.env.REACTORY_DEFAULT_CONTEXT_LENGTH = "not-a-number";

    const result = await service.resolveModelContextLength("unknown-model", "deepseek");

    expect(result.source).toBe("builtin-default");
    expect(result.value).toBe(DEFAULT_CONTEXT_LENGTH);
  });

  it("never reports a zero or negative window as a declaration", async () => {
    service.providers.set("broken", {
      id: "broken",
      models: [{ id: "zero-window", contextLength: 0 }],
    });

    const result = await service.resolveModelContextLength("zero-window", "broken");

    expect(result.authoritative).toBe(false);
    expect(result.value).toBe(DEFAULT_CONTEXT_LENGTH);
  });
});
