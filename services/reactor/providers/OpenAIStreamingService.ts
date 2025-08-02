import { ObjectId } from 'mongodb';
import OpenAI from 'openai';
import { service } from "@reactory/server-core/application/decorators/service";
import { 
  AIStreamingCapabilities,
  AIStreamingEvent,
  IOpenAIServiceProps
} from '../../../types/service.types';
import { 
  AIChatParams, 
  AIAudioChatParams 
} from '../../../types/model.types';
import { ReactorConversationHistoryItem } from '../../../models/ReactorChatState';
import { MacroToolDefinition } from '../../../ai/openai/types/chat';
import OpenAIService from './OpenAIService';

@service({
  id: "reactor.OpenAIStreamingService@1.0.0",
  name: "OpenAI Streaming Service",
  nameSpace: "reactor",
  description: "OpenAI Service with streaming capabilities for real-time AI interactions",
  serviceType: "ai",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.UserService@1.0.0", alias: "userService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },
    { id: "reactor.ReactorMacroService@1.0.0", alias: "macroService" },
  ],
})
class OpenAIStreamingService extends OpenAIService {
  
  version: string = '1.0.0';
  tags: string[] = ['streaming', 'ai', 'openai', 'gpt'];
  
  constructor(props: IOpenAIServiceProps, context: Reactory.Server.IReactoryContext) {
    super(props, context);
  }

  /**
   * Get streaming capabilities for this provider
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
   * Stream chat completion with real-time token events
   */
  async* chatStream(params: AIChatParams): AsyncIterable<AIStreamingEvent> {
    try {
      // Initialize chat state
      await this.initialize(params.chatSessionId, null);

      if (!this.chatState.persona) {
        const persona = await this.personaProvider.getPersona(params.personaId);
        if (!persona) {
          yield this.createStreamingEvent('error', {
            error: new Error(`Persona not found: ${params.personaId}`),
            timestamp: new Date()
          });
          return;
        }
        this.chatState.persona = persona;
      }

      // Add user message to history with proper structure
      const userHistoryItem: ReactorConversationHistoryItem = {
        id: new ObjectId(),
        role: 'user',
        content: params.message,
        timestamp: new Date()
      } as ReactorConversationHistoryItem;

      this.chatState.history.push(userHistoryItem);

      // Prepare chat messages for OpenAI
      const chatMessages = this.chatState.history.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      // Get available tools if any
      const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
      if (params.tools && Array.isArray(params.tools)) {
        params.tools.forEach((tool: MacroToolDefinition) => {
          tools.push({
            type: "function",
            function: {
              name: tool.function.name,
              description: tool.function.description || '',
              parameters: tool.function.parameters as any || {}
            }
          });
        });
      }

      // Create streaming request
      const streamRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: params.model || this.chatState.persona?.modelId || "gpt-4",
        messages: chatMessages as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: true,
        temperature: params.temperature || 0.7,
        max_tokens: params.maxTokens || 2000,
        ...(tools.length > 0 && { tools })
      };

      // Start streaming
      const stream = await this.ai.chat.completions.create(streamRequest);
      
      let assistantMessage = '';
      let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let currentToolCall: { id?: string; name?: string; arguments?: string } | null = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        
        if (!delta) continue;

        // Handle content tokens
        if (delta.content) {
          assistantMessage += delta.content;
          yield this.createStreamingEvent('token', {
            token: delta.content,
            timestamp: new Date()
          });
        }

        // Handle tool calls
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            if (toolCall.id) {
              // New tool call started
              if (currentToolCall && currentToolCall.id && currentToolCall.name) {
                toolCalls.push({
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  arguments: currentToolCall.arguments || ''
                });
              }
              currentToolCall = {
                id: toolCall.id,
                name: toolCall.function?.name || '',
                arguments: toolCall.function?.arguments || ''
              };
            } else if (currentToolCall && toolCall.function) {
              // Continue existing tool call
              if (toolCall.function.name) {
                currentToolCall.name = (currentToolCall.name || '') + toolCall.function.name;
              }
              if (toolCall.function.arguments) {
                currentToolCall.arguments = (currentToolCall.arguments || '') + toolCall.function.arguments;
              }
            }
          }
        }

        // Handle completion
        if (chunk.choices[0]?.finish_reason) {
          // Add final tool call if exists
          if (currentToolCall && currentToolCall.id && currentToolCall.name) {
            toolCalls.push({
              id: currentToolCall.id,
              name: currentToolCall.name,
              arguments: currentToolCall.arguments || ''
            });
          }

          // Emit tool call events
          for (const toolCall of toolCalls) {
            yield this.createStreamingEvent('tool_call', {
              toolCall: {
                id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments
              },
              timestamp: new Date()
            });
          }

          break;
        }
      }

      // Save assistant response to history
      const assistantHistoryItem: ReactorConversationHistoryItem = {
        id: new ObjectId(),
        role: 'assistant',
        content: assistantMessage,
        timestamp: new Date(),
        ...(toolCalls.length > 0 && {
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments
            }
          }))
        })
      } as ReactorConversationHistoryItem;

      this.chatState.history.push(assistantHistoryItem);
      
      // Persist chat state using protected method access
      await (this as any).persistChatState();

      // Emit completion event
      yield this.createStreamingEvent('complete', {
        message: assistantMessage,
        toolCalls: toolCalls,
        timestamp: new Date()
      });

    } catch (error) {
      yield this.createStreamingEvent('error', {
        error: error instanceof Error ? error : new Error(String(error)),
        timestamp: new Date()
      });
    }
  }

  /**
   * Stream audio chat (placeholder for future implementation)
   */
  async* chatAudioStream(params: AIAudioChatParams): AsyncIterable<AIStreamingEvent> {
    yield this.createStreamingEvent('error', {
      error: new Error('Audio streaming not yet implemented for OpenAI'),
      timestamp: new Date()
    });
  }

  /**
   * Create a streaming event with proper structure
   */
  private createStreamingEvent(type: AIStreamingEvent['type'], data: any): AIStreamingEvent {
    return {
      type,
      data,
      timestamp: new Date(),
      sessionId: this.chatState?.sseSession || 'unknown'
    };
  }

  /**
   * Override onStart if needed
   */
  async onStart(): Promise<void> {
    this.context.log('OpenAI Streaming Service started with streaming capabilities', 'info');
  }

  toString(includeVersion?: boolean): string {
    return `OpenAIStreamingService${includeVersion ? "@1.0.0" : ""}`;
  }
}

export default OpenAIStreamingService;
