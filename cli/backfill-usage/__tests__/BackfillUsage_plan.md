# BackfillUsage CLI test plan

Module: `src/modules/reactory-reactor/cli/backfill-usage/BackfillUsage.ts`

## Goals
- Verify the usage-extraction helper handles every shape we've written to `reactor_conversations.history[].response.usage` over time.
- Verify CLI argument parsing rejects bad input and accepts good input.

## Coverage

### `extractUsageFromHistory`

1. **Already-normalized (camelCase) shape** — modern entries carry `{ promptTokens, completionTokens, totalTokens }`; passes through.
2. **OpenAI snake_case shape** — `{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: { cached_tokens } }`.
3. **OpenAI reasoning shape** — `completion_tokens_details: { reasoning_tokens }` mapped to `reasoningTokens`.
4. **Anthropic shape** — `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`.
5. **History item without response** — returns `null` (not assistant turn or not yet completed).
6. **History item with empty response.usage** — returns `null`.

### `parseArgs`

7. **No flags** — returns defaults (`dryRun: false, since: null, userId: null, batchSize: 500`).
8. **--dry-run flag** — sets dryRun true.
9. **--since=YYYY-MM-DD** — parses to a Date.
10. **--since with bad value** — throws.
11. **--user=hexId** — parses to ObjectId.
12. **--batch=N** — sets batch size.
13. **--batch with non-numeric** — throws.

## Out of scope
- Mongo cursor iteration, progress logging, idempotency on duplicate inserts.
  These are exercised end-to-end on the prod copy when the operator runs `--dry-run`.
