import { ObjectId } from 'mongodb';
import { priceUsage } from '../ReactoryUsageService';
import { AIChatCompletionUsage, ReactoryUserBudgetPricingOverride } from '../../../types/usage.types';
import { ProviderModelPricing } from '../../../ai/providers/provider-loader';

jest.mock('../../../models/ReactoryUsageEvent', () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));

jest.mock('../../../models/ReactorChatState', () => ({
  __esModule: true,
  default: { findByIdAndUpdate: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(null) })) },
}));

function makePricing(overrides: Partial<ProviderModelPricing> = {}): ProviderModelPricing {
  return {
    inputPerTokenUsdCents: null,
    outputPerTokenUsdCents: null,
    cachedInputPerTokenUsdCents: null,
    cacheWritePerTokenUsdCents: null,
    reasoningPerTokenUsdCents: null,
    audioInputPerSecondUsdCents: null,
    audioOutputPerSecondUsdCents: null,
    videoInputPerSecondUsdCents: null,
    videoOutputPerSecondUsdCents: null,
    imageGenerationPerImageUsdCents: null,
    embeddingPerTokenUsdCents: null,
    currency: 'USD',
    pricingEffectiveFrom: '2026-04-29',
    ...overrides,
  };
}

function makeUsage(overrides: Partial<AIChatCompletionUsage> = {}): AIChatCompletionUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

describe('priceUsage', () => {
  it('prices fully-priced text usage and reports provider-yaml source', () => {
    const pricing = makePricing({
      inputPerTokenUsdCents: 0.0003,
      outputPerTokenUsdCents: 0.0015,
    });
    const usage = makeUsage({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });

    const result = priceUsage(pricing, usage);

    expect(result.costs.inputUsdCents).toBeCloseTo(0.0003 * 1000, 8);
    expect(result.costs.outputUsdCents).toBeCloseTo(0.0015 * 500, 8);
    expect(result.costs.totalUsdCents).toBeCloseTo(0.0003 * 1000 + 0.0015 * 500, 8);
    expect(result.pricingSource).toBe('provider-yaml');
    expect(result.costs.uncostedDimensions).toEqual([]);
  });

  it('subtracts cached tokens from billable input and charges cache at cached rate', () => {
    const pricing = makePricing({
      inputPerTokenUsdCents: 0.0003,
      outputPerTokenUsdCents: 0.0015,
      cachedInputPerTokenUsdCents: 0.00003,
    });
    const usage = makeUsage({
      promptTokens: 1000,
      cachedPromptTokens: 800,
      completionTokens: 200,
      totalTokens: 1200,
    });

    const result = priceUsage(pricing, usage);

    expect(result.costs.inputUsdCents).toBeCloseTo(0.0003 * 200, 8);
    expect(result.costs.cachedInputUsdCents).toBeCloseTo(0.00003 * 800, 8);
    expect(result.costs.outputUsdCents).toBeCloseTo(0.0015 * 200, 8);
  });

  it('charges cache write tokens at the cache write rate', () => {
    const pricing = makePricing({
      inputPerTokenUsdCents: 0.0003,
      outputPerTokenUsdCents: 0.0015,
      cacheWritePerTokenUsdCents: 0.000375,
    });
    const usage = makeUsage({
      promptTokens: 100,
      cacheWriteTokens: 50,
      completionTokens: 100,
      totalTokens: 200,
    });

    const result = priceUsage(pricing, usage);

    expect(result.costs.cacheWriteUsdCents).toBeCloseTo(0.000375 * 50, 8);
  });

  it('separately bills reasoning tokens when reasoning rate is set', () => {
    const pricing = makePricing({
      inputPerTokenUsdCents: 0.0003,
      outputPerTokenUsdCents: 0.0015,
      reasoningPerTokenUsdCents: 0.003,
    });
    const usage = makeUsage({
      promptTokens: 100,
      completionTokens: 500,
      reasoningTokens: 200,
      totalTokens: 600,
    });

    const result = priceUsage(pricing, usage);

    expect(result.costs.outputUsdCents).toBeCloseTo(0.0015 * 300, 8);
    expect(result.costs.reasoningUsdCents).toBeCloseTo(0.003 * 200, 8);
  });

  it('treats reasoning as plain output when no reasoning rate is configured', () => {
    const pricing = makePricing({
      inputPerTokenUsdCents: 0.0003,
      outputPerTokenUsdCents: 0.0015,
    });
    const usage = makeUsage({
      promptTokens: 100,
      completionTokens: 500,
      reasoningTokens: 200,
      totalTokens: 600,
    });

    const result = priceUsage(pricing, usage);

    expect(result.costs.outputUsdCents).toBeCloseTo(0.0015 * 500, 8);
    expect(result.costs.reasoningUsdCents).toBeNull();
  });

  it('prices audio input and output seconds independently', () => {
    const pricing = makePricing({
      audioInputPerSecondUsdCents: 0.01,
      audioOutputPerSecondUsdCents: 0.025,
    });
    const usage = makeUsage({ audioInputSeconds: 60, audioOutputSeconds: 30 });

    const result = priceUsage(pricing, usage);

    expect(result.costs.audioInputUsdCents).toBeCloseTo(0.01 * 60, 8);
    expect(result.costs.audioOutputUsdCents).toBeCloseTo(0.025 * 30, 8);
  });

  it('prices video input and output seconds independently', () => {
    const pricing = makePricing({
      videoInputPerSecondUsdCents: 0.05,
      videoOutputPerSecondUsdCents: 0.10,
    });
    const usage = makeUsage({ videoInputSeconds: 10, videoOutputSeconds: 4 });

    const result = priceUsage(pricing, usage);

    expect(result.costs.videoInputUsdCents).toBeCloseTo(0.05 * 10, 8);
    expect(result.costs.videoOutputUsdCents).toBeCloseTo(0.10 * 4, 8);
  });

  it('prices image generation at the flat rate when no tiers match', () => {
    const pricing = makePricing({ imageGenerationPerImageUsdCents: 4.0 });
    const usage = makeUsage({
      imagesGenerated: [{ size: '1024x1024', quality: 'standard', count: 3 }],
    });

    const result = priceUsage(pricing, usage);

    expect(result.costs.imageGenerationUsdCents).toBeCloseTo(4.0 * 3, 8);
  });

  it('prices image generation using tiers when a tier matches', () => {
    const pricing = makePricing({
      imageGenerationPerImageUsdCents: 4.0,
      imageGenerationTiers: [
        { match: { size: '1024x1024', quality: 'standard' }, usdCents: 4.0 },
        { match: { size: '1792x1024', quality: 'hd' }, usdCents: 12.0 },
      ],
    });
    const usage = makeUsage({
      imagesGenerated: [
        { size: '1024x1024', quality: 'standard', count: 2 },
        { size: '1792x1024', quality: 'hd', count: 1 },
      ],
    });

    const result = priceUsage(pricing, usage);

    expect(result.costs.imageGenerationUsdCents).toBeCloseTo(4.0 * 2 + 12.0 * 1, 8);
  });

  it('reports partial source when usage is reported for an unpriced dimension', () => {
    const pricing = makePricing({
      inputPerTokenUsdCents: 0.0003,
      outputPerTokenUsdCents: 0.0015,
    });
    const usage = makeUsage({
      promptTokens: 100,
      completionTokens: 50,
      audioInputSeconds: 5,
    });

    const result = priceUsage(pricing, usage);

    expect(result.pricingSource).toBe('partial');
    expect(result.costs.audioInputUsdCents).toBeNull();
    expect(result.costs.uncostedDimensions).toContain('audioInput');
  });

  it('reports unpriced source when usage is reported but no rates are set at all', () => {
    const pricing = makePricing({});
    const usage = makeUsage({ promptTokens: 100, completionTokens: 50 });

    const result = priceUsage(pricing, usage);

    expect(result.pricingSource).toBe('unpriced');
    expect(result.costs.totalUsdCents).toBe(0);
  });

  it('returns unpriced source when no pricing entry exists for the model', () => {
    const result = priceUsage(null, makeUsage({ promptTokens: 100, completionTokens: 50 }));

    expect(result.pricingSource).toBe('unpriced');
    expect(result.costs.totalUsdCents).toBe(0);
    expect(result.pricingSnapshot.currency).toBe('USD');
  });

  it('zero usage produces zero total without partial flag', () => {
    const pricing = makePricing({
      inputPerTokenUsdCents: 0.0003,
      outputPerTokenUsdCents: 0.0015,
    });
    const usage = makeUsage();

    const result = priceUsage(pricing, usage);

    expect(result.costs.totalUsdCents).toBe(0);
    expect(result.pricingSource).toBe('provider-yaml');
  });

  it('override numeric value wins over YAML and changes source to override', () => {
    const pricing = makePricing({
      inputPerTokenUsdCents: 0.0003,
      outputPerTokenUsdCents: 0.0015,
    });
    const override: ReactoryUserBudgetPricingOverride = {
      providerId: 'azure-openai',
      modelId: 'gpt-5.4',
      inputPerTokenUsdCents: 0.0001,
    };
    const usage = makeUsage({ promptTokens: 1000, completionTokens: 500 });

    const result = priceUsage(pricing, usage, override);

    expect(result.pricingSource).toBe('override');
    expect(result.costs.inputUsdCents).toBeCloseTo(0.0001 * 1000, 8);
    expect(result.costs.outputUsdCents).toBeCloseTo(0.0015 * 500, 8);
  });

  it('override with null/undefined falls through to YAML', () => {
    const pricing = makePricing({
      inputPerTokenUsdCents: 0.0003,
      outputPerTokenUsdCents: 0.0015,
    });
    const override: ReactoryUserBudgetPricingOverride = {
      providerId: 'azure-openai',
      modelId: 'gpt-5.4',
      inputPerTokenUsdCents: null,
    };
    const usage = makeUsage({ promptTokens: 1000, completionTokens: 500 });

    const result = priceUsage(pricing, usage, override);

    expect(result.costs.inputUsdCents).toBeCloseTo(0.0003 * 1000, 8);
    expect(result.pricingSource).toBe('provider-yaml');
  });

  it('handles cached + cache-write together (Anthropic shape)', () => {
    const pricing = makePricing({
      inputPerTokenUsdCents: 0.0003,
      outputPerTokenUsdCents: 0.0015,
      cachedInputPerTokenUsdCents: 0.00003,
      cacheWritePerTokenUsdCents: 0.000375,
    });
    const usage = makeUsage({
      promptTokens: 1500,
      cachedPromptTokens: 1000,
      cacheWriteTokens: 500,
      completionTokens: 200,
      totalTokens: 1700,
    });

    const result = priceUsage(pricing, usage);

    expect(result.costs.inputUsdCents).toBeCloseTo(0.0003 * 500, 8);
    expect(result.costs.cachedInputUsdCents).toBeCloseTo(0.00003 * 1000, 8);
    expect(result.costs.cacheWriteUsdCents).toBeCloseTo(0.000375 * 500, 8);
    expect(result.costs.outputUsdCents).toBeCloseTo(0.0015 * 200, 8);
    const expectedTotal =
      0.0003 * 500 + 0.00003 * 1000 + 0.000375 * 500 + 0.0015 * 200;
    expect(result.costs.totalUsdCents).toBeCloseTo(expectedTotal, 8);
  });
});

describe('ReactoryUsageService.recordUsage', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ReactoryUsageService = require('../ReactoryUsageService').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ReactoryUsageEventModel = require('../../../models/ReactoryUsageEvent').default;

  let service: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReactoryUsageService(
      { dependencies: {}, $services: new Map() } as any,
      { user: { _id: 'admin' }, debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
    );
  });

  it('writes a row through the model with priced costs from bundled YAML', async () => {
    (ReactoryUsageEventModel.create as jest.Mock).mockImplementation((doc: any) => ({
      toObject: () => doc,
    }));

    const result = await service.recordUsage({
      userId: new ObjectId(),
      conversationId: new ObjectId(),
      messageId: new ObjectId(),
      providerId: 'openai',
      modelId: 'gpt-4o',
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      occurredAt: new Date('2026-04-29T12:00:00Z'),
    });

    expect(ReactoryUsageEventModel.create).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result.providerId).toBe('openai');
    expect(result.modelId).toBe('gpt-4o');
    expect(result.costs.totalUsdCents).toBeGreaterThan(0);
    expect(result.pricingSource).toBe('provider-yaml');
    expect(typeof result.pricingSnapshot.inputPerTokenUsdCents).toBe('number');
  });

  it('returns null when a duplicate (conversation, message) is rejected by the unique index', async () => {
    (ReactoryUsageEventModel.create as jest.Mock).mockRejectedValue({ code: 11000 });

    const result = await service.recordUsage({
      userId: new ObjectId(),
      conversationId: new ObjectId(),
      messageId: new ObjectId(),
      providerId: 'openai',
      modelId: 'gpt-4o',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    expect(result).toBeNull();
  });

  it('rethrows non-duplicate errors', async () => {
    (ReactoryUsageEventModel.create as jest.Mock).mockRejectedValue(new Error('connection lost'));

    await expect(
      service.recordUsage({
        userId: new ObjectId(),
        conversationId: new ObjectId(),
        messageId: new ObjectId(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }),
    ).rejects.toThrow('connection lost');
  });

  it('records pricingSource: backfilled when the input flag is set', async () => {
    (ReactoryUsageEventModel.create as jest.Mock).mockImplementation((doc: any) => ({
      toObject: () => doc,
    }));

    const result = await service.recordUsage({
      userId: new ObjectId(),
      conversationId: new ObjectId(),
      messageId: new ObjectId(),
      providerId: 'openai',
      modelId: 'gpt-4o',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      backfilled: true,
    });

    expect(result.pricingSource).toBe('backfilled');
  });
});
