import { Response } from 'express';
import { WebSocket } from 'ws';
import { StreamingEvent } from './types/streaming.types';
import { ChatSessionResourceManager } from './ChatSessionResourceManager';
import { ReplayOutcome, StreamingEventLog, streamingEventLogOptionsFromEnv } from './StreamingEventLog';

/**
 * Abstract transport interface for streaming events
 */
export interface StreamingTransport {
  /** Whether the transport is currently connected */
  readonly isConnected: boolean;

  /** Initialize the transport connection */
  initialize(): Promise<void>;

  /**
   * Send a streaming event through the transport.
   *
   * `eventId` is the stream position assigned by the sender (the
   * StreamingTransportManager owns the per-session sequence). Transports that
   * have no concept of resumable ids — WebSocket — ignore it; the SSE transport
   * emits it as the `id:` field so a reconnecting EventSource can resume.
   */
  sendEvent(event: StreamingEvent, eventId?: number): Promise<void>;

  /** Close the transport connection */
  close(): Promise<void>;

  /**
   * Send a keepalive. Optional: only transports that can be reaped by an idle
   * proxy (SSE) implement it, and the manager duck-types the call.
   */
  sendHeartbeat?(): void;

  /**
   * Outcome of the `Last-Event-ID` replay attempted while connecting.
   * SSE only; absent on transports that do not support resume.
   */
  readonly replayOutcome?: ReplayOutcome | null;
}

/** Default retry hint (ms) advertised to EventSource clients. */
export const DEFAULT_SSE_RETRY_MS = 3000;

/**
 * Options for the SSE transport.
 *
 * All optional so the transport remains constructible in isolation (tests, any
 * future non-endpoint caller): without a `sessionKey` it still numbers its own
 * events, it just has no cross-connection replay history to draw on.
 */
export interface SSETransportOptions {
  /**
   * Chat/conversation id the stream belongs to. Ids are allocated per key, so
   * a reconnect that builds a *new* transport continues the same sequence.
   */
  sessionKey?: string;
  /** Streaming session id, for connection logging only. */
  sseSessionId?: string;
  /** Share one log (owned by the manager) across a session's transports. */
  eventLog?: StreamingEventLog;
  /** Value of the request's `Last-Event-ID` header, if the browser sent one. */
  lastEventId?: number;
  /** `retry:` hint in ms. */
  retryMs?: number;
}

/**
 * Server-Sent Events (SSE) transport implementation
 * Provides HTTP-based real-time streaming using the EventSource API
 */
export class SSETransport implements StreamingTransport {
  private _isConnected = false;
  private _isClosed = false;
  /** Set once close() has been called, so the close log can name the initiator. */
  private _closing = false;
  /** The conversationId this transport serves — set on first sendEvent */
  private _chatSessionId: string | null = null;
  private readonly _sessionKey?: string;
  private readonly _sseSessionId?: string;
  private readonly _retryMs: number;
  /**
   * Session-scoped replay history. Shared across a session's transports when
   * the manager supplies it, so a reconnect can be served from the events that
   * the *previous* connection emitted.
   */
  private readonly log: StreamingEventLog;
  /** Ids this transport allocated itself (only when it has no session key). */
  private _localEventId = 0;
  /** Wall-clock of the last byte written — the idle measure in the close log. */
  private _lastWriteAt = Date.now();
  private _eventsSent = 0;
  private _lastSentEventId: number | null = null;
  private _replayOutcome: ReplayOutcome | null = null;
  private readonly _requestedLastEventId?: number;

  constructor(private readonly response: Response, options: SSETransportOptions = {}) {
    this._sessionKey = options.sessionKey;
    this._sseSessionId = options.sseSessionId;
    this._requestedLastEventId = options.lastEventId;
    this._retryMs = Number.isFinite(options.retryMs) && (options.retryMs as number) > 0
      ? (options.retryMs as number)
      : DEFAULT_SSE_RETRY_MS;
    this.log = options.eventLog ?? new StreamingEventLog(streamingEventLogOptionsFromEnv());
  }

  /** What happened when this connection tried to resume from `Last-Event-ID`. */
  get replayOutcome(): ReplayOutcome | null {
    return this._replayOutcome;
  }

  /** The key ids are allocated under: the session, else the first event's chat. */
  private get streamKey(): string | null {
    return this._sessionKey ?? this._chatSessionId ?? null;
  }

  get isConnected(): boolean {
    if (!this._isConnected || this._isClosed) return false;
    return !this.response.writableEnded && !this.response.destroyed;
  }

  /**
   * Log to the session file logger.
   *
   * Falls back to the configured session key: a connection that never carried
   * an event still has to be able to say that it was opened and closed, and
   * that is precisely the connection whose disappearance is hardest to explain.
   */
  private slog(level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
    const sessionId = this._chatSessionId ?? this._sessionKey;
    if (sessionId) {
      ChatSessionResourceManager.forSession(sessionId)?.[level](
        `[SSETransport] ${message}`, meta
      );
    }
  }

  /**
   * Initialize SSE connection with proper headers and event handlers
   */
  async initialize(): Promise<void> {
    if (this._isConnected) {
      throw new Error('SSE transport already initialized');
    }

    if (this._isClosed) {
      throw new Error('SSE transport has been closed');
    }

    this.slog("debug", "Initializing SSE transport...");

    // Set SSE headers
    this.response.setHeader('Content-Type', 'text/event-stream');
    this.response.setHeader('Cache-Control', 'no-cache, no-transform');
    this.response.setHeader('Connection', 'keep-alive');
    this.response.setHeader('X-Accel-Buffering', 'no');
    this.response.setHeader('Access-Control-Allow-Origin', '*');
    this.response.setHeader('Access-Control-Allow-Headers', 'Cache-Control');

    // Flush headers immediately to establish the SSE connection
    this.response.flushHeaders();

    // Handle client disconnect.
    //
    // Logged with the numbers someone actually needs when a user reports a
    // frozen conversation: which session, how long the stream had been silent,
    // how much was delivered, and whether a resume was attempted. Diagnosing
    // this class of bug from "it stopped updating" is otherwise guesswork.
    this.response.on('close', () => {
      const idleMs = Date.now() - this._lastWriteAt;
      this.slog("info", `SSE connection closed (${this._closing ? 'server-close' : 'client-disconnect'})`, {
        sseSessionId: this._sseSessionId ?? null,
        chatSessionId: this._chatSessionId ?? null,
        idleMs,
        idleSeconds: Math.round(idleMs / 1000),
        eventsSent: this._eventsSent,
        lastEventId: this._lastSentEventId,
        requestedLastEventId: this._requestedLastEventId ?? null,
        replayStatus: this._replayOutcome?.status ?? null,
      });
      this._isConnected = false;
      this._isClosed = true;
    });

    this.response.on('error', (err) => {
      this.slog("warn", `Response error, marking transport disconnected: ${err.message}`);
      this._isConnected = false;
    });

    // Advertise the reconnect backoff (`retry:`) and announce the connection in
    // a single write so a proxy sees one complete chunk. Neither frame carries
    // an `id:`: they are transport housekeeping, not replayable application
    // events, and advancing Last-Event-ID over them would create a resumable
    // position that no log entry backs.
    this.writeRaw(`retry: ${this._retryMs}\n\nevent: connected\ndata: {}\n\n`);

    this._isConnected = true;

    // Resume from where this client left off, before any live event can be
    // written. The manager re-registers the transport after initialize(), so
    // nothing else can interleave here.
    this.replayFromLastEventId();

    this.slog("info", "SSE transport initialized successfully", {
      sseSessionId: this._sseSessionId ?? null,
      retryMs: this._retryMs,
      replayStatus: this._replayOutcome?.status ?? null,
    });
  }

  /**
   * Write raw bytes and mark the stream as freshly active. Keepalives and
   * replays must refresh the idle clock, otherwise the sweep measures silence
   * from the last *application* event and keeps writing anyway.
   */
  private writeRaw(frame: string): void {
    this.response.write(frame);
    this._lastWriteAt = Date.now();
    if (typeof (this.response as any).flush === 'function') {
      (this.response as any).flush();
      return;
    }
    this.response.cork();
    process.nextTick(() => this.response.uncork());
  }

  /**
   * Answer the browser's `Last-Event-ID`, if it sent one.
   *
   * Ordering is the whole point: replayed frames are written before live
   * delivery resumes, so the client sees the gap filled in the sequence the
   * events were originally produced in.
   */
  private replayFromLastEventId(): void {
    const key = this.streamKey;
    if (this._requestedLastEventId === undefined) {
      this._replayOutcome = { status: 'none', replayed: 0, latestId: key ? this.log.latestId(key) : 0 };
      return;
    }

    if (!key) {
      // No session identity to look history up under — treat as a fresh stream
      // rather than promising a continuity we cannot serve.
      this._replayOutcome = {
        status: 'resync',
        reason: 'unknown',
        replayed: 0,
        requestedLastEventId: this._requestedLastEventId,
        latestId: 0,
      };
      this.writeResync(this._replayOutcome);
      return;
    }

    const { outcome, entries } = this.log.since(key, this._requestedLastEventId);
    this._replayOutcome = outcome;

    if (outcome.status === 'resync') {
      this.writeResync(outcome);
      return;
    }

    for (const entry of entries) {
      this.writeRaw(`id: ${entry.id}\nevent: ${entry.type}\ndata: ${entry.payload}\n\n`);
      this._eventsSent++;
      this._lastSentEventId = entry.id;
    }

    if (outcome.replayed > 0) {
      this.slog("info", `Replayed ${outcome.replayed} event(s) after Last-Event-ID ${outcome.requestedLastEventId}`, {
        sseSessionId: this._sseSessionId ?? null,
        chatSessionId: key,
        fromEventId: outcome.requestedLastEventId,
        toEventId: this._lastSentEventId,
        replayed: outcome.replayed,
      });
    }
  }

  /**
   * Tell the client its resume point is unusable, so it re-fetches state
   * instead of silently continuing from an unknown position.
   *
   * Deliberately carries no `id:` — it is a control frame, not a stream entry,
   * and must not move the client's Last-Event-ID.
   */
  private writeResync(outcome: ReplayOutcome): void {
    const payload = JSON.stringify({
      reason: outcome.reason ?? 'unknown',
      lastEventId: outcome.requestedLastEventId ?? null,
      oldestEventId: outcome.oldestAvailableId ?? null,
      latestEventId: outcome.latestId,
    });
    this.writeRaw(`event: resync\ndata: ${payload}\n\n`);
    this.slog("warn", `Last-Event-ID replay could not be served — sent resync`, {
      sseSessionId: this._sseSessionId ?? null,
      chatSessionId: this.streamKey ?? null,
      reason: outcome.reason,
      requestedLastEventId: outcome.requestedLastEventId,
      oldestAvailableId: outcome.oldestAvailableId,
      latestId: outcome.latestId,
    });
  }

  /**
   * Send streaming event in SSE format.
   *
   * Every event carries a monotonic `id:`. Without it the browser has no
   * `Last-Event-ID` to send on reconnect, so anything emitted during a drop is
   * lost — which is the difference between "the stream paused" and "the
   * conversation is frozen until a page refresh".
   */
  async sendEvent(event: StreamingEvent, eventId?: number): Promise<void> {
    if (!this._isConnected) {
      throw new Error('SSE transport not initialized');
    }

    if (this._isClosed) {
      throw new Error('SSE transport has been closed');
    }

    // Capture the conversationId from the first event so subsequent logs
    // are routed to the correct session file.
    if (!this._chatSessionId && event.conversationId) {
      this._chatSessionId = event.conversationId;
    }

    try {
      const sseId = this.resolveEventId(event, eventId);
      const eventData = JSON.stringify(event);
      const sseMessage = `id: ${sseId}\nevent: ${event.type}\ndata: ${eventData}\n\n`;

      this.writeRaw(sseMessage);
      this._eventsSent++;
      this._lastSentEventId = sseId;
      this.slog("debug", `Sent SSE event: ${event.type}`, { eventType: event.type, eventId: sseId, hasImages: !!(event as any).data?.images?.length });
    } catch (error: any) {
      this.slog("error", `Error sending SSE event: ${error.message}`, { eventType: event.type });
      this._isConnected = false;
      throw error;
    }
  }

  /**
   * Send a keepalive.
   *
   * Writes BOTH halves, and both are load-bearing:
   *
   * - `: heartbeat` is an SSE comment. `EventSource` discards it silently — it
   *   produces no event object and invokes no listener — but it is a real byte
   *   on the wire, so proxies and byte-counting intermediaries see traffic and
   *   keep the connection open. Removing it would regress idle-proxy timeouts.
   * - `event: heartbeat` is a *named* frame, which is what a browser client can
   *   actually observe. The client's liveness watchdog is reset only by named
   *   events; with a comment-only keepalive a perfectly healthy stream looked
   *   dead, and the client force-closed it roughly every five minutes.
   *
   * No `id:` — see {@link replayFromLastEventId}. A heartbeat that advanced
   * Last-Event-ID would put the client's resume point at an entry no log holds.
   */
  sendHeartbeat(): void {
    if (!this._isConnected || this._isClosed) return;
    try {
      const ts = Date.now();
      this.writeRaw(`: heartbeat\n\nevent: heartbeat\ndata: ${JSON.stringify({ ts })}\n\n`);
    } catch {
      // Best-effort — don't break the caller if the connection dropped.
    }
  }

  /**
   * Resolve the id for an outgoing event.
   *
   * Uses the sender's id when given one (the manager allocates per session so
   * the number means the same thing across reconnects and across every
   * transport attached to that session). Falls back to allocating here, which
   * covers a transport driven directly rather than through the manager.
   */
  private resolveEventId(event: StreamingEvent, eventId?: number): number {
    if (typeof eventId === 'number' && Number.isFinite(eventId)) {
      // Keep any self-allocated numbering ahead of ids seen from the manager,
      // so a mixed call sequence still produces increasing ids on this stream.
      if (eventId > this._localEventId) this._localEventId = eventId;
      return eventId;
    }

    const key = this.streamKey;
    if (key) {
      const id = this.log.append(key, event);
      if (id > this._localEventId) this._localEventId = id;
      return id;
    }

    return ++this._localEventId;
  }

  /**
   * Close SSE connection
   */
  async close(): Promise<void> {
    if (this._isClosed) {
      return; // Already closed
    }

    this._closing = true;
    this.slog("info", "Closing SSE transport");

    try {
      if (this._isConnected) {
        // Send close event before ending
        this.response.write('event: close\ndata: {}\n\n');
      }

      this.response.end();
    } catch (error: any) {
      this.slog("warn", `Error during SSE transport close: ${error.message}`);
    } finally {
      this._isConnected = false;
      this._isClosed = true;
    }
  }
}

/**
 * WebSocket transport implementation
 * Provides bidirectional real-time communication using WebSocket protocol
 */
export class WebSocketTransport implements StreamingTransport {
  private _isConnected = false;
  private _isClosed = false;

  constructor(private readonly websocket: WebSocket) {}

  get isConnected(): boolean {
    return this._isConnected && this.websocket.readyState === WebSocket.OPEN;
  }

  /**
   * Initialize WebSocket connection with event handlers
   */
  async initialize(): Promise<void> {
    if (this._isConnected) {
      throw new Error('WebSocket transport already initialized');
    }

    if (this._isClosed) {
      throw new Error('WebSocket transport has been closed');
    }

    // Set up event handlers
    this.websocket.onopen = () => {
      this._isConnected = true;
    };

    this.websocket.onclose = () => {
      this._isConnected = false;
      this._isClosed = true;
    };

    this.websocket.onerror = (event: unknown) => {
      this._isConnected = false;
      this._isClosed = true;
    };

    // If WebSocket is already open, mark as connected
    if (this.websocket.readyState === WebSocket.OPEN) {
      this._isConnected = true;
    }
  }

  /**
   * Send streaming event as JSON message
   */
  async sendEvent(event: StreamingEvent): Promise<void> {
    if (!this._isConnected) {
      throw new Error('WebSocket transport not initialized');
    }

    if (this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }

    try {
      const message = JSON.stringify(event);
      this.websocket.send(message);
    } catch (error) {
      this._isConnected = false;
      throw error;
    }
  }

  /**
   * Close WebSocket connection
   */
  async close(): Promise<void> {
    if (this._isClosed) {
      return; // Already closed
    }

    try {
      if (this.websocket.readyState === WebSocket.OPEN) {
        this.websocket.close(1000, 'Normal closure');
      }
    } catch (error) {
      // Log error but continue with cleanup
      console.warn('Error during WebSocket transport close:', error);
    } finally {
      this._isConnected = false;
      this._isClosed = true;
    }
  }
}
