# PricingLoader test plan

Module: `src/modules/reactory-reactor/ai/providers/PricingLoader.ts`

## Goals
- Verify YAML pricing data loads into the in-memory map and exposes typed accessors.
- Catch regressions where pricing fields are renamed or removed without updating consumers.
- Validate image-generation tier matching (size/quality fallback).

## Cases

1. **load() populates the cache from the bundled providers.yaml** — pricing is non-empty for known priced models (e.g. `openai::gpt-4o`).
2. **getPricing returns null for unknown provider/model** — unknown keys never throw.
3. **getUnitPrice returns the float value when priced** — exact match against YAML for one priced and one unpriced dimension.
4. **getUnitPrice returns null for unpriced dimensions** — even if the model has *some* pricing.
5. **hasAnyPricing returns false for fully unpriced models** — e.g., `azure-openai::gpt-5.4`.
6. **hasAnyPricing returns true for partially priced models** — e.g., text-priced model with no audio pricing still reports true.
7. **getImageGenerationCost falls back to flat rate** when no tiers configured.
8. **getImageGenerationCost matches a tier** when `{size, quality}` matches.
9. **getImageGenerationCost falls back to flat rate** when tiers exist but none match.
10. **load() can be called with a custom yamlPath** for fixture-based tests.
11. **load() is idempotent** — second call replaces, doesn't accumulate.
12. **resolveImageGenerationCost helper** — pure function works without a loader instance.

## Fixtures
- One inline YAML fixture string written to a temp file for tier-matching tests, so we don't depend on prod YAML state.
- Production `providers.yaml` for the bundled-data smoke tests.
