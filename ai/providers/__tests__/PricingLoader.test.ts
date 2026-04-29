import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PricingLoader,
  resolveImageGenerationCost,
  getPricingLoader,
  __resetPricingLoaderForTests,
} from '../PricingLoader';

const FIXTURE_YAML = `
providers:
  - id: testprov
    name: Test Provider
    defaultModel: priced-model
    capabilities: [text-generation]
    credentialEnvVars:
      apiKey: TEST_FAKE_KEY_NEVER_SET
    models:
      - id: priced-model
        name: Priced Model
        capabilities: [text-generation]
        pricing:
          inputPerTokenUsdCents: 0.0003
          outputPerTokenUsdCents: 0.0015
          cachedInputPerTokenUsdCents: 0.00003
          cacheWritePerTokenUsdCents: null
          reasoningPerTokenUsdCents: null
          audioInputPerSecondUsdCents: null
          audioOutputPerSecondUsdCents: null
          videoInputPerSecondUsdCents: null
          videoOutputPerSecondUsdCents: null
          imageGenerationPerImageUsdCents: null
          embeddingPerTokenUsdCents: null
          currency: USD
          pricingEffectiveFrom: '2026-04-29'
      - id: unpriced-model
        name: Unpriced Model
        capabilities: [text-generation]
        pricing:
          inputPerTokenUsdCents: null
          outputPerTokenUsdCents: null
          cachedInputPerTokenUsdCents: null
          cacheWritePerTokenUsdCents: null
          reasoningPerTokenUsdCents: null
          audioInputPerSecondUsdCents: null
          audioOutputPerSecondUsdCents: null
          videoInputPerSecondUsdCents: null
          videoOutputPerSecondUsdCents: null
          imageGenerationPerImageUsdCents: null
          embeddingPerTokenUsdCents: null
          currency: USD
          pricingEffectiveFrom: '2026-04-29'
      - id: image-tiered-model
        name: Image Tiered
        capabilities: [image-generation]
        pricing:
          inputPerTokenUsdCents: null
          outputPerTokenUsdCents: null
          cachedInputPerTokenUsdCents: null
          cacheWritePerTokenUsdCents: null
          reasoningPerTokenUsdCents: null
          audioInputPerSecondUsdCents: null
          audioOutputPerSecondUsdCents: null
          videoInputPerSecondUsdCents: null
          videoOutputPerSecondUsdCents: null
          imageGenerationPerImageUsdCents: 4.0
          embeddingPerTokenUsdCents: null
          currency: USD
          pricingEffectiveFrom: '2026-04-29'
          imageGenerationTiers:
            - match: { size: '1024x1024', quality: 'standard' }
              usdCents: 4.0
            - match: { size: '1792x1024', quality: 'hd' }
              usdCents: 12.0
`;

function writeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-fixture-'));
  const filePath = path.join(dir, 'providers.yaml');
  fs.writeFileSync(filePath, FIXTURE_YAML, 'utf8');
  return filePath;
}

describe('PricingLoader', () => {
  describe('with fixture YAML', () => {
    let loader: PricingLoader;
    let fixturePath: string;

    beforeAll(() => {
      fixturePath = writeFixture();
      loader = new PricingLoader();
      loader.load(fixturePath);
    });

    it('returns the full pricing block for a priced model', () => {
      const pricing = loader.getPricing('testprov', 'priced-model');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPerTokenUsdCents).toBe(0.0003);
      expect(pricing!.outputPerTokenUsdCents).toBe(0.0015);
      expect(pricing!.cachedInputPerTokenUsdCents).toBe(0.00003);
      expect(pricing!.currency).toBe('USD');
    });

    it('returns null for unknown provider/model', () => {
      expect(loader.getPricing('nope', 'gpt-x')).toBeNull();
    });

    it('getUnitPrice returns the float value when priced', () => {
      expect(loader.getUnitPrice('testprov', 'priced-model', 'inputPerTokenUsdCents')).toBe(0.0003);
    });

    it('getUnitPrice returns null for unpriced dimensions', () => {
      expect(
        loader.getUnitPrice('testprov', 'priced-model', 'audioInputPerSecondUsdCents')
      ).toBeNull();
    });

    it('hasAnyPricing is false for fully unpriced model', () => {
      expect(loader.hasAnyPricing('testprov', 'unpriced-model')).toBe(false);
    });

    it('hasAnyPricing is true for partially priced model', () => {
      expect(loader.hasAnyPricing('testprov', 'priced-model')).toBe(true);
    });

    it('hasAnyPricing returns false for unknown model', () => {
      expect(loader.hasAnyPricing('nope', 'nope')).toBe(false);
    });

    it('image generation tier match wins over flat rate', () => {
      expect(
        loader.getImageGenerationCost('testprov', 'image-tiered-model', {
          size: '1792x1024',
          quality: 'hd',
        })
      ).toBe(12.0);
    });

    it('image generation falls back to flat rate when no tier matches', () => {
      expect(
        loader.getImageGenerationCost('testprov', 'image-tiered-model', {
          size: '512x512',
          quality: 'low',
        })
      ).toBe(4.0);
    });

    it('image generation returns null for unknown model', () => {
      expect(loader.getImageGenerationCost('nope', 'nope')).toBeNull();
    });

    it('load is idempotent', () => {
      loader.load(fixturePath);
      loader.load(fixturePath);
      expect(loader.getPricing('testprov', 'priced-model')!.inputPerTokenUsdCents).toBe(0.0003);
    });
  });

  describe('with bundled providers.yaml', () => {
    beforeEach(() => {
      __resetPricingLoaderForTests();
    });

    it('singleton loads bundled data on first access', () => {
      const loader = getPricingLoader();
      const pricing = loader.getPricing('openai', 'gpt-4o');
      expect(pricing).not.toBeNull();
      expect(typeof pricing!.inputPerTokenUsdCents).toBe('number');
      expect(typeof pricing!.outputPerTokenUsdCents).toBe('number');
      expect(pricing!.currency).toBe('USD');
    });

    it('every model in the registry has a complete pricing block', () => {
      const loader = getPricingLoader();
      const required: (keyof typeof loader extends never ? never : string)[] = [
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
        'currency',
        'pricingEffectiveFrom',
      ];
      for (const provider of loader.getProviders()) {
        for (const model of provider.models) {
          for (const key of required) {
            expect(model.pricing).toHaveProperty(key);
          }
        }
      }
    });
  });
});

describe('resolveImageGenerationCost (pure helper)', () => {
  const basePricing = {
    inputPerTokenUsdCents: null,
    outputPerTokenUsdCents: null,
    cachedInputPerTokenUsdCents: null,
    cacheWritePerTokenUsdCents: null,
    reasoningPerTokenUsdCents: null,
    audioInputPerSecondUsdCents: null,
    audioOutputPerSecondUsdCents: null,
    videoInputPerSecondUsdCents: null,
    videoOutputPerSecondUsdCents: null,
    embeddingPerTokenUsdCents: null,
    currency: 'USD',
    pricingEffectiveFrom: '2026-04-29',
  } as const;

  it('returns flat rate when no tiers', () => {
    expect(
      resolveImageGenerationCost({
        ...basePricing,
        imageGenerationPerImageUsdCents: 5.0,
      })
    ).toBe(5.0);
  });

  it('returns null when neither tiers nor flat rate set', () => {
    expect(
      resolveImageGenerationCost({
        ...basePricing,
        imageGenerationPerImageUsdCents: null,
      })
    ).toBeNull();
  });

  it('matches a tier on size only', () => {
    expect(
      resolveImageGenerationCost(
        {
          ...basePricing,
          imageGenerationPerImageUsdCents: 4.0,
          imageGenerationTiers: [{ match: { size: '1024x1024' }, usdCents: 4.0 }],
        },
        { size: '1024x1024', quality: 'whatever' }
      )
    ).toBe(4.0);
  });
});
