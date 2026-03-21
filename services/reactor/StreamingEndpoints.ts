import { Request, Response, Application } from 'express';
import { StreamingTransportManager } from './StreamingTransportManager';
import { StreamingSessionManager } from './StreamingSessionManager';
import { SSETransport } from './StreamingTransport';
import { StreamingEvent, StreamingSession } from './types/streaming.types';

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
    console.log('🔌 [StreamingEndpoints] Setting up streaming routes');
    
    // SSE endpoint for establishing streaming connections
    app.get('/reactor-chat/streaming/sse/:sessionId', this.handleSSEConnection.bind(this));
    
    // Event sending endpoint
    app.post('/reactor-chat/streaming/events/:sessionId', this.handleSendEvent.bind(this));
    
    // Session management endpoints
    app.get('/reactor-chat/streaming/session/:sessionId/status', this.handleSessionStatus.bind(this));
    app.delete('/reactor-chat/streaming/session/:sessionId', this.handleCloseSession.bind(this));
    
    // Health and statistics endpoints
    app.get('/reactor-chat/streaming/health', this.handleHealth.bind(this));
    app.get('/reactor-chat/streaming/stats', this.handleStats.bind(this));
    
    // Debug endpoint for troubleshooting
    app.get('/reactor-chat/streaming/debug', this.handleDebug.bind(this));
    
    console.log('✅ [StreamingEndpoints] All streaming routes set up successfully');
  }
  
  /**
   * Handle SSE connection establishment
   */
  static async handleSSEConnection(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> {
    const { context } = req;
    const transportManager = context.getService<StreamingTransportManager>("reactor.StreamingTransportManager@1.0.0");
    const sessionManager = context.getService<StreamingSessionManager>("reactor.StreamingSessionManager@1.0.0");
    const { sessionId } = req.params;
    
    console.log(`🔌 [StreamingEndpoints] SSE connection request for session: ${sessionId}`);
    console.log(`🔌 [StreamingEndpoints] Request details:`, {
      sessionId,
      headers: req.headers,
      query: req.query,
      user: context.user?._id,
      partner: context.partner?.key
    });
    
    try {
      // Retrieve session information
      const session: StreamingSession = await sessionManager.getSession(sessionId);
      
      if (!session) {
        console.log(`❌ [StreamingEndpoints] Session not found for: ${sessionId}`);
        res.status(404).json({
          error: 'Session not found',
          sessionId
        });
        return;
      }
      
      console.log(`🔌 [StreamingEndpoints] Streaming session retrieved:`, {
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        status: session.status,
        userId: session.userId,
        transport: session.transport,
        capabilities: session.capabilities
      });
      
      // Check if session is active
      if (session.status !== 'active') {
        console.log(`❌ [StreamingEndpoints] Session ${sessionId} is not active, status: ${session.status}`);
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
      // instead of being buffered into larger TCP segments.
      req.socket.setNoDelay(true);

      console.log(`🔌 [StreamingEndpoints] Created SSE transport for session: ${sessionId}`);
      console.log(`🔌 [StreamingEndpoints] Transport details:`, {
        transportType: transport.constructor.name,
        hasInitialize: typeof transport.initialize === 'function',
        hasSendEvent: typeof transport.sendEvent === 'function',
        hasClose: typeof transport.close === 'function'
      });
      
      try {
        // Register the transport with the transport manager
        // sessionId from URL is the conversation ID
        // session.sessionId is the SSE session ID
        console.log(`🔌 [StreamingEndpoints] Registering transport with:`);
        console.log(`  - sessionId (SSE session): ${session.sessionId}`);
        console.log(`  - chatSessionId (conversation): ${sessionId}`);
        
        await transportManager.registerTransport({ 
          sessionId: session.sessionId,  // SSE session ID
          chatSessionId: session.conversationId,      // Conversation ID (from URL parameter)
          transport 
        });
        
        console.log(`✅ [StreamingEndpoints] Transport registered successfully for session: ${sessionId}`);
        
        // Connection established successfully
        // The SSE transport initialization handles the response headers
      } catch (error) {
        console.error(`❌ [StreamingEndpoints] Error registering transport:`, error);
        console.error(`❌ [StreamingEndpoints] Error details:`, {
          errorMessage: error.message,
          errorStack: error.stack,
          errorName: error.name,
          sessionId,
          sessionSessionId: session.sessionId,
          conversationId: session.conversationId
        });
        await transport.close();
        throw error;
      }
      
    } catch (error) {
      console.error(`❌ [StreamingEndpoints] Error handling SSE connection:`, error);
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
        // Send an SSE error event and close the response so the client can
        // detect the failure and trigger its reconnect logic.
        try {
          const errorEvent = JSON.stringify({ type: 'error', data: { code: 'CONNECTION_ERROR', message: errorMessage } });
          res.write(`event: error\ndata: ${errorEvent}\n\n`);
          res.end();
        } catch (_) {
          // Response may already be destroyed — nothing more to do
          res.end();
        }
      }
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
      console.log('🔍 [StreamingEndpoints] Debug request received');
      
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
        for (const [sessionId, transport] of transports.entries()) {
          transportDetails.push({
            sessionId,
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
        for (const [chatSessionId, sessionId] of chatSessions.entries()) {
          chatSessionDetails.push({
            chatSessionId,
            sessionId
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
      
      console.log('🔍 [StreamingEndpoints] Debug info:', debugInfo);
      
      res.json(debugInfo);
      
    } catch (error) {
      console.error('❌ [StreamingEndpoints] Error in debug endpoint:', error);
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
      messageId: sessionId, // Use sessionId as messageId for validation
      timestamp: eventTimestamp,
      data: eventData
    };
  }
}
