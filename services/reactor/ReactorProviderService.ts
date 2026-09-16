import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import { IReactorProviderService, ReactorProviderAuthStatus, IModelContextLengthResolution } from "../../types/service.types";
import { loadProviders, ProviderConfig, ProviderModelConfig, getCompatibleModels, findModelById, findMissingContextLengths } from "../../ai/providers/provider-loader";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../utils/credential-encryption";
import { ReactorPostgresDataSource, ReactoryAiProvider, ReactoryAiModel, seedAiProviders } from "../../models";

const AUTH_KEY_PREFIX = "ai-provider:";

/**
 * The platform's last-resort context window, used only when a model declares no
 * `contextLength` in the registry and no `REACTORY_DEFAULT_CONTEXT_LENGTH` is
 * configured.
 *
 * This lives here — not in the conversation service — because the provider registry
 * is the single owner of model limits. Every use of it is logged at WARN: an
 * invented limit is not a measurement, and a silent invention is exactly how a
 * conversation ended up capped at a number that matched no model.
 */
export const DEFAULT_CONTEXT_LENGTH = 200000;

/**
 * Operator override for the last resort, in tokens. Set only if the platform
 * default is wrong for a deployment; it does NOT override a model's declared limit.
 */
const CONFIGURED_CONTEXT_LENGTH_ENV = "REACTORY_DEFAULT_CONTEXT_LENGTH";

export interface ResolvedCredentials {
  apiKey?: string;
  endpoint?: string;
  organization?: string;
  deploymentName?: string;
  apiVersion?: string;
  source: "session" | "user" | "app" | "persona" | "environment" | "none";
  [key: string]: any;
}

/**
 * Converts a database ReactoryAiProvider entity into a typed ProviderConfig.
 */
function entityToProviderConfig(entity: ReactoryAiProvider): ProviderConfig {
  const models: ProviderModelConfig[] = (entity.models || []).map((m) => ({
    id: m.modelKey,
    providerId: entity.id,
    name: m.name,
    version: m.version,
    capabilities: m.capabilities || [],
    contextLength: m.contextLength,
    costPerToken: m.costPerToken ? Number(m.costPerToken) : undefined,
    inputCostPerTokenUsdCents: m.inputCostPerTokenUsdCents ? Number(m.inputCostPerTokenUsdCents) : null,
    outputCostPerTokenUsdCents: m.outputCostPerTokenUsdCents ? Number(m.outputCostPerTokenUsdCents) : null,
    rpm: m.rpm,
    itpm: m.itpm,
    otpm: m.otpm,
    maxParallelRequests: m.maxParallelRequests,
    supportsStreaming: m.supportsStreaming,
    supportedTools: m.supportedTools,
    supportedMediaTypes: m.supportedMediaTypes,
    sampling: m.samplingConfig,
    thinking: m.thinkingConfig,
  }));

  return {
    id: entity.id,
    name: entity.name,
    endpointUrl: entity.endpointUrl,
    apiVersion: entity.apiVersion,
    models,
    defaultModel: entity.defaultModelId,
    capabilities: entity.capabilities || [],
    credentialRequirements: entity.credentialRequirements || [],
    credentialEnvVars: entity.credentialEnvVars,
    authComponentFqn: entity.authComponentFqn,
    roles: entity.roles || ['USER'],
    rateLimits: entity.rateLimits,
    status: {
      available: entity.status?.available ?? false,
      lastChecked: entity.status?.lastChecked ? new Date(entity.status.lastChecked) : new Date(),
      uptime: entity.status?.uptime ?? 99.9,
      responseTime: entity.status?.responseTime ?? 350,
      errorRate: entity.status?.errorRate ?? 0.1,
      quotaRemaining: entity.status?.quotaRemaining,
    },
  };
}

/**
 * Returns true if the override object contains at least one credential value.
 * Used to decide whether a per-request sessionOverride should take priority.
 */
function hasAnyCredential(override: Record<string, any>): boolean {
  return Object.values(override).some(
    (v) => v !== undefined && v !== null && v !== ""
  );
}

/**
 * Masks an API key for safe display, e.g. "sk-abcdef123456" -> "sk-…3456".
 * Returns undefined for empty input.
 */
function maskKey(key: string): string | undefined {
  if (!key || typeof key !== "string") return undefined;
  if (key.length <= 8) return "••••••••";
  const prefix = key.slice(0, key.indexOf("-") + 1 || 3);
  const tail = key.slice(-4);
  return `${prefix}…${tail}`;
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
  private dbLoaded: boolean = false;
  private loadPromise: Promise<void> | null = null;

  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
    this.initialize();
  }

  private initialize() {
    // Initial bootstrap from YAML (synchronous fallback)
    try {
      const providerConfigs = loadProviders();
      for (const config of providerConfigs) {
        this.providers.set(config.id, config);
      }
    } catch (err) {
      console.error('[ReactorProviderService] Failed to load providers.yaml:', (err as Error)?.message || err);
    }
    // Register response adapters for each provider type
    this.registerAdapters();

    // A model that consumes a context window but declares none will silently fall back
    // to an invented limit. Surface that at load time — it is a configuration gap, and
    // finding it here costs nothing, whereas discovering it from a refused tool call
    // costs an incident.
    this.reportMissingContextLengths(Array.from(this.providers.values()));

    // Async hydration from PostgreSQL if database is online
    this.ensureLoaded().catch((err) => {
      console.warn('[ReactorProviderService] Background DB hydration error:', err?.message || err);
    });
  }

  /**
   * Ensures provider definitions are hydrated from PostgreSQL when available.
   */
  private async ensureLoaded(force: boolean = false): Promise<void> {
    if (this.dbLoaded && !force) return;
    if (this.loadPromise && !force) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        if (ReactorPostgresDataSource.isInitialized) {
          const providerRepo = ReactorPostgresDataSource.getRepository(ReactoryAiProvider);
          const count = await providerRepo.count();
          if (count === 0) {
            await seedAiProviders(ReactorPostgresDataSource, false);
          }
          const entities = await providerRepo.find({
            relations: ['models'],
            order: { name: 'ASC' },
          });
          if (entities && entities.length > 0) {
            const newMap = new Map<string, ProviderConfig>();
            for (const entity of entities) {
              newMap.set(entity.id, entityToProviderConfig(entity));
            }
            this.providers = newMap;
            this.dbLoaded = true;
            return;
          }
        }
      } catch (err) {
        this.context?.warn?.(
          `[ReactorProviderService] Could not load from PostgreSQL, maintaining in-memory cache: ${(err as Error)?.message}`
        );
      }

      // Fallback: if not loaded from DB, ensure YAML providers exist in memory
      if (this.providers.size === 0) {
        try {
          const yamlConfigs = loadProviders();
          for (const config of yamlConfigs) {
            this.providers.set(config.id, config);
          }
        } catch (yamlErr) {
          console.error('[ReactorProviderService] Failed to load providers.yaml:', yamlErr);
        }
      }
    })();

    await this.loadPromise;
    this.loadPromise = null;
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
        if (response === null || response === undefined) {
          return {
            __typename: "ReactorErrorResponse",
            code: "PROVIDER_ERROR",
            message: "No response from Anthropic",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        if (response.error) {
          return {
            __typename: "ReactorErrorResponse",
            code: response.error.type || "PROVIDER_ERROR",
            message: response.error.message || "Unknown Anthropic error",
            timestamp: new Date(),
            recoverable: false,
          };
        }

        // Already normalized by processAIResponse — pass it through untouched.
        // Re-wrapping it here rebuilt the object from scratch and dropped
        // sessionId (declared `String!` in the schema), along with thinking,
        // images, tool_results and tool_errors. It also returned null for an
        // assistant turn that only made tool calls (empty content), which the
        // union resolver cannot type. Both surfaced to the client as a GraphQL
        // error at the very end of the turn, after the response had already
        // been streamed and persisted. The openai/google adapters have had
        // these passthrough guards all along; this one did not.
        if (response.__typename === "ReactorChatMessage") return response;

        if (response.role && response.content) {
          return { __typename: "ReactorChatMessage", ...response };
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
            sessionId: response.sessionId,
            id: response.id || Math.random().toString(36).substring(2, 15),
            role: "assistant",
            content: combinedContent,
            thinking: response.thinking || response.reasoning || response.__reasoning || undefined,
            images: response.images || response.__images || undefined,
            timestamp: new Date(),
            tool_calls: response.tool_calls || null,
          };
        }

        // AIChatCompletion shape (buildCompletion output) — reached when the
        // provider response has not been through processAIResponse yet.
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
    await this.ensureLoaded();
    return Array.from(this.providers.values());
  }

  async getProvider(providerId: string): Promise<ProviderConfig | undefined> {
    await this.ensureLoaded();
    const normalized = providerId?.toLowerCase();
    return this.providers.get(providerId) ?? this.providers.get(normalized);
  }

  async registerProvider(providerConfig: ProviderConfig): Promise<ProviderConfig> {
    this.providers.set(providerConfig.id, providerConfig);
    if (ReactorPostgresDataSource.isInitialized) {
      try {
        const repo = ReactorPostgresDataSource.getRepository(ReactoryAiProvider);
        let entity = await repo.findOne({ where: { id: providerConfig.id } });
        if (!entity) {
          entity = new ReactoryAiProvider();
          entity.id = providerConfig.id;
        }
        entity.name = providerConfig.name;
        entity.endpointUrl = providerConfig.endpointUrl;
        entity.apiVersion = providerConfig.apiVersion;
        entity.authComponentFqn = providerConfig.authComponentFqn;
        entity.defaultModelId = providerConfig.defaultModel;
        entity.capabilities = providerConfig.capabilities || [];
        entity.credentialRequirements = providerConfig.credentialRequirements || [];
        entity.credentialEnvVars = providerConfig.credentialEnvVars || {};
        entity.roles = providerConfig.roles || ['USER'];
        entity.rateLimits = providerConfig.rateLimits;
        entity.status = providerConfig.status;
        await repo.save(entity);
      } catch (err) {
        this.context?.warn?.(`[ReactorProviderService] registerProvider DB sync failed: ${(err as Error)?.message}`);
      }
    }
    return providerConfig;
  }

  async updateProviderStatus(providerId: string, status: Partial<ProviderConfig["status"]>): Promise<ProviderConfig> {
    const provider = await this.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }

    provider.status = {
      ...provider.status,
      ...status,
      lastChecked: new Date(),
    };

    this.providers.set(providerId, provider);

    if (ReactorPostgresDataSource.isInitialized) {
      try {
        const repo = ReactorPostgresDataSource.getRepository(ReactoryAiProvider);
        const entity = await repo.findOne({ where: { id: providerId } });
        if (entity) {
          entity.status = provider.status;
          await repo.save(entity);
        }
      } catch (err) {
        this.context?.warn?.(`[ReactorProviderService] updateProviderStatus DB sync failed: ${(err as Error)?.message}`);
      }
    }

    return provider;
  }

  /**
   * Create a new AI provider entity
   */
  async createProvider(input: any): Promise<ProviderConfig> {
    if (!input.id || !input.name) {
      throw new Error("Provider id and name are required");
    }
    const id = input.id.trim();
    if (ReactorPostgresDataSource.isInitialized) {
      const repo = ReactorPostgresDataSource.getRepository(ReactoryAiProvider);
      const existing = await repo.findOne({ where: { id } });
      if (existing) {
        throw new Error(`Provider with id '${id}' already exists`);
      }
      const entity = new ReactoryAiProvider();
      entity.id = id;
      entity.name = input.name;
      entity.description = input.description;
      entity.providerType = input.providerType || id.toLowerCase();
      entity.endpointUrl = input.endpointUrl;
      entity.apiVersion = input.apiVersion;
      entity.authComponentFqn = input.authComponentFqn;
      entity.defaultModelId = input.defaultModelId;
      entity.credentialRequirements = input.credentialRequirements || [];
      entity.credentialEnvVars = input.credentialEnvVars || {};
      entity.capabilities = input.capabilities || [];
      entity.roles = input.roles || ['USER'];
      entity.rateLimits = input.rateLimits;
      entity.status = input.status || {
        available: false,
        lastChecked: new Date(),
        uptime: 99.9,
        responseTime: 350,
        errorRate: 0.1,
      };
      entity.isEnabled = input.isEnabled !== false;
      entity.isSystem = false;
      entity.organizationId = input.organizationId;
      entity.createdBy = (this.context?.user as any)?._id?.toString?.();
      await repo.save(entity);
      await this.ensureLoaded(true);
      return (await this.getProvider(id)) as ProviderConfig;
    }

    const config: ProviderConfig = {
      id,
      name: input.name,
      endpointUrl: input.endpointUrl,
      apiVersion: input.apiVersion,
      authComponentFqn: input.authComponentFqn,
      defaultModel: input.defaultModelId,
      capabilities: input.capabilities || [],
      credentialRequirements: input.credentialRequirements || [],
      credentialEnvVars: input.credentialEnvVars || {},
      roles: input.roles || ['USER'],
      rateLimits: input.rateLimits,
      models: [],
      status: {
        available: false,
        lastChecked: new Date(),
        uptime: 99.9,
        responseTime: 350,
        errorRate: 0.1,
      },
    };
    this.providers.set(id, config);
    return config;
  }

  /**
   * Update an existing AI provider entity
   */
  async updateProvider(id: string, input: any): Promise<ProviderConfig> {
    if (ReactorPostgresDataSource.isInitialized) {
      const repo = ReactorPostgresDataSource.getRepository(ReactoryAiProvider);
      const entity = await repo.findOne({ where: { id }, relations: ['models'] });
      if (!entity) {
        throw new Error(`Provider '${id}' not found`);
      }
      if (input.name !== undefined) entity.name = input.name;
      if (input.description !== undefined) entity.description = input.description;
      if (input.providerType !== undefined) entity.providerType = input.providerType;
      if (input.endpointUrl !== undefined) entity.endpointUrl = input.endpointUrl;
      if (input.apiVersion !== undefined) entity.apiVersion = input.apiVersion;
      if (input.authComponentFqn !== undefined) entity.authComponentFqn = input.authComponentFqn;
      if (input.defaultModelId !== undefined) entity.defaultModelId = input.defaultModelId;
      if (input.credentialRequirements !== undefined) entity.credentialRequirements = input.credentialRequirements;
      if (input.credentialEnvVars !== undefined) entity.credentialEnvVars = input.credentialEnvVars;
      if (input.capabilities !== undefined) entity.capabilities = input.capabilities;
      if (input.roles !== undefined) entity.roles = input.roles;
      if (input.rateLimits !== undefined) entity.rateLimits = input.rateLimits;
      if (input.status !== undefined) entity.status = { ...entity.status, ...input.status };
      if (input.isEnabled !== undefined) entity.isEnabled = input.isEnabled;
      await repo.save(entity);
      await this.ensureLoaded(true);
      return (await this.getProvider(id)) as ProviderConfig;
    }

    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Provider '${id}' not found`);
    if (input.name !== undefined) provider.name = input.name;
    if (input.endpointUrl !== undefined) provider.endpointUrl = input.endpointUrl;
    if (input.apiVersion !== undefined) provider.apiVersion = input.apiVersion;
    if (input.authComponentFqn !== undefined) provider.authComponentFqn = input.authComponentFqn;
    if (input.defaultModelId !== undefined) provider.defaultModel = input.defaultModelId;
    if (input.capabilities !== undefined) provider.capabilities = input.capabilities;
    if (input.roles !== undefined) provider.roles = input.roles;
    if (input.rateLimits !== undefined) provider.rateLimits = input.rateLimits;
    return provider;
  }

  /**
   * Delete an AI provider entity and its models
   */
  async deleteProvider(id: string): Promise<boolean> {
    if (ReactorPostgresDataSource.isInitialized) {
      const repo = ReactorPostgresDataSource.getRepository(ReactoryAiProvider);
      const entity = await repo.findOne({ where: { id } });
      if (!entity) return false;
      await repo.remove(entity);
      await this.ensureLoaded(true);
      return true;
    }
    const existed = this.providers.delete(id);
    return existed;
  }

  /**
   * Create a new AI model entity
   */
  async createModel(input: any): Promise<ProviderModelConfig> {
    if (!input.providerId || !input.modelKey || !input.name) {
      throw new Error("providerId, modelKey, and name are required");
    }
    if (ReactorPostgresDataSource.isInitialized) {
      const modelRepo = ReactorPostgresDataSource.getRepository(ReactoryAiModel);
      const existing = await modelRepo.findOne({
        where: { providerId: input.providerId, modelKey: input.modelKey },
      });
      if (existing) {
        throw new Error(`Model '${input.modelKey}' already exists under provider '${input.providerId}'`);
      }
      const model = new ReactoryAiModel();
      model.providerId = input.providerId;
      model.modelKey = input.modelKey;
      model.name = input.name;
      model.version = input.version;
      model.contextLength = input.contextLength;
      model.maxOutputTokens = input.maxOutputTokens;
      model.capabilities = input.capabilities || [];
      model.supportsStreaming = input.supportsStreaming !== false;
      model.supportedTools = input.supportedTools || ['function-calling'];
      model.supportedMediaTypes = input.supportedMediaTypes || ['text'];
      model.inputCostPerTokenUsdCents = input.inputCostPerTokenUsdCents;
      model.outputCostPerTokenUsdCents = input.outputCostPerTokenUsdCents;
      model.costPerToken = input.costPerToken;
      model.rpm = input.rpm;
      model.itpm = input.itpm;
      model.otpm = input.otpm;
      model.maxParallelRequests = input.maxParallelRequests;
      model.samplingConfig = input.sampling;
      model.thinkingConfig = input.thinking;
      model.isEnabled = input.isEnabled !== false;
      model.sortOrder = input.sortOrder || 0;
      await modelRepo.save(model);
      await this.ensureLoaded(true);
      const provider = await this.getProvider(input.providerId);
      const found = provider?.models.find((m) => m.id === input.modelKey);
      if (found) return found;
    }

    const provider = this.providers.get(input.providerId);
    if (!provider) throw new Error(`Provider '${input.providerId}' not found`);
    const modelConfig: ProviderModelConfig = {
      id: input.modelKey,
      providerId: input.providerId,
      name: input.name,
      version: input.version,
      capabilities: input.capabilities || [],
      contextLength: input.contextLength,
      supportsStreaming: input.supportsStreaming !== false,
      supportedTools: input.supportedTools || ['function-calling'],
      supportedMediaTypes: input.supportedMediaTypes || ['text'],
      inputCostPerTokenUsdCents: input.inputCostPerTokenUsdCents,
      outputCostPerTokenUsdCents: input.outputCostPerTokenUsdCents,
      costPerToken: input.costPerToken,
      rpm: input.rpm,
      itpm: input.itpm,
      otpm: input.otpm,
      sampling: input.sampling,
      thinking: input.thinking,
    };
    provider.models.push(modelConfig);
    return modelConfig;
  }

  /**
   * Update an existing AI model entity
   */
  async updateModel(modelId: string, input: any): Promise<ProviderModelConfig> {
    if (ReactorPostgresDataSource.isInitialized) {
      const modelRepo = ReactorPostgresDataSource.getRepository(ReactoryAiModel);
      let model = await modelRepo.findOne({ where: { id: modelId } });
      if (!model && input.providerId) {
        model = await modelRepo.findOne({ where: { providerId: input.providerId, modelKey: modelId } });
      }
      if (!model) throw new Error(`Model '${modelId}' not found`);
      if (input.name !== undefined) model.name = input.name;
      if (input.version !== undefined) model.version = input.version;
      if (input.contextLength !== undefined) model.contextLength = input.contextLength;
      if (input.maxOutputTokens !== undefined) model.maxOutputTokens = input.maxOutputTokens;
      if (input.capabilities !== undefined) model.capabilities = input.capabilities;
      if (input.supportsStreaming !== undefined) model.supportsStreaming = input.supportsStreaming;
      if (input.supportedTools !== undefined) model.supportedTools = input.supportedTools;
      if (input.supportedMediaTypes !== undefined) model.supportedMediaTypes = input.supportedMediaTypes;
      if (input.inputCostPerTokenUsdCents !== undefined) model.inputCostPerTokenUsdCents = input.inputCostPerTokenUsdCents;
      if (input.outputCostPerTokenUsdCents !== undefined) model.outputCostPerTokenUsdCents = input.outputCostPerTokenUsdCents;
      if (input.costPerToken !== undefined) model.costPerToken = input.costPerToken;
      if (input.rpm !== undefined) model.rpm = input.rpm;
      if (input.itpm !== undefined) model.itpm = input.itpm;
      if (input.otpm !== undefined) model.otpm = input.otpm;
      if (input.sampling !== undefined) model.samplingConfig = input.sampling;
      if (input.thinking !== undefined) model.thinkingConfig = input.thinking;
      if (input.isEnabled !== undefined) model.isEnabled = input.isEnabled;
      if (input.sortOrder !== undefined) model.sortOrder = input.sortOrder;
      await modelRepo.save(model);
      await this.ensureLoaded(true);
      const provider = await this.getProvider(model.providerId);
      const found = provider?.models.find((m) => m.id === model?.modelKey);
      if (found) return found;
    }

    for (const provider of this.providers.values()) {
      const m = provider.models.find((mod) => mod.id === modelId);
      if (m) {
        if (input.name !== undefined) m.name = input.name;
        if (input.version !== undefined) m.version = input.version;
        if (input.contextLength !== undefined) m.contextLength = input.contextLength;
        if (input.capabilities !== undefined) m.capabilities = input.capabilities;
        if (input.supportsStreaming !== undefined) m.supportsStreaming = input.supportsStreaming;
        return m;
      }
    }
    throw new Error(`Model '${modelId}' not found`);
  }

  /**
   * Delete an AI model entity
   */
  async deleteModel(modelId: string): Promise<boolean> {
    if (ReactorPostgresDataSource.isInitialized) {
      const modelRepo = ReactorPostgresDataSource.getRepository(ReactoryAiModel);
      let model = await modelRepo.findOne({ where: { id: modelId } });
      if (!model) {
        model = await modelRepo.findOne({ where: { modelKey: modelId } });
      }
      if (!model) return false;
      await modelRepo.remove(model);
      await this.ensureLoaded(true);
      return true;
    }

    for (const provider of this.providers.values()) {
      const idx = provider.models.findIndex((m) => m.id === modelId);
      if (idx >= 0) {
        provider.models.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Test connection and credentials for an AI provider
   */
  async testProviderConnection(
    providerId: string,
    testModelId?: string
  ): Promise<{ success: boolean; latencyMs: number; message: string; details?: any }> {
    const start = Date.now();
    try {
      const provider = await this.getProvider(providerId);
      if (!provider) {
        return {
          success: false,
          latencyMs: 0,
          message: `Provider '${providerId}' not found`,
        };
      }

      const creds = await this.resolveProviderCredentials(providerId);
      if (creds.source === 'none' && !['ollama'].includes(providerId.toLowerCase())) {
        return {
          success: false,
          latencyMs: 0,
          message: `No credentials configured for provider '${providerId}' (source: none)`,
        };
      }

      const endpoint = creds.endpoint || provider.endpointUrl;
      if (!endpoint) {
        return {
          success: false,
          latencyMs: 0,
          message: `No endpoint URL configured for provider '${providerId}'`,
        };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {},
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const latencyMs = Date.now() - start;
        const isReachable = response.status < 500;
        const msg = isReachable
          ? `Provider '${providerId}' reached in ${latencyMs}ms (HTTP ${response.status})`
          : `Provider '${providerId}' returned HTTP ${response.status}`;

        await this.updateProviderStatus(providerId, {
          available: isReachable,
          responseTime: latencyMs,
          lastChecked: new Date(),
        });

        return {
          success: isReachable,
          latencyMs,
          message: msg,
          details: { status: response.status, statusText: response.statusText, source: creds.source },
        };
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const latencyMs = Date.now() - start;
        return {
          success: false,
          latencyMs,
          message: `Connection failed: ${(fetchErr as Error)?.message}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        latencyMs: Date.now() - start,
        message: `Error testing provider: ${(err as Error)?.message}`,
      };
    }
  }

  /**
   * Re-sync baseline providers from providers.yaml into PostgreSQL
   */
  async syncFromYaml(overwrite: boolean = false): Promise<{ providersCount: number; modelsCount: number }> {
    if (ReactorPostgresDataSource.isInitialized) {
      const stats = await seedAiProviders(ReactorPostgresDataSource, overwrite);
      await this.ensureLoaded(true);
      return stats;
    }
    const yamlProviders = loadProviders();
    this.providers.clear();
    for (const p of yamlProviders) {
      this.providers.set(p.id, p);
    }
    return {
      providersCount: yamlProviders.length,
      modelsCount: yamlProviders.reduce((acc, p) => acc + p.models.length, 0),
    };
  }

  async getAdapter(providerId: string): Promise<any> {
    // Adapters are registered under lowercase provider-type keys (e.g. "ollama").
    // Provider IDs from the registry may be cased differently (e.g. "Ollama"),
    // so normalize before lookup to avoid returning undefined.
    return this.adapters.get(providerId) ?? this.adapters.get(providerId?.toLowerCase());
  }

  /**
   * Provider types that have a wired structured-output implementation.
   * The OpenAI-compatible service also serves x-ai, copilot and azure-openai.
   */
  private static STRUCTURED_OUTPUT_PROVIDERS = new Set<string>([
    "openai",
    "xai",
    "x-ai",
    "copilot",
    "azure-openai",
    "google",
    "anthropic",
    "ollama",
  ]);

  /**
   * Whether the given provider/model can honour a structured-output request.
   *
   * - The provider must have a wired implementation (unwired providers such as
   *   amazon/cohere/deepseek return false — the request would fail at the SDK).
   * - A model may explicitly opt in by listing `structured-output` in its
   *   registry `capabilities`, or opt out with `no-structured-output`. Absent
   *   either flag, a wired provider defaults to supported (the SDKs support it
   *   broadly), matching the permissive default used for function calling.
   */
  async modelSupportsStructuredOutput(
    providerId: string,
    modelId?: string,
  ): Promise<boolean> {
    const normalized = (providerId || "").toLowerCase();
    if (!ReactorProviderService.STRUCTURED_OUTPUT_PROVIDERS.has(normalized)) {
      return false;
    }
    if (!modelId) return true;
    try {
      const provider = await this.getProvider(normalized);
      const model = provider?.models?.find((m) => m.id === modelId);
      const caps = model?.capabilities;
      if (caps?.includes("no-structured-output")) return false;
      if (caps?.includes("structured-output")) return true;
      return true; // wired provider default
    } catch {
      // Registry lookup failure should not block a wired provider.
      return true;
    }
  }

  /**
   * Log models that consume a context window but declare none. Non-fatal by design:
   * an incomplete registry must not stop the platform from booting.
   */
  private reportMissingContextLengths(providers: ProviderConfig[]): void {
    try {
      const gaps = findMissingContextLengths(providers);
      if (gaps.length === 0) return;

      const summary = gaps
        .slice(0, 20)
        .map((g) => `${g.providerId}/${g.modelId}`)
        .join(", ");

      const message =
        `[ReactorProviderService] ${gaps.length} model(s) consume a context window but declare no contextLength ` +
        `and will fall back to an invented limit: ${summary}${gaps.length > 20 ? ", …" : ""}. ` +
        `Declare contextLength in providers.yaml.`;

      if (typeof this.context?.warn === "function") {
        this.context.warn(message, { gaps });
      } else {
        console.warn(message);
      }
    } catch {
      // A validation pass must never break provider loading.
    }
  }

  /**
   * Resolve the context-window limit for a model from the provider registry.
   *
   * Scope is deliberately one provider: a model id found under a *different* provider
   * must never lend its limit to a conversation served elsewhere. The previous
   * implementation scanned every provider and returned the first match, which is how
   * a `deepseek-flash` conversation (declared 64 000) could be reported as having a
   * 1 000 000 window taken from an unrelated vendor's model of the same name.
   */
  async resolveModelContextLength(
    modelId?: string,
    providerId?: string
  ): Promise<IModelContextLengthResolution> {
    await this.ensureLoaded();

    const requestedModelId = modelId ? String(modelId).trim() : null;
    const requestedProviderId = providerId ? String(providerId).trim().toLowerCase() : null;

    const unresolved = (
      source: IModelContextLengthResolution["source"],
      value: number | null
    ): IModelContextLengthResolution => ({
      value,
      source,
      authoritative: false,
      providerId: requestedProviderId,
      modelId: requestedModelId,
    });

    if (requestedModelId && requestedProviderId) {
      const provider = await this.getProvider(requestedProviderId);

      if (provider) {
        const model = provider.models?.find((m) => m.id === requestedModelId);

        if (model?.contextLength && model.contextLength > 0) {
          this.context?.debug?.(
            `[ReactorProviderService] context window resolved from registry: ${requestedProviderId}/${requestedModelId} = ${model.contextLength}`,
            { providerId: requestedProviderId, modelId: requestedModelId, source: "model-declared" }
          );
          return {
            value: model.contextLength,
            source: "model-declared",
            authoritative: true,
            providerId: provider.id ?? requestedProviderId,
            modelId: requestedModelId,
          };
        }

        // Found the provider, but the model is absent or declares no contextLength.
        // Both are configuration gaps, not evidence about the window size.
        this.context?.warn?.(
          `[ReactorProviderService] model ${requestedModelId} under provider ${requestedProviderId} ` +
            (model
              ? "declares no contextLength in the provider registry"
              : "was not found in the provider registry") +
            `; using a fallback context window. Declare contextLength in providers.yaml for the model.`,
          { providerId: requestedProviderId, modelId: requestedModelId, modelFound: !!model }
        );
      } else {
        this.context?.warn?.(
          `[ReactorProviderService] provider ${requestedProviderId} is not in the registry; cannot resolve a context window for ${requestedModelId}`,
          { providerId: requestedProviderId, modelId: requestedModelId }
        );
      }
    } else {
      this.context?.warn?.(
        "[ReactorProviderService] resolveModelContextLength called without both a model and a provider; " +
          "a limit cannot be resolved authoritatively.",
        { providerId: requestedProviderId, modelId: requestedModelId }
      );
    }

    // Nothing declared. Use the operator's default if configured, else the platform one.
    const configured = Number(process.env[CONFIGURED_CONTEXT_LENGTH_ENV]);
    if (Number.isFinite(configured) && configured > 0) {
      return unresolved("configured-default", configured);
    }

    return unresolved("builtin-default", DEFAULT_CONTEXT_LENGTH);
  }

  /**
   * Returns the auth status for each provider for the current user, plus a
   * non-secret echo (endpoint, organization, maskedKeyHint) for providers the
   * user has configured. The echo is derived server-side via
   * redactCredentials(decrypt(...)) so the raw key never reaches the client.
   */
  async getUserProviderAuth(): Promise<ReactorProviderAuthStatus[]> {
    const providers = await this.getProviders();
    const user = this.context.user as any;
    const userAuths: any[] = user?.authentications || [];
    const partner = this.context.partner;
    const appAuthConfigs: any[] = (partner as any)?.auth_config || [];

    return providers.map((provider) => {
      const authKey = `${AUTH_KEY_PREFIX}${provider.id}`;
      const userAuth = userAuths.find((a: any) => a.provider === authKey);
      const appAuth = appAuthConfigs.find((a: any) => a.provider === authKey);

      let endpoint: string | undefined;
      let organization: string | undefined;
      let maskedKeyHint: string | undefined;

      if (userAuth?.props) {
        try {
          const propsObj = userAuth.props.toObject ? userAuth.props.toObject() : userAuth.props;
          const decrypted = decryptCredentials(propsObj);
          const { isDefault: _isDefault, ...creds } = decrypted;
          void _isDefault;
          endpoint = creds.endpoint;
          organization = creds.organization;
          maskedKeyHint = creds.apiKey ? maskKey(creds.apiKey) : undefined;
        } catch (err) {
          this.context.error?.(`Failed to decrypt user credentials for ${provider.id}`, err);
        }
      }

      const isDefault = !!(userAuth?.props?.isDefault === true);
      const isAppDefault = !!appAuth?.enabled;

      return {
        provider: provider.id,
        configured: !!userAuth,
        isDefault,
        isAppDefault,
        source: userAuth
          ? "user"
          : appAuth?.enabled
            ? "app"
            : provider.status?.available
              ? "environment"
              : "none",
        endpoint,
        organization,
        maskedKeyHint,
      };
    });
  }

  /**
   * Saves provider auth credentials for the current user. Encrypts sensitive
   * values, writes to user.authentications[ai-provider:<id>], and — when
   * setAsAccountDefault is true — clears isDefault on every other ai-provider:*
   * auth the user holds so only one provider is flagged as default at a time.
   * When setAsAppDefault is true (ADMIN only), updates partner.auth_config.
   */
  async saveProviderAuth(input: {
    providerId: string;
    credentials: Record<string, any>;
    setAsAccountDefault?: boolean;
    setAsAppDefault?: boolean;
  }): Promise<ReactorProviderAuthStatus> {
    const { providerId, credentials, setAsAccountDefault = true, setAsAppDefault = false } = input;
    const authKey = `${AUTH_KEY_PREFIX}${providerId}`;
    const user = this.context.user as any;

    const encrypted = encryptCredentials(credentials);
    if (setAsAccountDefault !== undefined) {
      encrypted.isDefault = setAsAccountDefault === true;
    }

    // Clear isDefault on every other ai-provider:* auth the user holds so only
    // one provider can be the user's default at a time.
    if (setAsAccountDefault === true && Array.isArray(user?.authentications)) {
      let mutated = false;
      for (const auth of user.authentications) {
        if (auth.provider?.startsWith?.(AUTH_KEY_PREFIX) && auth.provider !== authKey) {
          if (auth.props?.isDefault === true) {
            auth.props = { ...(auth.props.toObject ? auth.props.toObject() : auth.props), isDefault: false };
            mutated = true;
          }
        }
      }
      if (mutated) {
        await user.save();
      }
    }

    await user.setAuthentication({
      provider: authKey,
      props: encrypted,
      lastLogin: new Date(),
    });

    if (setAsAppDefault) {
      const isAdmin = this.context.hasRole?.("ADMIN") ?? false;
      if (!isAdmin) {
        throw new Error("Only ADMIN users can set app-level provider defaults");
      }

      const partner = this.context.partner as any;
      if (partner) {
        const existingConfigs: any[] = partner.auth_config || [];
        const existingIdx = existingConfigs.findIndex((c: any) => c.provider === authKey);
        const authConfigEntry = {
          provider: authKey,
          enabled: true,
          properties: encrypted,
        };
        if (existingIdx >= 0) {
          existingConfigs[existingIdx] = authConfigEntry;
        } else {
          existingConfigs.push(authConfigEntry);
        }
        partner.auth_config = existingConfigs;
        await partner.save();
      }
    }

    return {
      provider: providerId,
      configured: true,
      isDefault: setAsAccountDefault !== false,
      isAppDefault: setAsAppDefault === true,
      source: "user",
      endpoint: credentials.endpoint,
      organization: credentials.organization,
      maskedKeyHint: credentials.apiKey ? maskKey(credentials.apiKey) : undefined,
    };
  }

  /**
   * Removes provider auth credentials for the current user.
   */
  async removeProviderAuth(providerId: string): Promise<boolean> {
    const authKey = `${AUTH_KEY_PREFIX}${providerId}`;
    const user = this.context.user as any;
    await user.removeAuthentication(authKey);
    return true;
  }

  /**
   * Resolves provider credentials using priority:
   * sessionOverride > User > App > Persona config > Environment.
   * Decrypts any encrypted values before returning. The sessionOverride is a
   * per-request credential set supplied by the client (e.g. for a single chat
   * session); it is never persisted.
   */
  async resolveProviderCredentials(
    providerId: string,
    personaConfig?: Record<string, any>,
    sessionOverride?: Record<string, any>
  ): Promise<ResolvedCredentials> {
    // 0. Per-request session override (client-supplied, never persisted)
    if (sessionOverride && hasAnyCredential(sessionOverride)) {
      return { ...sessionOverride, source: "session" };
    }

    const authKey = `${AUTH_KEY_PREFIX}${providerId}`;
    const user = this.context.user;

    // 1. Check user-level auth
    const userAuths: any[] = (user as any)?.authentications || [];
    const userAuth = userAuths.find((a: any) => a.provider === authKey);
    if (userAuth?.props) {
      try {
        const decrypted = decryptCredentials(userAuth.props.toObject ? userAuth.props.toObject() : userAuth.props);
        const { isDefault: _isDefault, ...creds } = decrypted;
        void _isDefault;
        return { ...creds, source: "user" };
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
