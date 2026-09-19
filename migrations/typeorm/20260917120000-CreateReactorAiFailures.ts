import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Create `reactor_ai_failures`.
 *
 * WHY THIS EXISTS
 *
 * The usage dashboard reports `errorCount`, and it was structurally always zero.
 * Not by oversight in the query — by construction: `recordUsage` only ever ran on
 * the success path, and the message log only holds completed turns. A turn that
 * failed left no trace anywhere, so the one dashboard meant to reveal "the AI is
 * failing" could not.
 *
 * The fix is an attribution path for failed turns. The design choice — a dedicated
 * table rather than rows in `reactor_conversation_messages` — is argued in full on
 * the `ReactorAiFailure` entity. In short: the message table is the transcript, a
 * failed turn is not part of it and has no usage, and putting it there would force
 * every read path to learn to exclude it and every usage aggregation to include it
 * under different rules. A separate table is purely additive.
 *
 * Indexes are also declared on the entity, for the reason recorded in
 * `ReactorConversationMessage`: the runtime DataSource runs with `synchronize: true`
 * outside production and drops any index it cannot see declared on an entity.
 */
export class CreateReactorAiFailures20260917120000 implements MigrationInterface {
  name = "CreateReactorAiFailures20260917120000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS reactor_ai_failures (
         id              BIGSERIAL       PRIMARY KEY,
         user_id         CHAR(24)        NULL,
         conversation_id CHAR(24)        NULL,
         persona_id      VARCHAR(128)    NULL,
         provider_id     VARCHAR(128)    NULL,
         model_id        VARCHAR(255)    NULL,
         use_case        VARCHAR(64)     NULL,
         error_code      VARCHAR(64)     NULL,
         error_message   VARCHAR(1000)   NULL,
         retryable       BOOLEAN         NULL,
         attempts        INTEGER         NULL,
         duration_ms     INTEGER         NULL,
         turn_kind       VARCHAR(32)     NULL,
         created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
       )`
    );

    // Time-windowed error counts and the error rate: the window is always a date
    // range, so every query leads with `created_at`.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rai_fail_created
         ON reactor_ai_failures (created_at)`
    );

    // Error rate and error count *per provider* — the actionable form of the
    // question. "40 errors" is not actionable; "6% of google turns failed" is.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rai_fail_provider_created
         ON reactor_ai_failures (provider_id, created_at)`
    );

    // Same, per model: a single bad model shows up here before it shows up
    // anywhere else.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rai_fail_model_created
         ON reactor_ai_failures (model_id, created_at)`
    );

    // Per-user failure view, matching the reasoning for the user breakdown on
    // successful turns.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rai_fail_user_created
         ON reactor_ai_failures (user_id, created_at)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rai_fail_user_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rai_fail_model_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rai_fail_provider_created`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rai_fail_created`);
    await queryRunner.query(`DROP TABLE IF EXISTS reactor_ai_failures`);
  }
}
