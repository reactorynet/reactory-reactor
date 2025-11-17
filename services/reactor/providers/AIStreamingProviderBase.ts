import { 
  IAIStreamingProviderService, 
  AIStreamingCapabilities, 
  AIStreamingEvent,
  AIStreamingEventType,
  AITokenStreamingData,
  AIToolCallStreamingData,
  AIErrorStreamingData,
  AICompletionStreamingData,
  ChatParams,
  AudioChatParams
} from "../../../types/service.types";
import AIProviderBase from "./AIProviderBase";
import { StreamingSession } from "../types/streaming.types";

/**
 * Abstract base class for AI providers with streaming capabilities
 * Extends the basic AIProviderBase with streaming functionality
 */
abstract class AIStreamingProviderBase extends AIProviderBase implements IAIStreamingProviderService {
  
  /**
   * Abstract method to be implemented by specific providers
   * Returns the streaming capabilities of the provider
   */
  abstract getStreamingCapabilities(): Promise<AIStreamingCapabilities>;

  /**
   * Abstract method to be implemented by specific providers
   * Provides streaming chat functionality
   */
  abstract chatStream(params: ChatParams): AsyncIterable<AIStreamingEvent>;

  /**
   * Abstract method to be implemented by specific providers
   * Provides streaming audio chat functionality
   */
  abstract chatAudioStream(params: AudioChatParams): AsyncIterable<AIStreamingEvent>;

  /**
   * Utility method to create streaming events with consistent structure
   */
  protected createStreamingEvent(
    type: AIStreamingEventType,
    data: any,
    sessionId?: string
  ): AIStreamingEvent {
    return {
      type,
      timestamp: new Date(),
      sessionId,
      data
    };
  }

  /**
   * Create a token streaming event
   */
  protected createTokenEvent(
    content: string,
    delta: string,
    position: number,
    isComplete: boolean = false,
    sessionId?: string,
    metadata?: any
  ): AIStreamingEvent {
    const tokenData: AITokenStreamingData = {
      content,
      delta,
      position,
      isComplete,
      metadata
    };
    return this.createStreamingEvent('token', tokenData, sessionId);
  }

  /**
   * Create a tool call streaming event
   */
  protected createToolCallEvent(
    id: string,
    name: string,
    toolArguments: string,
    isComplete: boolean = false,
    result?: any,
    sessionId?: string
  ): AIStreamingEvent {
    const toolData: AIToolCallStreamingData = {
      id,
      name,
      arguments: toolArguments,
      isComplete,
      result
    };
    return this.createStreamingEvent('tool_call', toolData, sessionId);
  }

  /**
   * Create an error streaming event
   */
  protected createErrorEvent(
    code: string,
    message: string,
    details?: any,
    sessionId?: string
  ): AIStreamingEvent {
    const errorData: AIErrorStreamingData = {
      code,
      message,
      details
    };
    return this.createStreamingEvent('error', errorData, sessionId);
  }

  /**
   * Create a completion streaming event
   */
  protected createCompletionEvent(
    content: string,
    metadata: {
      totalTokens: number;
      promptTokens: number;
      completionTokens: number;
      finishReason: string;
      model: string;
    },
    sessionId?: string
  ): AIStreamingEvent {
    const completionData: AICompletionStreamingData = {
      content,
      metadata
    };
    return this.createStreamingEvent('complete', completionData, sessionId);
  }

  /**
   * Utility method to handle streaming errors consistently
   */
  protected async handleStreamingError(
    error: Error,
    sessionId?: string
  ): Promise<AIStreamingEvent> {
    this.context.error('Streaming error occurred', {
      error: error.message,
      sessionId,
      stack: error.stack
    });

    return this.createErrorEvent(
      'STREAMING_ERROR',
      error.message,
      { stack: error.stack },
      sessionId
    );
  }

  /**
   * Validate streaming parameters before processing
   */
  protected validateStreamingParams(params: ChatParams | AudioChatParams): void {
    if (!params.personaId) {
      throw new Error('personaId is required for streaming');
    }
    if (!params.message && !('audio' in params)) {
      throw new Error('message or audio is required for streaming');
    }
  }

  /**
   * Get or create a streaming session for the chat
   * This is a placeholder for future integration with StreamingSessionManager
   */
  protected async getStreamingSession(params: ChatParams): Promise<StreamingSession | null> {
    // TODO: Integrate with StreamingSessionManager when available
    // For now, this is a placeholder that would handle session retrieval/creation
    this.context.debug('Streaming session requested', {
      chatSessionId: params.chatSessionId,
      personaId: params.personaId
    });
    
    return null; // Return null until StreamingSessionManager integration
  }

  /**
   * Log streaming metrics for monitoring
   */
  protected logStreamingMetrics(
    eventType: AIStreamingEventType,
    sessionId?: string,
    additionalData?: any
  ): void {
    this.context.debug('Streaming event processed', {
      eventType,
      sessionId,
      timestamp: new Date().toISOString(),
      ...additionalData
    });
  }
}

export default AIStreamingProviderBase;
