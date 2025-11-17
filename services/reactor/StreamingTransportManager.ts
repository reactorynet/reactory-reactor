import { service } from '@reactory/server-core/application/decorators/service';
import { StreamingSessionManager } from './StreamingSessionManager';
import { StreamingTransport } from './StreamingTransport';
import { StreamingEvent } from './types/streaming.types';

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
  private sessionManager: StreamingSessionManager;

  private static instance: StreamingTransportManager;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    this.context = context;
    if (!StreamingTransportManager.instance) {
      StreamingTransportManager.instance = this;
    }
    return StreamingTransportManager.instance;
  }

  private setSessionManager(sessionManager: StreamingSessionManager) {
    this.sessionManager = sessionManager;
  }
  
  /**
   * Register a transport for a session and initialize it
   */
  async registerTransport(args: { 
    sessionId: string,
    chatSessionId: string,
    transport: StreamingTransport }): Promise<void> {
    const { sessionId, chatSessionId, transport } = args;
    
    console.log(`[StreamingTransportManager] registerTransport called with:`);
    console.log(`  - sessionId (SSE session): ${sessionId}`);
    console.log(`  - chatSessionId (conversation): ${chatSessionId}`);
    console.log(`  - transport type: ${transport.constructor.name}`);
    
    if (this.transports.has(sessionId)) {
      throw new Error('Transport already registered for session');
    }
    
    try {
      await transport.initialize();
      this.transports.set(sessionId, transport);
      this.chatSessions.set(chatSessionId, sessionId);
      
      console.log(`[StreamingTransportManager] Transport registered successfully`);
      console.log(`[StreamingTransportManager] Current chatSessions mapping:`, Array.from(this.chatSessions.entries()));
      console.log(`[StreamingTransportManager] Current transports mapping:`, Array.from(this.transports.keys()));
    } catch (error) {
      console.error(`[StreamingTransportManager] Error registering transport:`, error);
      // Clean up on initialization failure
      try {
        await transport.close();
      } catch (closeError) {
        console.warn('Error during transport cleanup:', closeError);
      }
      throw error;
    }
  }
  
  /**
   * Send an event to a specific session's transport
   */
  async sendEventToSession(chatSessionId: string, event: StreamingEvent): Promise<void> {
    console.log(`🔧 [StreamingTransportManager] sendEventToSession called with:`, {
      chatSessionId,
      eventType: event.type,
      eventData: event.data,
      eventTimestamp: event.timestamp,
      eventSessionId: event.sessionId,
      eventMessageId: event.messageId
    });
    console.log(`🔧 [StreamingTransportManager] Current chatSessions mapping:`, Array.from(this.chatSessions.entries()));
    console.log(`🔧 [StreamingTransportManager] Current transports mapping:`, Array.from(this.transports.keys()));
    
    const sessionId = this.chatSessions.get(chatSessionId);

    if (!sessionId) {
      console.error(`❌ [StreamingTransportManager] No session found for chat session ${chatSessionId}`);
      console.error(`❌ [StreamingTransportManager] Available chat sessions:`, Array.from(this.chatSessions.keys()));
      throw new Error('No session registered for chat session');
    }
    
    console.log(`🔧 [StreamingTransportManager] Found SSE session ID: ${sessionId} for chat session: ${chatSessionId}`);
    
    const transport = this.transports.get(sessionId);
    
    if (!transport) {
      console.error(`❌ [StreamingTransportManager] No transport found for SSE session ${sessionId}`);
      console.error(`❌ [StreamingTransportManager] Available transports:`, Array.from(this.transports.keys()));
      throw new Error('No transport registered for session');
    }
    
    console.log(`🔧 [StreamingTransportManager] Sending event to transport for SSE session: ${sessionId}`);
    console.log(`🔧 [StreamingTransportManager] Transport details:`, {
      transportType: transport.constructor.name,
      isConnected: transport.isConnected,
      hasSendEvent: typeof transport.sendEvent === 'function'
    });
    
    try {
      await transport.sendEvent(event);
      
      // Update session last activity
      await this.updateSessionActivity(sessionId);
      console.log(`✅ [StreamingTransportManager] Event sent successfully to transport`);
    } catch (error) {
      console.error(`❌ [StreamingTransportManager] Error sending event:`, error);
      console.error(`❌ [StreamingTransportManager] Error details:`, {
        errorMessage: error.message,
        errorStack: error.stack,
        errorName: error.name,
        chatSessionId,
        sessionId,
        eventType: event.type
      });
      
      // If transport fails, consider it disconnected
      if (!transport.isConnected) {
        console.warn(`⚠️ [StreamingTransportManager] Transport marked as disconnected, removing from registry`);
        this.transports.delete(sessionId);
      }
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
    
    try {
      await transport.close();
    } catch (error) {
      // Log error but continue with cleanup
      console.warn(`Error closing transport for session ${sessionId}:`, error);
    } finally {
      this.transports.delete(sessionId);
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
        } catch (error) {
          console.warn(`Error closing transport for session ${sessionId}:`, error);
        }
      }
    );
    
    await Promise.all(closePromises);
    this.transports.clear();
  }
  
  /**
   * Check if a transport is registered for a session
   */
  hasTransport(sessionId: string): boolean {
    return this.transports.has(sessionId);
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
    } catch (error) {
      // Log error but don't fail the event sending
      console.warn(`Error updating session activity for ${sessionId}:`, error);
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
