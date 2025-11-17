/**
 * Streaming Debug Utility
 * 
 * This utility provides debugging methods to help diagnose streaming issues
 * in the Reactor Chat system.
 */

export class StreamingDebug {
  
  /**
   * Check the health of streaming services
   */
  static async checkStreamingHealth(context: Reactory.Server.IReactoryContext): Promise<{
    streamingSessionManager: boolean;
    streamingTransportManager: boolean;
    services: {
      sessionManager: any;
      transportManager: any;
    };
    activeSessions: number;
    activeTransports: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let sessionManager: any = null;
    let transportManager: any = null;
    
    try {
      // Check StreamingSessionManager
      try {
        sessionManager = context.getService("reactor.StreamingSessionManager@1.0.0");
        console.log('🔍 [StreamingDebug] StreamingSessionManager found:', !!sessionManager);
      } catch (error) {
        errors.push(`StreamingSessionManager not found: ${error.message}`);
      }
      
      // Check StreamingTransportManager
      try {
        transportManager = context.getService("reactor.StreamingTransportManager@1.0.0");
        console.log('🔍 [StreamingDebug] StreamingTransportManager found:', !!transportManager);
      } catch (error) {
        errors.push(`StreamingTransportManager not found: ${error.message}`);
      }
      
      // Get active session and transport counts
      let activeSessions = 0;
      let activeTransports = 0;
      
      if (sessionManager) {
        try {
          // Try to get session count if method exists
          if (typeof sessionManager.getActiveSessionCount === 'function') {
            activeSessions = await sessionManager.getActiveSessionCount();
          }
        } catch (error) {
          console.warn('⚠️ [StreamingDebug] Could not get active session count:', error.message);
        }
      }
      
      if (transportManager) {
        try {
          // Try to get transport count if method exists
          if (typeof transportManager.getTransportCount === 'function') {
            activeTransports = transportManager.getTransportCount();
          }
        } catch (error) {
          console.warn('⚠️ [StreamingDebug] Could not get active transport count:', error.message);
        }
      }
      
      return {
        streamingSessionManager: !!sessionManager,
        streamingTransportManager: !!transportManager,
        services: {
          sessionManager,
          transportManager
        },
        activeSessions,
        activeTransports,
        errors
      };
      
    } catch (error) {
      errors.push(`General error during health check: ${error.message}`);
      return {
        streamingSessionManager: false,
        streamingTransportManager: false,
        services: {
          sessionManager: null,
          transportManager: null
        },
        activeSessions: 0,
        activeTransports: 0,
        errors
      };
    }
  }
  
  /**
   * Log detailed information about a streaming session
   */
  static logSessionDetails(session: any, context: string = 'StreamingDebug'): void {
    console.log(`🔍 [${context}] Session details:`, {
      sessionId: session?.sessionId,
      conversationId: session?.conversationId,
      userId: session?.userId,
      status: session?.status,
      transport: session?.transport,
      capabilities: session?.capabilities,
      createdAt: session?.createdAt,
      lastActivity: session?.lastActivity,
      expiresAt: session?.expiresAt
    });
  }
  
  /**
   * Log detailed information about a streaming transport
   */
  static logTransportDetails(transport: any, context: string = 'StreamingDebug'): void {
    console.log(`🔍 [${context}] Transport details:`, {
      transportType: transport?.constructor?.name,
      isConnected: transport?.isConnected,
      hasInitialize: typeof transport?.initialize === 'function',
      hasSendEvent: typeof transport?.sendEvent === 'function',
      hasClose: typeof transport?.close === 'function'
    });
  }
  
  /**
   * Log detailed information about a streaming event
   */
  static logEventDetails(event: any, context: string = 'StreamingDebug'): void {
    console.log(`🔍 [${context}] Event details:`, {
      type: event?.type,
      sessionId: event?.sessionId,
      conversationId: event?.conversationId,
      messageId: event?.messageId,
      timestamp: event?.timestamp,
      dataKeys: event?.data ? Object.keys(event.data) : [],
      dataType: typeof event?.data
    });
  }
  
  /**
   * Check if all required streaming dependencies are available
   */
  static checkDependencies(context: Reactory.Server.IReactoryContext): {
    available: boolean;
    missing: string[];
    availableServices: string[];
  } {
    const requiredServices = [
      "reactor.StreamingSessionManager@1.0.0",
      "reactor.StreamingTransportManager@1.0.0"
    ];
    
    const missing: string[] = [];
    const availableServices: string[] = [];
    
    for (const serviceId of requiredServices) {
      try {
        const service = context.getService(serviceId);
        if (service) {
          availableServices.push(serviceId);
        } else {
          missing.push(serviceId);
        }
      } catch (error) {
        missing.push(serviceId);
      }
    }
    
    return {
      available: missing.length === 0,
      missing,
      availableServices
    };
  }
}
