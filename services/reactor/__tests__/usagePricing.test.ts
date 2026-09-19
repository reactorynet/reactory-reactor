import {
  calculateCostUsdCents,
  isLocalProvider,
  isSuspectZeroRate,
  extractUsage,
  resolvePricingFromStatic,
  FREE_PRICING,
  LOCAL_PROVIDERS,
  type ModelPricing,
} from '../usagePricing';

/**
 * Tests for the usage-pricing honesty contract.
 *
 * The behaviour under test is not arithmetic — it is the *distinction* the old
 * implementation collapsed: a model with no known price must never be reported as
 * costing nothing. Every case below exists because getting it wrong understated
 * spend silently, which is the defect this module was written to remove.
 */
describe('usagePricing', () => {
  describe('isLocalProvider', () => {
    it('recognises the local providers whose zero cost is real', () => {
      expect(isLocalProvider('ollama')).toBe(true);
      expect(isLocalProvider('llamacpp')).toBe(true);
      expect(isLocalProvider('vllm')).toBe(true);
    });

    it('is case- and whitespace-insensitive', () => {
      expect(isLocalProvider('Ollama')).toBe(true);
      expect(isLocalProvider('  LLAMACPP  ')).toBe(true);
    });

    it('does not treat paid providers as local', () => {
      expect(isLocalProvider('google')).toBe(false);
      expect(isLocalProvider('anthropic')).toBe(false);
      expect(isLocalProvider('openai')).toBe(false);
    });

    it('treats absent or empty values as not local', () => {
      expect(isLocalProvider(undefined)).toBe(false);
      expect(isLocalProvider(null)).toBe(false);
      expect(isLocalProvider('')).toBe(false);
    });

    it('covers every provider the module declares', () => {
      for (const provider of LOCAL_PROVIDERS) {
        expect(isLocalProvider(provider)).toBe(true);
      }
    });
  });

  describe('calculateCostUsdCents', () => {
    const pricing: ModelPricing = {
      inputCostPerTokenUsdCents: 0.0002,
      outputCostPerTokenUsdCents: 0.0012,
      source: 'database',
    };

    it('prices prompt and completion tokens at their own rates', () => {
      // 1000 * 0.0002 + 500 * 0.0012 = 0.2 + 0.6 = 0.8
      expect(calculateCostUsdCents(pricing, 1000, 500)).toBe(0.8);
    });

    it('is zero for a genuinely free model', () => {
      expect(calculateCostUsdCents(FREE_PRICING, 1_000_000, 1_000_000)).toBe(0);
    });

    it('never returns a negative cost for negative input', () => {
      // A provider reporting a negative count is malformed, not a credit.
      expect(calculateCostUsdCents(pricing, -1000, -500)).toBe(0);
    });

    it('treats NaN and Infinity as zero rather than propagating them', () => {
      expect(calculateCostUsdCents(pricing, NaN, NaN)).toBe(0);
      // A non-finite count is zeroed, but the *other* half is still priced.
      // Discarding a valid count because its sibling was malformed would throw
      // away real spend, so the guard is per-value rather than per-row.
      expect(calculateCostUsdCents(pricing, Infinity, 100)).toBe(0.12);
    });

    it('rounds to the column precision (6dp) instead of drifting', () => {
      const value = calculateCostUsdCents(pricing, 3, 7);
      // 3*0.0002 + 7*0.0012 = 0.0006 + 0.0084 = 0.009
      expect(value).toBe(0.009);
      expect(String(value).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
    });
  });

  describe('isSuspectZeroRate', () => {
    it('flags a zero rate from a paid provider as unknown, not free', () => {
      // `xai/grok-4.5` reads this way in production: a paid provider with no
      // rates recorded. Reporting those 26 turns as costing nothing is the bug.
      const zero: ModelPricing = {
        inputCostPerTokenUsdCents: 0,
        outputCostPerTokenUsdCents: 0,
        source: 'database',
      };
      expect(isSuspectZeroRate(zero, 'xai')).toBe(true);
    });

    it('does not flag a zero rate from a local provider', () => {
      expect(isSuspectZeroRate(FREE_PRICING, 'ollama')).toBe(false);
      expect(isSuspectZeroRate(FREE_PRICING, 'llamacpp')).toBe(false);
    });

    it('does not flag a priced model', () => {
      expect(
        isSuspectZeroRate(
          {
            inputCostPerTokenUsdCents: 0.0002,
            outputCostPerTokenUsdCents: 0.0012,
            source: 'database',
          },
          'google'
        )
      ).toBe(false);
    });

    it('does not flag a model priced only on one side', () => {
      expect(
        isSuspectZeroRate(
          {
            inputCostPerTokenUsdCents: 0.0002,
            outputCostPerTokenUsdCents: 0,
            source: 'database',
          },
          'google'
        )
      ).toBe(false);
    });
  });

  describe('extractUsage', () => {
    it('reads the camelCase shape every stored envelope actually uses', () => {
      const result = extractUsage({
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      expect(result).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        source: 'provider',
      });
    });

    it('reads snake_case as well, for pre-adaption payloads', () => {
      const result = extractUsage({
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      expect(result.promptTokens).toBe(100);
      expect(result.completionTokens).toBe(50);
      expect(result.source).toBe('provider');
    });

    it('reads Anthropic-style input/output token names', () => {
      const result = extractUsage({
        usage: { input_tokens: 10, output_tokens: 20 },
      });
      expect(result.promptTokens).toBe(10);
      expect(result.completionTokens).toBe(20);
    });

    it('derives total from the parts when total is absent', () => {
      const result = extractUsage({ usage: { promptTokens: 7, completionTokens: 3 } });
      expect(result.totalTokens).toBe(10);
    });

    it('returns source "none" for an absent envelope rather than guessing', () => {
      // The legacy ingest script estimated counts from content length here.
      // Fabricating them is strictly worse than reporting nothing.
      expect(extractUsage(undefined)).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        source: 'none',
      });
      expect(extractUsage({}).source).toBe('none');
      expect(extractUsage({ usage: null }).source).toBe('none');
    });

    it('reports a nil usage object as "none", not "provider"', () => {
      const result = extractUsage({ usage: JSON.parse('null') });
      expect(result.source).toBe('none');
      expect(result.totalTokens).toBe(0);
    });
  });

  describe('resolvePricingFromStatic', () => {
    it('prices a model present in the provider registry', () => {
      const pricing = resolvePricingFromStatic('gemini-2.5-flash', 'google');
      expect(pricing).not.toBeNull();
      expect(pricing!.source).toBe('static');
      expect(pricing!.inputCostPerTokenUsdCents).toBeGreaterThanOrEqual(0);
    });

    it('returns null for a model the registry does not know', () => {
      // null means "unknown". It must not become 0, which would read as free.
      expect(resolvePricingFromStatic('definitely-not-a-real-model-xyz', 'google')).toBeNull();
    });

    it('returns null for an absent model id', () => {
      expect(resolvePricingFromStatic(null, 'google')).toBeNull();
      expect(resolvePricingFromStatic('', 'google')).toBeNull();
      expect(resolvePricingFromStatic(undefined, 'google')).toBeNull();
    });

    it('does not borrow another provider rates for the same model id', () => {
      // `gpt-4` exists under both openai (priced) and azure-openai (unpriced).
      // Applying openai's rates to an azure-openai turn would be wrong.
      const azure = resolvePricingFromStatic('gpt-4', 'azure-openai');
      if (azure) {
        expect(azure.inputCostPerTokenUsdCents).toBe(0);
      }
    });
  });
});
