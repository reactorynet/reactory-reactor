import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";

/**
 * Regression tests for the provider-resolution split brain.
 *
 * Background: `executeProviderChat` selects the provider *service* from the
 * `provider` argument, while `OpenAIService.initializeClient` derives the
 * *endpoint and credentials* from `persona.providerId`. When a client-tool
 * continuation (e.g. the `macros` tool) re-resolved the provider with an inline
 * `|| "openai"` fallback, a DeepSeek conversation ended up posting a Google key
 * to api.openai.com. These tests pin the single-source-of-truth behaviour.
 */
describe("ReactorConversationService - provider resolution", () => {
  let service: any;
  let mockContext: any;

  beforeEach(() => {
    mockContext = {
      getService: jest.fn(() => ({ getUserProviderAuth: jest.fn(async () => []) })),
      user: { _id: new ObjectId(), id: "u1" },
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    service = Object.create(ReactorConversationService.prototype);
    service.context = mockContext;
    service.sessionLog = jest.fn();
  });

  describe("resolveConversationProvider", () => {
    it("prefers an explicit override above everything else", async () => {
      const provider = await service.resolveConversationProvider(
        undefined,
        { providerId: "google" },
        "deepseek",
        "openai"
      );
      expect(provider).toBe("deepseek");
    });

    it("prefers the conversation's stored provider over the persona", async () => {
      const provider = await service.resolveConversationProvider(
        "sess_1",
        { providerId: "google" },
        undefined,
        "deepseek"
      );
      expect(provider).toBe("deepseek");
    });

    it("falls back to the persona provider when no conversation id is given", async () => {
      const provider = await service.resolveConversationProvider(undefined, {
        providerId: "Google",
      });
      expect(provider).toBe("google");
    });

    it("uses the configured default (the user's flagged provider) rather than an inline literal", async () => {
      mockContext.getService = jest.fn(() => ({
        getUserProviderAuth: jest.fn(async () => [
          { provider: "openai", isDefault: false },
          { provider: "deepseek", isDefault: true },
        ]),
      }));

      const provider = await service.resolveConversationProvider(undefined, {});
      expect(provider).toBe("deepseek");
    });

    it("honours REACTOR_DEFAULT_PROVIDER over the user default", async () => {
      const previous = process.env.REACTOR_DEFAULT_PROVIDER;
      process.env.REACTOR_DEFAULT_PROVIDER = "Ollama";
      try {
        const provider = await service.resolveConversationProvider(undefined, {});
        expect(provider).toBe("ollama");
      } finally {
        if (previous === undefined) delete process.env.REACTOR_DEFAULT_PROVIDER;
        else process.env.REACTOR_DEFAULT_PROVIDER = previous;
      }
    });
  });

  describe("resolveRoutedPersona", () => {
    it("leaves the persona untouched when the routed provider already matches", async () => {
      const persona: any = { providerId: "deepseek", config: { apiKey: "ds-key" } };
      const result = await service.resolveRoutedPersona("DeepSeek", persona);
      expect(result).toBe(persona);
    });

    it("drops the foreign provider's credentials and re-resolves for the routed provider", async () => {
      service.providerService = {
        resolveProviderCredentials: jest.fn(async () => ({
          apiKey: "ds-key",
          endpoint: "https://api.deepseek.com/v1",
          source: "user",
        })),
      };

      const persona: any = {
        providerId: "google",
        config: {
          apiKey: "AIzaSy-google-key",
          apiBaseURL: "https://generativelanguage.googleapis.com",
          project: "my-gcp-project",
        },
      };

      const result = await service.resolveRoutedPersona("deepseek", persona);

      expect(result.providerId).toBe("deepseek");
      // The Google key / base URL must NOT survive into a DeepSeek request.
      expect(result.config.apiKey).toBe("ds-key");
      expect(result.config.apiBaseURL).toBe("https://api.deepseek.com/v1");
      expect(result.config.project).toBeUndefined();
      // The foreign config must NOT be forwarded: the credential resolver's
      // `persona` rung is provider-agnostic and would hand the Google key back
      // for a DeepSeek request (the client-tool mis-route).
      expect(service.providerService.resolveProviderCredentials).toHaveBeenCalledWith(
        "deepseek"
      );
      // The original persona object must not be mutated.
      expect(persona.providerId).toBe("google");
      expect(persona.config.apiKey).toBe("AIzaSy-google-key");
    });

    it("does not forward a foreign provider's config to the credential resolver", async () => {
      const resolveProviderCredentials = jest.fn(async () => ({
        apiKey: "ds-key",
        endpoint: "https://api.deepseek.com/v1",
        source: "user" as const,
      }));
      service.providerService = { resolveProviderCredentials };

      const persona: any = {
        providerId: "google",
        config: {
          apiKey: "AIzaSy-google-key",
          apiBaseURL: "https://generativelanguage.googleapis.com",
        },
      };

      const result = await service.resolveRoutedPersona("deepseek", persona);

      // Called for the routed provider only — never with the foreign config.
      expect(resolveProviderCredentials).toHaveBeenCalledWith("deepseek");
      expect((resolveProviderCredentials as any).mock.calls[0][1]).toBeUndefined();
      // The routed credential wins; the Google key never survives.
      expect(result.config.apiKey).toBe("ds-key");
      expect(result.config.apiKey).not.toBe("AIzaSy-google-key");
      expect(result.config.apiBaseURL).toBe("https://api.deepseek.com/v1");
    });

    it("never adopts a persona-sourced credential for a routed provider", async () => {
      service.providerService = {
        resolveProviderCredentials: jest.fn(async () => ({
          source: "persona" as const,
          apiKey: "AIzaSy-google-key",
          endpoint: "https://generativelanguage.googleapis.com",
        })),
      };

      const persona: any = {
        providerId: "google",
        config: { apiKey: "AIzaSy-google-key" },
      };

      const result = await service.resolveRoutedPersona("deepseek", persona);

      // Regression: a DeepSeek conversation with a Google persona key used to
      // send the Google key to DeepSeek and fail with a 401.
      expect(result.providerId).toBe("deepseek");
      expect(result.config.apiKey).toBeUndefined();
      expect(result.config.apiBaseURL).toBeUndefined();
    });

    it("keeps the persona's own credentials when the routed provider is the same", async () => {
      service.providerService = { resolveProviderCredentials: jest.fn() };
      const persona: any = { providerId: "deepseek", config: { apiKey: "ds-own-key" } };

      const result = await service.resolveRoutedPersona("deepseek", persona);

      expect(result.config.apiKey).toBe("ds-own-key");
      expect(service.providerService.resolveProviderCredentials).not.toHaveBeenCalled();
    });
  });
});
