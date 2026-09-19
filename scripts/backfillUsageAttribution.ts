/**
 * Backfill usage attribution onto the message log.
 *
 * WHY THIS EXISTS
 *
 * The attribution columns added by `20260916090000-AddMessageUsageAttribution`
 * are written at append time, so they are populated for turns that happen after
 * this code deploys — but the ~20,000 turns already in the log carry none of
 * them, so a report over existing history would show tokens with no provider, no
 * model and no cost. This script backfills those dimensions.
 *
 * It replaces `ingestHistoricalConversations.ts`, which had the same intent and
 * three defects that made its output unusable:
 *
 *   1. It read `usage.prompt_tokens` / `usage.input_tokens`. Every stored
 *      envelope uses the camelCase `promptTokens`, so **no row matched** and the
 *      next branch fired instead.
 *   2. Having found no usage, it estimated counts from content length
 *      (`completionTokens = len / 4`, `promptTokens = completionTokens * 2.5`)
 *      and stored them as though they were measured. That is fabricated billing
 *      data — strictly worse than a blank, because nothing downstream could tell
 *      the difference.
 *   3. It hardcoded `durationMs: 1200` and fell back to a fixed user ObjectId
 *      when a conversation had no owner, attributing one user's spend to another.
 *
 * This script measures; it does not invent. A row with no usage envelope is
 * marked `usage_source = 'none'` and contributes nothing. A model with no known
 * price leaves `cost_usd_cents` NULL — "unknown" — rather than 0, so reporting
 * can count it as a coverage gap instead of silently treating it as free.
 *
 * IDEMPOTENT: safe to re-run. Only NULL attribution columns are written, so a
 * turn already attributed by the live write path is never restated.
 *
 * USAGE
 *   npx ts-node src/modules/reactory-reactor/scripts/backfillUsageAttribution.ts [--dry-run]
 *
 * Requires MONGOOSE and the REACTORY_POSTGRES_* variables from `.env`.
 */

import mongoose from 'mongoose';
import { DataSource } from 'typeorm';
import ReactorConversationMessage from '../models/ReactorConversationMessage';
import {
  isLocalProvider,
  resolvePricingFromDatabase,
  resolvePricingFromStatic,
  type ModelPricing,
} from '../services/reactor/usagePricing';

const MONGODB_URI =
  process.env.MONGOOSE ||
  'mongodb://reactory:reactorycore@localhost:27017/reactory-reactory?authSource=admin';

const DRY_RUN = process.argv.includes('--dry-run');

/** Guarded `jsonb -> bigint`, mirroring the analytics service. */
const intFrom = (expression: string): string =>
  `CASE WHEN (${expression}) ~ '^[0-9]+$' THEN (${expression})::bigint ELSE 0 END`;

const buildDataSource = (): DataSource =>
  new DataSource({
    type: 'postgres',
    host: process.env.REACTORY_POSTGRES_HOST || process.env.POSTGRES_DB_HOST || 'localhost',
    port: parseInt(process.env.REACTORY_POSTGRES_PORT || process.env.POSTGRES_DB_PORT || '5432', 10),
    username: process.env.REACTORY_POSTGRES_USER || process.env.POSTGRES_USER || 'reactory',
    password: process.env.REACTORY_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'reactory',
    database: process.env.REACTORY_POSTGRES_DB || process.env.POSTGRES_DB || 'reactory',
    synchronize: false,
    entities: [ReactorConversationMessage],
  });

const run = async () => {
  console.log(`[backfill-usage] starting${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);

  const dataSource = buildDataSource();
  await dataSource.initialize();
  console.log('[backfill-usage] connected to PostgreSQL');

  await mongoose.connect(MONGODB_URI);
  console.log('[backfill-usage] connected to MongoDB');

  // ── 1. Dimensions, from the conversation session ─────────────────────────
  //
  // `reactor_conversations` is the only place that knows which provider/model a
  // historical turn was routed to, because the stored envelope was normalised by
  // the adapter and lost that. One pass over 200-odd sessions, then one UPDATE
  // per session — bounded and cheap.
  //
  // Read through the driver's collection handle rather than the Mongoose model.
  // The model barrel (`models/index.ts` -> `ReactorChatState`) pulls in the whole
  // module registry and every `@reactory/server-modules/...` alias with it, which
  // only resolves under the app's babel module-resolver — so importing it makes
  // this script unrunnable from a plain CLI.
  const conversations = await mongoose.connection.db! 
    .collection('reactor_conversations')
    .find(
      {},
      { projection: { user: 1, providerId: 1, modelId: 1, personaId: 1, use_case: 1 } }
    )
    .toArray();

  console.log(`[backfill-usage] ${conversations.length} conversations to attribute`);

  // Distinct pricing lookups, so a 20k-row backfill does not issue 20k queries.
  const pricingCache = new Map<string, ModelPricing | null>();
  const resolvePricing = async (
    modelId: string | null,
    providerId: string | null
  ): Promise<ModelPricing | null> => {
    const key = `${providerId ?? ''}::${modelId ?? ''}`;
    if (pricingCache.has(key)) return pricingCache.get(key) ?? null;

    let pricing: ModelPricing | null = null;
    if (isLocalProvider(providerId)) {
      pricing = { inputCostPerTokenUsdCents: 0, outputCostPerTokenUsdCents: 0, source: 'static' };
    } else {
      pricing =
        (await resolvePricingFromDatabase(dataSource, modelId, providerId)) ??
        resolvePricingFromStatic(modelId, providerId);
    }

    pricingCache.set(key, pricing);
    return pricing;
  };

  let attributedSessions = 0;
  let unattributableSessions = 0;
  let malformedSessions = 0;
  const unpricedModels = new Set<string>();

  for (const conversation of conversations as any[]) {
    const conversationId = String(conversation?._id ?? '').trim();
    if (!conversationId) {
      // One such session exists in production: a document whose `_id` is
      // literally null. It cannot address any message row, so it is reported
      // rather than silently dropped — a malformed session is a data defect
      // worth knowing about, and it currently hides a real conversation's cost.
      malformedSessions += 1;
      console.warn('[backfill-usage] skipping a conversation document with no _id');
      continue;
    }

    const userId = conversation?.user ? String(conversation.user).trim().slice(0, 24) : null;
    const providerId = conversation?.providerId
      ? String(conversation.providerId).trim().toLowerCase().slice(0, 128)
      : null;
    const modelId = conversation?.modelId ? String(conversation.modelId).trim().slice(0, 255) : null;
    const personaId = conversation?.personaId
      ? String(conversation.personaId).trim().slice(0, 128)
      : null;
    const useCase = conversation?.use_case
      ? String(conversation.use_case).trim().slice(0, 64)
      : 'standalone';

    if (!providerId || !modelId) {
      // Reporting this rather than defaulting to a provider: the previous
      // ingest silently assumed OpenAI-compatible here, which would mis-price
      // the turn. A gap the operator can see beats a number that is wrong.
      unattributableSessions += 1;
      console.warn(
        `[backfill-usage] conversation ${conversationId} has provider=${providerId ?? 'null'} ` +
          `model=${modelId ?? 'null'} — leaving unattributed`
      );
      continue;
    }

    const pricing = await resolvePricing(modelId, providerId);
    if (!pricing) {
      unpricedModels.add(`${providerId}/${modelId}`);
    }

    if (!DRY_RUN) {
      // Only NULL columns are written, so re-running never restates a turn the
      // live write path already attributed, and a corrected session document is
      // not applied over a value captured at the time.
      await dataSource.query(
        `UPDATE reactor_conversation_messages
            SET user_id             = COALESCE(user_id, $1),
                provider_id         = COALESCE(provider_id, $2),
                model_id            = COALESCE(model_id, $3),
                persona_id          = COALESCE(persona_id, $4),
                use_case            = COALESCE(use_case, $5),
                session_provider_id = COALESCE(session_provider_id, $2),
                session_model_id    = COALESCE(session_model_id, $3),
                usage_source        = CASE
                  WHEN usage_source IS NOT NULL THEN usage_source
                  WHEN provider_response -> 'usage' IS NULL THEN 'none'
                  ELSE 'provider'
                END
          WHERE conversation_id = $6
            AND role = 'assistant'`,
        [userId, providerId, modelId, personaId, useCase, conversationId]
      );
    }

    attributedSessions += 1;

    // ── 2. Cost, per priced model ──────────────────────────────────────────
    //
    // Expressed in SQL so the arithmetic runs over the whole partition in one
    // statement. A per-row JS loop over 20k rows would issue 20k round trips for
    // arithmetic Postgres can do for free.
    if (pricing) {
      const promptExpr = intFrom(
        `COALESCE(m.provider_response->'usage'->>'promptTokens',
                  m.provider_response->'usage'->>'prompt_tokens',
                  m.provider_response->'usage'->>'input_tokens', '0')`
      );
      const completionExpr = intFrom(
        `COALESCE(m.provider_response->'usage'->>'completionTokens',
                  m.provider_response->'usage'->>'completion_tokens',
                  m.provider_response->'usage'->>'output_tokens', '0')`
      );

      if (!DRY_RUN) {
        await dataSource.query(
          `UPDATE reactor_conversation_messages m
              SET cost_usd_cents = ROUND(
                    (${promptExpr} * $1::numeric) + (${completionExpr} * $2::numeric),
                    6
                  )
            WHERE m.conversation_id = $3
              AND m.role = 'assistant'
              AND m.provider_response -> 'usage' IS NOT NULL
              AND m.cost_usd_cents IS NULL`,
          [
            pricing.inputCostPerTokenUsdCents,
            pricing.outputCostPerTokenUsdCents,
            conversationId,
          ]
        );
      }
    }
  }

  // ── 3. Rows with no usage envelope ───────────────────────────────────────
  if (!DRY_RUN) {
    const result = await dataSource.query(
      `UPDATE reactor_conversation_messages
          SET usage_source = 'none'
        WHERE role = 'assistant'
          AND usage_source IS NULL
          AND provider_response -> 'usage' IS NULL`
    );
    console.log(`[backfill-usage] marked ${result?.[1] ?? 0} usage-less assistant rows as 'none'`);
  }

  // ── 4. Report ────────────────────────────────────────────────────────────
  const verification = await dataSource.query(
    `SELECT
       COUNT(*) FILTER (WHERE role = 'assistant')::bigint                    AS assistant_turns,
       COUNT(provider_id)::bigint                                            AS attributed,
       COUNT(cost_usd_cents)::bigint                                         AS priced,
       COALESCE(SUM(cost_usd_cents), 0)                                      AS total_cost_cents
     FROM reactor_conversation_messages`
  );

  const stats = verification?.[0] ?? {};
  console.log('');
  console.log('[backfill-usage] ── summary ─────────────────────────────');
  console.log(`  sessions attributed     : ${attributedSessions}`);
  console.log(`  sessions unattributable : ${unattributableSessions}`);
  console.log(`  sessions malformed      : ${malformedSessions}`);  console.log(`  assistant turns         : ${stats.assistant_turns ?? 0}`);
  console.log(`  attributed turns        : ${stats.attributed ?? 0}`);
  console.log(`  priced turns            : ${stats.priced ?? 0}`);
  console.log(
    `  total cost (USD)        : ${(Number(stats.total_cost_cents ?? 0) / 100).toFixed(4)}`
  );

  if (unpricedModels.size > 0) {
    console.log('');
    console.log('  UNPRICED MODELS — cost for these turns is excluded, not zero:');
    for (const model of [...unpricedModels].sort()) {
      console.log(`    - ${model}`);
    }
    console.log('  Add rates to reactory_ai_models (or providers.yaml) and re-run.');
  }

  console.log('[backfill-usage] ──────────────────────────────────────────');

  await mongoose.disconnect();
  await dataSource.destroy();
};

run().catch((error) => {
  console.error('[backfill-usage] failed:', error);
  process.exit(1);
});
