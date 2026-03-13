import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

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
  maxParallelRequests?: number;
  supportsStreaming?: boolean;
  supportedTools?: string[];
  supportedMediaTypes?: string[];
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
 */
export function loadProviders(yamlPath?: string): ProviderConfig[] {
  const filePath = yamlPath || path.join(__dirname, 'providers.yaml');
  const raw = fs.readFileSync(filePath, 'utf8');
  const interpolated = interpolateEnvVars(yaml.load(raw)) as ProviderYamlRoot;
  return (interpolated.providers || []).map(toProviderConfig);
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
