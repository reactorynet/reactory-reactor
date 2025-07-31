import { StreamingSessionManager } from './StreamingSessionManager';
import { StreamingTransport } from './StreamingTransport';
import { StreamingEvent } from './types/streaming.types';

/**
 * Manages streaming transports for active sessions
 * Coordinates between session state and transport connections
 */
export class StreamingTransportManager {
  private readonly transports = new Map<string, StreamingTransport>();
  
  constructor(private readonly sessionManager: StreamingSessionManager) {}
  
  /**
   * Register a transport for a session and initialize it
   */
  async registerTransport(sessionId: string, transport: StreamingTransport): Promise<void> {
    if (this.transports.has(sessionId)) {
      throw new Error('Transport already registered for session');
    }
    
    try {
      await transport.initialize();
      this.transports.set(sessionId, transport);
    } catch (error) {
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
  async sendEventToSession(sessionId: string, event: StreamingEvent): Promise<void> {
    const transport = this.transports.get(sessionId);
    
    if (!transport) {
      throw new Error('No transport registered for session');
    }
    
    try {
      await transport.sendEvent(event);
      
      // Update session last activity
      await this.updateSessionActivity(sessionId);
    } catch (error) {
      // If transport fails, consider it disconnected
      if (!transport.isConnected) {
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
}
