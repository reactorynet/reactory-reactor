import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import {
  AIStreamingCapabilities,
  AIStreamingEvent,
  IAIPersona,
  IOpenAIServiceProps,
} from "../../../types/service.types";
import {
  AIChatParams,
  AIChatCompletion,
  AIImage,
  AIImageGenerationParams,
  AIListResponse,
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
  ErrorStreamingEvent,
} from "../types/streaming.types";
import { StreamingSessionManager } from "../StreamingSessionManager";
import { StreamingTransportManager } from "../StreamingTransportManager";
import { StreamingEventFactory, StreamingEventIds } from "../streaming/StreamingEventFactory";
import { TokenPacer } from "../streaming/TokenPacer";
import { IReactorProviderService } from "../../../types/service.types";


@service({
  id: "reactor.OpenAIService@1.0.0",
  name: "OpenAI Service",
  nameSpace: "reactor",
  description: "Service for managing OpenAI-compatible API requests (OpenAI, xAI, GitHub Copilot, Azure OpenAI)",
  serviceType: "ai",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.UserService@1.0.0", alias: "userService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },
    { id: "reactor.ReactorMacroService@1.0.0", alias: "macroService" },
    { id: "reactor.StreamingTransportManager@1.0.0", alias: "streamingTransportManager" },
    { id: "reactor.StreamingSessionManager@1.0.0", alias: "streamingSessionManager" },
    { id: "reactor.ReactorProviderService@1.0.0", alias: "providerService" },
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
  providerService!: IReactorProviderService;

  /** Cached model config from the provider registry */
  private _resolvedModelConfig: { supportedTools?: string[]; capabilities?: string[] } | null = null;

  constructor(props: IOpenAIServiceProps, context: Reactory.Server.IReactoryContext) {
    super(props, context);
    this.streamingMode = props.streamingMode || StreamingMode.NONE;
  }

  /**
   * Resolve the model config from the provider registry.
   */
  private async resolveModelConfig(): Promise<{ supportedTools?: string[]; capabilities?: string[] }> {
    if (this._resolvedModelConfig) return this._resolvedModelConfig;
    const modelId = this.chatState?.modelId || "";
    if (!modelId || !this.providerService) return {};
    try {
      const providers = await this.providerService.getProviders();
      for (const p of providers) {
        const model = p.models?.find((m: any) => m.id === modelId);
        if (model) {
          this._resolvedModelConfig = {
            supportedTools: model.supportedTools || [],
            capabilities: model.capabilities || [],
          };
          return this._resolvedModelConfig;
        }
      }
    } catch {
      // Fall through — assume function calling is supported
    }
    return {};
  }

  /** Check if the active model supports function calling based on provider config */
  private async modelSupportsFunctionCalling(): Promise<boolean> {
    const config = await this.resolveModelConfig();
    // If no config found (model not in registry), default to true for backward compatibility
    if (!config.supportedTools) return true;
    return config.supportedTools.includes("function-calling");
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
    // Reset cached model config for the new session/model
    this._resolvedModelConfig = null;
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
    const supportsFunctionCalling = await this.modelSupportsFunctionCalling();
    if (supportsFunctionCalling && tools.length > 0) {
      return {
        model: modelId,
        messages,
        tools,
        parallel_tool_calls: true,
        tool_choice: "auto",
      };
    }
    return {
      model: modelId,
      messages,
    };
  }

  // --- Streaming request handling ---

  /**
   * Handles a streaming AI request using TokenPacer + StreamingEventFactory,
   * sending token, reasoning, tool_call, and completion events to the client
   * at a normalised cadence.
   */
  private async handleStreamingRequest(args: {
    sessionId: string;
    prompt: OpenAI.Chat.Completions.ChatCompletionCreateParams;
    messageId?: string;
  }): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const { sessionId, prompt, messageId } = args;
    const ids: StreamingEventIds = {
      sessionId,
      conversationId: sessionId,
      messageId: messageId ?? "",
    };

    // Resolve per-persona pacing configuration
    const pacerCfg = this.chatState?.persona?.config?.streamingPace ?? {};

    // -- Create pacers for tokens and reasoning --
    let accumulatedText = "";
    let accumulatedReasoning = "";

    const tokenPacer = new TokenPacer({
      ...pacerCfg,
      onFlush: async (text) => {
        const event = StreamingEventFactory.createTokenEvent(
          text, accumulatedText.length, ids,
        );
        await this.streamingTransportManager.sendEventToSession(sessionId, event);
      },
    });

    const reasoningPacer = new TokenPacer({
      minChunkSize: pacerCfg.minChunkSize ?? 20,
      maxChunkSize: pacerCfg.maxChunkSize ?? 120,
      targetIntervalMs: pacerCfg.targetIntervalMs,
      flushTimeoutMs: pacerCfg.flushTimeoutMs,
      onFlush: async (text) => {
        const event = StreamingEventFactory.createReasoningEvent(
          text, accumulatedReasoning.length, ids,
        );
        await this.streamingTransportManager.sendEventToSession(sessionId, event);
      },
    });

    // -- Open the streaming API connection --
    let stream: Awaited<ReturnType<typeof this.ai.chat.completions.create>>;
    try {
      stream = await this.ai.chat.completions.create({
        ...prompt,
        stream: true,
        stream_options: { include_usage: true },
      });
    } catch (error: any) {
      const errorEvent = StreamingEventFactory.createErrorEvent(
        error.code || error.status || "CONNECTION_ERROR",
        error.message || "Failed to connect to AI provider",
        { recoverable: false },
        ids,
      );
      try {
        await this.streamingTransportManager.sendEventToSession(sessionId, errorEvent);
      } catch (_) { /* transport may not be available */ }
      throw new AIProviderError(
        `Failed to connect to AI provider: ${error.message || error.toString()}`,
      );
    }

    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let currentToolCall: { id?: string; name?: string; arguments?: string } | null = null;
    let finishReason: string | null = null;
    let completionId: string | null = null;
    let model = "";
    let streamUsage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    } | null = null;

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (!completionId && chunk.id) completionId = chunk.id;
        if (!model && chunk.model) model = chunk.model;

        const delta = choice.delta;

        // Feed content tokens into the pacer
        if (delta?.content) {
          accumulatedText += delta.content;
          tokenPacer.add(delta.content);
        }

        // Feed reasoning/thinking tokens
        // OpenAI o1/o3 uses `reasoning_content`, xAI Grok uses `reasoning`
        const reasoningContent = (delta as any)?.reasoning_content
          || (delta as any)?.reasoning;
        if (reasoningContent) {
          accumulatedReasoning += reasoningContent;
          reasoningPacer.add(reasoningContent);
        }

        // Accumulate tool calls from deltas
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
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

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // Capture usage from the final chunk (sent when stream_options.include_usage is true)
        if ((chunk as any).usage) {
          streamUsage = (chunk as any).usage;
        }
      }

      // Flush remaining buffered tokens after stream ends
      await tokenPacer.flush();
      await reasoningPacer.flush();
    } catch (streamError: any) {
      tokenPacer.destroy();
      reasoningPacer.destroy();
      const errorEvent = StreamingEventFactory.createErrorEvent(
        streamError.code || "STREAM_ERROR",
        streamError.message || "Stream interrupted",
        { recoverable: false },
        ids,
      );
      try {
        await this.streamingTransportManager.sendEventToSession(sessionId, errorEvent);
      } catch (_) { /* best-effort */ }
      throw new AIProviderError(
        `AI provider stream interrupted: ${streamError.message || streamError.toString()}`,
      );
    } finally {
      tokenPacer.destroy();
      reasoningPacer.destroy();
    }

    // Flush final tool call
    if (currentToolCall?.id && currentToolCall?.name) {
      toolCalls.push({
        id: currentToolCall.id,
        name: currentToolCall.name,
        arguments: currentToolCall.arguments || "",
      });
    }

    // Send tool_call events to client (suppress only in AUTO mode — server handles those).
    // isComplete is false because the tool has not been executed yet — the client will
    // prompt the user (PROMPT/PLAN) or auto-execute (SAFE_AUTO) based on the approval mode.
    const toolApprovalMode = this.chatState?.toolApprovalMode;
    if (toolApprovalMode !== ToolApprovalMode.AUTO) {
      for (const tc of toolCalls) {
        const event = StreamingEventFactory.createToolCallEvent(
          tc.id, tc.name, tc.arguments, false, undefined, ids,
        );
        await this.streamingTransportManager.sendEventToSession(sessionId, event);
      }
    }

    // Send completion event (defer in AUTO mode with pending tool calls)
    const hasPendingAutoToolCalls =
      toolApprovalMode === ToolApprovalMode.AUTO && toolCalls.length > 0;

    if (!hasPendingAutoToolCalls) {
      const completionEvent = StreamingEventFactory.createCompletionEvent(
        accumulatedText,
        finishReason || "stop",
        accumulatedReasoning || undefined,
        ids,
      );
      await this.streamingTransportManager.sendEventToSession(sessionId, completionEvent);
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
      usage: streamUsage
        ? {
            prompt_tokens: streamUsage.prompt_tokens,
            completion_tokens: streamUsage.completion_tokens,
            total_tokens: streamUsage.total_tokens,
            prompt_tokens_details: streamUsage.prompt_tokens_details,
            completion_tokens_details: streamUsage.completion_tokens_details,
          }
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
    const completion: AIChatCompletion = {
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
    if (response.usage) {
      const cached = (response.usage as any).prompt_tokens_details?.cached_tokens;
      const reasoning = (response.usage as any).completion_tokens_details?.reasoning_tokens;
      completion.usage = {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
        ...(typeof cached === 'number' ? { cachedPromptTokens: cached } : {}),
        ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
      };
    }
    return completion;
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
          const persona = await this.personaProvider.getPersona(personaId);
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

        // NOTE: We do NOT push the user message or assistant response to chatState.history here.
        // ReactorConversationService owns persistence of all conversation turns via atomic
        // $push operations and processAIResponse(). Pushing here would cause duplicates because:
        //   1. sendMessage() already $push-ed the user/tool message before calling us.
        //   2. loadChatState() loaded that message into this.chatState.history during initialize().
        //   3. processAIResponse() will $push the assistant response after we return.
        // Only persist if the caller explicitly opts in (e.g. standalone usage).
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

  async generateImage(params: AIImageGenerationParams): Promise<AIListResponse<AIImage>> {
    const persona = this.chatState?.persona;
    if (!this.ai) {
      await this.initializeClient(persona);
    }

    const response = await this.ai.images.generate({
      model: params.model || "dall-e-3",
      prompt: params.prompt,
      n: params.n || 1,
      size: (params.size as any) || "1024x1024",
      response_format: (params.response_format as any) || "b64_json",
    });

    const images: AIImage[] = (response.data || []).map((img) => ({
      b64_json: img.b64_json,
      url: img.url,
    }));

    return { data: images };
  }

  // --- IReactoryService interface ---

  toString(includeVersion?: boolean): string {
    return `OpenAIService${includeVersion ? "@1.0.0" : ""}`;
  }

  description?: string = "OpenAI-compatible AI Service (OpenAI, xAI, GitHub Copilot, Azure OpenAI)";
  tags?: string[] = ["ai", "openai", "xai", "copilot", "azure-openai"];
  nameSpace: string = "reactor";
  name: string = "OpenAIService";
  version: string = "1.0.0";
}

export default OpenAIService;
