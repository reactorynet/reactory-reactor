import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * WP-B2: tenant key (client_key) on the reactor message log and AI failures.
 * Add nullable, backfill with REACTOR_TENANT_BACKFILL_KEY (default
 * "reactory": every existing conversation ran inside that client), then
 * NOT NULL.
 */
const backfillKey = (): string => process.env.REACTOR_TENANT_BACKFILL_KEY || "reactory";

export class ClientKeyTenancy20260924110000 implements MigrationInterface {
    name = 'ClientKeyTenancy20260924110000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        const key = backfillKey();
        for (const table of ["reactor_conversation_messages", "reactor_ai_failures"]) {
            await queryRunner.query(`ALTER TABLE "${table}" ADD "client_key" character varying(255)`);
            // Every existing conversation ran inside the reactory client.
            await queryRunner.query(`UPDATE "${table}" SET "client_key" = $1 WHERE "client_key" IS NULL`, [key]);
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "client_key" SET NOT NULL`);
        }
        await queryRunner.query(`CREATE INDEX "IDX_7624706ee41cdb950ce1eb7782" ON "reactor_conversation_messages" ("client_key")`);
        await queryRunner.query(`CREATE INDEX "IDX_3df4009e6d1c883de93fed3152" ON "reactor_ai_failures" ("client_key")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."IDX_3df4009e6d1c883de93fed3152"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_7624706ee41cdb950ce1eb7782"
        `);
        await queryRunner.query(`
            ALTER TABLE "reactor_ai_failures" DROP COLUMN "client_key"
        `);
        await queryRunner.query(`
            ALTER TABLE "reactor_conversation_messages" DROP COLUMN "client_key"
        `);
    }

}
