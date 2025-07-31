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
    // TODO: Implement streaming response processing
    // For now, throw to make tests fail (TDD approach) 
    throw new Error('processStreamingResponse not implemented yet');
  }
}
