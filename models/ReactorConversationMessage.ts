import { ClientKeyColumn } from '../../../database/tenant/ClientKeyColumn';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Where a turn's token counts came from.
 *
 * `provider`  — reported by the provider in `provider_response.usage`. This is the
 *               only value safe to bill against.
 * `estimated` — derived from content length because the response carried no usage.
 *               Kept distinguishable so a fabricated figure is never presented as
 *               a measured one, and so reporting can exclude it on request. The
 *               legacy ingest script produced these silently; see
 *               `scripts/backfillUsageAttribution.ts`.
 * `none`      — no usage present and nothing to estimate from.
 */
export type UsageSource = 'provider' | 'estimated' | 'none';

/**
 * A single entry in a conversation's message log.
 *
 * Conversation *sessions* stay in MongoDB (`reactor_conversations`); the
 * append-heavy message log lives here so a long conversation cannot push the
 * session document toward the 16 MB BSON ceiling, and so windowed reads,
 * archive/compaction and search become indexed SQL rather than array rewrites.
 *
 * `mongo_id` preserves the `_id` the message carried while it lived in the
 * Mongo `history` array. That id is the paging cursor the client round-trips
 * (`historyWindow.oldestId` -> `before`), so keeping it stable is what lets the
 * read contract survive the cutover unchanged.
 */
/**
 * NOTE ON INDEXES
 *
 * Every index this table relies on is declared here, not only in the migration.
 * The runtime DataSource runs with `synchronize: true` outside production, and
 * TypeORM reconciles the schema against entity metadata - which means it DROPS
 * any index it cannot see declared. Indexes created only by migration SQL
 * therefore disappear on the next server start. That is exactly what happened to
 * the unique `(conversation_id, seq)` guard, and its absence let concurrent
 * appends collide on `MAX(seq)+1` and write duplicate `seq` values.
 *
 * The one exception is the `pg_trgm` GIN index on `search_text`, which TypeORM
 * cannot express and which is therefore migration-only (production runs with
 * `synchronize: false`, so it survives there).
 */
// Trigram index for ILIKE search over search_text. TypeORM cannot express a
// gin_trgm_ops index, so migrations own it; synchronize: false stops schema
// sync and migration:generate from dropping it as unknown. The unquoted name in
// the migration folds to lower case.
@Index('idx_rcm_search_text_trgm', { synchronize: false })
// Partial index for usage analytics (assistant turns with a usage envelope);
// the predicate reads JSONB, which TypeORM cannot express. Migration-owned.
@Index('idx_rcm_usage_turns_ts', { synchronize: false })
@Index('IDX_rcm_conv_archived_seq', ['conversationId', 'archived', 'seq'])
@Index('IDX_rcm_conv_role_seq', ['conversationId', 'role', 'seq'])
@Index('IDX_rcm_conv_seq', ['conversationId', 'seq'], { unique: true })
// Usage reporting scans. Declared on the entity rather than only in the migration
// because `synchronize` reconciles against entity metadata and drops anything it
// cannot see — the exact failure recorded in the index note above. Keyed on
// message_ts, the turn's own time: created_at is when the row was written, and
// the Mongo backfill wrote three months of history on one day.
@Index('IDX_rcm_usage_ts', ['messageTs'])
@Index('IDX_rcm_usage_user_ts', ['userId', 'messageTs'])
@Index('IDX_rcm_usage_provider_ts', ['providerId', 'messageTs'])
@Index('IDX_rcm_usage_model_ts', ['modelId', 'messageTs'])
@Entity({ name: 'reactor_conversation_messages' })
export default class ReactorConversationMessage {
  /** Internal row identity. Not exposed to clients; `mongoId` is. */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** Owning ReactoryClient key (WP-B2); stamped by the message store / analytics service. */
  @ClientKeyColumn()
  clientKey: string;

  /**
   * The Mongo subdocument `_id` this row originated from, or a freshly minted
   * 24-hex id for messages created after the cutover. Unique so backfill is
   * idempotent.
   */
  @Index('IDX_rcm_mongo_id', { unique: true, where: '"mongo_id" IS NOT NULL' })
  @Column({ name: 'mongo_id', type: 'char', length: 24, nullable: true })
  mongoId?: string | null;

  /** Mongo `_id` of the owning conversation session. */
  @Column({ name: 'conversation_id', type: 'char', length: 24 })
  conversationId: string;

  /**
   * Monotonic position within the conversation, assigned as `MAX(seq)+1`.
   * This is the only ordering source for a transcript; `messageTs` is purely
   * informational because wall clocks can skew between writers.
   */
  @Column({ name: 'seq', type: 'bigint' })
  seq: string;

  /** `system` | `user` | `assistant` | `tool`. */
  @Column({ name: 'role', type: 'varchar', length: 32 })
  role: string;

  /**
   * Message body. Stored as JSONB because a message may carry a plain string or
   * a provider content-part array. The service unwraps JSON strings on read.
   */
  @Column({ name: 'content', type: 'jsonb', nullable: true })
  content?: unknown;

  /** Flattened reasoning/thinking text. */
  @Column({ name: 'thinking', type: 'text', nullable: true })
  thinking?: string | null;

  /** Provider-native reasoning blocks, replayed verbatim where required. */
  @Column({ name: 'thinking_blocks', type: 'jsonb', nullable: true })
  thinkingBlocks?: unknown;

  /** Images generated by image-capable models. */
  @Column({ name: 'images', type: 'jsonb', nullable: true })
  images?: unknown;

  @Column({ name: 'refusal', type: 'text', nullable: true })
  refusal?: string | null;

  @Column({ name: 'tool_call_id', type: 'varchar', length: 255, nullable: true })
  toolCallId?: string | null;

  @Column({ name: 'tool_name', type: 'varchar', length: 255, nullable: true })
  toolName?: string | null;

  @Column({ name: 'tool_args', type: 'jsonb', nullable: true })
  toolArgs?: unknown;

  @Column({ name: 'tool_calls', type: 'jsonb', nullable: true })
  toolCalls?: unknown;

  @Column({ name: 'tool_results', type: 'jsonb', nullable: true })
  toolResults?: unknown;

  @Column({ name: 'tool_errors', type: 'jsonb', nullable: true })
  toolErrors?: unknown;

  /**
   * The full provider response envelope for the turn. Retained rather than
   * trimmed because token/cost analytics read `usage` from it.
   */
  @Column({ name: 'provider_response', type: 'jsonb', nullable: true })
  providerResponse?: unknown;

  @Column({ name: 'component', type: 'varchar', length: 255, nullable: true })
  component?: string | null;

  @Column({ name: 'rating', type: 'integer', nullable: true })
  rating?: number | null;

  @Column({ name: 'annotations', type: 'jsonb', nullable: true })
  annotations?: unknown;

  @Column({ name: 'audio', type: 'jsonb', nullable: true })
  audio?: unknown;

  // ───────────────────────────────────────────────────────────────────────────
  // Usage attribution
  //
  // Denormalised onto the row on purpose. At read time neither available source
  // can say which provider actually served a turn:
  //   - the adapters normalise every `providerResponse` to the OpenAI
  //     `chat.completion` shape, so no provider/model survives on the envelope;
  //   - `reactor_conversations`, which does carry `providerId`/`modelId`, lives
  //     in a different store and can hold a null provider.
  // Capturing the *routed* values here at append time is therefore the only
  // reliable basis for cost and per-provider reporting. See
  // `ReactorUsageAnalyticsService`.
  // ───────────────────────────────────────────────────────────────────────────

  /** Owner of the conversation, denormalised for per-user aggregation. */
  @Column({ name: 'user_id', type: 'char', length: 24, nullable: true })
  userId?: string | null;

  /**
   * Provider that actually served this turn, after routing overrides.
   * Lower-cased, matching the registry ids.
   */
  @Column({ name: 'provider_id', type: 'varchar', length: 128, nullable: true })
  providerId?: string | null;

  /** Model id that actually served this turn, after routing overrides. */
  @Column({ name: 'model_id', type: 'varchar', length: 255, nullable: true })
  modelId?: string | null;

  @Column({ name: 'persona_id', type: 'varchar', length: 128, nullable: true })
  personaId?: string | null;

  @Column({ name: 'use_case', type: 'varchar', length: 64, nullable: true })
  useCase?: string | null;

  /** Wall-clock duration of the provider call, for the latency metric. */
  @Column({ name: 'duration_ms', type: 'integer', nullable: true })
  durationMs?: number | null;

  /**
   * Cost of this turn in USD cents, priced at append time.
   *
   * Stored rather than derived so a later price-list change cannot retroactively
   * restate what a past turn cost — billing figures must be a snapshot. NULL
   * means "not priced" (an unknown model), which is deliberately distinct from
   * `0`, a genuinely free model.
   */
  @Column({ name: 'cost_usd_cents', type: 'numeric', precision: 18, scale: 6, nullable: true })
  costUsdCents?: number | null;

  /**
   * How the token counts were obtained. See {@link UsageSource}.
   *
   * Exists so an *estimated* figure can never be mistaken for a reported one:
   * the legacy ingest script fabricated counts from content length and billed
   * them as though they were real.
   */
  @Column({ name: 'usage_source', type: 'varchar', length: 16, nullable: true })
  usageSource?: string | null;

  /**
   * Provider declared on the session at the time of the turn.
   *
   * Retained alongside the routed value so a mis-route is detectable after the
   * fact: `providerId <> sessionProviderId` means the request did not go where
   * the conversation said it should.
   */
  @Column({ name: 'session_provider_id', type: 'varchar', length: 128, nullable: true })
  sessionProviderId?: string | null;

  /** Model declared on the session; see {@link sessionProviderId}. */
  @Column({ name: 'session_model_id', type: 'varchar', length: 255, nullable: true })
  sessionModelId?: string | null;

  /**
   * Prompt tokens the provider served from its cache.
   *
   * Captured because prompt caching changes the price by an order of magnitude:
   * charging a token the provider billed at its (cheap) cache-hit rate at the
   * full miss rate is what made cache-heavy turns read ~10x over their real
   * cost. NULL means "not reported" — distinct from 0, which says the provider
   * reported a genuine cache miss.
   */
  @Column({ name: 'cache_hit_tokens', type: 'integer', nullable: true })
  cacheHitTokens?: number | null;

  /** Prompt tokens NOT served from cache (billed at the full input rate). */
  @Column({ name: 'cache_miss_tokens', type: 'integer', nullable: true })
  cacheMissTokens?: number | null;

  /**
   * The `reactory_ai_model_pricing` row this turn was priced with.
   *
   * Provenance, so a stored cost is always reconcilable against the exact rate
   * in force when the turn completed — even after the price list changes. NULL
   * for an unpriced turn (unknown model) or a legacy row written before pricing
   * was versioned.
   */
  @Column({ name: 'pricing_id', type: 'uuid', nullable: true })
  pricingId?: string | null;

  /** When the turn was priced. See {@link pricingId}. */
  @Column({ name: 'priced_at', type: 'timestamp with time zone', nullable: true })
  pricedAt?: Date | null;

  /**
   * Flattened, searchable text derived from content (and thinking). Maintained
   * on write so session-list search is an indexed predicate rather than a
   * regex scan.
   */
  @Column({ name: 'search_text', type: 'text', nullable: true })
  searchText?: string | null;

  /**
   * True once the message has been displaced from the active context by
   * truncation or compaction. Archived rows are retained and remain visible to
   * the UI on request, so this is a client-visible attribute, not bookkeeping.
   */
  @Column({ name: 'archived', type: 'boolean', default: false })
  archived: boolean;

  @Column({ name: 'archived_at', type: 'timestamp with time zone', nullable: true })
  archivedAt?: Date | null;

  /** `truncated` | `compacted` | `cleared`. */
  @Column({ name: 'archived_reason', type: 'varchar', length: 64, nullable: true })
  archivedReason?: string | null;

  /**
   * When the message happened. Usage analytics report by this, not by
   * created_at, which is when the row was written (a backfill writes old
   * messages today). Never used to order a transcript; `seq` does that.
   * Defaults to now() when the message carries no timestamp.
   */
  @Column({ name: 'message_ts', type: 'timestamp with time zone', default: () => 'now()' })
  messageTs?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt: Date;
}
