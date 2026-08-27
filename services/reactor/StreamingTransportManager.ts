import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { service } from '@reactory/server-core/application/decorators/service';
import RedisService from '@reactory/server-modules/reactory-core/services/RedisService';
import { StreamingSessionManager } from './StreamingSessionManager';
import { StreamingTransport } from './StreamingTransport';
import { StreamingEvent } from './types/streaming.types';
import { ChatSessionResourceManager } from './ChatSessionResourceManager';

/** Redis pub/sub channel carrying streaming events for one conversation. */
const eventChannel = (chatSessionId: string): string =>
  `reactory:streaming:events:${chatSessionId}`;

/** Envelope published to the channel above. */
interface StreamingEventEnvelope {
  /** Process that published it, so the publisher can ignore its own message. */
  origin: string;
  chatSessionId: string;
  event: StreamingEvent;
}

/**
 * Manages streaming transports for active sessions
 * Coordinates between session state and transport connections
 */
@service({
  id: "reactor.StreamingTransportManager@1.0.0",
  nameSpace: "reactor",
  name: "StreamingTransportManager",
  version: "1.0.0",
  description: "Manages streaming transports for active sessions",
  dependencies: [
    { id: "reactor.StreamingSessionManager@1.0.0", alias: "sessionManager" },
    { id: "core.RedisService@1.0.0", alias: "redisService" },
  ],
  lifeCycle: 'singleton',
})
export class StreamingTransportManager implements Reactory.Service.IReactoryService {
  private readonly context: Reactory.Server.IReactoryContext;
  private readonly transports = new Map<string, StreamingTransport>();
  private readonly chatSessions = new Map<string, Set<string>>();
  private readonly sseToChatMap = new Map<string, string>();
  private readonly activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionManager: StreamingSessionManager;
  private redisService: RedisService;

  /**
   * Cross-process fanout.
   *
   * The transport registry above is per-process memory, but the server runs
   * many processes (pm2 `exec_mode: cluster` inside every replica, and several
   * replicas behind an ingress with no session affinity). The SSE GET that
   * registers a transport and the mutation that runs the turn are separate
   * requests, so they routinely land on different workers — and a worker that
   * holds no local transport for a conversation used to buffer the entire
   * response into its own memory, where nobody could ever read it.
   *
   * So every event is also published to a Redis channel scoped to its
   * conversation. Each process subscribes only to the conversations it actually
   * holds a transport for, and delivers what arrives to those local transports.
   * `PUBLISH` reports how many subscribers received the message, which is what
   * tells us whether the event reached *any* process — and therefore whether it
   * still needs buffering for a later reconnect.
   */
  private subscriber: Redis | null = null;
  private readonly subscribedChannels = new Set<string>();

  /**
   * Keepalive for idle streams.
   *
   * A reverse proxy closes a connection it has seen no traffic on:
   * ingress-nginx's `proxy_read_timeout` defaults to 60s. A stream waiting for
   * a background agent to say something writes nothing at all, so without this
   * every idle stream is cut roughly once a minute and reconnects — which,
   * across a stack of background streams, is a reconnect storm.
   *
   * The per-turn heartbeat in ReactorConversationService only covers the tool
   * loop; this one is a property of holding a transport open, so it lives with
   * the transports. `lastWriteAt` keeps it to genuinely idle streams rather than
   * interleaving comments into an active token stream.
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lastWriteAt = new Map<string, number>();
  private static readonly HEARTBEAT_INTERVAL_MS =
    parseInt(process.env.REACTORY_STREAMING_HEARTBEAT_MS || '25000', 10);
  /** Identifies this process, so we ignore the messages we published. */
  private readonly originId = randomUUID();
  private fanoutReady = false;

  /**
   * Events buffered for a chat session while no connected transport exists.
   * On reconnect (registerTransport), the buffer is flushed to the new transport
   * so the client receives the full response that was generated while it was away.
   */
  private readonly eventBuffer = new Map<string, { events: StreamingEvent[]; createdAt: number }>();
  private static readonly MAX_BUFFER_SIZE = 1000;
  private static readonly BUFFER_TTL_MS = 5 * 60 * 1000;

  private static instance: StreamingTransportManager;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    this.context = context;
    if (!StreamingTransportManager.instance) {
      StreamingTransportManager.instance = this;
    }
    return StreamingTransportManager.instance;
  }

  /**
   * Log to both context and the chat session logger (if available).
   */
  private slog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
    chatSessionId?: string,
  ): void {
    const prefixed = `[StreamingTransportManager] ${message}`;
    // Never let a log call be the reason a request fails — see the note on
    // ReactorConversationService.sessionLog.
    try {
      const safeLevel = typeof (this.context as any)?.[level] === 'function' ? level : 'error';
      this.context[safeLevel](prefixed, meta);
    } catch { /* swallow */ }
    if (chatSessionId) {
      try {
        ChatSessionResourceManager.forSession(chatSessionId)?.[level](prefixed, meta);
      } catch { /* swallow */ }
    }
  }

  /**
   * Resolve a chatSessionId from an SSE session ID.
   */
  private chatIdForSse(sseSessionId: string): string | undefined {
    return this.sseToChatMap.get(sseSessionId);
  }

  /**
   * Buffer an event for a chat session so it can be flushed when a transport
   * is re-registered. Drops the oldest events if the buffer is full and
   * discards buffers older than BUFFER_TTL_MS.
   */
  private bufferEvent(chatSessionId: string, event: StreamingEvent): void {
    this.cleanupExpiredBuffers();

    let entry = this.eventBuffer.get(chatSessionId);
    if (!entry) {
      entry = { events: [], createdAt: Date.now() };
      this.eventBuffer.set(chatSessionId, entry);
    }

    entry.events.push(event);
    if (entry.events.length > StreamingTransportManager.MAX_BUFFER_SIZE) {
      entry.events.splice(0, entry.events.length - StreamingTransportManager.MAX_BUFFER_SIZE);
    }
  }

  /**
   * Flush buffered events for a chat session to a newly registered transport.
   * Called from registerTransport after the transport is initialized.
   */
  private async flushEventBuffer(chatSessionId: string, transport: StreamingTransport): Promise<void> {
    const entry = this.eventBuffer.get(chatSessionId);
    if (!entry || entry.events.length === 0) return;

    this.eventBuffer.delete(chatSessionId);

    this.slog("info", `Flushing ${entry.events.length} buffered event(s) for chat session ${chatSessionId}`, {
      eventCount: entry.events.length,
      bufferedAt: new Date(entry.createdAt).toISOString(),
    }, chatSessionId);

    for (const event of entry.events) {
      if (!transport.isConnected) {
        this.bufferEvent(chatSessionId, event);
        return;
      }
      try {
        await transport.sendEvent(event);
      } catch (error: any) {
        this.slog("warn", `Error flushing buffered event: ${error.message}`, {
          eventType: event.type,
          chatSessionId,
        }, chatSessionId);
        this.bufferEvent(chatSessionId, event);
        return;
      }
    }
  }

  /**
   * Remove buffers that have exceeded their TTL.
   */
  private cleanupExpiredBuffers(): void {
    const now = Date.now();
    for (const [chatSessionId, entry] of this.eventBuffer.entries()) {
      if (now - entry.createdAt > StreamingTransportManager.BUFFER_TTL_MS) {
        this.slog("debug", `Discarding expired event buffer for chat session ${chatSessionId}`, {
          eventCount: entry.events.length,
        }, chatSessionId);
        this.eventBuffer.delete(chatSessionId);
      }
    }
  }

  private setSessionManager(sessionManager: StreamingSessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * Dependency setter resolved by ServiceManager from the `dependencies`
   * declaration (`set${alias}`). Public because it is part of the service's
   * wiring contract, matching StreamingSessionManager.
   */
  public setRedisService(redisService: RedisService) {
    this.redisService = redisService;
    this.initFanout();
  }

  /** True when cross-process fanout is available and wanted. */
  private get fanoutEnabled(): boolean {
    if (process.env.REACTORY_STREAMING_FANOUT === 'off') return false;
    return this.fanoutReady;
  }

  /**
   * Open the dedicated subscriber connection.
   *
   * A Redis client in subscriber mode cannot issue ordinary commands, so this
   * duplicates the shared client rather than borrowing it — publishes keep
   * going out on the original.
   */
  private initFanout(): void {
    if (this.subscriber || process.env.REACTORY_STREAMING_FANOUT === 'off') return;
    if (!this.redisService?.getClient) return;

    try {
      const subscriber = this.redisService.getClient().duplicate();

      subscriber.on('message', (channel: string, payload: string) => {
        this.onFanoutMessage(channel, payload);
      });
      subscriber.on('error', (err: Error) => {
        this.slog("warn", `Streaming fanout subscriber error: ${err.message}`);
      });

      this.subscriber = subscriber;
      this.fanoutReady = true;
      this.slog("info", `Streaming fanout enabled`, { origin: this.originId });
    } catch (err: any) {
      // Local-only delivery is still correct for a single-process deployment.
      this.slog("warn", `Streaming fanout unavailable, falling back to local delivery: ${err.message}`);
    }
  }

  /**
   * Deliver an event published by another process to this process's transports.
   */
  private onFanoutMessage(channel: string, payload: string): void {
    let envelope: StreamingEventEnvelope;
    try {
      envelope = JSON.parse(payload);
    } catch (err: any) {
      this.slog("warn", `Discarding malformed fanout payload on ${channel}: ${err.message}`);
      return;
    }

    // Our own publish, already delivered locally before it went out.
    if (!envelope || envelope.origin === this.originId) return;

    const { chatSessionId, event } = envelope;
    if (!chatSessionId || !event) return;

    // JSON round-tripping flattens the Date; restore it so downstream
    // consumers see the same shape as a locally produced event.
    if (event.timestamp) event.timestamp = new Date(event.timestamp);

    this.deliverLocal(chatSessionId, event).catch((err: Error) => {
      this.slog("warn", `Error delivering fanout event: ${err.message}`, {
        eventType: event.type,
        chatSessionId,
      }, chatSessionId);
    });
  }

  /**
   * Subscribe to a conversation's channel. Called when a chat session gains its
   * first local transport — a process only listens to what it can deliver.
   */
  private async subscribeToChat(chatSessionId: string): Promise<void> {
    if (!this.fanoutEnabled || !this.subscriber) return;
    const channel = eventChannel(chatSessionId);
    if (this.subscribedChannels.has(channel)) return;
    this.subscribedChannels.add(channel);
    try {
      await this.subscriber.subscribe(channel);
      this.slog("debug", `Subscribed to streaming fanout for ${chatSessionId}`, undefined, chatSessionId);
    } catch (err: any) {
      this.subscribedChannels.delete(channel);
      this.slog("warn", `Failed to subscribe to ${channel}: ${err.message}`, undefined, chatSessionId);
    }
  }

  /** Stop listening once this process holds no transport for the conversation. */
  private async unsubscribeFromChat(chatSessionId: string): Promise<void> {
    const channel = eventChannel(chatSessionId);
    if (!this.subscribedChannels.delete(channel)) return;
    if (!this.subscriber) return;
    try {
      await this.subscriber.unsubscribe(channel);
      this.slog("debug", `Unsubscribed from streaming fanout for ${chatSessionId}`, undefined, chatSessionId);
    } catch (err: any) {
      this.slog("warn", `Failed to unsubscribe from ${channel}: ${err.message}`, undefined, chatSessionId);
    }
  }

  /**
   * Record an SSE session against a chat, subscribing on the first one.
   */
  private attachSse(sseSessionId: string, chatSessionId: string): void {
    this.sseToChatMap.set(sseSessionId, chatSessionId);
    let sseSet = this.chatSessions.get(chatSessionId);
    const isFirst = !sseSet || sseSet.size === 0;
    if (!sseSet) {
      sseSet = new Set<string>();
      this.chatSessions.set(chatSessionId, sseSet);
    }
    sseSet.add(sseSessionId);
    if (isFirst) {
      // Fire and forget: delivery of the first event does not depend on the
      // subscription being live, only remote delivery does.
      this.subscribeToChat(chatSessionId).catch(() => {});
    }
  }

  /**
   * Forget an SSE session across every index, unsubscribing when its chat has
   * no local transports left. Single owner of this bookkeeping — it used to be
   * copy-pasted into each removal path, which is how a subscription would have
   * been leaked by whichever copy forgot it.
   */
  private detachSse(sseSessionId: string): void {
    const chatId = this.sseToChatMap.get(sseSessionId);
    this.transports.delete(sseSessionId);
    this.lastWriteAt.delete(sseSessionId);
    this.sseToChatMap.delete(sseSessionId);
    this.stopHeartbeatIfIdle();
    if (!chatId) return;
    const set = this.chatSessions.get(chatId);
    if (!set) return;
    set.delete(sseSessionId);
    if (set.size === 0) {
      this.chatSessions.delete(chatId);
      this.unsubscribeFromChat(chatId).catch(() => {});
    }
  }

  /**
   * Close and remove a transport + its reverse-mapping entry by SSE session ID.
   * Safe to call even if the transport is already gone.
   */
  private async evictTransport(sseSessionId: string, reason: string): Promise<void> {
    const transport = this.transports.get(sseSessionId);
    if (!transport) return;
    const chatId = this.sseToChatMap.get(sseSessionId);
    this.slog("info", `Evicting transport ${sseSessionId} (${reason}, connected: ${transport.isConnected})`, undefined, chatId);
    try {
      await transport.close();
    } catch (err: any) {
      this.slog("warn", `Error closing transport ${sseSessionId}: ${err.message}`, undefined, chatId);
    }
    this.detachSse(sseSessionId);
  }

  /**
   * Register a transport for a session and initialize it
   */
  async registerTransport(args: {
    sessionId: string,
    chatSessionId: string,
    transport: StreamingTransport }): Promise<void> {
    const { sessionId, chatSessionId, transport } = args;

    this.slog("info", `registerTransport called`, {
      sessionId,
      chatSessionId,
      transportType: transport.constructor.name,
    }, chatSessionId);

    // If a transport already exists for this exact SSE session ID, close and replace it.
    await this.evictTransport(sessionId, 'same SSE session ID re-registration');

    try {
      await transport.initialize();
      this.transports.set(sessionId, transport);
      this.lastWriteAt.set(sessionId, Date.now());
      this.attachSse(sessionId, chatSessionId);
      this.ensureHeartbeat();

      this.slog("info", `Transport registered successfully`, {
        chatSessions: Array.from(this.chatSessions.entries()).map(([k, v]) => [k, Array.from(v)]),
        transports: Array.from(this.transports.keys()),
      }, chatSessionId);

      await this.flushEventBuffer(chatSessionId, transport);
    } catch (error: any) {
      this.slog("error", `Error registering transport: ${error.message}`, {
        stack: error.stack,
      }, chatSessionId);
      try {
        await transport.close();
      } catch (closeError: any) {
        this.slog("warn", `Error during transport cleanup: ${closeError.message}`, undefined, chatSessionId);
      }
      throw error;
    }
  }

  /**
   * Send an event to all connected transports registered for this chat session.
   * If no connected transport exists, the event is buffered and flushed
   * when a transport is re-registered (e.g. on client reconnect).
   */
  async sendEventToSession(chatSessionId: string, event: StreamingEvent): Promise<void> {
    // Snapshot our own subscription BEFORE delivering: delivering can prune the
    // last dead transport for this conversation and unsubscribe us, and Redis
    // will still be counting us as a subscriber when the publish below lands.
    // Reading it afterwards would let us mistake our own subscription for a
    // remote receiver and drop the event instead of buffering it.
    const wasSubscribed = this.subscribedChannels.has(eventChannel(chatSessionId));

    // Deliver to whatever this process holds, then hand the event to every
    // other process so the transports they hold get it too.
    const sentCount = await this.deliverLocal(chatSessionId, event);
    const remoteCount = await this.publishEvent(chatSessionId, event, wasSubscribed);

    if (sentCount > 0) {
      if (event.type === 'tool_call' || event.type === 'complete' || event.type === 'error') {
        this.slog("debug", `Sent ${event.type} event to ${sentCount} local transport(s)`, {
          eventType: event.type,
          chatSessionId,
          messageId: event.messageId,
          remoteSubscribers: remoteCount,
        }, chatSessionId);
      }
      return;
    }

    // Another process is subscribed for this conversation, so it holds the
    // transport and has delivered the event. Buffering here would duplicate it
    // on this process's next reconnect.
    if (remoteCount > 0) return;

    // Nowhere to deliver it: hold it for a reconnect.
    this.slog("debug", `No transport anywhere for chat session ${chatSessionId} — buffering event`, {
      eventType: event.type,
    }, chatSessionId);
    this.bufferEvent(chatSessionId, event);
  }

  /**
   * Write an event to this process's connected transports for a chat session,
   * pruning any that have dropped. Returns how many received it.
   *
   * Does not publish or buffer — callers decide that, which is what lets the
   * fanout subscriber reuse this without echoing the event back out.
   */
  private async deliverLocal(chatSessionId: string, event: StreamingEvent): Promise<number> {
    const sseSet = this.chatSessions.get(chatSessionId);
    if (!sseSet || sseSet.size === 0) return 0;

    const deadSessions: string[] = [];
    let sentCount = 0;

    for (const sessionId of Array.from(sseSet)) {
      const transport = this.transports.get(sessionId);
      if (!transport || !transport.isConnected) {
        deadSessions.push(sessionId);
        continue;
      }
      try {
        await transport.sendEvent(event);
        sentCount++;
        this.lastWriteAt.set(sessionId, Date.now());
        this.throttledUpdateSessionActivity(sessionId);
      } catch (err: any) {
        this.slog("error", `Error sending event to SSE session ${sessionId}: ${err.message}`, {
          eventType: event.type,
          chatSessionId,
        }, chatSessionId);
        if (!transport.isConnected) {
          deadSessions.push(sessionId);
        }
      }
    }

    for (const deadId of deadSessions) {
      this.detachSse(deadId);
    }

    return sentCount;
  }

  /**
   * Publish an event to the other processes holding transports for this
   * conversation. Returns the number of *remote* subscribers that received it,
   * which is how the caller knows whether the event landed somewhere.
   *
   * Returns 0 when fanout is off, so a single-process deployment behaves exactly
   * as it did before: deliver locally, buffer when there is nowhere to deliver.
   */
  private async publishEvent(
    chatSessionId: string,
    event: StreamingEvent,
    wasSubscribed: boolean,
  ): Promise<number> {
    if (!this.fanoutEnabled || !this.redisService?.getClient) return 0;

    const channel = eventChannel(chatSessionId);
    const envelope: StreamingEventEnvelope = {
      origin: this.originId,
      chatSessionId,
      event,
    };

    try {
      const receivers = await this.redisService
        .getClient()
        .publish(channel, JSON.stringify(envelope));
      // We are a subscriber ourselves whenever we hold a transport for this
      // conversation, and we ignore our own message — so discount it. Uses the
      // caller's pre-delivery snapshot, not the current set: see the note in
      // sendEventToSession.
      const selfSubscribed = wasSubscribed || this.subscribedChannels.has(channel) ? 1 : 0;
      return Math.max(0, (receivers || 0) - selfSubscribed);
    } catch (err: any) {
      this.slog("warn", `Failed to publish streaming event for ${chatSessionId}: ${err.message}`, {
        eventType: event.type,
      }, chatSessionId);
      return 0;
    }
  }

  /**
   * Close and unregister transport for a session
   */
  async closeTransport(sessionId: string): Promise<void> {
    const transport = this.transports.get(sessionId);

    if (!transport) {
      return; // Already closed or never registered
    }

    const chatId = this.sseToChatMap.get(sessionId);

    try {
      await transport.close();
    } catch (error: any) {
      this.slog("warn", `Error closing transport for session ${sessionId}: ${error.message}`, undefined, chatId);
    } finally {
      this.detachSse(sessionId);
    }
  }

  /**
   * Close all registered transports
   */
  async closeAllTransports(): Promise<void> {
    const closePromises = Array.from(this.transports.entries()).map(
      async ([sessionId, transport]) => {
        try {
          await transport.close();
        } catch (error: any) {
          this.slog("warn", `Error closing transport for session ${sessionId}: ${error.message}`);
        }
      }
    );

    await Promise.all(closePromises);
    this.transports.clear();
    this.sseToChatMap.clear();
    this.chatSessions.clear();
    this.lastWriteAt.clear();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.subscriber) {
      try {
        if (this.subscribedChannels.size > 0) {
          await this.subscriber.unsubscribe(...Array.from(this.subscribedChannels));
        }
        this.subscriber.disconnect();
      } catch (err: any) {
        this.slog("warn", `Error tearing down streaming fanout subscriber: ${err.message}`);
      } finally {
        this.subscribedChannels.clear();
        this.subscriber = null;
        this.fanoutReady = false;
      }
    }
  }

  /**
   * Check if an active (connected) transport exists for a session.
   * Automatically cleans up stale entries where the transport is registered
   * but the underlying connection has dropped.
   */
  hasTransport(sessionId: string): boolean {
    const transport = this.transports.get(sessionId);
    if (!transport) return false;

    if (!transport.isConnected) {
      const chatId = this.sseToChatMap.get(sessionId);
      this.slog("debug", `hasTransport: transport for ${sessionId} exists but is disconnected — removing stale entry`, undefined, chatId);
      this.detachSse(sessionId);
      return false;
    }

    return true;
  }

  /**
   * Check if an active transport exists for a chat (conversation) session.
   */
  hasActiveTransportForChat(chatSessionId: string): boolean {
    const sseSet = this.chatSessions.get(chatSessionId);
    if (!sseSet || sseSet.size === 0) return false;
    for (const sessionId of Array.from(sseSet)) {
      if (this.hasTransport(sessionId)) return true;
    }
    return false;
  }

  /**
   * Send a keepalive heartbeat to prevent proxy/browser timeouts during
   * long-running server-side operations (e.g. AUTO tool execution loops).
   * Best-effort — failures are silently ignored.
   */
  /**
   * Start the keepalive sweep once this process holds a transport. Idempotent.
   */
  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.transports.size === 0) return;
    const interval = StreamingTransportManager.HEARTBEAT_INTERVAL_MS;
    if (!Number.isFinite(interval) || interval <= 0) return;

    this.heartbeatTimer = setInterval(() => this.sweepHeartbeats(), interval);
    // Never a reason to keep the process alive for this.
    if (typeof (this.heartbeatTimer as any).unref === 'function') {
      (this.heartbeatTimer as any).unref();
    }
    this.slog("debug", `Streaming keepalive started`, { intervalMs: interval });
  }

  /** Stop the sweep when there is nothing left to keep alive. */
  private stopHeartbeatIfIdle(): void {
    if (!this.heartbeatTimer || this.transports.size > 0) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.slog("debug", `Streaming keepalive stopped — no transports held`);
  }

  /** Write a comment to every stream that has been silent for too long. */
  private sweepHeartbeats(): void {
    const now = Date.now();
    const interval = StreamingTransportManager.HEARTBEAT_INTERVAL_MS;

    for (const [sessionId, transport] of Array.from(this.transports.entries())) {
      if (!transport.isConnected) continue;
      const last = this.lastWriteAt.get(sessionId) ?? 0;
      if (now - last < interval) continue;
      if ('sendHeartbeat' in transport && typeof (transport as any).sendHeartbeat === 'function') {
        (transport as any).sendHeartbeat();
        this.lastWriteAt.set(sessionId, now);
      }
    }
  }

  sendHeartbeatToSession(chatSessionId: string): void {
    const sseSet = this.chatSessions.get(chatSessionId);
    if (!sseSet || sseSet.size === 0) return;
    for (const sessionId of Array.from(sseSet)) {
      const transport = this.transports.get(sessionId);
      if (!transport || !transport.isConnected) continue;
      if ('sendHeartbeat' in transport && typeof (transport as any).sendHeartbeat === 'function') {
        (transport as any).sendHeartbeat();
        this.lastWriteAt.set(sessionId, Date.now());
      }
    }
  }

  /**
   * Get the number of active transports
   */
  getTransportCount(): number {
    return this.transports.size;
  }

  /**
   * Clean up disconnected transports
   */
  async cleanupDisconnectedTransports(): Promise<number> {
    const disconnectedSessions: string[] = [];

    for (const [sessionId, transport] of this.transports.entries()) {
      if (!transport.isConnected) {
        disconnectedSessions.push(sessionId);
      }
    }

    // Close disconnected transports
    await Promise.all(
      disconnectedSessions.map(sessionId => this.closeTransport(sessionId))
    );

    return disconnectedSessions.length;
  }

  /**
   * Throttle session activity updates to at most once per second per session.
   * Avoids a MongoDB round-trip on every streamed token.
   */
  private throttledUpdateSessionActivity(sessionId: string): void {
    if (this.activityTimers.has(sessionId)) return;
    this.activityTimers.set(sessionId, setTimeout(() => {
      this.activityTimers.delete(sessionId);
      this.updateSessionActivity(sessionId).catch(() => {});
    }, 1000));
  }

  /**
   * Update session last activity timestamp
   */
  private async updateSessionActivity(sessionId: string): Promise<void> {
    try {
      const session = await this.sessionManager.getSession(sessionId);
      if (session) {
        await this.sessionManager.updateSession(sessionId, {
          lastActivity: new Date()
        });
      }
    } catch (error: any) {
      // Log error but don't fail the event sending
      this.slog("warn", `Error updating session activity for ${sessionId}: ${error.message}`);
    }
  }

  description?: string = "Manages streaming transports for active sessions";
  tags?: string[] = ["reactor", "streaming", "transport", "manager"];
  toString?(includeVersion?: boolean): string {
    return `${this.nameSpace}.${this.name}@${this.version}`;
  }
  nameSpace: string = "reactor";
  name: string = "StreamingTransportManager";
  version: string = "1.0.0";
}
