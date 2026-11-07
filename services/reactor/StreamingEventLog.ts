import { StreamingEvent } from './types/streaming.types';

/**
 * Session-scoped, bounded log of SSE events that have already been emitted.
 *
 * Why this exists
 * ---------------
 * An `EventSource` reconnect is only lossless when the server can answer the
 * question the browser asks with its `Last-Event-ID` header: "give me
 * everything after id N". Without an `id:` field on the wire there is no N,
 * and without a log there is nothing to replay from — so every reconnect
 * (including the ones the client's own liveness watchdog used to trigger
 * against a healthy but silent socket) dropped whatever was emitted during the
 * gap. The conversation then looked frozen until a full page refresh.
 *
 * Design constraints
 * ------------------
 * - **Bounded.** Two independent bounds — a maximum number of retained events
 *   and a maximum age — so a long streamed answer cannot grow process memory
 *   without limit. Both are asserted by tests.
 * - **Monotonic per stream, and monotonic across a reset.** Ids are allocated
 *   per session key, not per transport, so a reconnect that creates a *new*
 *   `SSETransport` continues the same numbering and its `Last-Event-ID` is
 *   comparable with ids already sent. A stream whose state is reclaimed for
 *   idleness also continues the numbering instead of restarting at 1 — see
 *   `highWaterMark`. Restarting would let a stale `Last-Event-ID` name a
 *   *different* event that happened to reuse the number, which is a silent
 *   mis-resume: exactly the failure this log exists to prevent.
 * - **Honest about gaps.** When the requested id has been evicted (or was never
 *   seen by this process — e.g. the reconnect landed on a different worker),
 *   {@link StreamingEventLog.prototype.since} reports `resync` rather than
 *   silently resuming at the oldest entry it happens to still hold. A silent
 *   gap is the failure mode this whole mechanism exists to remove.
 *
 * Per-process, not shared storage: the log lives in the worker that holds the
 * transport. A reconnect to a different worker therefore answers `resync`
 * (unknown id) and the client re-fetches state, which is the correct, explicit
 * degradation. Sharing the log through Redis is a larger change and is not
 * required to fix the reported symptom.
 */

/** One recorded event, kept only so it can be replayed after a reconnect. */
export interface SSEEventLogEntry {
  /** Monotonic per-stream id, emitted on the wire as `id: <n>`. */
  id: number;
  /** SSE event name, emitted on the wire as `event: <type>`. */
  type: string;
  /** The `data:` payload, serialized once when the event was emitted. */
  payload: string;
  /** When the entry was recorded (ms since epoch), used for age pruning. */
  recordedAt: number;
}

/** What happened when a client asked to resume from a given id. */
export type ReplayStatus =
  /** No `Last-Event-ID` was supplied — first connection, nothing to do. */
  | 'none'
  /** The client is already at the newest id; live delivery resumes immediately. */
  | 'current'
  /** Entries were found after the requested id — they must be written first. */
  | 'replayed'
  /** The requested position cannot be served; the client must re-fetch state. */
  | 'resync';

export interface ReplayOutcome {
  status: ReplayStatus;
  /** Why a `resync` was required. Absent for every other status. */
  reason?: 'evicted' | 'unknown';
  /** Number of entries carried in the accompanying slice. */
  replayed: number;
  /** The id the client asked to resume from, if it supplied one. */
  requestedLastEventId?: number;
  /** Oldest id still retained for this stream, if any. */
  oldestAvailableId?: number;
  /** Newest id ever allocated for this stream (0 when nothing was emitted). */
  latestId: number;
}

export interface ReplaySlice {
  outcome: ReplayOutcome;
  entries: SSEEventLogEntry[];
}

interface StreamState {
  entries: SSEEventLogEntry[];
  /** Highest id ever allocated for this stream — survives pruning. */
  lastId: number;
  updatedAt: number;
}

/** Default number of events retained per stream. */
export const DEFAULT_MAX_EVENTS_PER_STREAM = 1000;
/** Default retention window. Matches the event buffer's TTL. */
export const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

export interface StreamingEventLogOptions {
  maxEventsPerStream?: number;
  maxAgeMs?: number;
}

/**
 * Reads the retention bounds from the environment, falling back to the
 * defaults. Exported so the manager and the tests agree on one source of truth.
 */
export function streamingEventLogOptionsFromEnv(): StreamingEventLogOptions {
  const maxEvents = parseInt(process.env.REACTORY_SSE_REPLAY_MAX_EVENTS || '', 10);
  const maxAge = parseInt(process.env.REACTORY_SSE_REPLAY_TTL_MS || '', 10);
  return {
    maxEventsPerStream: Number.isFinite(maxEvents) && maxEvents > 0
      ? maxEvents
      : DEFAULT_MAX_EVENTS_PER_STREAM,
    maxAgeMs: Number.isFinite(maxAge) && maxAge > 0 ? maxAge : DEFAULT_MAX_AGE_MS,
  };
}

export class StreamingEventLog {
  private readonly streams = new Map<string, StreamState>();
  private readonly maxEventsPerStream: number;
  private readonly maxAgeMs: number;
  /** When the map of streams was last swept for idle keys. */
  private lastSweepAt = 0;
  /**
   * Highest id this log has ever issued, across every stream.
   *
   * A stream that is created after another one has already issued ids starts its
   * own numbering here rather than at 1. That matters in one specific case: a
   * stream reclaimed for idleness and then rebuilt by a later turn. Seeding from
   * the high-water mark means its ids continue upward, so a client that reconnects
   * holding a pre-sweep `Last-Event-ID` can only ever be served a *later* event
   * (a contiguous replay) or an explicit `resync` — never an older, unrelated
   * event that reuses the number it is holding.
   */
  private highWaterMark = 0;

  constructor(options: StreamingEventLogOptions = {}) {
    this.maxEventsPerStream = options.maxEventsPerStream && options.maxEventsPerStream > 0
      ? Math.floor(options.maxEventsPerStream)
      : DEFAULT_MAX_EVENTS_PER_STREAM;
    this.maxAgeMs = options.maxAgeMs && options.maxAgeMs > 0
      ? options.maxAgeMs
      : DEFAULT_MAX_AGE_MS;
  }

  /** Number of entries currently retained for a stream. */
  size(streamKey: string): number {
    return this.streams.get(streamKey)?.entries.length ?? 0;
  }

  /** Highest id allocated for a stream (0 when nothing has been emitted). */
  latestId(streamKey: string): number {
    return this.streams.get(streamKey)?.lastId ?? 0;
  }

  /**
   * Record an event and allocate its id.
   *
   * Ids are allocated even when the write to the socket later fails: the id is
   * the position of the event in the stream, not proof that it was delivered.
   * That is exactly what makes replay after a failed write correct — the client
   * asks from the last id it *received* and gets everything after it.
   */
  append(streamKey: string, event: Pick<StreamingEvent, 'type'> & { data?: unknown }, now: number = Date.now()): number {
    // Sweep before resolving the target state: a sweep must never run against
    // the entry it is about to write.
    this.sweepIdleStreams(now);

    let state = this.streams.get(streamKey);
    if (!state) {
      // Seed from the high-water mark, not from 0: a rebuilt stream continues the
      // numbering instead of restarting it. See the field doc above.
      state = { entries: [], lastId: this.highWaterMark, updatedAt: now };
      this.streams.set(streamKey, state);
    }
    this.prune(state, now);

    const id = ++state.lastId;
    this.highWaterMark = id;
    state.entries.push({
      id,
      type: String(event.type),
      payload: this.serialize(event),
      recordedAt: now,
    });
    this.enforceCapacity(state);
    state.updatedAt = now;
    return id;
  }

  /**
   * Everything needed to answer a `Last-Event-ID` resume request.
   *
   * `lastEventId` is the value the browser sent. `undefined`, a non-numeric
   * value or a value below 1 all mean "no usable resume point" and yield
   * `status: 'none'` — the client behaves as a first connection.
   */
  since(streamKey: string, lastEventId?: number, now: number = Date.now()): ReplaySlice {
    const requested = this.usableId(lastEventId);
    if (requested === undefined) {
      return {
        outcome: { status: 'none', replayed: 0, latestId: this.latestId(streamKey) },
        entries: [],
      };
    }

    const state = this.streams.get(streamKey);
    if (!state) {
      // This process has never emitted anything for the session: either a fresh
      // stream or a reconnect that landed on another worker. We cannot prove
      // continuity, so say so instead of resuming at an arbitrary point.
      return {
        outcome: {
          status: 'resync',
          reason: 'unknown',
          replayed: 0,
          requestedLastEventId: requested,
          latestId: 0,
        },
        entries: [],
      };
    }

    this.prune(state, now);

    const latestId = state.lastId;
    if (requested > latestId) {
      // The client has seen ids this process never issued.
      return {
        outcome: {
          status: 'resync',
          reason: 'unknown',
          replayed: 0,
          requestedLastEventId: requested,
          oldestAvailableId: state.entries[0]?.id,
          latestId,
        },
        entries: [],
      };
    }

    if (requested === latestId) {
      return {
        outcome: {
          status: 'current',
          replayed: 0,
          requestedLastEventId: requested,
          oldestAvailableId: state.entries[0]?.id,
          latestId,
        },
        entries: [],
      };
    }

    const oldestAvailableId = state.entries[0]?.id;
    // A gap exists when the entry that must follow `requested` is gone. Either
    // the buffer was pruned past it, or nothing is retained at all.
    if (oldestAvailableId === undefined || oldestAvailableId > requested + 1) {
      return {
        outcome: {
          status: 'resync',
          reason: 'evicted',
          replayed: 0,
          requestedLastEventId: requested,
          oldestAvailableId,
          latestId,
        },
        entries: [],
      };
    }

    const entries = state.entries.filter((entry) => entry.id > requested);
    return {
      outcome: {
        status: 'replayed',
        replayed: entries.length,
        requestedLastEventId: requested,
        oldestAvailableId,
        latestId,
      },
      entries,
    };
  }

  /** Drop a stream's history (e.g. the conversation is closed for good). */
  forget(streamKey: string): void {
    this.streams.delete(streamKey);
  }

  /** Drop every stream and the id watermark. Test helper; not used in production paths. */
  clear(): void {
    this.streams.clear();
    this.highWaterMark = 0;
    this.lastSweepAt = 0;
  }

  /**
   * Forget streams that have been idle for a full retention window.
   *
   * Pruning a stream's entries leaves its (now empty) map key behind, and a
   * conversation that is never resumed would keep that key forever — one per
   * session, for the life of the process. Swept at most once per window so the
   * cost amortizes to nothing across a token stream.
   *
   * Reclaiming the state does NOT reclaim the id numbering: `highWaterMark`
   * carries it, so a later event for the same session gets a higher id than
   * anything already sent. The consequence for a client is one of two explicit
   * answers on reconnect, never a silent rewind:
   *
   * - nothing else happened in between, so the next event is contiguous with the
   *   id the client holds and it is replayed (`replayed`);
   * - other conversations consumed ids meanwhile, so the gap is reported as
   *   `resync`/`evicted` rather than replayed from an id that means something
   *   else.
   */
  private sweepIdleStreams(now: number): void {
    if (now - this.lastSweepAt < this.maxAgeMs) return;
    this.lastSweepAt = now;
    for (const [key, state] of this.streams.entries()) {
      // Nothing was appended for a full window, so every entry it holds is older
      // than the window too: there is no replayable state left, only the key.
      if (now - state.updatedAt >= this.maxAgeMs) {
        this.streams.delete(key);
      }
    }
  }

  private usableId(value?: number): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const id = Math.floor(value);
    return id >= 1 ? id : undefined;
  }

  /** Drop entries older than the retention window. */
  private prune(state: StreamState, now: number): void {
    const cutoff = now - this.maxAgeMs;
    let drop = 0;
    while (drop < state.entries.length && state.entries[drop].recordedAt < cutoff) {
      drop++;
    }
    if (drop > 0) state.entries.splice(0, drop);
  }

  /** Enforce the count bound by dropping the oldest entries. */
  private enforceCapacity(state: StreamState): void {
    const overflow = state.entries.length - this.maxEventsPerStream;
    if (overflow > 0) state.entries.splice(0, overflow);
  }

  private serialize(event: unknown): string {
    try {
      return JSON.stringify(event);
    } catch {
      // A payload with a cycle is not replayable, but it must not stop the
      // event from being emitted — record an empty payload and move on.
      return '{}';
    }
  }
}
