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
    // TODO: Implement streaming logic
    // For now, throw to make tests fail (TDD approach)
    throw new Error('sendMessageWithStreaming not implemented yet');
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
