import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import Ollama, { Message, Tool, ToolCall } from "ollama";
import {
  AIStreamingCapabilities,
  IAIPersona,
  IOpenAIServiceProps,
} from "../../../types/service.types";
import {
  AIChatParams,
  AIChatCompletion,
} from "../../../types/model.types";
import AIPersonaProvider from "../AIPersonaProvider";
import AIProviderBase from "./AIProviderBase";
import { AIProviderError } from "./AIProviderError";
import {
  MacroComponentDefinition,
  MacroToolDefinition,
  ToolApprovalMode,
} from "../../../ai/openai/types/chat";
import { ObjectId } from "mongodb";
import ReactorMacroService from "./ReactorMacroService";
import { StreamingMode } from "../types/streaming.types";
import { StreamingSessionManager } from "../StreamingSessionManager";
import { StreamingTransportManager } from "../StreamingTransportManager";
import { StreamingEventFactory, StreamingEventIds } from "../streaming/StreamingEventFactory";
import { TokenPacer } from "../streaming/TokenPacer";

@service({
  id: "reactor.OllamaAIService@1.0.0",
  name: "Ollama AI Service",
  nameSpace: "reactor",
  description: "Service for managing Ollama AI requests using the official Ollama Node SDK",
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
class OllamaAIService extends AIProviderBase {
  ai!: Ollama;
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

  async getStreamingCapabilities(): Promise<AIStreamingCapabilities> {
    return {
      supportsTokenStreaming: true,
      supportsToolStreaming: true,
      supportsFunctionStreaming: true,
      maxConcurrentStreams: 5,
      supportedFormats: ["json", "text", "sse"],
    };
  }

  protected async initializeClient(persona: IAIPersona): Promise<void> {
    const host =
      persona.config?.apiBaseURL ||
      this.props?.apiBaseURL ||
      process.env.OLLAMA_HOST ||
      "http://localhost:11434";

    this.ai = new Ollama({ host });
  }

  // --- Tool definitions ---

  private async getToolDefinitions(): Promise<Tool[]> {
    const tools: Tool[] = [];
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

  // --- Message building ---

  private buildMessages(userMessage: string): Message[] {
    const messages: Message[] = [];
    const { history } = this.chatState;

    history.forEach((msg) => {
      if (!msg) return;

      if ((msg.role === "system" || msg.role === "user") && msg.content) {
        messages.push({ role: msg.role, content: msg.content as string });
      } else if (msg.role === "assistant") {
        const toolCalls = (msg as any).tool_calls;
        if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
          // Ollama assistant messages with tool_calls
          const ollamaToolCalls: ToolCall[] = toolCalls.map((tc: any) => ({
            function: {
              name: tc.function?.name || tc.name || "",
              arguments:
                typeof tc.function?.arguments === "string"
                  ? JSON.parse(tc.function.arguments || "{}")
                  : tc.function?.arguments ?? tc.args ?? {},
            },
          }));
          messages.push({
            role: "assistant",
            content: (msg.content as string) || "",
            tool_calls: ollamaToolCalls,
          });
        } else if (msg.content) {
          messages.push({ role: "assistant", content: msg.content as string });
        }
      } else if (msg.role === "tool") {
        messages.push({
          role: "tool",
          content:
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify((msg as any).tool_results || msg.content || ""),
        });
      }
    });

    if (this.chatState.files && this.chatState.files.length > 0) {
      const fileManifest = this.chatState.files
        .map(
          (f: any) =>
            `- id: "${f._id || f.id}", filename: "${f.filename}", path: "${f.path || "N/A"}", type: "${f.mimetype || "unknown"}", size: ${f.size || 0}`
        )
        .join("\n");

      messages.push({
        role: "system",
        content: `The user has the following files attached to this chat session. You can read their contents using the readChatFile tool with the file id.\n\nAttached files:\n${fileManifest}`,
      });
    }

    messages.push({ role: "user", content: userMessage });

    return messages;
  }

  // --- Streaming request handling ---

  private async handleStreamingRequest(args: {
    sessionId: string;
    model: string;
    messages: Message[];
    tools: Tool[];
    messageId?: string;
  }): Promise<AIChatCompletion> {
    const { sessionId, model, messages, tools, messageId } = args;
    const ids: StreamingEventIds = {
      sessionId,
      conversationId: sessionId,
      messageId: messageId ?? "",
    };

    const pacerCfg = this.chatState?.persona?.config?.streamingPace ?? {};

    let accumulatedText = "";
    let accumulatedToolCallContent = "";

    const tokenPacer = new TokenPacer({
      ...pacerCfg,
      onFlush: async (text) => {
        const event = StreamingEventFactory.createTokenEvent(
          text,
          accumulatedText.length,
          ids
        );
        await this.streamingTransportManager.sendEventToSession(sessionId, event);
      },
    });

    let stream: AsyncIterable<any>;
    try {
      stream = await this.ai.chat({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
      });
    } catch (error: any) {
      const errorEvent = StreamingEventFactory.createErrorEvent(
        error.code || "CONNECTION_ERROR",
        error.message || "Failed to connect to Ollama",
        { recoverable: false },
        ids
      );
      try {
        await this.streamingTransportManager.sendEventToSession(sessionId, errorEvent);
      } catch (_) { /* best-effort */ }
      throw new AIProviderError(
        `Failed to connect to Ollama: ${error.message || error.toString()}`
      );
    }

    // Accumulate tool calls across chunks — Ollama doesn't provide ids
    const toolCallsMap: Map<string, { name: string; arguments: string }> = new Map();
    const toolCallOrder: string[] = [];
    let finishReason = "stop";

    try {
      for await (const chunk of stream) {
        const msg = chunk.message;
        if (!msg) continue;

        if (msg.content) {
          accumulatedText += msg.content;
          tokenPacer.add(msg.content);
        }

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            // Generate a stable id per tool call by position
            const tcId = new ObjectId().toString();
            const name = tc.function?.name || "";
            const args =
              typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments ?? {});

            toolCallsMap.set(tcId, { name, arguments: args });
            toolCallOrder.push(tcId);
          }
        }

        if (chunk.done) {
          finishReason = chunk.done_reason || (toolCallOrder.length > 0 ? "tool_calls" : "stop");
        }
      }

      await tokenPacer.flush();
    } catch (streamError: any) {
      tokenPacer.destroy();
      const errorEvent = StreamingEventFactory.createErrorEvent(
        streamError.code || "STREAM_ERROR",
        streamError.message || "Stream interrupted",
        { recoverable: false },
        ids
      );
      try {
        await this.streamingTransportManager.sendEventToSession(sessionId, errorEvent);
      } catch (_) { /* best-effort */ }
      throw new AIProviderError(
        `Ollama stream interrupted: ${streamError.message || streamError.toString()}`
      );
    } finally {
      tokenPacer.destroy();
    }

    const resolvedToolCalls = toolCallOrder.map((id) => {
      const tc = toolCallsMap.get(id)!;
      return { id, name: tc.name, arguments: tc.arguments };
    });

    // Send tool_call events if not in AUTO mode
    const toolApprovalMode = this.chatState?.toolApprovalMode;
    if (toolApprovalMode !== ToolApprovalMode.AUTO) {
      for (const tc of resolvedToolCalls) {
        const event = StreamingEventFactory.createToolCallEvent(
          tc.id,
          tc.name,
          tc.arguments,
          true,
          undefined,
          ids
        );
        await this.streamingTransportManager.sendEventToSession(sessionId, event);
      }
    }

    const hasPendingAutoToolCalls =
      toolApprovalMode === ToolApprovalMode.AUTO && resolvedToolCalls.length > 0;

    if (!hasPendingAutoToolCalls) {
      const completionEvent = StreamingEventFactory.createCompletionEvent(
        accumulatedText,
        finishReason,
        undefined,
        ids
      );
      await this.streamingTransportManager.sendEventToSession(sessionId, completionEvent);
    }

    return {
      id: new ObjectId(),
      object: "chat.completion",
      created: new Date(),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: accumulatedText || "",
            tool_calls:
              resolvedToolCalls.length > 0
                ? resolvedToolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function" as const,
                    function: { name: tc.name, arguments: tc.arguments },
                  }))
                : [],
          },
          finish_reason: finishReason,
        },
      ],
    };
  }

  // --- Non-streaming request ---

  private async handleNonStreamingRequest(
    model: string,
    messages: Message[],
    tools: Tool[]
  ): Promise<AIChatCompletion> {
    const response = await this.ai.chat({
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      stream: false,
    });

    const msg = response.message;
    const toolCalls =
      msg.tool_calls?.map((tc: ToolCall) => ({
        id: new ObjectId().toString(),
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments:
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
        },
      })) ?? [];

    return {
      id: new ObjectId(),
      object: "chat.completion",
      created: new Date(),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: msg.content || "",
            tool_calls: toolCalls,
          },
          finish_reason: response.done_reason || (toolCalls.length > 0 ? "tool_calls" : "stop"),
        },
      ],
    };
  }

  // --- Retry helpers ---

  private isRetryableError(error: any): boolean {
    if (!error) return false;
    const msg = error.message?.toLowerCase() || "";
    return (
      msg.includes("rate limit") ||
      msg.includes("timeout") ||
      msg.includes("network") ||
      msg.includes("connection") ||
      msg.includes("service unavailable") ||
      msg.includes("internal server error")
    );
  }

  // --- Public chat method ---

  async chat(
    params: AIChatParams & { persistState?: boolean }
  ): Promise<AIChatCompletion> {
    const {
      personaId,
      chatSessionId,
      message,
      persistState = true,
      streamingMode = StreamingMode.NONE,
    } = params;

    this.streamingMode = streamingMode;
    const maxRetries = 2;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!this.ai || (chatSessionId && this.chatState?.id !== chatSessionId)) {
          const persona = await this.personaProvider.getPersona(personaId);
          if (!persona) {
            throw new AIProviderError(`Persona ${personaId} not found`);
          }
          await this.initialize(chatSessionId ?? "", persona);
        }

        const model = this.chatState.modelId;
        const userMessage = attempt > 1 ? `Please provide a simple, direct response to: ${message}` : message;
        const messages = this.buildMessages(userMessage);
        const tools = await this.getToolDefinitions();

        let completion: AIChatCompletion;

        if (this.streamingMode === StreamingMode.SSE) {
          const messageId = new ObjectId();
          completion = await this.handleStreamingRequest({
            sessionId: this.chatState.id ?? "",
            model,
            messages,
            tools,
            messageId: messageId.toString(),
          });
        } else {
          completion = await this.handleNonStreamingRequest(model, messages, tools);
        }

        if (persistState) {
          await this.persistChatState();
        }

        return completion;
      } catch (error: any) {
        lastError = error;
        if (attempt < maxRetries && this.isRetryableError(error)) {
          this.context.warn(
            `Retry attempt ${attempt} for Ollama chat (${error.message})`,
            { error, attempt, maxRetries },
            "OllamaAIService.chat"
          );
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          continue;
        }
        break;
      }
    }

    this.context.error(
      `Error in Ollama chat after ${maxRetries} attempts: ${lastError?.message ?? lastError?.toString()}`,
      { error: lastError, params },
      "OllamaAIService.chat"
    );

    throw new AIProviderError(
      lastError?.message || "Ollama provider request failed after retries"
    );
  }

  setStreamingSessionManager(sessionManager: StreamingSessionManager) {
    this.streamingSessionManager = sessionManager;
  }

  setStreamingTransportManager(transportManager: StreamingTransportManager) {
    this.streamingTransportManager = transportManager;
  }

  toString(includeVersion?: boolean): string {
    return `OllamaAIService${includeVersion ? "@1.0.0" : ""}`;
  }

  description?: string = "Ollama AI Service using the official Ollama Node SDK";
  tags?: string[] = ["ai", "ollama", "local"];
  nameSpace: string = "reactor";
  name: string = "OllamaAIService";
  version: string = "1.0.0";
}

export default OllamaAIService;
