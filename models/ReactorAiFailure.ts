import { ClientKeyColumn } from '../../../database/tenant/ClientKeyColumn';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * A failed AI turn.
 *
 * WHY THIS IS A SEPARATE TABLE AND NOT A ROW IN THE MESSAGE LOG
 *
 * Usage reporting needs to answer "how often does the AI fail, and on which
 * provider?". Before this, it could not answer either: `errorCount` was
 * structurally 0 because only successful turns were ever recorded anywhere.
 *
 * The obvious-looking fix — write a failed turn into `reactor_conversation_messages`
 * as a row with `status: 'error'` — is the wrong shape, for two reasons:
 *
 *  1. **That table is the transcript.** A failed turn produced no assistant output,
 *     so it is not part of the conversation. Every transcript read would have to
 *     learn to exclude it, or the model would be handed a "message" that no user
 *     or assistant ever sent. That is a wide blast radius across windowing,
 *     paging, search, context assembly and compaction for a row that is not
 *     conversation.
 *
 *  2. **It has no usage.** Every aggregation over that table is built around
 *     `provider_response -> 'usage'`. A usage-less error row would need special
 *     handling in each of them: excluded from token sums, excluded from cost,
 *     included in the error count, excluded from the ledger's token columns.
 *
 * A separate table has neither problem. The transcript is untouched by
 * construction, and the failure aggregation is purely additive.
 *
 * The dimension columns deliberately mirror the message attribution (`user_id`,
 * `provider_id`, `model_id`, `persona_id`, `use_case`) so an error rate can be
 * computed per provider and per model — which is the actionable form of the
 * question. "40 errors" is not actionable; "6% of google turns failed" is.
 */
/** Declared on the entity as well as in the migration — see the note in ReactorConversationMessage. */
@Index('IDX_rai_fail_created', ['createdAt'])
@Index('IDX_rai_fail_provider_created', ['providerId', 'createdAt'])
@Index('IDX_rai_fail_model_created', ['modelId', 'createdAt'])
@Index('IDX_rai_fail_user_created', ['userId', 'createdAt'])
@Entity({ name: 'reactor_ai_failures' })
export default class ReactorAiFailure {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** Owning ReactoryClient key (WP-B2); stamped by the message store / analytics service. */
  @ClientKeyColumn()
  clientKey: string;

  /** Owner of the conversation the turn belonged to, when known. */
  @Column({ name: 'user_id', type: 'char', length: 24, nullable: true })
  userId?: string | null;

  /** Mongo `_id` of the conversation, when the failure happened inside one. */
  @Column({ name: 'conversation_id', type: 'char', length: 24, nullable: true })
  conversationId?: string | null;

  @Column({ name: 'persona_id', type: 'varchar', length: 128, nullable: true })
  personaId?: string | null;

  /**
   * Provider that was being used when the turn failed. Lower-cased, matching the
   * usage attribution so the two can be grouped together.
   */
  @Column({ name: 'provider_id', type: 'varchar', length: 128, nullable: true })
  providerId?: string | null;

  @Column({ name: 'model_id', type: 'varchar', length: 255, nullable: true })
  modelId?: string | null;

  @Column({ name: 'use_case', type: 'varchar', length: 64, nullable: true })
  useCase?: string | null;

  /**
   * Classification of the failure. Kept as a code rather than inferred from the
   * message, which is free text and varies by provider SDK.
   */
  @Column({ name: 'error_code', type: 'varchar', length: 64, nullable: true })
  errorCode?: string | null;

  /**
   * The error message, truncated.
   *
   * Bounded because provider messages can be arbitrarily long (and can carry
   * request echoes). A bounded excerpt is enough to triage; the full text lives in
   * the session log for the turn.
   */
  @Column({ name: 'error_message', type: 'varchar', length: 1000, nullable: true })
  errorMessage?: string | null;

  /**
   * Whether the failure was judged retryable at the time.
   *
   * Stored because it partitions the failures usefully: a corpus of retryable
   * failures that exhausted their retries is an availability problem, whereas
   * non-retryable failures are usually a request or configuration problem.
   */
  @Column({ name: 'retryable', type: 'boolean', nullable: true })
  retryable?: boolean | null;

  /** How many attempts were made before giving up. */
  @Column({ name: 'attempts', type: 'integer', nullable: true })
  attempts?: number | null;

  /** Wall-clock duration of the failed turn, when measurable. */
  @Column({ name: 'duration_ms', type: 'integer', nullable: true })
  durationMs?: number | null;

  /** Whether this was a client-tool continuation rather than a user turn. */
  @Column({ name: 'turn_kind', type: 'varchar', length: 32, nullable: true })
  turnKind?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;
}
