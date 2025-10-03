import Reactory from "@reactory/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import Anthropic from "@anthropic-ai/sdk";
import {
  AIChatParams,
  AIAudioChatParams,
  AIChatCompletion,
} from "../../../types/model.types";
import {
  AICompletionStreamingData,
  AIErrorStreamingData,
  AIStreamingCapabilities,
  AIStreamingEvent,
  AIStreamingEventType,
  AITokenStreamingData,
  AIToolCallStreamingData,
  IAIPersona,
} from "../../../types/service.types";
import AIPersonaProvider from "../AIPersonaProvider";
import AIProviderBase from "./AIProviderBase";
import { AIProviderError } from "./AIProviderError";
import { ObjectId } from "mongodb";
import ReactorMacroService from "./ReactorMacroService";
import {
  MacroComponentDefinition,
  MacroToolDefinition,
} from "modules/reactory-reactor/ai/openai/types/chat";
import {
  ChatHistoryItem,
  ReactorConversationHistory,
  ReactorConversationHistoryItem,
  ReactorToolResult,
  ValidProviderResponseTypes,
} from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionDeveloperMessageParam,
  ChatCompletionMessage,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from "openai/resources";
import path from "path";
import { CompletionStreamingEvent, ErrorStreamingEvent, StreamingEvent, StreamingEventType, StreamingMode, TokenStreamingEvent, ToolCallStreamingEvent } from "../types/streaming.types";
import { StreamingSessionManager } from "../StreamingSessionManager";
import { StreamingTransportManager } from "../StreamingTransportManager";

@service({
  id: "reactor.AnthropicService@1.0.0",
  name: "Anthropic AI Service",
  nameSpace: "reactor",
  description: "Service for managing Anthropic AI API requests",
  serviceType: "ai",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.UserService@1.0.0", alias: "userService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },
    { id: "reactor.ReactorMacroService@1.0.0", alias: "macroService" },
    { id: "reactor.StreamingTransportManager@1.0.0", alias: "streamingTransportManager" },
    { id: "reactor.StreamingSessionManager@1.0.0", alias: "streamingSessionManager" },
  ],
})
class AnthropicService extends AIProviderBase {
  anthropic: Anthropic;
  modelId: string;
  fileService: Reactory.Service.IReactoryFileService;
  userService: Reactory.Service.IReactoryUserService;
  fetchService: Reactory.Service.IFetchService;
  macroService: ReactorMacroService;
  streamingMode: StreamingMode = StreamingMode.NONE;
  streamingSessionManager: StreamingSessionManager;
  streamingTransportManager: StreamingTransportManager;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    super(props, context);
    this.streamingMode = props.streamingMode || StreamingMode.NONE;
  }

  /**
   * Get streaming capabilities for Anthropic
   */
  async getStreamingCapabilities(): Promise<AIStreamingCapabilities> {
    return {
      supportsTokenStreaming: true,
      supportsToolStreaming: true,
      supportsFunctionStreaming: true,
      maxConcurrentStreams: 10,
      supportedFormats: ["json", "text", "sse"],
    };
  }

  protected async initializeClient(persona: IAIPersona): Promise<void> {
    const apiKey = persona.config?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AIProviderError("Anthropic API key is not set");
    }

    this.anthropic = new Anthropic({
      apiKey,
    });

    this.modelId = persona.modelId || process.env.ANTHROPIC_MODEL_ID || "claude-3-sonnet-20240229";
  }

  /**
   * Convert chat history to Anthropic format
   */
  private convertHistoryToAnthropicFormat(history: ReactorConversationHistoryItem[]): Anthropic.Messages.MessageParam[] {
    const messages: Anthropic.Messages.MessageParam[] = [];
    
    for (const msg of history) {
      let role: "user" | "assistant" = "user";
      let content: string | Anthropic.Messages.ContentBlock[] = "";
      
      switch (msg.role) {
        case "assistant":
          role = "assistant";
          break;
        case "system":
          // Anthropic doesn't have system role, we'll handle this in the system prompt
          continue;
        case "tool":
          // Convert tool messages to user messages with tool results
          role = "user";
          break;
        default:
          role = "user";
      }

      // Extract content
      if (msg.content) {
        if (Array.isArray(msg.content)) {
          content = msg.content.map(c => typeof c === "string" ? c : (c as any).text || "").join(" ");
        } else if (typeof msg.content === "string") {
          content = msg.content;
        } else if (msg.content && typeof msg.content === "object" && "text" in msg.content) {
          content = (msg.content as any).text;
        }
      }

      // Handle tool calls and results
      if ((msg as any).tool_calls && (msg as any).tool_calls.length > 0) {
        for (const toolCall of (msg as any).tool_calls) {
          messages.push({
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: new ObjectId().toString(),
                name: toolCall.function?.name || toolCall.name,
                input: toolCall.function?.arguments || toolCall.arguments || {},
              }
            ]
          });
        }
      }

      if ((msg as any).tool_results && (msg as any).tool_results.length > 0) {
        for (const toolResult of (msg as any).tool_results) {
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolResult.tool_call_id || new ObjectId().toString(),
                content: toolResult.content || toolResult.result || "",
              }
            ]
          });
        }
      }

      if (content && typeof content === "string" && content.trim()) {
        messages.push({
          role,
          content: content.trim()
        });
      }
    }

    return messages;
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
  ): TokenStreamingEvent {
    const tokenData: AITokenStreamingData = {
      content,
      delta,
      position,
      isComplete,
    };
    return this.createStreamingEvent(StreamingEventType.TOKEN, tokenData, sessionId) as TokenStreamingEvent;
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
  ): ToolCallStreamingEvent {
    const toolData: AIToolCallStreamingData = {
      id,
      name,
      arguments: toolArguments,
      isComplete,
      result,
    };
    return this.createStreamingEvent(StreamingEventType.TOOL_CALL, toolData, sessionId) as ToolCallStreamingEvent;
  }

  /**
   * Create an error streaming event
   */
  private createErrorEvent(
    code: string,
    message: string,
    details?: any,
    sessionId?: string
  ): ErrorStreamingEvent {
    const errorData: AIErrorStreamingData = {
      code,
      message,
      details,
    };
    return this.createStreamingEvent(StreamingEventType.ERROR, errorData, sessionId) as ErrorStreamingEvent;
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
  ): CompletionStreamingEvent {
    const completionData: AICompletionStreamingData = {
      content,
      metadata,
    };
    return this.createStreamingEvent(StreamingEventType.COMPLETE, completionData, sessionId) as CompletionStreamingEvent;
  }

  /**
   * Create streaming event with consistent structure
   */
  private createStreamingEvent(
    type: StreamingEventType,
    data: any,
    sessionId?: string,
    conversationId?: string,
    messageId?: string
  ): StreamingEvent {
    return {
      type,
      timestamp: new Date(),
      sessionId,
      messageId,
      data,
      conversationId,
    };
  }

  /**
   * Handle streaming request for Anthropic
   */
  private async handleStreamingRequest(args: {
    sessionId: string;
    message: string;
    persona: IAIPersona;
    history: ReactorConversationHistory;
    messageId?: string;
  }): Promise<any> {
    const { sessionId, message, persona, history, messageId } = args;

    // Convert history to Anthropic format
    const messages = this.convertHistoryToAnthropicFormat(history);
    
    // Add the current user message
    messages.push({
      role: "user",
      content: message
    });

    const stream = await this.anthropic.messages.create({
      model: this.modelId,
      max_tokens: persona.modelConfig?.maxTokens || 4096,
      messages,
      system: this.createSystemPrompt(persona).content,
      temperature: persona.modelConfig?.temperature || 0.7,
      top_p: persona.modelConfig?.topP || 1.0,
      stream: true,
    });

    let accumulatedText = "";
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason = "stop";

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta") {
        const delta = (chunk.delta as any).text || "";
        accumulatedText += delta;
        
        const event = this.createTokenEvent(
          accumulatedText,
          delta,
          accumulatedText.length,
          false,
          sessionId
        );
        event.messageId = messageId;
        
        await this.streamingTransportManager.sendEventToSession(sessionId, event as TokenStreamingEvent);
      } else if (chunk.type === "message_stop") {
        finishReason = "stop";
        if ((chunk as any).usage) {
          totalTokens = (chunk as any).usage.input_tokens + (chunk as any).usage.output_tokens;
          promptTokens = (chunk as any).usage.input_tokens;
          completionTokens = (chunk as any).usage.output_tokens;
        }
      }
    }

    // Send completion event
    const completionEvent = this.createCompletionEvent(
      accumulatedText,
      {
        totalTokens,
        promptTokens,
        completionTokens,
        finishReason,
        model: this.modelId,
      },
      sessionId
    );
    completionEvent.messageId = messageId;
    await this.streamingTransportManager.sendEventToSession(sessionId, completionEvent);

    return {
      content: accumulatedText,
      finishReason,
    };
  }

  private async getAIResponse(
    message: string,
    role: "user" | "assistant" | "tool" | "system" = "user",
    messageId?: string
  ): Promise<AIChatCompletion> {
    try {
      const persona: IAIPersona = await this.personaProvider.getPersona(
        this.chatState.personaId
      );

      // Handle tool results differently
      if (role === "tool") {
        // For tool results, we need to create a new conversation context
        const messages = this.convertHistoryToAnthropicFormat(this.chatState.history);
        
        const response = await this.anthropic.messages.create({
          model: this.modelId,
          max_tokens: persona.modelConfig?.maxTokens || 4096,
          messages,
          system: this.createSystemPrompt(persona).content,
          temperature: persona.modelConfig?.temperature || 0.7,
          top_p: persona.modelConfig?.topP || 1.0,
        });

        const responseText = response.content[0]?.type === "text" ? response.content[0].text : "";

        const completion: AIChatCompletion = {
          id: new ObjectId(),
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                content: responseText,
                role: "assistant",
                tool_calls: [],
              },
              finish_reason: "stop",
            },
          ],
          created: new Date(),
        };

        return completion;
      }

      // Handle user messages
      if (role === "user") {
        let result: any;
        
        if (this.streamingMode === StreamingMode.SSE) {
          result = await this.handleStreamingRequest({
            sessionId: this.chatState.id,
            message,
            persona: this.chatState.persona,
            history: this.chatState.history,
            messageId,
          });
        } else {
          const messages = this.convertHistoryToAnthropicFormat(this.chatState.history);
          messages.push({
            role: "user",
            content: message
          });

          const response = await this.anthropic.messages.create({
            model: this.modelId,
            max_tokens: persona.modelConfig?.maxTokens || 4096,
            messages,
            system: this.createSystemPrompt(persona).content,
            temperature: persona.modelConfig?.temperature || 0.7,
            top_p: persona.modelConfig?.topP || 1.0,
          });

          result = {
            content: response.content[0]?.type === "text" ? response.content[0].text : "",
            finishReason: "stop",
          };
        }

        // Add user message to history
        const userConversationHistoryItem: ReactorConversationHistoryItem = {
          id: new ObjectId(),
          role: "user",
          content: message,
          timestamp: new Date(),
          tool_results: [],
        };
        this.chatState.history.push(userConversationHistoryItem);

        // Format response similar to OpenAI for compatibility
        const completion: AIChatCompletion = {
          id: new ObjectId(),
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                content: result.content,
                role: "assistant",
                tool_calls: [],
              },
              finish_reason: result.finishReason || "stop",
            },
          ],
          created: new Date(),
        };

        return completion;
      }

      // Handle other roles - just add to history without getting response
      const historyItem = {
        id: new ObjectId(),
        role,
        content: message,
        timestamp: new Date(),
        tool_results: [],
      } as ReactorConversationHistoryItem;

      this.chatState.history.push(historyItem);

      return {
        id: new ObjectId(),
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              content: "",
              role: "assistant",
              tool_calls: [],
            },
            finish_reason: "stop",
          },
        ],
        created: new Date(),
      };
    } catch (error) {
      this.context.error(
        `Error in getAIResponse: ${error.message ?? error.toString()}`,
        { error },
        "AnthropicService.getAIResponse"
      );
      throw error;
    }
  }

  async chat(
    params: AIChatParams & { persistState?: boolean }
  ): Promise<AIChatCompletion> {
    const {
      personaId,
      chatSessionId,
      message,
      role = "user",
      tool_name,
      tool_args,
      tool_call_id,
      persistState = true,
      streamingMode = StreamingMode.NONE,
    } = params;

    const maxRetries = 2;
    let lastError: any;
    this.streamingMode = streamingMode;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Initialize if needed
        if (
          !this.anthropic ||
          (chatSessionId && this.chatState?.id !== chatSessionId)
        ) {
          const persona = this.personaProvider.getPersona(personaId);
          if (!persona) {
            throw new AIProviderError(`Persona ${personaId} not found`);
          }
          await this.initialize(chatSessionId, persona);
        }

        const messageId = new ObjectId();
        const response = await this.getAIResponse(message, role, messageId.toString());

        // Add AI response to history
        if (response.choices && response.choices.length > 0) {
          this.chatState.history.push({
            id: messageId,
            timestamp: new Date(),
            tool_calls: response.choices[0].message.tool_calls ?? [],
            tool_results: [],
            role: "assistant",
            content: response.choices[0].message.content,
          } as ReactorConversationHistoryItem);
        }

        if (persistState) {
          await this.persistChatState();
        }

        return response;
      } catch (error: any) {
        lastError = error;

        if (attempt < maxRetries && this.isRetryableError(error)) {
          this.context.warn(
            `Retry attempt ${attempt} for Anthropic chat (${error.message})`,
            { error, attempt, maxRetries },
            "AnthropicService.chat"
          );

          const backoffDelay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          continue;
        }

        break;
      }
    }

    // Return graceful error response
    return {
      id: new ObjectId(),
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            content: "I'm experiencing some technical difficulties right now. Please try again in a moment.",
            role: "assistant",
            tool_calls: [],
          },
          finish_reason: "stop",
        },
      ],
      created: new Date(),
    };
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: any): boolean {
    if (!error) return false;

    const errorMessage = error.message?.toLowerCase() || "";
    const errorCode = error.code?.toLowerCase() || "";

    const retryablePatterns = [
      "rate limit",
      "timeout",
      "network",
      "connection",
      "temporary",
      "service unavailable",
      "internal server error",
      "bad gateway",
      "gateway timeout",
      "throttling",
      "throttled",
      "quota exceeded",
      "rate limit exceeded",
    ];

    return retryablePatterns.some(
      (pattern) => errorMessage.includes(pattern) || errorCode.includes(pattern)
    );
  }

  // Override only needed methods, using base class implementations for others
  async chatAudio(params: AIAudioChatParams): Promise<AIChatCompletion> {
    this.context.warn("chatAudio not implemented", {}, "AnthropicService");
    throw new AIProviderError("Method not implemented");
  }

  async speech2Text(audio: string | Buffer[]): Promise<string> {
    this.context.warn("speech2Text not implemented", {}, "AnthropicService");
    throw new AIProviderError("Method not implemented");
  }

  // Dependency injection setters
  setFileService(fileService: Reactory.Service.IReactoryFileService) {
    this.fileService = fileService;
  }

  setUserService(userService: Reactory.Service.IReactoryUserService) {
    this.userService = userService;
  }

  setFetchService(fetchService: Reactory.Service.IFetchService) {
    this.fetchService = fetchService;
  }

  setPersonaProvider(personaProvider: AIPersonaProvider) {
    this.personaProvider = personaProvider;
  }

  setMacroService(macroService: ReactorMacroService) {
    this.macroService = macroService;
  }

  setStreamingSessionManager(streamingSessionManager: StreamingSessionManager) {
    this.streamingSessionManager = streamingSessionManager;
  }

  setStreamingTransportManager(streamingTransportManager: StreamingTransportManager) {
    this.streamingTransportManager = streamingTransportManager;
  }

  toString(includeVersion?: boolean): string {
    return `AnthropicService${includeVersion ? "@1.0.0" : ""}`;
  }

  description = "Service for managing Anthropic AI API requests";
  tags = ["ai", "anthropic", "claude"];
  nameSpace = "reactor";
  name = "AnthropicService";
  version = "1.0.0";
}

export default AnthropicService;
