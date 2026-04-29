import {
  ProviderConfig,
  ProviderModelConfig,
  ProviderModelPricing,
  ProviderImageGenerationTier,
  loadProviders,
} from './provider-loader';

/**
 * Cached map keyed by `${providerId}::${modelId}` for O(1) lookup.
 */
type PricingMap = Map<string, ProviderModelPricing>;

/**
 * Resolves an image-generation cost for a given size/quality combination.
 * Tiers win over the flat rate when a tier matches.
 */
export function resolveImageGenerationCost(
  pricing: ProviderModelPricing,
  options: { size?: string; quality?: string } = {}
): number | null {
  const tiers = pricing.imageGenerationTiers || [];
  for (const tier of tiers) {
    const sizeOk = !tier.match.size || tier.match.size === options.size;
    const qualityOk = !tier.match.quality || tier.match.quality === options.quality;
    if (sizeOk && qualityOk) {
      return tier.usdCents;
    }
  }
  return pricing.imageGenerationPerImageUsdCents;
}

export class PricingLoader {
  private providers: ProviderConfig[] = [];
  private pricing: PricingMap = new Map();
  private modelLookup: Map<string, ProviderModelConfig> = new Map();
  private loadedFrom: string | null = null;

  /**
   * Load (or reload) pricing from `providers.yaml`. Idempotent — call again to refresh.
   */
  load(yamlPath?: string): void {
    this.providers = loadProviders(yamlPath);
    this.pricing.clear();
    this.modelLookup.clear();
    this.loadedFrom = yamlPath || null;
    for (const provider of this.providers) {
      for (const model of provider.models) {
        const key = this.key(provider.id, model.id);
        this.pricing.set(key, model.pricing);
        this.modelLookup.set(key, model);
      }
    }
  }

  /**
   * Returns the pricing block for a given provider/model, or `null` if unknown.
   */
  getPricing(providerId: string, modelId: string): ProviderModelPricing | null {
    return this.pricing.get(this.key(providerId, modelId)) ?? null;
  }

  /**
   * Convenience accessor that returns the per-token price for a single dimension,
   * or `null` if either the model is unknown or the dimension is unpriced.
   */
  getUnitPrice(
    providerId: string,
    modelId: string,
    dimension: keyof ProviderModelPricing,
  ): number | null {
    const pricing = this.getPricing(providerId, modelId);
    if (!pricing) return null;
    const value = pricing[dimension];
    return typeof value === 'number' ? value : null;
  }

  /**
   * Resolves the cost for one image generation call given the model and its
   * size/quality. Returns `null` for unpriced models.
   */
  getImageGenerationCost(
    providerId: string,
    modelId: string,
    options: { size?: string; quality?: string } = {},
  ): number | null {
    const pricing = this.getPricing(providerId, modelId);
    if (!pricing) return null;
    return resolveImageGenerationCost(pricing, options);
  }

  /**
   * Returns true if this provider/model has at least one priced dimension.
   * Used to decide between `pricingSource: 'provider-yaml' | 'unpriced'`.
   */
  hasAnyPricing(providerId: string, modelId: string): boolean {
    const pricing = this.getPricing(providerId, modelId);
    if (!pricing) return false;
    const priceKeys: (keyof ProviderModelPricing)[] = [
      'inputPerTokenUsdCents',
      'outputPerTokenUsdCents',
      'cachedInputPerTokenUsdCents',
      'cacheWritePerTokenUsdCents',
      'reasoningPerTokenUsdCents',
      'audioInputPerSecondUsdCents',
      'audioOutputPerSecondUsdCents',
      'videoInputPerSecondUsdCents',
      'videoOutputPerSecondUsdCents',
      'imageGenerationPerImageUsdCents',
      'embeddingPerTokenUsdCents',
    ];
    if (priceKeys.some(k => typeof pricing[k] === 'number')) return true;
    return (pricing.imageGenerationTiers || []).length > 0;
  }

  getModel(providerId: string, modelId: string): ProviderModelConfig | null {
    return this.modelLookup.get(this.key(providerId, modelId)) ?? null;
  }

  getProviders(): ProviderConfig[] {
    return this.providers;
  }

  private key(providerId: string, modelId: string): string {
    return `${providerId}::${modelId}`;
  }
}

/** Module-level singleton — load once on first import. */
let singleton: PricingLoader | null = null;
export function getPricingLoader(): PricingLoader {
  if (!singleton) {
    singleton = new PricingLoader();
    singleton.load();
  }
  return singleton;
}

/** For tests: reset the singleton so a fresh load happens. */
export function __resetPricingLoaderForTests(): void {
  singleton = null;
}
