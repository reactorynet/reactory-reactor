import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Add usage-attribution columns to `reactor_conversation_messages`.
 *
 * WHY THIS EXISTS
 *
 * The AI usage dashboard reported nothing real: its backing ledger
 * (`reactor_ai_usages`) was empty, so the form rendered hardcoded fixtures. The
 * obvious replacement — derive usage from the message log — is blocked by two
 * facts established on 2026-09-16:
 *
 *   1. The provider adapters normalise every `provider_response` to the OpenAI
 *      `chat.completion` shape. Verified across all 20,710 stored envelopes:
 *      keys are exactly `choices, created, id, images, object, __reasoning,
 *      usage`. No `provider` and no `model` survives, so the envelope alone
 *      cannot attribute a turn.
 *   2. `reactor_conversations` (Mongo) does carry `providerId`/`modelId`, but it
 *      is a different store and can hold a null provider — one such session
 *      exists. Joining across stores would price a mis-routed call with the
 *      wrong provider's rates, silently.
 *
 * The routed provider and model are therefore captured on the row at append
 * time, from the values the router actually resolved. The measures themselves
 * stay where they belong — `provider_response -> 'usage'` — so token counts are
 * never duplicated; these columns carry only the dimensions.
 *
 * `session_provider_id` / `session_model_id` are kept alongside so a divergence
 * (`provider_id <> session_provider_id`) is detectable after the fact.
 *
 * `usage_source` distinguishes a provider-reported count from an estimated one,
 * because the legacy ingest script fabricated counts from content length and
 * presented them as measurements.
 *
 * These indexes are also declared on the `ReactorConversationMessage` entity.
 * That is not redundant: the runtime DataSource runs with `synchronize: true`
 * outside production and TypeORM reconciles the schema against entity metadata,
 * dropping any index it cannot see declared. That is exactly how
 * `IDX_rcm_conv_seq` was lost before, so the same mistake is not repeated here.
 */
export class AddMessageUsageAttribution20260916090000
  implements MigrationInterface
{
  name = "AddMessageUsageAttribution20260916090000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Dimensions only. Measures continue to come from
    // `provider_response -> 'usage'`, which every assistant turn already carries.
    await queryRunner.query(
      `ALTER TABLE reactor_conversation_messages
         ADD COLUMN IF NOT EXISTS user_id            CHAR(24)        NULL,
         ADD COLUMN IF NOT EXISTS provider_id        VARCHAR(128)    NULL,
         ADD COLUMN IF NOT EXISTS model_id           VARCHAR(255)    NULL,
         ADD COLUMN IF NOT EXISTS persona_id         VARCHAR(128)    NULL,
         ADD COLUMN IF NOT EXISTS use_case           VARCHAR(64)     NULL,
         ADD COLUMN IF NOT EXISTS duration_ms        INTEGER         NULL,
         ADD COLUMN IF NOT EXISTS cost_usd_cents     NUMERIC(18,6)   NULL,
         ADD COLUMN IF NOT EXISTS usage_source       VARCHAR(16)     NULL,
         ADD COLUMN IF NOT EXISTS session_provider_id VARCHAR(128)   NULL,
         ADD COLUMN IF NOT EXISTS session_model_id   VARCHAR(255)    NULL`
    );

    // Time-windowed totals and the daily time series.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_usage_created
         ON reactor_conversation_messages (created_at)`
    );

    // Per-user breakdown and the /admin/ai/usage/:userId drill-down.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_usage_user_created
         ON reactor_conversation_messages (user_id, created_at)`
    );

    // Provider breakdown.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_usage_provider_created
         ON reactor_conversation_messages (provider_id, created_at)`
    );

    // Model breakdown.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_usage_model_created
         ON reactor_conversation_messages (model_id, created_at)`
    );

    // Partial index over the only rows analytics ever reads: assistant turns
    // carrying a usage envelope. Keeps the aggregation index-only for the
    // predicate and avoids scanning the ~22k tool rows entirely.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_usage_turns
         ON reactor_conversation_messages (created_at)
         WHERE role = 'assistant' AND provider_response -> 'usage' IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_usage_turns`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_usage_model_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_usage_provider_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_usage_user_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_usage_created`);

    await queryRunner.query(
      `ALTER TABLE reactor_conversation_messages
         DROP COLUMN IF EXISTS session_model_id,
         DROP COLUMN IF EXISTS session_provider_id,
         DROP COLUMN IF EXISTS usage_source,
         DROP COLUMN IF EXISTS cost_usd_cents,
         DROP COLUMN IF EXISTS duration_ms,
         DROP COLUMN IF EXISTS use_case,
         DROP COLUMN IF EXISTS persona_id,
         DROP COLUMN IF EXISTS model_id,
         DROP COLUMN IF EXISTS provider_id,
         DROP COLUMN IF EXISTS user_id`
    );
  }
}
