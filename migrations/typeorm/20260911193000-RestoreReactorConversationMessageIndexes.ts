import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Restore the conversation-message indexes, including the unique
 * `(conversation_id, seq)` ordering guard.
 *
 * WHY THIS EXISTS
 *
 * The create-table migration declared these indexes in SQL only, but the runtime
 * DataSource runs with `synchronize: true` outside production and TypeORM
 * reconciles the schema against entity metadata - dropping any index it cannot
 * see declared on an entity. The four btree indexes therefore vanished on the
 * next server start.
 *
 * Losing `IDX_rcm_conv_seq` was the damaging part: without a unique constraint on
 * `(conversation_id, seq)`, two concurrent appends could both compute the same
 * `MAX(seq)+1` and succeed, writing duplicate `seq` values and corrupting the
 * transcript order.
 *
 * Two changes fix this properly:
 *   1. The indexes are now declared on the `ReactorConversationMessage` entity,
 *      so `synchronize` preserves them.
 *   2. This migration (re)creates them for databases that already lost them.
 *
 * Prerequisite: `seq` must be unique per conversation before the unique index can
 * be built. Run `bin/migrate-conversation-messages.sh resync` first - it re-derives
 * `seq` from the authoritative Mongo order.
 */
export class RestoreReactorConversationMessageIndexes20260911193000
  implements MigrationInterface
{
  name = "RestoreReactorConversationMessageIndexes20260911193000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Primary windowed read.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_conv_archived_seq ON reactor_conversation_messages (conversation_id, archived, seq)`
    );

    // Anchoring the window on the nearest `user` message.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_conv_role_seq ON reactor_conversation_messages (conversation_id, role, seq)`
    );

    // Ordering authority, and the guard against concurrent MAX(seq)+1 collisions.
    // Fails loudly if duplicates remain, which is the correct behaviour: silently
    // skipping it would re-introduce the corruption this migration exists to fix.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS IDX_rcm_conv_seq ON reactor_conversation_messages (conversation_id, seq)`
    );

    // Idempotent backfill / cursor continuity.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS IDX_rcm_mongo_id ON reactor_conversation_messages (mongo_id) WHERE mongo_id IS NOT NULL`
    );

    // Search over message text. GIN/trigram cannot be expressed on the TypeORM
    // entity, so this one is migration-only; production runs with
    // `synchronize: false`, so it persists there.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_search_text_trgm ON reactor_conversation_messages USING gin (search_text gin_trgm_ops)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_search_text_trgm`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_conv_role_seq`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_conv_archived_seq`);
    // The unique seq guard and mongo_id index are load-bearing for correctness;
    // reverting leaves them in place deliberately.
  }
}
