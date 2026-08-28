import { Request, Response, Application } from 'express';
import { StreamingTransportManager } from './StreamingTransportManager';
import { StreamingSessionManager } from './StreamingSessionManager';
import { SSETransport } from './StreamingTransport';
import { StreamingEvent, StreamingSession } from './types/streaming.types';
import { ChatSessionResourceManager } from './ChatSessionResourceManager';
import { ShellSessionManager } from './ShellSessionManager';
import passport from 'passport';
import safeUrl from '@reactory/server-core/utils/url/safeUrl';
import { sseUriRoot } from './streaming/sseOrigin';
import Helpers from 'authentication/strategies/helpers';

/**
 * Helper: log to both context and the chat session file logger.
 */
function slog(
  context: Reactory.Server.IReactoryContext,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
  chatSessionId?: string,
): void {
  const prefixed = `[StreamingEndpoints] ${message}`;
  // Never let a log call be the reason a request fails — see the note on
  // ReactorConversationService.sessionLog.
  try {
    const safeLevel = typeof (context as any)?.[level] === 'function' ? level : 'error';
    context[safeLevel](prefixed, meta);
  } catch { /* swallow */ }
  if (chatSessionId) {
    try {
      ChatSessionResourceManager.forSession(chatSessionId)?.[level](prefixed, meta);
    } catch { /* swallow */ }
  }
}

/**
 * HTTP endpoints for streaming functionality
 * Provides SSE endpoints and session management APIs
 */
export class StreamingEndpoints {
  constructor(

  ) {}

  /**
   * Setup all streaming routes on the Express application
   */
  static setupRoutes(app: Application): void {
    console.log('[StreamingEndpoints] Setting up streaming routes');

    // SSE endpoint for establishing streaming connections
    app.get('/reactor-chat/streaming/sse/:sessionId', this.handleSSEConnection.bind(this));

    // Event sending endpoint
    app.post('/reactor-chat/streaming/events/:sessionId', this.handleSendEvent.bind(this));

    // Standalone streaming-session creation (used by the shell widget / workflow
    // console and the multi-session FAB hub to obtain a dedicated SSE channel
    // independent of a chat turn).
    //
    // This route needs an authenticated *user*, not just a validated partner:
    // it mints the SSE URL's JWT and owns the streaming session. The base
    // middleware chain (cors → session → body → context → client) only
    // populates `context.partner`; `context.user` is set by the JWT strategy,
    // which runs per route. Without this, `getJwtTokenForUser` throws
    // "User object cannot be null".
    app.post(
      '/reactor-chat/streaming/session',
      passport.authenticate('jwt', { session: false }),
      this.handleCreateSession.bind(this),
    );

    // Session management endpoints
    app.get('/reactor-chat/streaming/session/:sessionId/status', this.handleSessionStatus.bind(this));
    app.delete('/reactor-chat/streaming/session/:sessionId', this.handleCloseSession.bind(this));

    // Health and statistics endpoints
    app.get('/reactor-chat/streaming/health', this.handleHealth.bind(this));
    app.get('/reactor-chat/streaming/stats', this.handleStats.bind(this));

    // Debug endpoint for troubleshooting
    app.get('/reactor-chat/streaming/debug', this.handleDebug.bind(this));

    // ── Interactive shell (PTY) session I/O ─────────────────────────────
    // Output flows OUT over the SSE transport as `shell` events; these routes
    // carry the IN direction (open / keystrokes / resize / kill) + listing.
    app.post('/reactor-chat/shell/session', this.handleShellOpen.bind(this));
    app.get('/reactor-chat/shell/sessions', this.handleShellList.bind(this));
    app.post('/reactor-chat/shell/session/:shellSessionId/input', this.handleShellInput.bind(this));
    app.post('/reactor-chat/shell/session/:shellSessionId/resize', this.handleShellResize.bind(this));
    app.delete('/reactor-chat/shell/session/:shellSessionId', this.handleShellClose.bind(this));

    console.log('[StreamingEndpoints] All streaming routes set up successfully');
  }

  /**
   * Open a new interactive shell session. The session streams its output onto
   * the SSE channel identified by `channelId` (the chat conversation id) as
   * `shell` events. Returns the `shellSessionId` used for subsequent I/O.
   */
  static async handleShellOpen(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    try {
      const shellManager = context.getService<ShellSessionManager>('reactor.ShellSessionManager@1.0.0');
      const { channelId, shell, cwd, cols, rows, env } = req.body || {};
      if (!channelId || typeof channelId !== 'string') {
        res.status(400).json({ error: 'channelId is required' });
        return;
      }
      const result = await shellManager.create({ channelId, shell, cwd, cols, rows, env }, context);
      res.json(result);
    } catch (error: any) {
      const message = error?.message || 'Unknown error';
      const status = /unauthorized/i.test(message) ? 403 : /node-pty/i.test(message) ? 501 : 500;
      res.status(status).json({ error: 'Failed to open shell session', details: message });
    }
  }

  /** Write keystrokes / input to a shell session's PTY. */
  static async handleShellInput(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    const { shellSessionId } = req.params;
    try {
      const shellManager = context.getService<ShellSessionManager>('reactor.ShellSessionManager@1.0.0');
      const { data } = req.body || {};
      if (typeof data !== 'string') {
        res.status(400).json({ error: 'data (string) is required' });
        return;
      }
      shellManager.write(shellSessionId, data, context);
      res.json({ status: 'ok' });
    } catch (error: any) {
      const message = error?.message || 'Unknown error';
      const status = /unauthorized/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 500;
      res.status(status).json({ error: 'Failed to write to shell session', details: message });
    }
  }

  /** Resize a shell session's PTY. */
  static async handleShellResize(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    const { shellSessionId } = req.params;
    try {
      const shellManager = context.getService<ShellSessionManager>('reactor.ShellSessionManager@1.0.0');
      const { cols, rows } = req.body || {};
      shellManager.resize(shellSessionId, Number(cols), Number(rows), context);
      res.json({ status: 'ok' });
    } catch (error: any) {
      const message = error?.message || 'Unknown error';
      const status = /unauthorized/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 500;
      res.status(status).json({ error: 'Failed to resize shell session', details: message });
    }
  }

  /** Terminate a shell session. */
  static async handleShellClose(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    const { shellSessionId } = req.params;
    try {
      const shellManager = context.getService<ShellSessionManager>('reactor.ShellSessionManager@1.0.0');
      shellManager.kill(shellSessionId, context);
      res.json({ status: 'closed', shellSessionId });
    } catch (error: any) {
      const message = error?.message || 'Unknown error';
      const status = /unauthorized/i.test(message) ? 403 : 500;
      res.status(status).json({ error: 'Failed to close shell session', details: message });
    }
  }

  /** List the requesting user's active shell sessions. */
  static async handleShellList(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    try {
      const shellManager = context.getService<ShellSessionManager>('reactor.ShellSessionManager@1.0.0');
      res.json({ sessions: shellManager.list(context) });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to list shell sessions', details: error?.message || 'Unknown error' });
    }
  }

  /**
   * Handle SSE connection establishment
   */
  static async handleSSEConnection(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    const transportManager = context.getService<StreamingTransportManager>("reactor.StreamingTransportManager@1.0.0");
    const sessionManager = context.getService<StreamingSessionManager>("reactor.StreamingSessionManager@1.0.0");
    const { sessionId } = req.params;

    slog(context, "info", `SSE connection request for session: ${sessionId}`, {
      sessionId,
      user: context.user?._id,
      partner: context.partner?.key,
    }, sessionId);

    try {
      // Retrieve session information
      const session: StreamingSession = await sessionManager.getSession(sessionId);

      if (!session) {
        slog(context, "warn", `Session not found for: ${sessionId}`, undefined, sessionId);
        res.status(404).json({
          error: 'Session not found',
          sessionId
        });
        return;
      }

      // The conversationId from the session is the actual chat ID for logging
      const chatId = session.conversationId;

      slog(context, "info", `Streaming session retrieved`, {
        sessionId: session.sessionId,
        conversationId: chatId,
        status: session.status,
        userId: session.userId,
        transport: session.transport,
        capabilities: session.capabilities,
      }, chatId);

      // Check if session is active
      if (session.status !== 'active') {
        slog(context, "warn", `Session ${sessionId} is not active, status: ${session.status}`, undefined, chatId);
        res.status(400).json({
          error: 'Session is not active',
          sessionId,
          status: session.status
        });
        return;
      }

      // Create SSE transport and register it
      const transport = new SSETransport(res);

      // Disable Nagle's algorithm so small SSE chunks are sent immediately
      req.socket.setNoDelay(true);

      slog(context, "debug", `Created SSE transport for session: ${sessionId}`, {
        transportType: transport.constructor.name,
      }, chatId);

      try {
        slog(context, "debug", `Registering transport`, {
          sseSessionId: session.sessionId,
          chatSessionId: chatId,
        }, chatId);

        await transportManager.registerTransport({
          sessionId: session.sessionId,
          chatSessionId: session.conversationId,
          transport
        });

        const subscribers = transportManager.getChatTransportCount(chatId);
        slog(context, "info", `Transport registered successfully for session: ${sessionId}`, {
          // Who connected, and whether this conversation now has more than one
          // subscriber. `client-instance` is `<tab>:<mount>` from useSSE: the
          // same tab id with a different suffix means two chat components
          // mounted in one tab, a different tab id means another tab, and an
          // absent value means the connection came from somewhere other than
          // the active-chat stream (e.g. the background session hub).
          clientInstance: (req.query?.['client-instance'] as string) || 'unset',
          subscribersForConversation: subscribers,
        }, chatId);

        if (subscribers > 1) {
          slog(context, "warn", `Conversation ${chatId} now has ${subscribers} live transports — every event is delivered to each`, {
            chatSessionId: chatId,
            subscribersForConversation: subscribers,
            clientInstance: (req.query?.['client-instance'] as string) || 'unset',
          }, chatId);
        }

      } catch (error: any) {
        slog(context, "error", `Error registering transport: ${error.message}`, {
          errorStack: error.stack,
          sessionId,
          sseSessionId: session.sessionId,
          conversationId: chatId,
        }, chatId);
        await transport.close();
        throw error;
      }

    } catch (error: any) {
      slog(context, "error", `Error handling SSE connection: ${error.message}`, {
        stack: error.stack,
      }, sessionId);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (!res.headersSent) {
        if (errorMessage.includes('Session') || errorMessage.includes('session')) {
          res.status(500).json({
            error: 'Failed to retrieve session',
            details: errorMessage
          });
        } else {
          res.status(500).json({
            error: 'Failed to establish streaming connection',
            details: errorMessage
          });
        }
      } else {
        // Headers already flushed (SSE connection was partially established).
        try {
          const errorEvent = JSON.stringify({ type: 'error', data: { code: 'CONNECTION_ERROR', message: errorMessage } });
          res.write(`event: error\ndata: ${errorEvent}\n\n`);
          res.end();
        } catch (_) {
          res.end();
        }
      }
    }
  }

  /**
   * Create a standalone streaming session for an arbitrary channel id.
   * Returns the streaming session UUID; the client builds the SSE endpoint URL
   * (`/reactor-chat/streaming/sse/:sessionId` + auth query params) and connects
   * an EventSource. Used by the interactive shell widget and the workflow
   * console, both of which need their own persistent channel separate from the
   * chat conversation's SSE transport.
   */
  static async handleCreateSession(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    const { channelId: requestedChannelId } = req.body || {};
    try {
      const sessionManager = context.getService<StreamingSessionManager>('reactor.StreamingSessionManager@1.0.0');
      const channelId = requestedChannelId;
      if (!channelId || typeof channelId !== 'string') {
        slog(context, "warn", `Streaming session creation rejected: channelId is required`, {
          received: typeof requestedChannelId,
        });
        res.status(400).json({ error: 'channelId is required' });
        return;
      }

      if (!context.user || context.user.anon === true) {
        slog(context, "warn", `Streaming session creation rejected: no authenticated user`, {
          channelId,
          partner: context.partner?.key,
          anon: context.user?.anon === true,
        }, channelId);
        res.status(401).json({ error: 'An authenticated user is required to create a streaming session' });
        return;
      }

      slog(context, "info", `Creating standalone streaming session for channel ${channelId}`, {
        channelId,
        user: context.user?._id,
        partner: context.partner?.key,
      }, channelId);

      const userId = String(context.user._id);
      const session = await sessionManager.createSession({
        conversationId: channelId,
        userId,
        transport: 'sse',
        capabilities: { supportsTokenStreaming: true, supportsToolStreaming: true },
      });

      // Build a fully-authenticated SSE URL, mirroring
      // ReactorConversationService.createInitiateSSEResponse. Auth travels as
      // query params because EventSource cannot set headers, and x-client-pwd
      // is a server-only secret the browser cannot supply itself.
      const sseUrl = new URL(safeUrl([sseUriRoot(), `reactor-chat/streaming/sse/${session.sessionId}`]));
      const partnerKey = context.partner?.key?.toUpperCase().replace(/-/g, '_') || '';
      sseUrl.searchParams.set('transport', 'sse');
      sseUrl.searchParams.set('no-upgrade', 'true');
      sseUrl.searchParams.set('jwt', Helpers.getJwtTokenForUser(context.user));
      sseUrl.searchParams.set('expiry', new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString());
      sseUrl.searchParams.set('x-client-key', (process.env[`${partnerKey}_APPLICATION_USERNAME`] as string) || '');
      sseUrl.searchParams.set('x-client-pwd', (process.env[`${partnerKey}_APPLICATION_PASSWORD`] as string) || '');

      slog(context, "info", `Standalone streaming session created for channel ${channelId}`, {
        channelId,
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        hasClientKey: !!sseUrl.searchParams.get('x-client-key'),
        hasClientPwd: !!sseUrl.searchParams.get('x-client-pwd'),
      }, channelId);

      res.json({
        sessionId: session.sessionId,
        channelId,
        endpoint: sseUrl.toString(),
        expiresAt: session.expiresAt,
      });
    } catch (error: any) {
      slog(context, "error", `Failed to create streaming session: ${error?.message || 'Unknown error'}`, {
        channelId: requestedChannelId,
        stack: error?.stack,
      }, typeof requestedChannelId === 'string' ? requestedChannelId : undefined);
      res.status(500).json({ error: 'Failed to create streaming session', details: error?.message || 'Unknown error' });
    }
  }

  /**
   * Handle sending events to a streaming session
   */
  static async handleSendEvent(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    const transportManager = context.getService<StreamingTransportManager>("reactor.StreamingTransportManager@1.0.0");
    const { sessionId } = req.params;

    try {
      // Validate event data
      const event = this.validateStreamingEvent(req.body, sessionId);

      // Check if transport exists for session
      if (!transportManager.hasTransport(sessionId)) {
        res.status(404).json({
          error: 'No transport registered for session',
          sessionId
        });
        return;
      }

      // Send event to transport
      await transportManager.sendEventToSession(sessionId, event);

      res.json({ status: 'sent' });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (errorMessage.includes('validation') || errorMessage.includes('invalid')) {
        res.status(400).json({
          error: 'Invalid event data',
          details: errorMessage
        });
      } else {
        res.status(500).json({
          error: 'Failed to send event',
          details: errorMessage
        });
      }
    }
  }

  /**
   * Handle session status requests
   */
  static async handleSessionStatus(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    const transportManager = context.getService<StreamingTransportManager>("reactor.StreamingTransportManager@1.0.0");
    const sessionManager = context.getService<StreamingSessionManager>("reactor.StreamingSessionManager@1.0.0");
    const { sessionId } = req.params;

    try {
      const session = await sessionManager.getSession(sessionId);

      if (!session) {
        res.status(404).json({
          error: 'Session not found',
          sessionId
        });
        return;
      }

      const hasTransport = transportManager.hasTransport(sessionId);

      res.json({
        sessionId: session.sessionId,
        status: session.status,
        hasTransport,
        lastActivity: session.lastActivity.toISOString(),
        expiresAt: session.expiresAt.toISOString()
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: 'Failed to retrieve session status',
        details: errorMessage
      });
    }
  }

  /**
   * Handle session closure requests
   */
  static async handleCloseSession(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    const transportManager = context.getService<StreamingTransportManager>("reactor.StreamingTransportManager@1.0.0");
    const { sessionId } = req.params;

    try {
      await transportManager.closeTransport(sessionId);

      res.json({
        status: 'closed',
        sessionId
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Still return success but include warning
      res.json({
        status: 'closed',
        sessionId,
        warning: errorMessage
      });
    }
  }

  /**
   * Handle health check requests
   */
  static async handleHealth(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    const transportManager = context.getService<StreamingTransportManager>("reactor.StreamingTransportManager@1.0.0");
    const activeTransports = transportManager.getTransportCount();

    res.json({
      status: 'healthy',
      activeTransports,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle statistics requests
   */
  static async handleStats(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    try {
      const { context } = req;
      const transportManager = context.getService<StreamingTransportManager>("reactor.StreamingTransportManager@1.0.0");
      const sessionManager = context.getService<StreamingSessionManager>("reactor.StreamingSessionManager@1.0.0");
      const activeTransports = transportManager.getTransportCount();
      const expiredSessions = await sessionManager.cleanupExpiredSessions();

      res.json({
        activeTransports,
        expiredSessions,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: 'Failed to retrieve statistics',
        details: errorMessage
      });
    }
  }

  /**
   * Handle debug requests
   */
  static async handleDebug(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    try {
      const { context } = req;

      const transportManager = context.getService<StreamingTransportManager>("reactor.StreamingTransportManager@1.0.0");
      const sessionManager = context.getService<StreamingSessionManager>("reactor.StreamingSessionManager@1.0.0");

      if (!transportManager || !sessionManager) {
        res.status(500).json({
          error: 'Streaming services not available',
          transportManager: !!transportManager,
          sessionManager: !!sessionManager
        });
        return;
      }

      const activeTransports = transportManager.getTransportCount();
      const expiredSessions = await sessionManager.cleanupExpiredSessions();

      // Get detailed information about active transports
      const transportDetails = [];
      if (transportManager.hasOwnProperty('transports')) {
        const transports = (transportManager as any).transports;
        for (const [sid, transport] of transports.entries()) {
          transportDetails.push({
            sessionId: sid,
            transportType: transport.constructor.name,
            isConnected: transport.isConnected,
            hasSendEvent: typeof transport.sendEvent === 'function'
          });
        }
      }

      // Get detailed information about chat sessions
      const chatSessionDetails = [];
      if (transportManager.hasOwnProperty('chatSessions')) {
        const chatSessions = (transportManager as any).chatSessions;
        for (const [chatSessionId, sid] of chatSessions.entries()) {
          chatSessionDetails.push({
            chatSessionId,
            sessionId: sid
          });
        }
      }

      const debugInfo = {
        status: 'debug',
        timestamp: new Date().toISOString(),
        services: {
          transportManager: {
            available: true,
            activeTransports,
            transportDetails
          },
          sessionManager: {
            available: true,
            expiredSessions
          }
        },
        mappings: {
          chatSessionDetails
        },
        request: {
          user: context.user?._id?.toString(),
          partner: context.partner?.key,
          headers: Object.keys(req.headers)
        }
      };

      context.debug('[StreamingEndpoints] Debug info', debugInfo);

      res.json(debugInfo);

    } catch (error: any) {
      console.error('[StreamingEndpoints] Error in debug endpoint:', error);
      res.status(500).json({
        error: 'Debug endpoint error',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Validate streaming event data
   */
  static validateStreamingEvent(data: any, sessionId: string): StreamingEvent {
    if (!data || typeof data !== 'object') {
      throw new Error('Event data must be an object');
    }

    const { type, conversationId, timestamp, data: eventData } = data;

    if (!type || typeof type !== 'string') {
      throw new Error('Event type is required and must be a string');
    }

    if (!['token', 'tool_call', 'complete', 'error'].includes(type)) {
      throw new Error(`Invalid event type: ${type}`);
    }

    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error('Conversation ID is required and must be a string');
    }

    // Use provided timestamp or current time
    const eventTimestamp = timestamp ? new Date(timestamp) : new Date();

    if (isNaN(eventTimestamp.getTime())) {
      throw new Error('Invalid timestamp format');
    }

    return {
      type: type as StreamingEvent['type'],
      sessionId,
      conversationId,
      messageId: sessionId,
      timestamp: eventTimestamp,
      data: eventData
    };
  }
}
