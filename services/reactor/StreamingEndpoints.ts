import { Request, Response, Application } from 'express';
import { StreamingTransportManager } from './StreamingTransportManager';
import { StreamingSessionManager } from './StreamingSessionManager';
import { SSETransport } from './StreamingTransport';
import { StreamingEvent } from './types/streaming.types';

/**
 * HTTP endpoints for streaming functionality
 * Provides SSE endpoints and session management APIs
 */
export class StreamingEndpoints {
  constructor(
    private readonly transportManager: StreamingTransportManager,
    private readonly sessionManager: StreamingSessionManager
  ) {}
  
  /**
   * Setup all streaming routes on the Express application
   */
  setupRoutes(app: Application): void {
    // SSE endpoint for establishing streaming connections
    app.get('/streaming/sse/:sessionId', this.handleSSEConnection.bind(this));
    
    // Event sending endpoint
    app.post('/streaming/events/:sessionId', this.handleSendEvent.bind(this));
    
    // Session management endpoints
    app.get('/streaming/session/:sessionId/status', this.handleSessionStatus.bind(this));
    app.delete('/streaming/session/:sessionId', this.handleCloseSession.bind(this));
    
    // Health and statistics endpoints
    app.get('/streaming/health', this.handleHealth.bind(this));
    app.get('/streaming/stats', this.handleStats.bind(this));
  }
  
  /**
   * Handle SSE connection establishment
   */
  private async handleSSEConnection(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    
    try {
      // Retrieve session information
      const session = await this.sessionManager.getSession(sessionId);
      
      if (!session) {
        res.status(404).json({
          error: 'Session not found',
          sessionId
        });
        return;
      }
      
      // Check if session is active
      if (session.status !== 'active') {
        res.status(400).json({
          error: 'Session is not active',
          sessionId,
          status: session.status
        });
        return;
      }
      
      // Create SSE transport and register it
      const transport = new SSETransport(res);
      
      try {
        await this.transportManager.registerTransport(sessionId, transport);
        
        // Connection established successfully
        // The SSE transport initialization handles the response headers
      } catch (error) {
        await transport.close();
        throw error;
      }
      
    } catch (error) {
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
      }
    }
  }
  
  /**
   * Handle sending events to a streaming session
   */
  private async handleSendEvent(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    
    try {
      // Validate event data
      const event = this.validateStreamingEvent(req.body, sessionId);
      
      // Check if transport exists for session
      if (!this.transportManager.hasTransport(sessionId)) {
        res.status(404).json({
          error: 'No transport registered for session',
          sessionId
        });
        return;
      }
      
      // Send event to transport
      await this.transportManager.sendEventToSession(sessionId, event);
      
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
  private async handleSessionStatus(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    
    try {
      const session = await this.sessionManager.getSession(sessionId);
      
      if (!session) {
        res.status(404).json({
          error: 'Session not found',
          sessionId
        });
        return;
      }
      
      const hasTransport = this.transportManager.hasTransport(sessionId);
      
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
  private async handleCloseSession(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    
    try {
      await this.transportManager.closeTransport(sessionId);
      
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
  private async handleHealth(req: Request, res: Response): Promise<void> {
    const activeTransports = this.transportManager.getTransportCount();
    
    res.json({
      status: 'healthy',
      activeTransports,
      timestamp: new Date().toISOString()
    });
  }
  
  /**
   * Handle statistics requests
   */
  private async handleStats(req: Request, res: Response): Promise<void> {
    try {
      const activeTransports = this.transportManager.getTransportCount();
      const expiredSessions = await this.sessionManager.cleanupExpiredSessions();
      
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
   * Validate streaming event data
   */
  private validateStreamingEvent(data: any, sessionId: string): StreamingEvent {
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
      timestamp: eventTimestamp,
      data: eventData
    };
  }
}
