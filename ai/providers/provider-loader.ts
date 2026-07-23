import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Declares which sampling parameters a model accepts. Newer models (e.g. the
 * Anthropic Opus 4.7+/Sonnet 5/Fable 5 family) have removed `temperature`,
 * `top_p`, and `top_k` and return a 400 if any are sent. When a sub-field is
 * omitted the parameter is treated as supported (legacy default), so only
 * models that reject a parameter need to declare it `false`.
 */
export interface ModelSamplingSupport {
  temperature?: boolean;
  topP?: boolean;
  topK?: boolean;
}

/**
 * How a model exposes extended/adaptive thinking.
 * - `adaptive`: send `thinking: {type: "adaptive"}` and control depth via
 *   `output_config.effort`. `budget_tokens` is rejected (400). Used by the
 *   Anthropic Opus 4.6+/Sonnet 4.6+/Fable 5 family.
 * - `budget`: legacy extended thinking — `thinking: {type: "enabled", budget_tokens: N}`
 *   with N < max_tokens. Used by older models (Sonnet 4.5, 3.7 Sonnet, …).
 * - `none`: the model does not support (or should not use) thinking.
 */
export type ModelThinkingMode = "adaptive" | "budget" | "none";

/**
 * Per-model thinking capability. `mode` selects the request shape; `effort`
 * and `display` apply only to `adaptive` mode. Absent → `mode: "none"`.
 */
export interface ModelThinkingSupport {
  mode?: ModelThinkingMode;
  /** Adaptive only: thinking depth / token spend. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Adaptive only: `summarized` returns readable reasoning; API default is `omitted` (empty). */
  display?: "summarized" | "omitted";
}

export interface ProviderModelConfig {
  id: string;
  providerId?: string;
  name: string;
  version?: string;
  capabilities: string[];
  contextLength?: number;
  costPerToken?: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  inputCostPerTokenUsdCents?: number | null;
  outputCostPerTokenUsdCents?: number | null;
  rpm?: number | null;
  itpm?: number | null;
  otpm?: number | null;
  maxParallelRequests?: number;
  supportsStreaming?: boolean;
  supportedTools?: string[];
  supportedMediaTypes?: string[];
  /**
   * Per-model sampling capability overrides. Absent → all sampling params
   * supported. See {@link resolveSamplingSupport} for how this is read.
   */
  sampling?: ModelSamplingSupport;
  /**
   * Per-model thinking capability. Absent → `mode: "none"`.
   * See {@link resolveThinkingSupport} for how this is read.
   */
  thinking?: ModelThinkingSupport;
}

export interface ProviderStatusConfig {
  available: boolean;
  lastChecked: Date;
  uptime: number;
  responseTime: number;
  errorRate: number;
  quotaRemaining?: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  endpointUrl?: string;
  apiVersion?: string;
  models: ProviderModelConfig[];
  defaultModel?: string;
  status: ProviderStatusConfig;
  capabilities: string[];
  credentialRequirements?: string[];
  credentialEnvVars?: Record<string, string>;
  authComponentFqn?: string;
  roles?: string[];
  rateLimits?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
    concurrentRequests?: number;
  };
}

interface ProviderYamlRoot {
  providers: ProviderYamlEntry[];
}

interface ProviderYamlEntry {
  id: string;
  name: string;
  endpointUrl?: string;
  apiVersion?: string;
  defaultModel?: string;
  capabilities?: string[];
  credentialRequirements?: string[];
  credentialEnvVars?: Record<string, string>;
  authComponentFqn?: string;
  roles?: string[];
  models?: ProviderModelConfig[];
}

/**
 * Interpolates environment variables in string values.
 * Supports ${VAR_NAME} and ${VAR_NAME:-default} syntax.
 */
function interpolateEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_match, envExpr: string) => {
      const [varName, defaultValue] = envExpr.split(':-');
      return process.env[varName.trim()] || defaultValue?.trim() || '';
    });
  }
  if (Array.isArray(value)) {
    return value.map(interpolateEnvVars);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateEnvVars(v);
    }
    return result;
  }
  return value;
}

/**
 * Determines provider availability based on configured credential env vars.
 */
function resolveAvailability(entry: ProviderYamlEntry): boolean {
  if (!entry.credentialEnvVars) return false;
  // Provider is available if at least one credential env var is set and non-empty
  return Object.values(entry.credentialEnvVars).some(
    envVar => !!process.env[envVar]?.trim()
  );
}

/**
 * Converts a raw YAML provider entry into a typed ProviderConfig.
 */
function toProviderConfig(entry: ProviderYamlEntry): ProviderConfig {
  const models: ProviderModelConfig[] = (entry.models || []).map(m => ({
    ...m,
    providerId: entry.id,
  }));

  return {
    id: entry.id,
    name: entry.name,
    endpointUrl: entry.endpointUrl,
    apiVersion: entry.apiVersion,
    models,
    defaultModel: entry.defaultModel,
    capabilities: entry.capabilities || [],
    credentialRequirements: entry.credentialRequirements || [],
    credentialEnvVars: entry.credentialEnvVars,
    authComponentFqn: entry.authComponentFqn,
    roles: entry?.roles || ['USER'], // default to adding user role if not specified
    // TODO: add realtime status checks for availability, uptime, response time, error rate, etc.
    status: {
      available: resolveAvailability(entry),
      lastChecked: new Date(),
      uptime: 99.9,
      responseTime: 350,
      errorRate: 0.1,
    },
  };
}

/**
 * Loads provider configs from the default providers.yaml file co-located
 * with this module, with environment variable interpolation.
 * Optionally loads user-specific providers from ~/.reactor/providers.yaml.
 */
export function loadProviders(yamlPath?: string): ProviderConfig[] {
  const defaultFilePath = yamlPath || path.join(__dirname, 'providers.yaml');
  const userFilePath = path.join(process.env.HOME || '/', '.reactor', 'providers.yaml');

  // Load default providers
  const defaultRaw = fs.readFileSync(defaultFilePath, 'utf8');
  const defaultInterpolated = interpolateEnvVars(yaml.load(defaultRaw)) as ProviderYamlRoot;

  // Load user providers if they exist
  let userProviders: ProviderYamlEntry[] = [];
  try {
    if (fs.existsSync(userFilePath)) {
      const userRaw = fs.readFileSync(userFilePath, 'utf8');
      const userInterpolated = interpolateEnvVars(yaml.load(userRaw)) as ProviderYamlRoot;
      userProviders = userInterpolated.providers || [];
    }
  } catch (error) {
    // If user file cannot be read, continue with just default providers
    console.info(`Info: User provider file does not exist ${userFilePath} - ${error}`);
  }

  // Combine default providers with user providers
  const allProviders = [...(defaultInterpolated.providers || []), ...userProviders];

  // Remove duplicates (user providers take precedence)
  const providerMap = new Map<string, ProviderYamlEntry>();
  allProviders.forEach(provider => {
    providerMap.set(provider.id, provider);
  });

  // Convert to ProviderConfig
  return Array.from(providerMap.values()).map(toProviderConfig);
}

/**
 * Returns an individual model's config by model ID, searching across providers.
 */
export function findModelById(
  providers: ProviderConfig[],
  modelId: string
): { provider: ProviderConfig; model: ProviderModelConfig } | null {
  for (const provider of providers) {
    const model = provider.models.find(m => m.id === modelId);
    if (model) return { provider, model };
  }
  return null;
}

/**
 * Returns all models from a given provider that are compatible with a set
 * of required capabilities. A model is compatible if its capabilities
 * include at least all of the required capabilities.
 */
export function getCompatibleModels(
  providers: ProviderConfig[],
  requiredCapabilities: string[]
): { provider: ProviderConfig; model: ProviderModelConfig }[] {
  const results: { provider: ProviderConfig; model: ProviderModelConfig }[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      const hasAll = requiredCapabilities.every(
        cap => model.capabilities.includes(cap)
      );
      if (hasAll) {
        results.push({ provider, model });
      }
    }
  }
  return results;
}

/**
 * Resolves a model's sampling support into a fully-populated set of booleans.
 * A missing `sampling` block, or a missing sub-field within it, defaults to
 * `true` (supported) — preserving legacy behaviour for models that haven't
 * declared overrides. Providers/models that reject a sampling parameter should
 * set it to `false` in providers.yaml so callers can guard before sending it.
 */
export function resolveSamplingSupport(
  model?: ProviderModelConfig | null
): Required<ModelSamplingSupport> {
  const s = model?.sampling;
  return {
    temperature: s?.temperature !== false,
    topP: s?.topP !== false,
    topK: s?.topK !== false,
  };
}

/**
 * Resolves a model's thinking support. A missing `thinking` block defaults to
 * `mode: "none"` (no thinking) — the safe default, since thinking is opt-in and
 * an unsupported request shape (e.g. `budget_tokens` on an adaptive-only model)
 * returns a 400. Models that support thinking declare it in providers.yaml.
 */
export function resolveThinkingSupport(
  model?: ProviderModelConfig | null
): {
  mode: ModelThinkingMode;
  effort?: ModelThinkingSupport["effort"];
  display?: ModelThinkingSupport["display"];
} {
  const t = model?.thinking;
  return {
    mode: t?.mode ?? "none",
    effort: t?.effort,
    display: t?.display,
  };
}
