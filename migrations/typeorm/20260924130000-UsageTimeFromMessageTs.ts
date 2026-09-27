import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Usage analytics report by message_ts, the turn's own time, not created_at,
 * the time the row was written. The Mongo-to-Postgres backfill wrote messages
 * from June to September with created_at 2026-09-16, so every report put three
 * months of usage on one day.
 *
 * message_ts becomes NOT NULL with default now() (backfilled from created_at
 * where a message carried no timestamp), and the usage indexes move to it.
 *
 * On a large table the index builds block writes for their duration; schedule
 * accordingly.
 */
const PARTIAL_USAGE_PREDICATE = `(((role)::text = 'assistant'::text) AND ((provider_response -> 'usage'::text) IS NOT NULL))`;

export class UsageTimeFromMessageTs20260924130000 implements MigrationInterface {
    name = 'UsageTimeFromMessageTs20260924130000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "reactor_conversation_messages" SET "message_ts" = "created_at" WHERE "message_ts" IS NULL`);
        await queryRunner.query(`ALTER TABLE "reactor_conversation_messages" ALTER COLUMN "message_ts" SET DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "reactor_conversation_messages" ALTER COLUMN "message_ts" SET NOT NULL`);

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_ts" ON "reactor_conversation_messages" ("message_ts")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_user_ts" ON "reactor_conversation_messages" ("user_id", "message_ts")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_provider_ts" ON "reactor_conversation_messages" ("provider_id", "message_ts")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_model_ts" ON "reactor_conversation_messages" ("model_id", "message_ts")`);
        // Migration-owned: TypeORM cannot express the JSONB predicate.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_rcm_usage_turns_ts ON "reactor_conversation_messages" ("message_ts") WHERE ${PARTIAL_USAGE_PREDICATE}`);

        await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_rcm_usage_turns"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_rcm_usage_created"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_rcm_usage_user_created"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_rcm_usage_provider_created"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_rcm_usage_model_created"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_created" ON "reactor_conversation_messages" ("created_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_user_created" ON "reactor_conversation_messages" ("user_id", "created_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_provider_created" ON "reactor_conversation_messages" ("provider_id", "created_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_model_created" ON "reactor_conversation_messages" ("model_id", "created_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_rcm_usage_turns ON "reactor_conversation_messages" ("created_at") WHERE ${PARTIAL_USAGE_PREDICATE}`);

        await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_rcm_usage_turns_ts"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_rcm_usage_model_ts"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_rcm_usage_provider_ts"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_rcm_usage_user_ts"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_rcm_usage_ts"`);

        await queryRunner.query(`ALTER TABLE "reactor_conversation_messages" ALTER COLUMN "message_ts" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "reactor_conversation_messages" ALTER COLUMN "message_ts" DROP DEFAULT`);
    }

}
