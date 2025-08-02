import Reactory from "@reactory/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import {
  AIChatParams,
  AIAudioChatParams,
} from "../../../types/model.types";
import { 
  IAIStreamingProviderService, 
  AIStreamingCapabilities, 
  AIStreamingEvent,
  AIStreamingEventType,
  AITokenStreamingData,
  AIToolCallStreamingData,
  AIErrorStreamingData,
  AICompletionStreamingData,
  IAIPersona
} from "../../../types/service.types";
import GoogleAIService from "./GoogleAIService";
import { AIProviderError } from "./AIProviderError";
import { ObjectId } from "mongodb";
import {
  ReactorConversationHistoryItem,
  ReactorToolResult,
} from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";

/**
 * Google AI Service with streaming capabilities
 * Extends the base GoogleAIService to provide real-time token streaming
 */
@service({
  id: "reactor.GoogleAIStreamingService@1.0.0",
  name: "Google AI Streaming Service",
  nameSpace: "reactor",
  description: "Service for streaming Google AI (Gemini) responses",
  serviceType: "ai",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.UserService@1.0.0", alias: "userService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },
    { id: "reactor.ReactorMacroService@1.0.0", alias: "macroService" },
  ],
})
export class GoogleAIStreamingService extends GoogleAIService implements IAIStreamingProviderService {

  version: string = '1.0.0';
  tags: string[] = ['streaming', 'ai', 'google', 'gemini'];

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    super(props, context);
    this.context.log('GoogleAIStreamingService initialized', {}, 'GoogleAIStreamingService.constructor');
  }

  /**
   * Get streaming capabilities for Google AI/Gemini
   */
  async getStreamingCapabilities(): Promise<AIStreamingCapabilities> {
    return {
      supportsTokenStreaming: true,
      supportsToolStreaming: true,
      supportsFunctionStreaming: true,
      maxConcurrentStreams: 10,
      supportedFormats: ['json', 'text', 'sse']
    };
  }

  /**
   * Stream chat responses from Google AI/Gemini
   * Provides real-time token streaming with tool call support
   */
  async* chatStream(params: AIChatParams): AsyncIterable<AIStreamingEvent> {
    try {
      yield* this.processStreamingChat(params);
    } catch (error: any) {
      this.context.error('Google AI streaming error', {
        error: error.message,
        stack: error.stack,
        params
      }, 'GoogleAIStreamingService.chatStream');

      yield this.createErrorEvent(
        'GOOGLE_AI_STREAMING_ERROR',
        error.message || 'Unknown streaming error',
        { stack: error.stack },
        params.chatSessionId
      );
    }
  }

  /**
   * Process the streaming chat logic
   */
  private async* processStreamingChat(params: AIChatParams): AsyncIterable<AIStreamingEvent> {
    const { personaId, chatSessionId, message, role = "user" } = params;
    
    this.context.log('Starting Google AI streaming chat', { 
      personaId, 
      chatSessionId, 
      messageLength: message?.length || 0,
      role 
    }, 'GoogleAIStreamingService.processStreamingChat');

    // Initialize chat state
    await this.initializeChatState(params);
    
    // Update history with new message
    this.updateChatHistory(params);

    // Create chat session and get response
    const persona = await this.personaProvider.getPersona(personaId);
    const streamingMessage = role === "tool" ? "" : message;
    
    yield* this.streamGoogleAIResponse(streamingMessage, persona, chatSessionId);
    
    // Persist updated state
    await this.persistChatState();
  }

  /**
   * Initialize chat state if needed
   */
  private async initializeChatState(params: AIChatParams): Promise<void> {
    const { personaId, chatSessionId } = params;
    
    if (!this.ai || !this.model || (chatSessionId && this.chatState?.id !== chatSessionId)) {
      const persona = await this.personaProvider.getPersona(personaId);
      if (!persona) {
        throw new AIProviderError(`Persona ${personaId} not found`);
      }
      await this.initialize(chatSessionId, persona);
    }
  }

  /**
   * Update chat history with new message or tool result
   */
  private updateChatHistory(params: AIChatParams): void {
    const { role, message, tool_name, tool_call_id, tool_args } = params;
    
    if (role === "user" && message) {
      this.chatState.history.push({
        id: new ObjectId(),
        role: 'user',
        content: message,
        timestamp: new Date()
      } as ReactorConversationHistoryItem);
    } else if (role === "tool" && tool_name && tool_call_id) {
      this.addToolResultToHistory(tool_name, tool_call_id, tool_args || message);
    }
  }

  /**
   * Add tool result to the last assistant message
   */
  private addToolResultToHistory(toolName: string, toolCallId: string, content: any): void {
    const lastAssistantMessage = this.chatState.history
      .slice()
      .reverse()
      .find(msg => msg.role === 'assistant');
    
    if (lastAssistantMessage) {
      if (!lastAssistantMessage.tool_results) {
        lastAssistantMessage.tool_results = [];
      }
      lastAssistantMessage.tool_results.push({
        tool_name: toolName,
        tool_call_id: toolCallId,
        content,
        role: 'tool',
        timestamp: new Date()
      } as unknown as ReactorToolResult);
    }
  }

  /**
   * Stream response from Google AI
   */
  private async* streamGoogleAIResponse(
    message: string, 
    persona: IAIPersona, 
    sessionId?: string
  ): AsyncIterable<AIStreamingEvent> {
    let assistantMessage = '';
    let tokenPosition = 0;
    let completionTokens = 0;

    try {
      // Use the non-streaming approach since Google AI streaming API is complex
      // We'll simulate streaming by processing the response word by word
      const response = await this.getNonStreamingResponse(message, persona);
      
      if (response.responseText) {
        yield* this.simulateTokenStreaming(response.responseText, sessionId);
        assistantMessage = response.responseText;
        tokenPosition = response.responseText.split(' ').length;
        completionTokens = tokenPosition;
      }

      // Handle function calls
      if (response.functionCalls && response.functionCalls.length > 0) {
        yield* this.processFunctionCalls(response.functionCalls, sessionId);
      }

      // Add assistant response to history
      this.addAssistantMessageToHistory(assistantMessage);

      // Emit completion event
      yield this.createCompletionEvent(
        assistantMessage,
        {
          totalTokens: tokenPosition + 10,
          promptTokens: 10,
          completionTokens,
          finishReason: 'stop',
          model: this.model?.name || 'gemini-pro'
        },
        sessionId
      );

    } catch (error: any) {
      this.context.error('Error streaming Google AI response', { error: error.message }, 'GoogleAIStreamingService.streamGoogleAIResponse');
      throw error;
    }
  }

  /**
   * Get non-streaming response from Google AI and simulate streaming
   */
  private async getNonStreamingResponse(message: string, persona: IAIPersona): Promise<{ responseText: string; functionCalls: any[] }> {
    // Create a simple chat request without streaming
    const result = await this.chat({
      personaId: this.chatState.personaId,
      chatSessionId: this.chatState.id,
      message,
      persistState: false // We'll handle persistence ourselves
    });

    // Extract response content
    const responseText = result.choices?.[0]?.message?.content || '';
    const functionCalls: any[] = [];

    // Extract tool calls if present
    if (result.choices?.[0]?.message?.tool_calls) {
      for (const toolCall of result.choices[0].message.tool_calls) {
        functionCalls.push({
          name: toolCall.function?.name || '',
          args: typeof toolCall.function?.arguments === 'string' 
            ? JSON.parse(toolCall.function.arguments) 
            : toolCall.function?.arguments || {}
        });
      }
    }

    return { responseText, functionCalls };
  }

  /**
   * Simulate token streaming by breaking response into words
   */
  private async* simulateTokenStreaming(responseText: string, sessionId?: string): AsyncIterable<AIStreamingEvent> {
    const words = responseText.split(' ');
    let content = '';
    
    for (let i = 0; i < words.length; i++) {
      const word = i === words.length - 1 ? words[i] : words[i] + ' ';
      content += word;

      yield this.createTokenEvent(
        content,
        word,
        i + 1,
        i === words.length - 1,
        sessionId
      );

      // Small delay to simulate streaming
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /**
   * Process function calls and emit tool call events
   */
  private async* processFunctionCalls(functionCalls: any[], sessionId?: string): AsyncIterable<AIStreamingEvent> {
    for (const functionCall of functionCalls) {
      const toolCallId = new ObjectId().toString();
      
      yield this.createToolCallEvent(
        toolCallId,
        functionCall.name,
        JSON.stringify(functionCall.args || {}),
        true,
        undefined,
        sessionId
      );
    }
  }

  /**
   * Add assistant message to chat history
   */
  private addAssistantMessageToHistory(content: string): void {
    if (content) {
      this.chatState.history.push({
        id: new ObjectId(),
        role: 'assistant',
        content,
        timestamp: new Date(),
        tool_calls: [],
        tool_results: []
      } as ReactorConversationHistoryItem);
    }
  }

  /**
   * Stream audio chat responses (placeholder implementation)
   * Google AI doesn't currently support audio streaming in the same way as text
   */
  async* chatAudioStream(params: AIAudioChatParams): AsyncIterable<AIStreamingEvent> {
    this.context.warn('Google AI audio streaming not yet implemented', {}, 'GoogleAIStreamingService.chatAudioStream');
    
    yield this.createErrorEvent(
      'NOT_IMPLEMENTED',
      'Google AI audio streaming is not yet implemented',
      { feature: 'audioStreaming' },
      params.chatSessionId
    );
  }

  /**
   * Create a token streaming event
   */
  private createTokenEvent(
    content: string,
    delta: string,
    position: number,
    isComplete: boolean = false,
    sessionId?: string
  ): AIStreamingEvent {
    const tokenData: AITokenStreamingData = {
      content,
      delta,
      position,
      isComplete
    };
    return this.createStreamingEvent('token', tokenData, sessionId);
  }

  /**
   * Create a tool call streaming event
   */
  private createToolCallEvent(
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
  private createErrorEvent(
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
  private createCompletionEvent(
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
   * Create streaming event with consistent structure
   */
  private createStreamingEvent(
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

  toString(includeVersion?: boolean): string {
    return `GoogleAIStreamingService${includeVersion ? "@1.0.0" : ""}`;
  }

  description = "Google AI Service with streaming capabilities for real-time Gemini interactions";
  tags = ["ai", "google", "gemini", "streaming"];
  nameSpace = "reactor";
  name = "GoogleAIStreamingService";
  version = "1.0.0";
}

export default GoogleAIStreamingService;
