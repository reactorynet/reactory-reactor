import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the Postgres message log backing conversations.
 *
 * Conversations keep their session metadata in MongoDB; only the append-heavy
 * message history moves here. See the Phase 3 migration design for the full
 * rationale.
 *
 * `IF NOT EXISTS` throughout so the migration is a no-op in environments where
 * `synchronize` already created the table from the entity.
 */
export class CreateReactorConversationMessagesTable20260911150000 implements MigrationInterface {
  name = "CreateReactorConversationMessagesTable20260911150000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Trigram indexes make `ILIKE '%term%'` search over message text indexed.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS reactor_conversation_messages (
        id BIGSERIAL PRIMARY KEY,
        mongo_id CHAR(24) NULL,
        conversation_id CHAR(24) NOT NULL,
        seq BIGINT NOT NULL,
        role VARCHAR(32) NOT NULL,
        content JSONB NULL,
        thinking TEXT NULL,
        thinking_blocks JSONB NULL,
        images JSONB NULL,
        refusal TEXT NULL,
        tool_call_id VARCHAR(255) NULL,
        tool_name VARCHAR(255) NULL,
        tool_args JSONB NULL,
        tool_calls JSONB NULL,
        tool_results JSONB NULL,
        tool_errors JSONB NULL,
        provider_response JSONB NULL,
        component VARCHAR(255) NULL,
        rating INTEGER NULL,
        annotations JSONB NULL,
        audio JSONB NULL,
        search_text TEXT NULL,
        archived BOOLEAN NOT NULL DEFAULT false,
        archived_at TIMESTAMPTZ NULL,
        archived_reason VARCHAR(64) NULL,
        message_ts TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Primary windowed read: newest N messages of a conversation by state.
    // Ascending btree; Postgres scans it backwards for `ORDER BY seq DESC`.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_conv_archived_seq ON reactor_conversation_messages (conversation_id, archived, seq)`
    );

    // Anchoring the window on the nearest `user` message.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_conv_role_seq ON reactor_conversation_messages (conversation_id, role, seq)`
    );

    // Ordering authority within a conversation; also guards MAX(seq)+1 races.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS IDX_rcm_conv_seq ON reactor_conversation_messages (conversation_id, seq)`
    );

    // Makes backfill idempotent and preserves cursor continuity across cutover.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS IDX_rcm_mongo_id ON reactor_conversation_messages (mongo_id) WHERE mongo_id IS NOT NULL`
    );

    // Session-list search predicate.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_rcm_search_text_trgm ON reactor_conversation_messages USING gin (search_text gin_trgm_ops)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_search_text_trgm`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_mongo_id`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_conv_seq`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_conv_role_seq`);
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_rcm_conv_archived_seq`);
    await queryRunner.query(`DROP TABLE IF EXISTS reactor_conversation_messages`);
    // pg_trgm is intentionally left installed: other tables may rely on it and
    // dropping an extension is not safely reversible.
  }
}
