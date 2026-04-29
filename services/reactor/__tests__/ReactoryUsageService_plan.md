# ReactoryUsageService test plan

Module: `src/modules/reactory-reactor/services/reactor/ReactoryUsageService.ts`

## Goals
- Verify `priceUsage` (the pure pricing function) produces correct dollar totals across all dimensions.
- Catch regressions when new pricing dimensions are added or token-accounting rules change.
- Confirm pricing-source classification: `provider-yaml` / `override` / `partial` / `unpriced` / `backfilled`.

## Coverage of `priceUsage`

1. **Fully priced text usage** — input + output tokens with both rates set; total = sum(input * inrate, output * outrate); source = `provider-yaml`.
2. **Cached input subtraction** — when `cachedPromptTokens` > 0, billable input is `promptTokens - cachedPromptTokens`; cached charged at the cached rate.
3. **Cache write tokens** — Anthropic-style; charged separately from input.
4. **Reasoning billed separately** — when `reasoningPerTokenUsdCents !== null`, completion tokens minus reasoning tokens go to output; reasoning charged at its own rate.
5. **Reasoning falls into output** — when `reasoningPerTokenUsdCents === null`, all completion tokens (including reasoning) bill at output rate.
6. **Audio seconds** — input and output independently priced.
7. **Video seconds** — input and output independently priced.
8. **Image generation flat rate** — image count × `imageGenerationPerImageUsdCents`.
9. **Image generation tier match** — uses tiered price when `{size, quality}` matches; mixed-tier batch sums correctly.
10. **Partial pricing** — usage reported for unpriced dimension → `pricingSource: 'partial'`, `uncostedDimensions` includes the dimension name.
11. **Fully unpriced model** — usage reported but no rates set → `pricingSource: 'unpriced'`, `totalUsdCents = 0`, all dimension costs `null`.
12. **No usage at all** — zero totals across the board, `totalUsdCents = 0`.
13. **Override wins over YAML** — override sets a number; effective pricing uses it; `pricingSource: 'override'`.
14. **Override with null falls through** — null in override is ignored; YAML rate used.
15. **Null pricing arg** — when no pricing entry exists for the model, returns `unpriced` with empty snapshot.

## Coverage of service methods (Mongo-touching)

The following are validated by the integration test (UsageIntegration.test.ts) which spins up the full module — out of scope here:

- `recordUsage` writes a row, returns the document, applies idempotency on duplicate.
- `getUsageForPeriod` aggregates correctly across users/scopes.
- `recomputeConversationSummary` updates the conversation's `usageSummary`.

## Out of scope
- Concurrent insert handling (Mongo guarantees via unique index — covered by integration test).
- Performance benchmarks.
