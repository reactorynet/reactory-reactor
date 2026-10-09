import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Cache-aware, historical model pricing.
 *
 * Three related changes, all additive:
 *
 *  1. `reactory_ai_model_pricing` — an append-only price list (see the entity
 *     for why it is separate from `reactory_ai_models`). A price change appends
 *     a row; the current price is the latest `effective_from`.
 *  2. Cache rates on `reactory_ai_models` — the admin mirror gains the hit/miss
 *     rates so the editor can set them; the history table remains the source of
 *     truth for pricing.
 *  3. Cache + pricing-provenance columns on `reactor_conversation_messages` —
 *     the token split and the `pricing_id` used to price the turn, so a stored
 *     cost can always be reconciled against the rate that produced it.
 *
 * Existing message rows are untouched (NULL): there is no historical cache data
 * to reconstruct — the providers' cache fields were never captured — so those
 * turns keep their single-rate cost and simply carry no `pricing_id`.
 */
export class AddModelPricingHistory20261004120000 implements MigrationInterface {
  name = "AddModelPricingHistory20261004120000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Append-only price list ───────────────────────────────────────────
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS reactory_ai_model_pricing (
         id                              UUID            DEFAULT gen_random_uuid() PRIMARY KEY,
         "modelKey"                      VARCHAR(100)    NOT NULL,
         "providerId"                    VARCHAR(64)     NOT NULL,
         currency                        VARCHAR(8)      NOT NULL DEFAULT 'USD',
         "inputCostPerTokenUsdCents"     NUMERIC(18,10)  NULL,
         "outputCostPerTokenUsdCents"    NUMERIC(18,10)  NULL,
         "cacheHitCostPerTokenUsdCents"  NUMERIC(18,10)  NULL,
         "cacheMissCostPerTokenUsdCents" NUMERIC(18,10)  NULL,
         effective_from                  TIMESTAMPTZ     NOT NULL DEFAULT now(),
         created_at                      TIMESTAMPTZ     NOT NULL DEFAULT now(),
         updated_at                      TIMESTAMPTZ     NOT NULL DEFAULT now()
       )`
    );

    // Latest-price lookup: (providerId, modelKey) ordered by effective_from.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_raimp_lookup
         ON reactory_ai_model_pricing ("providerId", "modelKey", effective_from DESC)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_raimp_provider
         ON reactory_ai_model_pricing ("providerId")`
    );

    // ── 2. Cache rates on the admin mirror ──────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE reactory_ai_models
         ADD COLUMN IF NOT EXISTS "cacheHitCostPerTokenUsdCents"  NUMERIC(18,10) NULL,
         ADD COLUMN IF NOT EXISTS "cacheMissCostPerTokenUsdCents" NUMERIC(18,10) NULL`
    );

    // ── 3. Cache split + pricing provenance on the turn ─────────────────────
    await queryRunner.query(
      `ALTER TABLE reactor_conversation_messages
         ADD COLUMN IF NOT EXISTS cache_hit_tokens  INTEGER      NULL,
         ADD COLUMN IF NOT EXISTS cache_miss_tokens INTEGER      NULL,
         ADD COLUMN IF NOT EXISTS pricing_id        UUID         NULL,
         ADD COLUMN IF NOT EXISTS priced_at         TIMESTAMPTZ  NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE reactor_conversation_messages
         DROP COLUMN IF EXISTS priced_at,
         DROP COLUMN IF EXISTS pricing_id,
         DROP COLUMN IF EXISTS cache_miss_tokens,
         DROP COLUMN IF EXISTS cache_hit_tokens`
    );

    await queryRunner.query(
      `ALTER TABLE reactory_ai_models
         DROP COLUMN IF EXISTS "cacheMissCostPerTokenUsdCents",
         DROP COLUMN IF EXISTS "cacheHitCostPerTokenUsdCents"`
    );

    await queryRunner.query(`DROP INDEX IF EXISTS IDX_raimp_provider`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_raimp_lookup`);
    await queryRunner.query(`DROP TABLE IF EXISTS reactory_ai_model_pricing`);
  }
}
