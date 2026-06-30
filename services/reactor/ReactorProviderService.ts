import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import { IReactorProviderService } from "../../types/service.types";
import { loadProviders, ProviderConfig, ProviderModelConfig, getCompatibleModels, findModelById } from "../../ai/providers/provider-loader";
import { decryptCredentials } from "../../utils/credential-encryption";

const AUTH_KEY_PREFIX = "ai-provider:";

export interface ResolvedCredentials {
  apiKey?: string;
  endpoint?: string;
  organization?: string;
  deploymentName?: string;
  apiVersion?: string;
  source: "user" | "app" | "persona" | "environment" | "none";
  [key: string]: any;
}

/**
 * Service for managing AI provider integrations.
 * Provider and model metadata is loaded from ai/providers/providers.yaml.
 * Response adapters remain code-based since they contain behavioral logic.
 */
@service({
  id: "reactor.ReactorProviderService@1.0.0",
  name: "Reactor Provider Service",
  nameSpace: "reactor",
  description: "Service for managing AI provider integrations and abstractions",
  serviceType: "ai",
})
class ReactorProviderService implements IReactorProviderService {
  context: Reactory.Server.IReactoryContext;
  private providers: Map<string, ProviderConfig> = new Map();
  private adapters: Map<string, any> = new Map();

  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
    this.initialize();
  }

  private initialize() {
    // Load providers from YAML (synchronous — loadProviders uses fs.readFileSync)
    try {
      const providerConfigs = loadProviders();
      for (const config of providerConfigs) {
        this.providers.set(config.id, config);
      }
    } catch (err) {
      // Log but don't crash — adapters still register and providers can be added dynamically
      console.error('[ReactorProviderService] Failed to load providers.yaml:', (err as Error)?.message || err);
    }
    // Register response adapters for each provider type
    this.registerAdapters();
  }

  /**
   * Registers response adapters for each known provider type.
   * Adapters contain behavioral logic (response parsing) and remain code-based.
   */
  private registerAdapters() {
    // OpenAI-compatible adapter (works for openai, xai — both use choices[] format)
    const openaiCompatibleAdapter = (providerName: string, streamEndpoint: string) => ({
      adaptResponse: (response: any): any => {
        if (response === null) {
          return {
            __typename: "ReactorErrorResponse",
            code: "PROVIDER_ERROR",
            message: `No response from ${providerName}`,
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.code || "PROVIDER_ERROR",
            message: response.error.message || `Unknown ${providerName} error`,
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.role && response.content) {
          return { __typename: "ReactorChatMessage", ...response };
        }

        if (response.choices && response.choices.length > 0) {
          const message = response.choices[0].message;
          return {
            __typename: "ReactorChatMessage",
            sessionId: response.sessionId,
            id: response.id,
            role: message.role,
            content: message.content,
            timestamp: new Date(),
            tool_calls: message.tool_calls || null,
          };
        }

        return null;
      },
      adaptStreamingResponse: (stream: any): any => ({
        __typename: "ReactorInitiateSSE",
        sessionId: stream.id || Math.random().toString(36).substring(2, 15),
        endpoint: streamEndpoint,
        token: stream.token,
        status: "ready",
        expiry: new Date(Date.now() + 3600 * 1000),
      }),
    });

    // Google adapter — handles Gemini response format
    const googleAdapter = {
      adaptResponse: (response: any): any => {
        if (response === null) {
          return {
            __typename: "ReactorErrorResponse",
            code: "PROVIDER_ERROR",
            message: "No response from Google",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.code || "PROVIDER_ERROR",
            message: response.error.message || "Unknown Google error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.__typename === "ReactorChatMessage") return response;

        if (response.role && response.content) {
          return { __typename: "ReactorChatMessage", ...response };
        }

        if (response.choices && response.choices.length > 0) {
          const message = response.choices[0].message;
          return {
            __typename: "ReactorChatMessage",
            sessionId: response.sessionId,
            id: response.id,
            role: message.role,
            content: message.content,
            timestamp: new Date(),
            tool_calls: message.tool_calls || null,
          };
        }

        return {
          __typename: "ReactorChatMessage",
          id: response?.id || Math.random().toString(36).substring(2, 15),
          role: "assistant",
          content: response?.text || response?.content,
          timestamp: new Date(),
          tool_calls: response?.tool_calls || null,
          tool_results: response?.tool_results || null,
        };
      },
      adaptStreamingResponse: (stream: any): any => ({
        __typename: "ReactorInitiateSSE",
        sessionId: stream.id || Math.random().toString(36).substring(2, 15),
        endpoint: "/api/reactor/stream/google",
        token: stream.token,
        status: "ready",
        expiry: new Date(Date.now() + 3600 * 1000),
      }),
    };

    // Amazon Bedrock adapter — uses results[] format
    const amazonAdapter = {
      adaptResponse: (response: any): any => {
        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.code || "PROVIDER_ERROR",
            message: response.error.message || "Unknown Amazon error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.results && response.results.length > 0) {
          const result = response.results[0];
          return {
            __typename: "ReactorChatMessage",
            id: response.responseId || Math.random().toString(36).substring(2, 15),
            role: "assistant",
            content: result.text || result.completion,
            timestamp: new Date(),
            tool_calls: result.toolUses || null,
          };
        }

        return null;
      },
      adaptStreamingResponse: (stream: any): any => ({
        __typename: "ReactorInitiateSSE",
        sessionId: stream.id || Math.random().toString(36).substring(2, 15),
        endpoint: "/api/reactor/stream/amazon",
        token: stream.token,
        status: "ready",
        expiry: new Date(Date.now() + 3600 * 1000),
      }),
    };

    // Anthropic adapter — handles content blocks
    const anthropicAdapter = {
      adaptResponse: (response: any): any => {
        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.type || "PROVIDER_ERROR",
            message: response.error.message || "Unknown Anthropic error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.content) {
          let combinedContent = "";
          if (Array.isArray(response.content)) {
            combinedContent = response.content
              .filter((block: any) => block.type === "text")
              .map((block: any) => block.text)
              .join("\n");
          } else {
            combinedContent = response.content;
          }

          return {
            __typename: "ReactorChatMessage",
            id: response.id || Math.random().toString(36).substring(2, 15),
            role: "assistant",
            content: combinedContent,
            timestamp: new Date(),
            tool_calls: response.tool_calls || null,
          };
        }

        return null;
      },
      adaptStreamingResponse: (stream: any): any => ({
        __typename: "ReactorInitiateSSE",
        sessionId: stream.id || Math.random().toString(36).substring(2, 15),
        endpoint: "/api/reactor/stream/anthropic",
        token: stream.token,
        status: "ready",
        expiry: new Date(Date.now() + 3600 * 1000),
      }),
    };

    // Cohere adapter — handles text/generations format
    const cohereAdapter = {
      adaptResponse: (response: any): any => {
        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.code || "PROVIDER_ERROR",
            message: response.error.message || "Unknown Cohere error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.text || response.generations) {
          const content =
            response.text ||
            (response.generations && response.generations[0]?.text) ||
            "";
          return {
            __typename: "ReactorChatMessage",
            id: response.id || Math.random().toString(36).substring(2, 15),
            role: "assistant",
            content,
            timestamp: new Date(),
            tool_calls: response.tool_calls || null,
          };
        }

        return null;
      },
      adaptStreamingResponse: (stream: any): any => ({
        __typename: "ReactorInitiateSSE",
        sessionId: stream.id || Math.random().toString(36).substring(2, 15),
        endpoint: "/api/reactor/stream/cohere",
        token: stream.token,
        status: "ready",
        expiry: new Date(Date.now() + 3600 * 1000),
      }),
    };

    // Map provider IDs to their adapters
    this.adapters.set("openai", openaiCompatibleAdapter("OpenAI", "/api/reactor/stream"));
    this.adapters.set("xai", openaiCompatibleAdapter("xAI", "/api/reactor/stream/xai"));
    this.adapters.set("ollama", openaiCompatibleAdapter("Ollama", "/api/reactor/stream/ollama"));
    this.adapters.set("copilot", openaiCompatibleAdapter("GitHub Copilot", "/api/reactor/stream/copilot"));
    this.adapters.set("azure-openai", openaiCompatibleAdapter("Azure OpenAI", "/api/reactor/stream/azure-openai"));
    this.adapters.set("llamacpp", openaiCompatibleAdapter("llama.cpp", "/api/reactor/stream/llamacpp"));
    this.adapters.set("vllm", openaiCompatibleAdapter("vLLM", "/api/reactor/stream/vllm"));
    this.adapters.set("deepseek", openaiCompatibleAdapter("DeepSeek", "/api/reactor/stream/deepseek"));
    this.adapters.set("google", googleAdapter);
    this.adapters.set("amazon", amazonAdapter);
    this.adapters.set("anthropic", anthropicAdapter);
    this.adapters.set("cohere", cohereAdapter);
  }

  /**
   * Returns compatible models for a persona based on its capabilities.
   * If no persona capabilities are specified, returns all available models.
   */
  async getModelsForPersona(
    personaCapabilities?: string[]
  ): Promise<{ provider: ProviderConfig; model: ProviderModelConfig }[]> {
    const allProviders = Array.from(this.providers.values());
    if (!personaCapabilities || personaCapabilities.length === 0) {
      // Return all models from all available providers
      const results: { provider: ProviderConfig; model: ProviderModelConfig }[] = [];
      for (const provider of allProviders) {
        if (!provider.status?.available) continue;
        for (const model of provider.models) {
          results.push({ provider, model });
        }
      }
      return results;
    }
    return getCompatibleModels(allProviders, personaCapabilities);
  }

  async getProviders(): Promise<ProviderConfig[]> {
    return Array.from(this.providers.values());
  }

  async getProvider(providerId: string): Promise<ProviderConfig | undefined> {
    return this.providers.get(providerId);
  }

  async registerProvider(providerConfig: ProviderConfig): Promise<ProviderConfig> {
    this.providers.set(providerConfig.id, providerConfig);
    return providerConfig;
  }

  async updateProviderStatus(providerId: string, status: Partial<ProviderConfig["status"]>): Promise<ProviderConfig> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }

    provider.status = {
      ...provider.status,
      ...status,
      lastChecked: new Date(),
    };

    this.providers.set(providerId, provider);
    return provider;
  }

  async getAdapter(providerId: string): Promise<any> {
    return this.adapters.get(providerId);
  }

  /**
   * Resolves provider credentials using priority: User > App > Persona config > Environment.
   * Decrypts any encrypted values before returning.
   */
  async resolveProviderCredentials(
    providerId: string,
    personaConfig?: Record<string, any>
  ): Promise<ResolvedCredentials> {
    const authKey = `${AUTH_KEY_PREFIX}${providerId}`;
    const user = this.context.user;

    // 1. Check user-level auth
    const userAuths: any[] = (user as any)?.authentications || [];
    const userAuth = userAuths.find((a: any) => a.provider === authKey);
    if (userAuth?.props) {
      try {
        const decrypted = decryptCredentials(userAuth.props.toObject ? userAuth.props.toObject() : userAuth.props);
        return { ...decrypted, source: "user" };
      } catch (err) {
        this.context.error?.(`Failed to decrypt user credentials for ${providerId}`, err);
      }
    }

    // 2. Check app-level (ReactoryClient) auth
    const partner = this.context.partner;
    const appConfigs: any[] = (partner as any)?.auth_config || [];
    const appAuth = appConfigs.find((a: any) => a.provider === authKey && a.enabled);
    if (appAuth?.properties) {
      try {
        const decrypted = decryptCredentials(
          appAuth.properties.toObject ? appAuth.properties.toObject() : appAuth.properties
        );
        return { ...decrypted, source: "app" };
      } catch (err) {
        this.context.error?.(`Failed to decrypt app credentials for ${providerId}`, err);
      }
    }

    // 3. Check persona config
    if (personaConfig) {
      const { apiKey, apiOrg, apiBaseURL } = personaConfig;
      if (apiKey) {
        return {
          apiKey,
          organization: apiOrg,
          endpoint: apiBaseURL,
          source: "persona",
        };
      }
    }

    // 4. Fall back to environment variables
    const provider = this.providers.get(providerId);
    if (provider?.credentialEnvVars) {
      const envCreds: Record<string, any> = {};
      let hasAny = false;
      for (const [key, envVar] of Object.entries(provider.credentialEnvVars)) {
        const val = process.env[envVar];
        if (val) {
          envCreds[key] = val;
          hasAny = true;
        }
      }
      if (hasAny) {
        return { ...envCreds, source: "environment" };
      }
    }

    return { source: "none" };
  }

  toString?(includeVersion?: boolean): string {
    return `ReactorProviderService${includeVersion ? "@1.0.0" : ""}`;
  }

  description?: string = "Service for managing AI provider integrations";
  tags?: string[] = ["ai", "llm", "provider"];
  nameSpace: string = "reactor";
  name: string = "Reactor Provider Service";
  version: string = "1.0.0";
}

export default ReactorProviderService;
