import { service } from '@reactory/server-core/application/decorators/service';
import { StreamingSessionManager } from './StreamingSessionManager';
import { StreamingTransport } from './StreamingTransport';
import { StreamingEvent } from './types/streaming.types';
import { ChatSessionResourceManager } from './ChatSessionResourceManager';

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
  ],
  lifeCycle: 'singleton',
})
export class StreamingTransportManager implements Reactory.Service.IReactoryService {
  private readonly context: Reactory.Server.IReactoryContext;
  private readonly transports = new Map<string, StreamingTransport>();
  private readonly chatSessions = new Map<string, string>();
  private readonly activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionManager: StreamingSessionManager;

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
    this.context[level](`[StreamingTransportManager] ${message}`, meta);
    if (chatSessionId) {
      ChatSessionResourceManager.forSession(chatSessionId)?.[level](
        `[StreamingTransportManager] ${message}`, meta
      );
    }
  }

  /**
   * Resolve a chatSessionId from an SSE session ID by reverse-looking up
   * the chatSessions map.
   */
  private chatIdForSse(sseSessionId: string): string | undefined {
    for (const [chatId, sseId] of this.chatSessions.entries()) {
      if (sseId === sseSessionId) return chatId;
    }
    return undefined;
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
   * Close and remove a transport + its reverse-mapping entry by SSE session ID.
   * Safe to call even if the transport is already gone.
   */
  private async evictTransport(sseSessionId: string, reason: string): Promise<void> {
    const transport = this.transports.get(sseSessionId);
    if (!transport) return;
    const chatId = this.chatIdForSse(sseSessionId);
    this.slog("info", `Evicting transport ${sseSessionId} (${reason}, connected: ${transport.isConnected})`, undefined, chatId);
    try {
      await transport.close();
    } catch (err: any) {
      this.slog("warn", `Error closing transport ${sseSessionId}: ${err.message}`, undefined, chatId);
    }
    this.transports.delete(sseSessionId);
    if (chatId) {
      this.chatSessions.delete(chatId);
    }
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

    // If a transport already exists for this SSE session ID, close and replace it.
    await this.evictTransport(sessionId, 'same SSE session ID re-registration');

    // On reconnect the chatSessionId may already map to a DIFFERENT (old) SSE
    // session whose transport is dead.  Clean that up so the old transport
    // doesn't leak and the mapping is deterministic.
    const previousSseId = this.chatSessions.get(chatSessionId);
    if (previousSseId && previousSseId !== sessionId) {
      await this.evictTransport(previousSseId, `replaced by new SSE session for chat ${chatSessionId}`);
    }

    try {
      await transport.initialize();
      this.transports.set(sessionId, transport);
      this.chatSessions.set(chatSessionId, sessionId);

      this.slog("info", `Transport registered successfully`, {
        chatSessions: Array.from(this.chatSessions.entries()),
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
   * Send an event to a specific session's transport.
   * If no connected transport exists, the event is buffered and flushed
   * when a transport is re-registered (e.g. on client reconnect).
   */
  async sendEventToSession(chatSessionId: string, event: StreamingEvent): Promise<void> {
    const sessionId = this.chatSessions.get(chatSessionId);

    if (!sessionId) {
      this.slog("debug", `No session found for chat session ${chatSessionId} — buffering event`, {
        eventType: event.type,
      }, chatSessionId);
      this.bufferEvent(chatSessionId, event);
      return;
    }

    const transport = this.transports.get(sessionId);

    if (!transport) {
      this.slog("debug", `No transport found for SSE session ${sessionId} — buffering event`, {
        eventType: event.type,
      }, chatSessionId);
      this.bufferEvent(chatSessionId, event);
      return;
    }

    if (!transport.isConnected) {
      this.slog("debug", `Transport for SSE session ${sessionId} is disconnected — buffering event`, {
        eventType: event.type,
      }, chatSessionId);
      this.transports.delete(sessionId);
      this.chatSessions.delete(chatSessionId);
      this.bufferEvent(chatSessionId, event);
      return;
    }

    try {
      await transport.sendEvent(event);

      if (event.type === 'tool_call' || event.type === 'complete' || event.type === 'error') {
        this.slog("debug", `Sent ${event.type} event`, {
          eventType: event.type,
          chatSessionId,
          messageId: event.messageId,
        }, chatSessionId);
      }

      this.throttledUpdateSessionActivity(sessionId);
    } catch (error: any) {
      this.slog("error", `Error sending event: ${error.message}`, {
        eventType: event.type,
        chatSessionId,
      }, chatSessionId);

      if (!transport.isConnected) {
        this.transports.delete(sessionId);
        this.chatSessions.delete(chatSessionId);
      }
      this.bufferEvent(chatSessionId, event);
      throw error;
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

    const chatId = this.chatIdForSse(sessionId);

    try {
      await transport.close();
    } catch (error: any) {
      this.slog("warn", `Error closing transport for session ${sessionId}: ${error.message}`, undefined, chatId);
    } finally {
      this.transports.delete(sessionId);
      if (chatId) {
        this.chatSessions.delete(chatId);
      }
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
      const chatId = this.chatIdForSse(sessionId);
      this.slog("debug", `hasTransport: transport for ${sessionId} exists but is disconnected — removing stale entry`, undefined, chatId);
      this.transports.delete(sessionId);
      if (chatId) {
        this.chatSessions.delete(chatId);
      }
      return false;
    }

    return true;
  }

  /**
   * Check if an active transport exists for a chat (conversation) session.
   * Convenience method that resolves the chatSessionId → sseSessionId
   * mapping internally.
   */
  hasActiveTransportForChat(chatSessionId: string): boolean {
    const sessionId = this.chatSessions.get(chatSessionId);
    if (!sessionId) return false;
    return this.hasTransport(sessionId);
  }

  /**
   * Send a keepalive heartbeat to prevent proxy/browser timeouts during
   * long-running server-side operations (e.g. AUTO tool execution loops).
   * Best-effort — failures are silently ignored.
   */
  sendHeartbeatToSession(chatSessionId: string): void {
    const sessionId = this.chatSessions.get(chatSessionId);
    if (!sessionId) return;
    const transport = this.transports.get(sessionId);
    if (!transport || !transport.isConnected) return;
    if ('sendHeartbeat' in transport && typeof (transport as any).sendHeartbeat === 'function') {
      (transport as any).sendHeartbeat();
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
