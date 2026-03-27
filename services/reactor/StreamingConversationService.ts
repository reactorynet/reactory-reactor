import { service } from "@reactory/server-core/application/decorators/service";
import ReactorConversationService from "./ReactorConversationService";
import { 
  SendMessageWithStreamingArgs, 
  StreamingSession 
} from "./types/streaming.types";

/**
 * Enhanced conversation service with streaming capabilities
 * Extends existing ReactorConversationService with real-time features
 * 
 * @class StreamingConversationService
 * @extends ReactorConversationService
 * @service reactor.StreamingConversationService@1.0.0
 */
@service({
  id: "reactor.StreamingConversationService@1.0.0"
})
export class StreamingConversationService extends ReactorConversationService {
  
  /**
   * Service identifier for dependency injection
   */
  public readonly serviceId = "reactor.StreamingConversationService@1.0.0";
  
  /**
   * Send message with streaming response support
   * Returns either immediate response or streaming session info
   * 
   * @param args - Message arguments with streaming configuration 
   * @returns Promise resolving to either direct response or streaming session initiation
   */
  async sendMessageWithStreaming(args: SendMessageWithStreamingArgs): Promise<any> {
    // Validate required parameters
    if (!args.personaId) {
      throw new Error('personaId is required');
    }
    
    if (!args.message) {
      throw new Error('message is required');
    }
    
    // Validate streaming mode
    const validStreamingModes = ['none', 'sse', 'websocket'];
    if (!validStreamingModes.includes(args.streamingMode)) {
      throw new Error('Invalid streaming mode');
    }
    
    // For non-streaming mode, delegate to base service
    if (args.streamingMode === 'none') {
      return this.sendMessage({
        personaId: args.personaId,
        chatSessionId: args.chatSessionId,
        message: args.message,
        role: 'user'
      });
    }
    
    // For streaming modes, return session initiation response
    const sessionId = this.generateSessionId();
    const endpoint = args.streamingMode === 'sse' 
      ? `/api/reactor/stream/${sessionId}`
      : `/api/reactor/ws/${sessionId}`;
    
    // TODO: Create actual streaming session here
    // For now, return the initiation response structure
    return {
      __typename: 'ReactorInitiateSSE',
      sessionId,
      endpoint,
      status: 'ready',
      expiry: new Date(Date.now() + 3600000), // 1 hour from now
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    };
  }
  
  /**
   * Generate a unique session ID
   * @returns String session ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }
  
  /**
   * Process streaming response from AI provider
   * Handles token-by-token streaming and session management
   * 
   * @param streamingSession - Active streaming session
   * @param aiResponse - ReadableStream from AI provider
   * @returns Promise that resolves when streaming is complete
   */
  async processStreamingResponse(
    streamingSession: StreamingSession,
    aiResponse: ReadableStream<any>
  ): Promise<void> {
    // Validate required parameters
    if (!streamingSession) {
      throw new Error('streamingSession is required');
    }
    
    if (!aiResponse) {
      throw new Error('aiResponse stream is required');
    }
    
    try {
      // Get a reader for the stream
      const reader = aiResponse.getReader();
      const decoder = new TextDecoder();
      
      let accumulatedContent = '';
      let tokenPosition = 0;
      
      // Process the stream chunk by chunk
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }
        
        // Decode the chunk
        let chunk: string;
        if (typeof value === 'string') {
          chunk = value;
        } else {
          chunk = decoder.decode(value, { stream: true });
        }
        
        // Handle empty chunks
        if (!chunk) {
          continue;
        }
        
        // Try to parse as JSON for structured streaming events
        try {
          const parsedChunk = JSON.parse(chunk);
          
          if (parsedChunk.type === 'token') {
            // Handle token streaming events
            const tokenData = parsedChunk.data;
            accumulatedContent += tokenData.delta || tokenData.content || '';
            tokenPosition += tokenData.delta?.length || tokenData.content?.length || 0;
            
            // TODO: Emit token event to client via WebSocket
            this.emitStreamingEvent(streamingSession, {
              type: 'token',
              sessionId: streamingSession.sessionId,
              conversationId: streamingSession.conversationId,
              timestamp: new Date(),
              data: {
                content: accumulatedContent,
                delta: tokenData.delta || tokenData.content,
                position: tokenPosition,
                isComplete: false
              }
            });
            
          } else if (parsedChunk.type === 'complete') {
            // Handle completion events
            this.emitStreamingEvent(streamingSession, {
              type: 'complete',
              sessionId: streamingSession.sessionId,
              conversationId: streamingSession.conversationId,
              timestamp: new Date(),
              data: {
                content: accumulatedContent,
                delta: '',
                position: tokenPosition,
                isComplete: true
              }
            });
            break;
            
          } else if (parsedChunk.type === 'tool_call') {
            // Handle tool call events
            this.emitStreamingEvent(streamingSession, {
              type: 'tool_call',
              sessionId: streamingSession.sessionId,
              conversationId: streamingSession.conversationId,
              timestamp: new Date(),
              data: parsedChunk.data
            });
          }
          
        } catch (parseError) {
          // If not JSON, treat as raw text token
          accumulatedContent += chunk;
          tokenPosition += chunk.length;
          
          // Emit as token event
          this.emitStreamingEvent(streamingSession, {
            type: 'token',
            sessionId: streamingSession.sessionId,
            conversationId: streamingSession.conversationId,
            timestamp: new Date(),
            data: {
              content: accumulatedContent,
              delta: chunk,
              position: tokenPosition,
              isComplete: false
            }
          });
        }
      }
      
      // Emit final completion event if we haven't already
      if (accumulatedContent) {
        this.emitStreamingEvent(streamingSession, {
          type: 'complete',
          sessionId: streamingSession.sessionId,
          conversationId: streamingSession.conversationId,
          timestamp: new Date(),
          data: {
            content: accumulatedContent,
            delta: '',
            position: tokenPosition,
            isComplete: true
          }
        });
      }
      
    } catch (error: any) {
      // Re-throw stream errors to be handled by caller
      throw new Error(error.message || 'Error processing streaming response');
    }
  }
  
  /**
   * Emit streaming event to the client
   * This is a placeholder that will be implemented with actual transport layer
   * 
   * @param session - The streaming session
   * @param event - The streaming event to emit
   */
  private emitStreamingEvent(session: StreamingSession, event: any): void {
    // TODO: Implement actual event emission via SSE/WebSocket
    // For now, this is a placeholder that logs the event
    console.log(`[${session.sessionId}] Streaming event:`, event.type, event.data);
  }
}
