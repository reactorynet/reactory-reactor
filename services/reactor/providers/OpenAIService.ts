import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import {
  AIStreamingCapabilities,
  AIStreamingEvent,
  AITokenStreamingData,
  AIToolCallStreamingData,
  AIErrorStreamingData,
  AICompletionStreamingData,
  IAIPersona,
  IOpenAIServiceProps,
} from "../../../types/service.types";
import {
  AIChatParams,
  AIChatCompletion,
} from "../../../types/model.types";
import OpenAI, { ClientOptions } from "openai";
import AIPersonaProvider from "../AIPersonaProvider";
import AIProviderBase from "./AIProviderBase";
import { AIProviderError } from "./AIProviderError";
import {
  MacroComponentDefinition,
  MacroToolDefinition,
  ToolApprovalMode,
} from "../../../ai/openai/types/chat";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources";
import { ObjectId } from "mongodb";
import {
  ReactorConversationHistoryItem,
} from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import ReactorMacroService from "./ReactorMacroService";
import {
  StreamingMode,
  StreamingEventType,
  StreamingEvent,
  TokenStreamingEvent,
  ToolCallStreamingEvent,
  ReasoningStreamingEvent,
  CompletionStreamingEvent,
  ErrorStreamingEvent,
} from "../types/streaming.types";
import { StreamingSessionManager } from "../StreamingSessionManager";
import { StreamingTransportManager } from "../StreamingTransportManager";


@service({
  id: "reactor.OpenAIService@1.0.0",
  name: "OpenAI Service",
  nameSpace: "reactor",
  description: "Service for managing OpenAI-compatible API requests (OpenAI, xAI, Ollama)",
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
class OpenAIService extends AIProviderBase {

  ai!: OpenAI;
  fileService!: Reactory.Service.IReactoryFileService;
  userService!: Reactory.Service.IReactoryUserService;
  fetchService!: Reactory.Service.IFetchService;
  macroService!: ReactorMacroService;
  streamingMode: StreamingMode = StreamingMode.NONE;
  streamingSessionManager!: StreamingSessionManager;
  streamingTransportManager!: StreamingTransportManager;

  constructor(props: IOpenAIServiceProps, context: Reactory.Server.IReactoryContext) {
    super(props, context);
    this.streamingMode = props.streamingMode || StreamingMode.NONE;
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
      supportedFormats: ['json', 'text', 'sse'],
    };
  }

  /**
   * Initialize the OpenAI-compatible client based on providerId.
   * Supports OpenAI, xAI, and Ollama endpoints.
   */
  protected async initializeClient(persona: IAIPersona): Promise<void> {
    const { apiKey, apiOrganizationId, apiBaseURL } = this.props;
    const { providerId } = persona;

    const openAIArgs: ClientOptions = {
      apiKey: apiKey || process.env.OPENAI_API_KEY,
      organization: apiOrganizationId,
      baseURL: apiBaseURL || process.env.OPENAI_API_BASE_URL,
    };

    switch (providerId) {
      case "xai":
        openAIArgs.baseURL = apiBaseURL || process.env.XAI_API_BASE_URL || "https://api.x.ai/v1";
        openAIArgs.apiKey = apiKey || process.env.X_AI_API_KEY;
        delete openAIArgs.organization;
        break;
      case "ollama":
        openAIArgs.baseURL = apiBaseURL || process.env.OLLAMA_API_BASE_URL || "http://localhost:11434/v1";
        openAIArgs.apiKey = "";
        openAIArgs.organization = "";
        break;
      case "copilot":
        openAIArgs.baseURL = apiBaseURL || process.env.GITHUB_COPILOT_API_URL || "https://models.inference.ai.azure.com";
        openAIArgs.apiKey = apiKey || process.env.GITHUB_TOKEN;
        delete openAIArgs.organization;
        break;
      case "azure-openai": {
        const endpoint = apiBaseURL || process.env.AZURE_OPENAI_ENDPOINT || "";
        const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview";
        openAIArgs.baseURL = endpoint ? `${endpoint.replace(/\/$/, '')}/openai` : undefined;
        openAIArgs.apiKey = apiKey || process.env.AZURE_OPENAI_API_KEY;
        openAIArgs.defaultQuery = { 'api-version': apiVersion };
        delete openAIArgs.organization;
        break;
      }
    }

    // Apply persona-specific configuration overrides
    if (persona.config) {
      if (persona.config.apiKey) openAIArgs.apiKey = persona.config.apiKey;
      if (persona.config.apiOrg) openAIArgs.organization = persona.config.apiOrg;
      if (persona.config.apiBaseURL) openAIArgs.baseURL = persona.config.apiBaseURL;
    }

    this.ai = new OpenAI(openAIArgs);
  }

  // --- Tool definitions ---

  private async getToolsDefinitions(): Promise<ChatCompletionTool[]> {
    const tools: ChatCompletionTool[] = [];
    const macros = await this.macroService.listMacrosForPersona(this.chatState.personaId);

    macros.forEach((macro: MacroComponentDefinition<unknown>) => {
      if (macro.tools) {
        macro.tools.forEach((tool: MacroToolDefinition) => {
          if (tool.type === "function") {
            const { function: func } = tool;
            tools.push({
              type: "function",
              function: {
                name: func.name,
                description: func.description || "",
                parameters: func.parameters as Record<string, unknown>,
              },
            });
          }
        });
      }
    });

    return tools;
  }

  // --- Prompt building ---

  private async createPrompt(
    message: string,
  ): Promise<OpenAI.Chat.Completions.ChatCompletionCreateParams> {
    const { chatState } = this;
    const { history, modelId } = chatState;

    const messages: ChatCompletionMessageParam[] = [];

    history.forEach((msg) => {
      if (!msg) return;

      if (msg.role === "system" && msg.content) {
        messages.push({ role: "system", content: msg.content as string });
      } else if (msg.role === "user" && msg.content) {
        messages.push({ role: "user", content: msg.content as string });
      } else if (msg.role === "assistant") {
        const toolCalls = (msg as any).tool_calls;
        if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: (msg.content as string) || null,
            tool_calls: toolCalls.map((tc: any) => ({
              id: tc.id?.toString() || tc._id?.toString(),
              type: "function" as const,
              function: {
                name: tc.function?.name || tc.name,
                arguments: typeof tc.function?.arguments === "string"
                  ? tc.function.arguments
                  : JSON.stringify(tc.function?.arguments ?? tc.args ?? {}),
              },
            })),
          });
        } else if (msg.content) {
          messages.push({ role: "assistant", content: msg.content as string });
        }
      } else if (msg.role === "tool") {
        const toolCallId = (msg as any).tool_call_id;
        if (toolCallId) {
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: typeof msg.content === "string"
              ? msg.content
              : JSON.stringify((msg as any).tool_results || msg.content || ""),
          });
        }
      }
    });

    if (chatState.files && chatState.files.length > 0) {
      const fileManifest = chatState.files.map((f: any) =>
        `- id: "${f._id || f.id}", filename: "${f.filename}", path: "${f.path || 'N/A'}", type: "${f.mimetype || 'unknown'}", size: ${f.size || 0}`
      ).join("\n");

      messages.push({
        role: "system",
        content: `The user has the following files attached to this chat session. You can read their contents using the readChatFile tool with the file id.\n\nAttached files:\n${fileManifest}`,
      });
    }

    messages.push({
      role: "user",
      content: message,
    });

    const tools = await this.getToolsDefinitions();
    if (tools.length > 0) {
      return {
        model: modelId,
        messages,
        tools,
        tool_choice: "auto",
      };
    }
    return {
      model: modelId,
      messages,
    };
  }

  // --- Streaming event helpers ---

  private createTokenEvent(
    content: string,
    delta: string,
    position: number,
    isComplete: boolean = false,
    sessionId?: string,
  ): TokenStreamingEvent {
    const tokenData: AITokenStreamingData = { content, delta, position, isComplete };
    return this.createStreamingEvent(
      StreamingEventType.TOKEN, tokenData, sessionId,
    ) as TokenStreamingEvent;
  }

  private createReasoningEvent(
    content: string,
    delta: string,
    position: number,
    isComplete: boolean = false,
    sessionId?: string,
  ): ReasoningStreamingEvent {
    const data: AITokenStreamingData = { content, delta, position, isComplete };
    return this.createStreamingEvent(
      StreamingEventType.REASONING, data, sessionId,
    ) as ReasoningStreamingEvent;
  }

  private createToolCallEvent(
    id: string,
    name: string,
    toolArguments: string,
    isComplete: boolean = false,
    result?: any,
    sessionId?: string,
  ): ToolCallStreamingEvent {
    const toolCallId = id || new ObjectId().toString();
    const toolData: AIToolCallStreamingData = {
      id: toolCallId, name, arguments: toolArguments, isComplete, result,
    };
    return this.createStreamingEvent(
      StreamingEventType.TOOL_CALL, toolData, sessionId,
    ) as ToolCallStreamingEvent;
  }

  private createErrorEvent(
    code: string,
    message: string,
    details?: any,
    sessionId?: string,
  ): ErrorStreamingEvent {
    const errorData: AIErrorStreamingData = { code, message, details };
    return this.createStreamingEvent(
      StreamingEventType.ERROR, errorData, sessionId,
    ) as ErrorStreamingEvent;
  }

  private createCompletionEvent(
    content: string,
    metadata: {
      totalTokens: number;
      promptTokens: number;
      completionTokens: number;
      finishReason: string;
      model: string;
    },
    sessionId?: string,
  ): CompletionStreamingEvent {
    const completionData: AICompletionStreamingData = { content, metadata };
    return this.createStreamingEvent(
      StreamingEventType.COMPLETE, completionData, sessionId,
    ) as CompletionStreamingEvent;
  }

  private createStreamingEvent(
    type: StreamingEventType,
    data: any,
    sessionId?: string,
    conversationId?: string,
    messageId?: string,
  ): StreamingEvent {
    return {
      type,
      timestamp: new Date(),
      sessionId: sessionId ?? "",
      conversationId: conversationId ?? "",
      messageId: messageId ?? "",
      data,
    };
  }

  // --- Streaming request handling ---

  /**
   * Handles a streaming AI request using the StreamingTransportManager,
   * sending token, tool_call, and completion events to the client.
   */
  private async handleStreamingRequest(args: {
    sessionId: string;
    prompt: OpenAI.Chat.Completions.ChatCompletionCreateParams;
    messageId?: string;
  }): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const { sessionId, prompt, messageId } = args;

    let stream: Awaited<ReturnType<typeof this.ai.chat.completions.create>>;
    try {
      stream = await this.ai.chat.completions.create({ ...prompt, stream: true });
    } catch (error: any) {
      // Connection/auth errors — send an error event over SSE so the client
      // sees the failure immediately instead of hanging.
      const errorEvent = this.createErrorEvent(
        error.message || "Failed to connect to AI provider",
        error.code || error.status || "CONNECTION_ERROR",
        false,
        sessionId,
      );
      errorEvent.messageId = messageId ?? "";
      errorEvent.conversationId = sessionId;
      try {
        await this.streamingTransportManager.sendEventToSession(
          sessionId, errorEvent as ErrorStreamingEvent,
        );
      } catch (_) {
        // Transport may not be available; the throw below still surfaces the error.
      }
      throw new AIProviderError(
        `Failed to connect to AI provider: ${error.message || error.toString()}`,
      );
    }

    let accumulatedText = "";
    let accumulatedReasoning = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let currentToolCall: { id?: string; name?: string; arguments?: string } | null = null;
    let finishReason: string | null = null;
    let completionId: string | null = null;
    let model = "";

    // Token buffering: accumulate small OpenAI deltas and flush in larger batches
    // to reduce per-token SSE overhead while keeping output feeling responsive.
    const TOKEN_BUFFER_THRESHOLD = 4; // chars (~2 tokens) before flushing
    const REASONING_BUFFER_THRESHOLD = 4;
    const BUFFER_FLUSH_TIMEOUT_MS = 8; // ~1 frame at 60fps
    let tokenBuffer = "";
    let reasoningBuffer = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushTokenBuffer = async () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (tokenBuffer) {
        const content = tokenBuffer;
        tokenBuffer = "";
        const event = this.createTokenEvent(
          content, content, accumulatedText.length, false, sessionId,
        );
        event.messageId = messageId ?? "";
        event.conversationId = sessionId;
        await this.streamingTransportManager.sendEventToSession(
          sessionId, event as TokenStreamingEvent,
        );
      }
      if (reasoningBuffer) {
        const content = reasoningBuffer;
        reasoningBuffer = "";
        const event = this.createReasoningEvent(
          content, content, accumulatedReasoning.length, false, sessionId,
        );
        event.messageId = messageId ?? "";
        event.conversationId = sessionId;
        await this.streamingTransportManager.sendEventToSession(
          sessionId, event as ReasoningStreamingEvent,
        );
      }
    };

    const scheduleFlush = () => {
      if (flushTimer === null) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flushTokenBuffer().catch(() => {});
        }, BUFFER_FLUSH_TIMEOUT_MS);
      }
    };

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (!completionId && chunk.id) completionId = chunk.id;
        if (!model && chunk.model) model = chunk.model;

        const delta = choice.delta;

        // Buffer content tokens instead of sending immediately
        if (delta?.content) {
          accumulatedText += delta.content;
          tokenBuffer += delta.content;
          if (tokenBuffer.length >= TOKEN_BUFFER_THRESHOLD) {
            await flushTokenBuffer();
          } else {
            scheduleFlush();
          }
        }

        // Buffer reasoning/thinking tokens (OpenAI o1/o3 models)
        const reasoningContent = (delta as any)?.reasoning_content;
        if (reasoningContent) {
          accumulatedReasoning += reasoningContent;
          reasoningBuffer += reasoningContent;
          if (reasoningBuffer.length >= REASONING_BUFFER_THRESHOLD) {
            await flushTokenBuffer();
          } else {
            scheduleFlush();
          }
        }

        // Accumulate tool calls from deltas
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              // New tool call started — flush previous
              if (currentToolCall?.id && currentToolCall?.name) {
                toolCalls.push({
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  arguments: currentToolCall.arguments || "",
                });
              }
              currentToolCall = {
                id: tc.id,
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "",
              };
            } else if (currentToolCall && tc.function) {
              if (tc.function.name) {
                currentToolCall.name = (currentToolCall.name || "") + tc.function.name;
              }
              if (tc.function.arguments) {
                currentToolCall.arguments = (currentToolCall.arguments || "") + tc.function.arguments;
              }
            }
          }
        }

        // Capture finish reason
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }

      // Flush any remaining buffered tokens after stream ends
      await flushTokenBuffer();
    } catch (streamError: any) {
      // Clean up buffer timer on error
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // Mid-stream failure — notify the client via SSE before re-throwing
      const errorEvent = this.createErrorEvent(
        streamError.message || "Stream interrupted",
        streamError.code || "STREAM_ERROR",
        false,
        sessionId,
      );
      errorEvent.messageId = messageId ?? "";
      errorEvent.conversationId = sessionId;
      try {
        await this.streamingTransportManager.sendEventToSession(
          sessionId, errorEvent as ErrorStreamingEvent,
        );
      } catch (_) {
        // best-effort
      }
      throw new AIProviderError(
        `AI provider stream interrupted: ${streamError.message || streamError.toString()}`,
      );
    }

    // Flush final tool call
    if (currentToolCall?.id && currentToolCall?.name) {
      toolCalls.push({
        id: currentToolCall.id,
        name: currentToolCall.name,
        arguments: currentToolCall.arguments || "",
      });
    }

    // Send tool_call events (suppress in AUTO mode — server handles them)
    const toolApprovalMode = this.chatState?.toolApprovalMode;
    if (toolApprovalMode !== ToolApprovalMode.AUTO) {
      for (const tc of toolCalls) {
        const event = this.createToolCallEvent(
          tc.id, tc.name, tc.arguments, true, undefined, sessionId,
        );
        event.messageId = messageId ?? "";
        event.conversationId = sessionId;
        await this.streamingTransportManager.sendEventToSession(
          sessionId, event as ToolCallStreamingEvent,
        );
      }
    }

    // Send completion event (defer in AUTO mode with pending tool calls)
    const hasPendingAutoToolCalls =
      toolApprovalMode === ToolApprovalMode.AUTO && toolCalls.length > 0;

    if (!hasPendingAutoToolCalls) {
      const completionEvent = this.createCompletionEvent(
        accumulatedText,
        {
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          finishReason: finishReason || "stop",
          model,
        },
        sessionId,
      );
      // Include accumulated reasoning in completion metadata
      if (accumulatedReasoning) {
        (completionEvent.data as any).thinking = accumulatedReasoning;
      }
      completionEvent.messageId = messageId ?? "";
      completionEvent.conversationId = sessionId;
      await this.streamingTransportManager.sendEventToSession(
        sessionId, completionEvent,
      );
    }

    // Reconstruct a ChatCompletion-shaped result for the caller
    return {
      id: completionId || new ObjectId().toString(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: accumulatedText || null,
          tool_calls: toolCalls.length > 0
            ? toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              }))
            : undefined,
        },
        finish_reason: finishReason || "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      // Carry reasoning through for persistence by the conversation service
      reasoning: accumulatedReasoning || undefined,
    } as any;
  }

  // --- AI response ---

  private async getAIResponse(
    prompt: OpenAI.Chat.Completions.ChatCompletionCreateParams,
    messageId?: string,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    // Filter out empty/invalid messages
    if (prompt.messages && Array.isArray(prompt.messages)) {
      prompt.messages = prompt.messages.filter(
        (msg: OpenAI.ChatCompletionMessageParam) => {
          if (!msg) return false;
          if (msg.role === "tool") return true;
          if (msg.role === "assistant" && (msg as any).tool_calls?.length > 0) return true;
          return msg?.content && typeof msg.content === "string" && msg.content.trim() !== "";
        },
      );

      if (
        prompt.messages.length === 0 ||
        !prompt.messages.some((msg) => msg.role === "user")
      ) {
        throw new AIProviderError("No valid messages found in prompt");
      }
    }

    if (this.streamingMode === StreamingMode.SSE) {
      return await this.handleStreamingRequest({
        sessionId: this.chatState.id ?? "",
        prompt,
        messageId,
      });
    }

    return await this.ai.chat.completions.create(prompt) as OpenAI.Chat.Completions.ChatCompletion;
  }

  // --- Normalize to AIChatCompletion ---

  private normalizeCompletion(
    response: OpenAI.Chat.Completions.ChatCompletion,
  ): AIChatCompletion {
    return {
      id: new ObjectId(),
      object: "chat.completion",
      created: new Date(),
      choices: response.choices.map((choice) => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          content: choice.message.content || "",
          tool_calls: choice.message.tool_calls
            ? choice.message.tool_calls.map((tc) => ({
                id: tc.id,
                type: tc.type,
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                },
              }))
            : [],
        },
        finish_reason: choice.finish_reason || "stop",
      })),
    };
  }

  // --- Retry helpers ---

  private isRetryableError(error: any): boolean {
    if (!error) return false;
    const msg = error.message?.toLowerCase() || "";
    const code = error.code?.toLowerCase() || "";
    const retryablePatterns = [
      "rate limit", "timeout", "network", "connection",
      "temporary", "service unavailable", "internal server error",
      "bad gateway", "gateway timeout",
    ];
    return retryablePatterns.some((p) => msg.includes(p) || code.includes(p));
  }

  private modifyMessageForRetry(message: string, lastError: any): string {
    const errorMsg = lastError?.message?.toLowerCase() || "";
    if (errorMsg.includes("tool") || errorMsg.includes("function")) {
      return `Please provide a simple, direct response to: ${message}`;
    }
    return message;
  }

  // --- Public chat method ---

  async chat(
    params: AIChatParams & { persistState?: boolean },
  ): Promise<AIChatCompletion> {
    const {
      personaId,
      chatSessionId,
      message,
      role = "user",
      persistState = true,
      streamingMode = StreamingMode.NONE,
    } = params;

    const maxRetries = 2;
    let lastError: any;
    this.streamingMode = streamingMode;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Re-initialize if needed
        if (!this.ai || (chatSessionId && this.chatState?.id !== chatSessionId)) {
          const persona = this.personaProvider.getPersona(personaId);
          if (!persona) {
            throw new AIProviderError(`Persona ${personaId} not found`);
          }
          await this.initialize(chatSessionId ?? "", persona);
        }

        const modifiedMessage = attempt > 1
          ? this.modifyMessageForRetry(message, lastError)
          : message;

        const messageId = new ObjectId();
        const prompt = await this.createPrompt(modifiedMessage);
        const response = await this.getAIResponse(prompt, messageId.toString());
        const completion = this.normalizeCompletion(response);

        // Add user message to history
        const userHistoryItem: ReactorConversationHistoryItem = {
          id: new ObjectId(),
          role: "user",
          content: message,
          timestamp: new Date(),
          tool_results: [],
        };
        this.chatState.history.push(userHistoryItem);

        // Add assistant response to history
        if (completion.choices && completion.choices.length > 0) {
          this.chatState.history.push({
            id: messageId,
            timestamp: new Date(),
            tool_calls: (completion.choices[0].message.tool_calls ?? []).map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: tc.function,
            })),
            tool_results: [],
            role: "assistant",
            content: completion.choices[0].message.content,
          });
        }

        if (persistState) {
          await this.persistChatState();
        }

        return completion;
      } catch (error: any) {
        lastError = error;
        if (attempt < maxRetries && this.isRetryableError(error)) {
          this.context.warn(
            `Retry attempt ${attempt} for OpenAI chat (${error.message})`,
            { error, attempt, maxRetries },
            "OpenAIService.chat",
          );
          const backoffDelay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          continue;
        }
        break;
      }
    }

    this.context.error(
      `Error in chat after ${maxRetries} attempts: ${lastError?.message ?? lastError?.toString()}`,
      { error: lastError, params },
      "OpenAIService.chat",
    );

    // Surface the error to the caller so the conversation service can
    // return a proper ReactorErrorResponse to the client.
    throw new AIProviderError(
      lastError?.message || "AI provider request failed after retries",
    );
  }

  // --- Service dependency setters ---

  setStreamingSessionManager(streamingSessionManager: StreamingSessionManager) {
    this.streamingSessionManager = streamingSessionManager;
  }

  setStreamingTransportManager(streamingTransportManager: StreamingTransportManager) {
    this.streamingTransportManager = streamingTransportManager;
  }

  // --- IReactoryService interface ---

  toString(includeVersion?: boolean): string {
    return `OpenAIService${includeVersion ? "@1.0.0" : ""}`;
  }

  description?: string = "OpenAI-compatible AI Service (OpenAI, xAI, Ollama)";
  tags?: string[] = ["ai", "openai", "xai", "ollama"];
  nameSpace: string = "reactor";
  name: string = "OpenAIService";
  version: string = "1.0.0";
}

export default OpenAIService;
