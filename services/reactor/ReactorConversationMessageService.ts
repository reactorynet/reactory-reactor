import { DataSource, Repository } from 'typeorm';
import { ObjectId } from 'mongodb';
import ReactorConversationMessage from '../../models/ReactorConversationMessage';

/**
 * Bounds on the message window returned to a caller.
 *
 * Deliberately mirrors `HISTORY_WINDOW` in ReactorConversationService: the Mongo
 * and Postgres implementations of the window must agree, because step 3b swaps
 * one for the other behind a flag and the parity tests compare them directly.
 */
export const MESSAGE_WINDOW = {
  DEFAULT_LIMIT: 100,
  MAX_LIMIT: 500,
} as const;

/**
 * Which store is authoritative for conversation messages.
 *
 * `mongo` (the default) keeps the embedded `history` array authoritative and is
 * the pre-Phase-3 behaviour unchanged. `postgres` routes reads at the
 * `reactor_conversation_messages` table.
 *
 * Defaulting to `mongo` means deploying this code changes nothing observable;
 * the cutover is one environment variable and the rollback is the same variable,
 * unset. Anything other than the exact value `postgres` resolves to `mongo`, so
 * a typo degrades to the known-good path rather than to an empty transcript.
 *
 * Resolved per call rather than cached at module load so a test can flip it
 * without re-importing the module.
 */
export type MessageSource = "mongo" | "postgres";

/**
 * The two spellings that once selected the message source.
 *
 * RETIRED. The Postgres message store became authoritative when the embedded `history` /
 * `truncatedHistory` arrays were retired across `reactor_conversations` (Phase 3c step 2,
 * 2026-09-15), so there is no longer a second source to choose between.
 *
 * These keys are still read — but only so that setting one is *reported* rather than silently
 * ignored. A stale flag is the exact failure mode that cost a restart cycle in §22: a deployment
 * believing it had selected a source while a different one served it. An inert flag that looks live
 * is worse than no flag, so the code says so out loud.
 */
export const MESSAGE_SOURCE_ENV_KEYS = [
  "REACTOR_MESSAGES_SOURCE",
  "REACTOR_MESSAGE_SOURCE",
] as const;

/**
 * The message store is authoritative. This is not configurable.
 *
 * Kept as a function rather than collapsed to a constant so that its callers — and the branches
 * they gate — can be deleted in the follow-up cleanup (§59) without a coordinated change here.
 * Every branch it gates now takes the store path; the `mongo` branches are unreachable.
 */
export const resolveMessagesSource = (): MessageSource => {
  for (const key of MESSAGE_SOURCE_ENV_KEYS) {
    const raw = process.env[key];
    if (raw === undefined || String(raw).trim() === "") continue;
    // eslint-disable-next-line no-console
    console.warn(
      `[reactor] ${key}=${raw} is set, but the message source is no longer configurable: the ` +
        `Postgres message store is authoritative. Remove this variable — it has no effect.`
    );
  }

  return "postgres";
};

/**
 * Resolve the effective window size.
 *
 * A non-finite or non-positive request is treated as "unset" and falls back to
 * the default — it must never silently shrink the window to one item. The hard
 * cap is always applied. Pure and exported so the Phase 1 window contract can be
 * asserted without a database.
 */
export const resolveWindowLimit = (requested?: number): number => {
  const raw = Number(requested);
  const resolved =
    Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MESSAGE_WINDOW.DEFAULT_LIMIT;
  return Math.min(resolved, MESSAGE_WINDOW.MAX_LIMIT);
};

export interface IWindowStartInput {
  /** `seq` of the oldest row in the initially selected tail. */
  tailOldestSeq: number;
  /** Role of that row. */
  tailOldestRole: string;
  /** Nearest earlier `user` seq, or null when none precedes the tail. */
  anchorSeq?: number | null;
  /** First `user` seq at/after the tail start, used only when no earlier one exists. */
  forwardAnchorSeq?: number | null;
}

/**
 * Decide where a window starts.
 *
 * A window must never begin mid-exchange (on an orphaned tool result or a
 * continuation assistant turn). When the tail does not already start on a
 * `user` message we prefer expanding **backwards** to the nearest earlier user:
 * that keeps the newest items and never yields an empty or short window. We only
 * fall forward when no user message precedes the slice at all. Pure and exported
 * so every branch is unit-tested.
 */
export const resolveWindowStart = (input: IWindowStartInput): number => {
  const { tailOldestSeq, tailOldestRole, anchorSeq, forwardAnchorSeq } = input;

  if (tailOldestRole === 'user') return tailOldestSeq;
  if (typeof anchorSeq === 'number' && Number.isFinite(anchorSeq)) return anchorSeq;
  if (typeof forwardAnchorSeq === 'number' && Number.isFinite(forwardAnchorSeq)) {
    return forwardAnchorSeq;
  }
  return tailOldestSeq;
};

export interface IMessageWindowOptions {
  /** Max items returned. Defaults to MESSAGE_WINDOW.DEFAULT_LIMIT, capped at MAX_LIMIT. */
  limit?: number;
  /** Cursor: return items strictly older than the message with this mongoId. */
  before?: string;
  /** Include leading `system` message(s). Default true. */
  includeSystem?: boolean;
  /** Include messages displaced by truncation/compaction. Default false. */
  includeArchived?: boolean;
}

export interface IMessageWindow {
  total: number;
  returned: number;
  hasMoreBefore: boolean;
  oldestId: string | null;
  newestId: string | null;
}

/**
 * Resolve a stable 24-hex identifier for a Mongo history item.
 *
 * Persisted history subdocuments carry `_id`; the schema's optional `id` field
 * is only populated by some writers. `_id` wins so the paging cursor stays
 * consistent with what the client already round-trips.
 */
const readMongoId = (item: any): string | null => {
  const raw = item?._id ?? item?.id;
  if (!raw) return null;
  const value = String(raw);
  return value || null;
};

/**
 * Make a value safe to persist in a Postgres `jsonb`/`text` column.
 *
 * Postgres rejects NUL (`\u0000`) inside text and jsonb values — it is not a
 * legal character in either type — and a real conversation carried a binary
 * payload (a PNG embedded in a tool result) containing one, which aborted the
 * whole backfill with `22P05: \u0000 cannot be converted to text`.
 *
 * Mongo happily stores those bytes, so the NULs are stripped only on the way
 * into Postgres. The Mongo document remains the untouched original until step
 * 3c, so nothing is lost while both stores are live.
 */
export const sanitizeForPostgres = <T>(value: T): T => {
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex
    return value.replace(/\u0000/g, "") as unknown as T;
  }

  if (value === null || value === undefined) return value;

  if (value instanceof Date) return value;

  // BSON types are serialised by the driver; walking them would flatten them to
  // `{}` and silently corrupt ids and binary fields.
  if (typeof value === "object") {
    const bsonType = (value as any)._bsontype;
    if (bsonType === "ObjectId" || bsonType === "Binary") {
      return value;
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return value;
    }
    // Mongoose subdocuments expose their plain form; walking the document
    // directly would pick up internal `$__` bookkeeping fields.
    if (typeof (value as any).toObject === "function") {
      return sanitizeForPostgres((value as any).toObject());
    }
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForPostgres(entry)) as unknown as T;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeForPostgres(entry);
    }
    return out as unknown as T;
  }

  return value;
};

/**
 * Flatten a message body (and its reasoning) into text for indexing.
 *
 * Kept on the row so session-list search is an indexed predicate rather than a
 * regex scan across a document.
 */
export const buildMessageSearchText = (message: any): string | null => {
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string') {
      parts.push(value);
    } else if (value && typeof value === 'object') {
      const text = (value as any).text;
      if (typeof text === 'string') parts.push(text);
    }
  };

  const content = message?.content;
  if (Array.isArray(content)) content.forEach(push);
  else push(content);

  push(message?.thinking);

  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : null;
};

/**
 * Repository wrapper over the Postgres conversation message log.
 *
 * This is the only place that reads or writes `reactor_conversation_messages`.
 * Every method is written to be safe to call when Postgres is unavailable or
 * uninitialised: callers get a null/empty result and the Mongo path continues
 * untouched. That matters in step 3a, where this store is written alongside the
 * existing Mongo history but is not yet authoritative.
 */
export default class ReactorConversationMessageService {
  private readonly injectedDataSource?: DataSource;

  constructor(dataSource?: DataSource) {
    this.injectedDataSource = dataSource;
  }

  private get dataSource(): DataSource {
    if (this.injectedDataSource) return this.injectedDataSource;

    // Resolved lazily rather than imported at module scope. The models barrel
    // pulls in every persona, provider and graph definition the module
    // registers; requiring it eagerly made this service — and every CLI script
    // or unit test that only wants the window logic — load the whole registry.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReactorPostgresDataSource } = require('../../models') as {
      ReactorPostgresDataSource: DataSource;
    };
    return ReactorPostgresDataSource;
  }

  /** True when the backing DataSource is initialised and usable. */
  isAvailable(): boolean {
    try {
      return this.dataSource?.isInitialized === true;
    } catch {
      return false;
    }
  }

  private getRepository(): Repository<ReactorConversationMessage> | null {
    if (!this.isAvailable()) return null;
    try {
      return this.dataSource.getRepository(ReactorConversationMessage);
    } catch {
      return null;
    }
  }

  /** Next `seq` for a conversation: `MAX(seq) + 1`, or 1 for a new conversation. */
  async nextSeq(conversationId: string): Promise<number> {
    const repo = this.getRepository();
    if (!repo) return 1;

    const raw = await repo
      .createQueryBuilder('m')
      .select('COALESCE(MAX(m.seq), 0)', 'max')
      .where('m.conversationId = :conversationId', { conversationId })
      .getRawOne<{ max: string | number }>();

    return Number(raw?.max || 0) + 1;
  }

  /**
   * Map a Mongo history item into row columns.
   * `seq` is assigned by the caller.
   */
  private toRow(
    conversationId: string,
    message: any,
    seq: number
  ): Partial<ReactorConversationMessage> {
    // Every value is sanitised on the way in: Postgres rejects NUL bytes in
    // text and jsonb, and real conversations contain binary payloads that
    // carry them. See sanitizeForPostgres.
    const sanitize = sanitizeForPostgres;

    return {
      mongoId: readMongoId(message),
      conversationId,
      seq: String(seq),
      role: String(message?.role ?? 'assistant'),
      content: sanitize(message?.content ?? null),
      thinking: sanitize(message?.thinking ?? null),
      thinkingBlocks: sanitize(message?.thinking_blocks ?? null),
      images: sanitize(message?.images ?? null),
      refusal: sanitize(message?.refusal ?? null),
      toolCallId: message?.tool_call_id ?? null,
      toolName: sanitize(message?.tool_name ?? null),
      toolArgs: sanitize(message?.tool_args ?? null),
      toolCalls: sanitize(message?.tool_calls ?? null),
      toolResults: sanitize(message?.tool_results ?? null),
      toolErrors: sanitize(message?.tool_errors ?? null),
      providerResponse: sanitize(message?.response ?? null),
      component: sanitize(message?.component ?? null),
      rating: typeof message?.rating === 'number' ? message.rating : null,
      annotations: sanitize(message?.annotations ?? null),
      audio: sanitize(message?.audio ?? null),
      searchText: sanitize(buildMessageSearchText(message)),
      archived: Boolean(message?.archived),
      archivedAt: message?.archivedAt ?? null,
      archivedReason: message?.archivedReason ?? null,
      messageTs: message?.timestamp ? new Date(message.timestamp) : null,
    };
  }

  /**
   * Map a history item onto the columns an in-place mutation may change.
   *
   * Excludes the identity columns (`mongo_id`, `conversation_id`, `seq`) because
   * an update must not reassign them, and excludes the archival lifecycle
   * columns (`archived*`) because a Mongo history item does not carry them —
   * writing them from such an item would silently un-archive a displaced row.
   */
  private toMutableRow(message: any): Partial<ReactorConversationMessage> {
    const row = this.toRow("", message, 0);
    delete row.mongoId;
    delete row.conversationId;
    delete row.seq;
    delete row.archived;
    delete row.archivedAt;
    delete row.archivedReason;
    return row;
  }

  /**
   * Map a row back into the message shape the conversation code expects.
   * The exposed `id` is the `mongoId`, so paging cursors stay stable.
   */
  private toMessage(row: ReactorConversationMessage): any {
    return {
      id: row.mongoId ?? undefined,
      _id: row.mongoId ?? undefined,
      role: row.role,
      content: row.content ?? null,
      thinking: row.thinking ?? undefined,
      thinking_blocks: row.thinkingBlocks ?? undefined,
      images: row.images ?? undefined,
      refusal: row.refusal ?? undefined,
      tool_call_id: row.toolCallId ?? undefined,
      tool_name: row.toolName ?? undefined,
      tool_args: row.toolArgs ?? undefined,
      tool_calls: row.toolCalls ?? undefined,
      tool_results: row.toolResults ?? undefined,
      tool_errors: row.toolErrors ?? undefined,
      response: row.providerResponse ?? undefined,
      component: row.component ?? undefined,
      rating: row.rating ?? undefined,
      annotations: row.annotations ?? undefined,
      audio: row.audio ?? undefined,
      timestamp: row.messageTs ?? row.createdAt,
      archived: row.archived,
      archivedAt: row.archivedAt ?? undefined,
      archivedReason: row.archivedReason ?? undefined,
    };
  }

  /**
   * Append a single message to the log.
   *
   * Returns the assigned `seq`, or null when the store is unavailable. The
   * unique `(conversation_id, seq)` index guards against a concurrent append
   * racing `MAX(seq)+1`; one retry is enough to resolve the normal case.
   */
  async appendMessage(
    conversationId: string,
    message: any
  ): Promise<{ seq: number; id: string | null } | null> {
    const repo = this.getRepository();
    if (!repo) return null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const seq = await this.nextSeq(conversationId);
      const row = this.toRow(conversationId, message, seq);
      try {
        await repo.insert(row as ReactorConversationMessage);
        return { seq, id: row.mongoId ?? null };
      } catch (error: any) {
        // 23505 = unique_violation on (conversation_id, seq): another writer
        // took the slot; recompute and try once more.
        if (attempt === 0 && String(error?.code ?? '').includes('23505')) continue;
        throw error;
      }
    }

    return null;
  }

  /**
   * Append many messages in order, for backfill.
   *
   * Idempotent when the messages carry a `mongoId`: rows whose id already
   * exists are skipped, so the backfill can be safely re-run. `seq` is the
   * item's index in the source array, which keeps row order identical to the
   * Mongo history order.
   */
  async appendMessages(
    conversationId: string,
    messages: any[],
    options?: { startSeq?: number }
  ): Promise<{ inserted: number; skipped: number }> {
    const repo = this.getRepository();
    if (!repo) return { inserted: 0, skipped: 0 };

    let inserted = 0;
    let skipped = 0;
    let seq = options?.startSeq ?? 1;

    for (const message of messages) {
      const row = this.toRow(conversationId, message, seq);

      if (row.mongoId) {
        const existing = await repo.findOne({
          where: { mongoId: row.mongoId },
          select: ['id'],
        });
        if (existing) {
          skipped += 1;
          seq += 1;
          continue;
        }
      }

      await repo.insert(row as ReactorConversationMessage);
      inserted += 1;
      seq += 1;
    }

    return { inserted, skipped };
  }

  /**
   * How many archived rows a conversation has.
   *
   * Backs the client's "earlier, compacted" affordance: the expander should only
   * be offered when there is something to show, and it must be decidable without
   * loading the archived set.
   */
  async countArchived(conversationId: string): Promise<number> {
    const repo = this.getRepository();
    if (!repo) return 0;

    return repo
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId })
      .andWhere('m.archived = true')
      .getCount();
  }

  /**
   * Whether a conversation already holds a system message.
   *
   * `getNewConversation` may hand back a conversation that already carries the persona prompt, and
   * the embedded `history` array used to answer that question (`$size: 1` with role `system`). That
   * array no longer records messages, so a reuse would see "no system message" and append a second
   * persona prompt — the store answers instead.
   */
  async hasSystemMessage(conversationId: string): Promise<boolean> {
    const repo = this.getRepository();
    if (!repo) return false;

    try {
      const count = await repo
        .createQueryBuilder('m')
        .where('m.conversationId = :conversationId', { conversationId })
        .andWhere('m.role = :role', { role: 'system' })
        .getCount();
      return count > 0;
    } catch {
      // The caller decides the failure direction; report "no message" so a fresh conversation still
      // receives its prompt.
      return false;
    }
  }

  /**
   * Of the given conversations, which hold a real transcript?
   *
   * A conversation has content when it has at least one non-system row, active or archived. This is
   * the store-side answer to "is this conversation blank?", which the embedded Mongo array used to
   * answer. After the write-path cutover that array is no longer written, so `history` is empty even
   * on a conversation holding hundreds of messages — anything that decides blankness from it is now
   * wrong. `getNewConversation` uses this to avoid handing back a conversation that has been used.
   *
   * Archived rows count as content on purpose: a compacted conversation has real history, reachable
   * through the "earlier, compacted" expander.
   *
   * On failure this returns **every** requested id rather than none. The direction is deliberate: the
   * caller excludes what is returned, so "cannot tell" must mean "do not reuse", whose cost is one
   * extra blank conversation. Returning an empty set would mean "everything is blank" and would
   * silently re-use a transcript — the bug this exists to prevent.
   */
  async conversationsWithContent(conversationIds: string[]): Promise<Set<string>> {
    const ids = (conversationIds ?? [])
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0);

    if (ids.length === 0) return new Set();

    try {
      const repo = this.getRepository();
      if (!repo) return new Set(ids);

      const rows = await repo
        .createQueryBuilder('m')
        .select('m.conversationId', 'conversationId')
        .where('m.conversationId IN (:...ids)', { ids })
        .andWhere('m.role <> :systemRole', { systemRole: 'system' })
        .distinct(true)
        .getRawMany<{ conversationId: string }>();

      // The column is CHAR(24), so Postgres pads on read; trim so callers can compare directly.
      return new Set((rows ?? []).map((row) => String(row?.conversationId ?? '').trim()));
    } catch {
      return new Set(ids);
    }
  }

  /** Total number of rows for a conversation, optionally including archived. */
  async countForConversation(
    conversationId: string,
    options?: { includeArchived?: boolean }
  ): Promise<number> {
    const repo = this.getRepository();
    if (!repo) return 0;

    const builder = repo
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId });

    if (!options?.includeArchived) {
      builder.andWhere('m.archived = false');
    }

    return builder.getCount();
  }

  /**
   * Select a bounded, contiguous window of a conversation's message log.
   *
   * Reproduces the invariants of `ReactorConversationService.buildHistoryWindow`
   * so the two implementations are interchangeable:
   *
   *  - `system` rows are kept on a full read, never on a paging read.
   *  - Paging operates over non-system rows only.
   *  - The oldest row in the window is a `user` message. The window **expands
   *    backwards** to the nearest preceding user rather than trimming forward,
   *    so a page is never empty or smaller than requested.
   *  - `hasMoreBefore` is true iff non-system rows exist older than the window.
   */
  async getHistoryWindow(
    conversationId: string,
    options?: IMessageWindowOptions
  ): Promise<{ items: any[]; window: IMessageWindow }> {
    const repo = this.getRepository();
    const empty: IMessageWindow = {
      total: 0,
      returned: 0,
      hasMoreBefore: false,
      oldestId: null,
      newestId: null,
    };

    if (!repo) return { items: [], window: empty };

    const includeSystem = options?.includeSystem !== false;
    const includeArchived = options?.includeArchived === true;

    const limit = resolveWindowLimit(options?.limit);

    // Resolve the paging cursor once, up front.
    //
    // Mongo's `buildHistoryWindow` treats an unrecognised `before` id as "no
    // cursor at all": the id is simply not found in the array, so the newest
    // window is returned unchanged. Reproducing that exactly — rather than
    // returning an empty page — is what keeps the two implementations
    // interchangeable. The parity tests pin this behaviour.
    let cursorSeq: number | null = null;
    if (options?.before) {
      const cursor = await repo
        .createQueryBuilder('c')
        .select('c.seq', 'seq')
        .where('c.conversationId = :conversationId', { conversationId })
        .andWhere('c.mongoId = :beforeSeq', { beforeSeq: options.before })
        .getRawOne<{ seq: string | number }>();
      cursorSeq = cursor ? Number(cursor.seq) : null;
    }

    // Restrict to the non-system region (optionally older than a cursor).
    const region = () => {
      const builder = repo
        .createQueryBuilder('m')
        .where('m.conversationId = :conversationId', { conversationId })
        .andWhere("m.role <> 'system'");

      if (!includeArchived) builder.andWhere('m.archived = false');

      // An unknown cursor is ignored, matching the Mongo path.
      if (cursorSeq !== null) {
        builder.andWhere('m.seq < :cursorSeq', { cursorSeq });
      }

      return builder;
    };

    const total = await this.countForConversation(conversationId, { includeArchived });

    // Newest `limit` rows of the region.
    const tail = await region()
      .orderBy('m.seq', 'DESC')
      .take(limit)
      .getMany();

    if (tail.length === 0) {
      const systemItems = includeSystem
        ? await this.getSystemMessages(repo, conversationId, includeArchived)
        : [];
      return {
        items: systemItems.map((row) => this.toMessage(row)),
        window: {
          total,
          returned: systemItems.length,
          hasMoreBefore: false,
          oldestId: null,
          newestId: null,
        },
      };
    }

    const ascending = [...tail].sort((a, b) => Number(a.seq) - Number(b.seq));
    const tailStartSeq = Number(ascending[0].seq);
    const tailOldestRole = ascending[0].role;

    // Only consult the database when the tail does not already begin on a user
    // message; the common case needs no anchor lookup at all.
    let anchorSeq: number | null = null;
    let forwardAnchorSeq: number | null = null;

    if (tailOldestRole !== 'user') {
      const anchor = await region()
        .andWhere('m.role = :userRole', { userRole: 'user' })
        .andWhere('m.seq < :startSeq', { startSeq: tailStartSeq })
        .orderBy('m.seq', 'DESC')
        .getOne();

      anchorSeq = anchor ? Number(anchor.seq) : null;

      if (anchorSeq === null) {
        const forward = await region()
          .andWhere('m.role = :userRole', { userRole: 'user' })
          .andWhere('m.seq >= :startSeq', { startSeq: tailStartSeq })
          .orderBy('m.seq', 'ASC')
          .getOne();
        forwardAnchorSeq = forward ? Number(forward.seq) : null;
      }
    }

    const startSeq = resolveWindowStart({
      tailOldestSeq: tailStartSeq,
      tailOldestRole,
      anchorSeq,
      forwardAnchorSeq,
    });

    const kept = await region()
      .andWhere('m.seq >= :startSeq', { startSeq })
      .orderBy('m.seq', 'ASC')
      .getMany();

    const systemItems = includeSystem
      ? await this.getSystemMessages(repo, conversationId, includeArchived)
      : [];

    const oldestRow = kept[0];
    const newestRow = kept[kept.length - 1];

    const hasMoreBefore = await region()
      .andWhere('m.seq < :startSeq', { startSeq })
      .getCount();

    const items = [...systemItems, ...kept].map((row) => this.toMessage(row));

    return {
      items,
      window: {
        total,
        returned: items.length,
        hasMoreBefore: hasMoreBefore > 0,
        oldestId: oldestRow?.mongoId ?? null,
        newestId: newestRow?.mongoId ?? null,
      },
    };
  }

  /**
   * Page backwards through a conversation. Pages are system-free and anchored
   * on a `user` message, matching the Phase 1 `getConversationHistoryPage`.
   */
  async getHistoryPage(
    conversationId: string,
    options?: { before?: string; limit?: number }
  ): Promise<{ items: any[]; window: IMessageWindow }> {
    return this.getHistoryWindow(conversationId, {
      before: options?.before,
      limit: options?.limit,
      includeSystem: false,
    });
  }

  private async getSystemMessages(
    repo: Repository<ReactorConversationMessage>,
    conversationId: string,
    includeArchived: boolean
  ): Promise<ReactorConversationMessage[]> {
    const builder = repo
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId })
      .andWhere("m.role = 'system'");

    if (!includeArchived) builder.andWhere('m.archived = false');

    return builder.orderBy('m.seq', 'ASC').getMany();
  }

  /**
   * Flag messages older than a boundary as archived.
   *
   * Replaces the Mongo behaviour of rewriting the history array and appending
   * the displaced items to `truncatedHistory`: the rows stay put, they simply
   * stop contributing to the active context. Archived rows remain readable, so
   * the UI can surface them.
   */
  async archiveBefore(
    conversationId: string,
    boundarySeqExclusive: number,
    reason: 'truncated' | 'compacted' | 'cleared' = 'truncated'
  ): Promise<number> {
    const repo = this.getRepository();
    if (!repo) return 0;

    const result = await repo
      .createQueryBuilder()
      .update(ReactorConversationMessage)
      .set({ archived: true, archivedAt: new Date(), archivedReason: reason })
      .where('conversation_id = :conversationId', { conversationId })
      .andWhere('seq < :boundarySeqExclusive', { boundarySeqExclusive })
      .andWhere('archived = false')
      .execute();

    return result.affected ?? 0;
  }

  /** Archive an explicit set of messages by their Mongo ids. */
  async archiveByMongoIds(
    mongoIds: string[],
    reason: 'truncated' | 'compacted' | 'cleared' = 'truncated'
  ): Promise<number> {
    const repo = this.getRepository();
    if (!repo || !Array.isArray(mongoIds) || mongoIds.length === 0) return 0;

    const result = await repo
      .createQueryBuilder()
      .update(ReactorConversationMessage)
      .set({ archived: true, archivedAt: new Date(), archivedReason: reason })
      .where('mongo_id IN (:...mongoIds)', { mongoIds })
      .andWhere('archived = false')
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Insert a message immediately ahead of a conversation's first *kept* message.
   *
   * Compaction replaces the displaced prefix of a transcript with a summary that sits **in front
   * of** the messages it kept — `[system…, summary, …kept]`. Mongo expressed that by rewriting the
   * array. With rows, the summary needs a `seq` smaller than the first kept message while every
   * such value is already taken, so the trailing range has to move up by one first.
   *
   * The shift is deliberately two-phase. A single `UPDATE … SET seq = seq + 1` is **not safe**
   * against `IDX_rcm_conv_seq`: Postgres checks the unique index row by row, so if it moves the
   * lower row first the two collide, and it does not promise an order. Moving the range clear of
   * the table's maximum first (every target exceeding it) and then bringing it back down by one
   * makes each phase collision-free whatever order the planner picks. This is the same reasoning
   * that took three attempts to get right in the reconcile tool's `safeSeqShift` — §39.2 records
   * why `max + 1` and `n - min + 1` were both wrong — so the note is repeated here rather than
   * rediscovered.
   *
   * Runs in a transaction: a half-applied shift would leave the transcript with a hole or a
   * collision, and the archive that precedes it (in the caller) is a separate statement.
   *
   * Returns the assigned `seq` and `mongo_id`, or null when the store is unavailable.
   */
  async insertCompactionSummary(
    conversationId: string,
    message: any
  ): Promise<{ seq: number; id: string | null } | null> {
    if (!conversationId) return null;

    const dataSource = (() => {
      try {
        return this.dataSource;
      } catch {
        return null;
      }
    })();
    if (!dataSource?.isInitialized) return null;

    return await dataSource.transaction(async (manager) => {
      const bounds = await manager.query(
        `SELECT COALESCE(MAX(seq), 0) AS max
           FROM reactor_conversation_messages
          WHERE conversation_id = $1`,
        [conversationId]
      );
      const max = Number(bounds?.[0]?.max ?? 0);

      // The first active non-system row is the first message compaction kept, because the
      // displaced ones were archived immediately before this call.
      const firstKept = await manager.query(
        `SELECT MIN(seq) AS seq
           FROM reactor_conversation_messages
          WHERE conversation_id = $1 AND archived = false AND role <> 'system'`,
        [conversationId]
      );

      let targetSeq: number | null =
        firstKept?.[0]?.seq === null || firstKept?.[0]?.seq === undefined
          ? null
          : Number(firstKept[0].seq);

      if (targetSeq === null) {
        // Nothing was kept: the summary still belongs after the system messages.
        const lastSystem = await manager.query(
          `SELECT MAX(seq) AS seq
             FROM reactor_conversation_messages
            WHERE conversation_id = $1 AND archived = false AND role = 'system'`,
          [conversationId]
        );
        targetSeq = (lastSystem?.[0]?.seq === null || lastSystem?.[0]?.seq === undefined
          ? 0
          : Number(lastSystem[0].seq)) + 1;
      }

      const offset = max + 1;

      await manager.query(
        `UPDATE reactor_conversation_messages
            SET seq = seq + $1
          WHERE conversation_id = $2 AND seq >= $3`,
        [offset, conversationId, targetSeq]
      );

      await manager.query(
        `UPDATE reactor_conversation_messages
            SET seq = seq - $1 + 1
          WHERE conversation_id = $2 AND seq > $3`,
        [offset, conversationId, max]
      );

      const row = this.toRow(conversationId, message, targetSeq);
      if (!row.mongoId) {
        // Time-ordered, like every other minted id, so a later re-derivation of chronology has
        // something to work with.
        row.mongoId = new ObjectId().toString();
      }

      await manager.insert(ReactorConversationMessage, row as ReactorConversationMessage);

      return { seq: targetSeq, id: row.mongoId ?? null };
    });
  }

  /** Delete a single message row by its Mongo id. */
  async deleteByMongoId(mongoId: string): Promise<boolean> {
    const repo = this.getRepository();
    if (!repo || !mongoId) return false;

    const result = await repo.delete({ mongoId });
    return (result.affected ?? 0) > 0;
  }

  /**
   * Apply an in-place mutation of a history item to the row keyed by `mongoId`.
   *
   * The mutating paths in `ReactorConversationService` (`deleteToolCall`,
   * `updateToolCallStatus`, `rateMessage`, `patchSystemPrompt`) historically
   * wrote the Mongo document only, while reads are served from this table — so such a write was
   * invisible: the change landed in Mongo and the transcript came from the store. This applies the
   * same item state to the row, which is now the only record of it.
   */
  async updateMessageByMongoId(mongoId: string, message: any): Promise<boolean> {
    const repo = this.getRepository();
    if (!repo || !mongoId) return false;

    const result = await repo.update({ mongoId }, this.toMutableRow(message));
    return (result.affected ?? 0) > 0;
  }

  /**
   * Apply a tool-call status change to whichever row carries that tool call.
   *
   * `updateToolCallStatus` targets a tool call by id across the whole history
   * array, so the owning message is not known to the caller and the tool call
   * id is not a row key. Rows are therefore matched by JSONB containment
   * (`tool_calls @> [{"id": …}]`) rather than by scanning the conversation.
   */
  async updateToolCallStatusByToolCallId(
    conversationId: string,
    toolCallId: string,
    status: string
  ): Promise<number> {
    const repo = this.getRepository();
    if (!repo || !conversationId || !toolCallId) return 0;

    // `@>` is array containment: the needle array is contained when any element
    // of `tool_calls` is a superset of `{ id: toolCallId }`.
    const needle = JSON.stringify([{ id: toolCallId }]);
    const matches: Array<{ id: string; tool_calls: any }> = await repo.query(
      `SELECT id, tool_calls FROM reactor_conversation_messages
        WHERE conversation_id = $1 AND tool_calls @> $2::jsonb`,
      [conversationId, needle]
    );

    let affected = 0;
    for (const match of matches ?? []) {
      const calls = Array.isArray(match?.tool_calls) ? match.tool_calls : null;
      if (!calls) continue;

      let changed = false;
      const next = calls.map((tc: any) => {
        if (tc && tc.id === toolCallId && tc.status !== status) {
          changed = true;
          return { ...tc, status };
        }
        return tc;
      });
      if (!changed) continue;

      await repo.update({ id: match.id }, { toolCalls: next });
      affected += 1;
    }

    return affected;
  }

  /**
   * Set the rating on the row keyed by `mongo_id`.
   *
   * `rateMessage` historically wrote `session.history[i].rating`. Once the array is retired it no
   * longer holds the message at all, so without this the write is lost and the UI keeps showing the
   * previous rating — silently, because the Mongo update succeeds against a document that no longer
   * matches.
   */
  async setMessageRatingByMongoId(mongoId: string, rating: number | null): Promise<number> {
    const repo = this.getRepository();
    if (!repo || !mongoId) return 0;

    const result = await repo.update({ mongoId } as any, { rating } as any);
    return result?.affected ?? 0;
  }

  /**
   * Set the content of a conversation's first active `system` message.
   *
   * Returns the number of rows changed so the caller can tell "edited the existing system message"
   * from "there was none" and append instead — which is exactly what the Mongo path does with its
   * `findIndex` / `unshift` pair.
   */
  async setSystemMessageContent(conversationId: string, content: string): Promise<number> {
    const repo = this.getRepository();
    if (!repo || !conversationId) return 0;

    const rows: Array<{ id: string }> = await repo.query(
      `SELECT id FROM reactor_conversation_messages
        WHERE conversation_id = $1 AND role = 'system' AND archived = false
        ORDER BY seq ASC
        LIMIT 1`,
      [conversationId]
    );

    const target = rows?.[0]?.id;
    if (!target) return 0;

    await repo.update(
      { id: target } as any,
      {
        content: content as any,
        searchText: buildMessageSearchText({ role: "system", content }),
      } as any
    );

    return 1;
  }

  /**
   * Append a tool result onto the message that owns a given tool call.
   *
   * Two paths push `tool_results` onto the assistant message that carries the call: the server macro
   * tool result and the client tool result. The tool-call id is not a row key, so rows are matched by
   * JSONB containment — the same technique as `updateToolCallStatusByToolCallId`.
   *
   * Existing results are appended to rather than replaced, matching `$push` semantics.
   */
  async appendToolResultToOwningMessage(
    conversationId: string,
    toolCallId: string,
    toolResult: any
  ): Promise<number> {
    const repo = this.getRepository();
    if (!repo || !conversationId || !toolCallId) return 0;

    const needle = JSON.stringify([{ id: toolCallId }]);
    const matches: Array<{ id: string; tool_results: any }> = await repo.query(
      `SELECT id, tool_results FROM reactor_conversation_messages
        WHERE conversation_id = $1 AND tool_calls @> $2::jsonb`,
      [conversationId, needle]
    );

    let affected = 0;
    for (const match of matches ?? []) {
      const existing = Array.isArray(match?.tool_results) ? match.tool_results : [];
      await repo.update(
        { id: match.id } as any,
        { toolResults: [...existing, toolResult] } as any
      );
      affected += 1;
    }

    return affected;
  }

  /**
   * Overwrite the content of a conversation's `tool` message for a given tool call.
   *
   * `completeClientToolCalls` finds the placeholder tool message by `tool_call_id` and replaces its
   * content, results and timestamp; when there is no placeholder it appends a new message, which is
   * an ordinary append already handled by the append mirror. Only the replacement half lives here.
   *
   * Returns 1 when a row was updated and 0 when there was none — the caller uses that to decide
   * whether to fall back to appending, exactly as the Mongo path uses a null `findOneAndUpdate`.
   */
  async replaceToolMessageByToolCallId(
    conversationId: string,
    toolCallId: string,
    patch: { content: string; toolResults?: any[]; timestamp?: Date }
  ): Promise<number> {
    const repo = this.getRepository();
    if (!repo || !conversationId || !toolCallId) return 0;

    const rows: Array<{ id: string }> = await repo.query(
      `SELECT id FROM reactor_conversation_messages
        WHERE conversation_id = $1 AND role = 'tool' AND tool_call_id = $2 AND archived = false
        ORDER BY seq ASC
        LIMIT 1`,
      [conversationId, toolCallId]
    );

    const target = rows?.[0]?.id;
    if (!target) return 0;

    const update: Record<string, any> = {
      content: patch.content,
      searchText: buildMessageSearchText({ role: "tool", content: patch.content }),
    };
    if (Array.isArray(patch.toolResults)) update.toolResults = patch.toolResults;
    if (patch.timestamp) update.messageTs = patch.timestamp;

    await repo.update({ id: target } as any, update as any);
    return 1;
  }

  /**
   * Delete rows for a conversation whose `mongo_id` is not among the ids Mongo
   * currently holds.
   *
   * Repairs conversations mirrored before the id-keying fix, where the same
   * message could be written twice: once under the provisional `id` (dual-write)
   * and once under the persisted `_id` (backfill). Both look valid in isolation,
   * so the only way to distinguish a genuine row from a duplicate is to check it
   * against the source of truth. Returns the number of rows removed.
   */
  async pruneOrphanedMessages(
    conversationId: string,
    knownMongoIds: string[]
  ): Promise<number> {
    const repo = this.getRepository();
    if (!repo) return 0;

    const builder = repo
      .createQueryBuilder()
      .delete()
      .from(ReactorConversationMessage)
      .where('conversation_id = :conversationId', { conversationId });

    if (knownMongoIds.length > 0) {
      builder.andWhere(
        '(mongo_id IS NULL OR mongo_id NOT IN (:...knownMongoIds))',
        { knownMongoIds }
      );
    }

    const result = await builder.execute();
    return result.affected ?? 0;
  }

  /** Remove every message attached to a conversation (session deletion). */
  async deleteForConversation(conversationId: string): Promise<number> {
    const repo = this.getRepository();
    if (!repo) return 0;

    const result = await repo.delete({ conversationId });
    return result.affected ?? 0;
  }

  /**
   * Conversation ids whose active messages match a search term.
   * Backs the session-list search predicate.
   */
  async searchConversationIds(term: string, limit = 200): Promise<string[]> {
    const repo = this.getRepository();
    if (!repo || !term || term.trim().length === 0) return [];

    const rows = await repo
      .createQueryBuilder('m')
      .select('DISTINCT m.conversationId', 'conversationId')
      .where('m.archived = false')
      .andWhere('m.searchText ILIKE :term', { term: `%${term.trim()}%` })
      .limit(limit)
      .getRawMany<{ conversationId: string }>();

    return rows.map((row) => row.conversationId).filter(Boolean);
  }

  /**
   * All active messages for a conversation in order, for LLM context assembly.
   */
  async getActiveMessages(conversationId: string): Promise<ReactorConversationMessage[]> {
    const repo = this.getRepository();
    if (!repo) return [];

    return repo
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId })
      .andWhere('m.archived = false')
      .orderBy('m.seq', 'ASC')
      .getMany();
  }

  /** Archived messages for a conversation, newest first. */
  async getArchivedMessages(
    conversationId: string,
    limit = MESSAGE_WINDOW.MAX_LIMIT
  ): Promise<ReactorConversationMessage[]> {
    const repo = this.getRepository();
    if (!repo) return [];

    return repo
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId })
      .andWhere('m.archived = true')
      .orderBy('m.seq', 'DESC')
      .take(Math.min(limit, MESSAGE_WINDOW.MAX_LIMIT))
      .getMany();
  }

  /**
   * Every archived row for a conversation, oldest first.
   *
   * Deliberately unbounded, unlike `getArchivedMessages`, which is a *paged*
   * read capped at MESSAGE_WINDOW.MAX_LIMIT. This backs the full-read contract
   * (`getFullConversationHistory`) and the "earlier, compacted" expander, both
   * of which must surface the complete archived set. The 500-row cap silently
   * dropped two thirds of one real conversation's compacted history.
   *
   * Ordered `seq ASC`: for rows migrated from Mongo `truncatedHistory` that is
   * the order in which the messages were displaced.
   */
  async getAllArchivedMessages(
    conversationId: string,
    max = 10_000
  ): Promise<ReactorConversationMessage[]> {
    const repo = this.getRepository();
    if (!repo) return [];

    return repo
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId })
      .andWhere('m.archived = true')
      .orderBy('m.seq', 'ASC')
      .take(max)
      .getMany();
  }

  /** Convert rows to the conversation message shape (used by callers/tests). */
  toMessages(rows: ReactorConversationMessage[]): any[] {
    return rows.map((row) => this.toMessage(row));
  }
}
