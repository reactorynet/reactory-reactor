import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * reactory-reactor baseline (WP-B3). Generated with `typeorm migration:generate` from
 * the entities, then made idempotent so that every existing database can adopt
 * it. Until now every database was built by `synchronize`, so it already
 * matches the entities:
 *   - CREATE TABLE / INDEX use IF NOT EXISTS
 *   - enum types and constraints are created only when absent
 *   - indexes that differ from the entity only by name are renamed in place
 *     (not rebuilt); where both names exist, e.g. because the earlier reactor
 *     migrations ran on a synchronized database, the duplicate is dropped
 * On an empty database it creates the full schema. On a database that already
 * has it, it only records itself in the migrations table.
 */

export class ReactorBaseline20260923120000 implements MigrationInterface {
    name = 'ReactorBaseline20260923120000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE EXTENSION IF NOT EXISTS "uuid-ossp"
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rcm_conv_archived_seq"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rcm_conv_archived_seq"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rcm_conv_archived_seq";
                    ELSE
                        ALTER INDEX "public"."idx_rcm_conv_archived_seq" RENAME TO "IDX_rcm_conv_archived_seq";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rcm_conv_role_seq"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rcm_conv_role_seq"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rcm_conv_role_seq";
                    ELSE
                        ALTER INDEX "public"."idx_rcm_conv_role_seq" RENAME TO "IDX_rcm_conv_role_seq";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rcm_conv_seq"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rcm_conv_seq"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rcm_conv_seq";
                    ELSE
                        ALTER INDEX "public"."idx_rcm_conv_seq" RENAME TO "IDX_rcm_conv_seq";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rcm_mongo_id"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rcm_mongo_id"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rcm_mongo_id";
                    ELSE
                        ALTER INDEX "public"."idx_rcm_mongo_id" RENAME TO "IDX_rcm_mongo_id";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rcm_usage_created"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rcm_usage_created"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rcm_usage_created";
                    ELSE
                        ALTER INDEX "public"."idx_rcm_usage_created" RENAME TO "IDX_rcm_usage_created";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rcm_usage_user_created"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rcm_usage_user_created"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rcm_usage_user_created";
                    ELSE
                        ALTER INDEX "public"."idx_rcm_usage_user_created" RENAME TO "IDX_rcm_usage_user_created";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rcm_usage_provider_created"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rcm_usage_provider_created"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rcm_usage_provider_created";
                    ELSE
                        ALTER INDEX "public"."idx_rcm_usage_provider_created" RENAME TO "IDX_rcm_usage_provider_created";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rcm_usage_model_created"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rcm_usage_model_created"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rcm_usage_model_created";
                    ELSE
                        ALTER INDEX "public"."idx_rcm_usage_model_created" RENAME TO "IDX_rcm_usage_model_created";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rai_fail_created"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rai_fail_created"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rai_fail_created";
                    ELSE
                        ALTER INDEX "public"."idx_rai_fail_created" RENAME TO "IDX_rai_fail_created";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rai_fail_provider_created"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rai_fail_provider_created"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rai_fail_provider_created";
                    ELSE
                        ALTER INDEX "public"."idx_rai_fail_provider_created" RENAME TO "IDX_rai_fail_provider_created";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rai_fail_model_created"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rai_fail_model_created"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rai_fail_model_created";
                    ELSE
                        ALTER INDEX "public"."idx_rai_fail_model_created" RENAME TO "IDX_rai_fail_model_created";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF to_regclass('public."idx_rai_fail_user_created"') IS NOT NULL THEN
                    IF to_regclass('public."IDX_rai_fail_user_created"') IS NOT NULL THEN
                        DROP INDEX "public"."idx_rai_fail_user_created";
                    ELSE
                        ALTER INDEX "public"."idx_rai_fail_user_created" RENAME TO "IDX_rai_fail_user_created";
                    END IF;
                END IF;
            END $$
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "reactory_ai_models" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "modelKey" character varying(100) NOT NULL,
                "providerId" character varying(64) NOT NULL,
                "name" character varying(255) NOT NULL,
                "version" character varying(50),
                "contextLength" integer,
                "maxOutputTokens" integer,
                "capabilities" text array NOT NULL DEFAULT '{}',
                "supportsStreaming" boolean NOT NULL DEFAULT true,
                "supportedTools" text array NOT NULL DEFAULT '{function-calling}',
                "supportedMediaTypes" text array NOT NULL DEFAULT '{text}',
                "inputCostPerTokenUsdCents" numeric(12, 8),
                "outputCostPerTokenUsdCents" numeric(12, 8),
                "costPerToken" numeric(12, 8),
                "rpm" integer,
                "itpm" integer,
                "otpm" integer,
                "maxParallelRequests" integer,
                "samplingConfig" jsonb,
                "thinkingConfig" jsonb,
                "isEnabled" boolean NOT NULL DEFAULT true,
                "sortOrder" integer NOT NULL DEFAULT '0',
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_8628b67c5ad0241f4ef4b543d6b" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_3eea2af63c1fdb1e4a61917e57" ON "reactory_ai_models" ("providerId")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_1962734dc5ab6b82c78f760d21" ON "reactory_ai_models" ("providerId", "modelKey")
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "reactory_ai_providers" (
                "id" character varying(64) NOT NULL,
                "name" character varying(255) NOT NULL,
                "description" text,
                "providerType" character varying(50) NOT NULL DEFAULT 'custom',
                "endpointUrl" character varying(500),
                "apiVersion" character varying(50),
                "authComponentFqn" character varying(255),
                "defaultModelId" character varying(100),
                "credentialRequirements" jsonb NOT NULL DEFAULT '[]',
                "credentialEnvVars" jsonb NOT NULL DEFAULT '{}',
                "capabilities" text array NOT NULL DEFAULT '{}',
                "roles" text array NOT NULL DEFAULT '{USER}',
                "rateLimits" jsonb,
                "status" jsonb NOT NULL DEFAULT '{}',
                "isEnabled" boolean NOT NULL DEFAULT true,
                "isSystem" boolean NOT NULL DEFAULT false,
                "organizationId" character varying(64),
                "createdBy" character varying(64),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_b4e5a599b812facdee9c8f4c728" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_6bb3fa8c879e5eaa30e431a7f3" ON "reactory_ai_providers" ("organizationId")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rcm_mongo_id" ON "reactor_conversation_messages" ("mongo_id")
            WHERE "mongo_id" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_model_created" ON "reactor_conversation_messages" ("model_id", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_provider_created" ON "reactor_conversation_messages" ("provider_id", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_user_created" ON "reactor_conversation_messages" ("user_id", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rcm_usage_created" ON "reactor_conversation_messages" ("created_at")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rcm_conv_seq" ON "reactor_conversation_messages" ("conversation_id", "seq")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rcm_conv_role_seq" ON "reactor_conversation_messages" ("conversation_id", "role", "seq")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rcm_conv_archived_seq" ON "reactor_conversation_messages" ("conversation_id", "archived", "seq")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rai_fail_user_created" ON "reactor_ai_failures" ("user_id", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rai_fail_model_created" ON "reactor_ai_failures" ("model_id", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rai_fail_provider_created" ON "reactor_ai_failures" ("provider_id", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rai_fail_created" ON "reactor_ai_failures" ("created_at")
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_3eea2af63c1fdb1e4a61917e57d') THEN
                    ALTER TABLE "reactory_ai_models"
            ADD CONSTRAINT "FK_3eea2af63c1fdb1e4a61917e57d" FOREIGN KEY ("providerId") REFERENCES "reactory_ai_providers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
                END IF;
            END $$
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "reactory_ai_models" DROP CONSTRAINT "FK_3eea2af63c1fdb1e4a61917e57d"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rai_fail_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rai_fail_provider_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rai_fail_model_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rai_fail_user_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rcm_conv_archived_seq"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rcm_conv_role_seq"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rcm_conv_seq"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rcm_usage_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rcm_usage_user_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rcm_usage_provider_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rcm_usage_model_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_rcm_mongo_id"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_6bb3fa8c879e5eaa30e431a7f3"
        `);
        await queryRunner.query(`
            DROP TABLE "reactory_ai_providers"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_1962734dc5ab6b82c78f760d21"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_3eea2af63c1fdb1e4a61917e57"
        `);
        await queryRunner.query(`
            DROP TABLE "reactory_ai_models"
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_rai_fail_user_created" ON "reactor_ai_failures" ("created_at", "user_id")
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_rai_fail_model_created" ON "reactor_ai_failures" ("created_at", "model_id")
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_rai_fail_provider_created" ON "reactor_ai_failures" ("created_at", "provider_id")
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_rai_fail_created" ON "reactor_ai_failures" ("created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_rcm_usage_model_created" ON "reactor_conversation_messages" ("created_at", "model_id")
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_rcm_usage_provider_created" ON "reactor_conversation_messages" ("created_at", "provider_id")
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_rcm_usage_user_created" ON "reactor_conversation_messages" ("created_at", "user_id")
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_rcm_usage_created" ON "reactor_conversation_messages" ("created_at")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_rcm_mongo_id" ON "reactor_conversation_messages" ("mongo_id")
            WHERE (mongo_id IS NOT NULL)
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_rcm_conv_seq" ON "reactor_conversation_messages" ("conversation_id", "seq")
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_rcm_conv_role_seq" ON "reactor_conversation_messages" ("conversation_id", "role", "seq")
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_rcm_conv_archived_seq" ON "reactor_conversation_messages" ("archived", "conversation_id", "seq")
        `);
    }

}
