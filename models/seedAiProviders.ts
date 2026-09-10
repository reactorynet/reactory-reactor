import { DataSource } from 'typeorm';
import { loadProviders, ProviderConfig } from '../ai/providers/provider-loader';
import ReactoryAiProvider from './ReactoryAiProvider';
import ReactoryAiModel from './ReactoryAiModel';

/**
 * Seeds baseline AI providers and models from providers.yaml into the PostgreSQL database.
 * If overwrite is false (default), only seeds if the reactory_ai_providers table is empty.
 */
export async function seedAiProviders(
  dataSource: DataSource,
  overwrite: boolean = false
): Promise<{ providersCount: number; modelsCount: number }> {
  const providerRepo = dataSource.getRepository(ReactoryAiProvider);
  const modelRepo = dataSource.getRepository(ReactoryAiModel);

  const existingCount = await providerRepo.count();
  if (existingCount > 0 && !overwrite) {
    return { providersCount: existingCount, modelsCount: await modelRepo.count() };
  }

  const yamlProviders: ProviderConfig[] = loadProviders();
  let totalProviders = 0;
  let totalModels = 0;

  for (const p of yamlProviders) {
    let provider = await providerRepo.findOne({ where: { id: p.id } });
    if (!provider) {
      provider = new ReactoryAiProvider();
      provider.id = p.id;
    }

    provider.name = p.name;
    provider.description = `${p.name} AI Provider`;
    provider.providerType = p.id.toLowerCase();
    provider.endpointUrl = p.endpointUrl;
    provider.apiVersion = p.apiVersion;
    provider.authComponentFqn = p.authComponentFqn;
    provider.defaultModelId = p.defaultModel;
    provider.credentialRequirements = p.credentialRequirements || [];
    provider.credentialEnvVars = p.credentialEnvVars || {};
    provider.capabilities = p.capabilities || [];
    provider.roles = p.roles || ['USER'];
    provider.rateLimits = p.rateLimits;
    provider.status = p.status || {
      available: false,
      uptime: 99.9,
      responseTime: 350,
      errorRate: 0.1,
    };
    provider.isEnabled = true;
    provider.isSystem = true;

    await providerRepo.save(provider);
    totalProviders++;

    // Seed child models
    let sortOrder = 0;
    for (const m of p.models || []) {
      let model = await modelRepo.findOne({
        where: { providerId: p.id, modelKey: m.id },
      });

      if (!model) {
        model = new ReactoryAiModel();
        model.providerId = p.id;
        model.modelKey = m.id;
      }

      model.name = m.name;
      model.version = m.version;
      model.contextLength = m.contextLength;
      model.capabilities = m.capabilities || [];
      model.supportsStreaming = m.supportsStreaming !== false;
      model.supportedTools = m.supportedTools || ['function-calling'];
      model.supportedMediaTypes = m.supportedMediaTypes || ['text'];
      model.inputCostPerTokenUsdCents = m.inputCostPerTokenUsdCents ?? undefined;
      model.outputCostPerTokenUsdCents = m.outputCostPerTokenUsdCents ?? undefined;
      model.costPerToken = m.costPerToken ?? undefined;
      model.rpm = m.rpm ?? undefined;
      model.itpm = m.itpm ?? undefined;
      model.otpm = m.otpm ?? undefined;
      model.maxParallelRequests = m.maxParallelRequests ?? undefined;
      model.samplingConfig = m.sampling;
      model.thinkingConfig = m.thinking;
      model.isEnabled = true;
      model.sortOrder = sortOrder++;

      await modelRepo.save(model);
      totalModels++;
    }
  }

  return { providersCount: totalProviders, modelsCount: totalModels };
}

export default seedAiProviders;
