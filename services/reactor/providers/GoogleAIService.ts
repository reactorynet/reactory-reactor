import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import GoogleGenAI, {
  FunctionCallingConfigMode,
  FunctionDeclaration,
  FunctionResponse,
  Type,
} from "@google/genai";
import https from "https";
import fs from "fs";
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
  ToolApprovalMode,
} from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
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
import {
  CompletionStreamingEvent,
  ErrorStreamingEvent,
  ReasoningStreamingEvent,
  StreamingEvent,
  StreamingEventType,
  StreamingMode,
  TokenStreamingEvent,
  ToolCallStreamingEvent,
} from "../types/streaming.types";
import { StreamingSessionManager } from "../StreamingSessionManager";
import { StreamingTransportManager } from "../StreamingTransportManager";

@service({
  id: "reactor.GoogleAIService@1.0.0",
  name: "Google AI Service",
  nameSpace: "reactor",
  description: "Service for managing Google AI API requests",
  serviceType: "ai",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.UserService@1.0.0", alias: "userService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },
    { id: "reactor.ReactorMacroService@1.0.0", alias: "macroService" },
    {
      id: "reactor.StreamingTransportManager@1.0.0",
      alias: "streamingTransportManager",
    },
    {
      id: "reactor.StreamingSessionManager@1.0.0",
      alias: "streamingSessionManager",
    },
  ],
})
class GoogleAIService extends AIProviderBase {
  ai!: GoogleGenAI.GoogleGenAI;
  model!: GoogleGenAI.Model;
  fileService!: Reactory.Service.IReactoryFileService;
  userService!: Reactory.Service.IReactoryUserService;
  fetchService!: Reactory.Service.IFetchService;
  macroService!: ReactorMacroService;
  streamingMode: StreamingMode = StreamingMode.NONE;
  streamingSessionManager!: StreamingSessionManager;
  streamingTransportManager!: StreamingTransportManager;
  models: GoogleGenAI.Pager<GoogleGenAI.Model> | null = null;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    super(props, context);
    this.streamingMode = props.streamingMode || StreamingMode.NONE;
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
      supportedFormats: ["json", "text", "sse"],
    };
  }

  protected async initializeClient(persona: IAIPersona): Promise<void> {
    const apiKey = persona.config?.apiKey || process.env.GOOGLE_AI_API_KEY;
    const project = persona.config?.project || process.env.GOOGLE_AI_PROJECT_ID;
    if (!apiKey) {
      throw new AIProviderError("Google AI API key is not set");
    }

    this.ai = new GoogleGenAI.GoogleGenAI({
      apiKey,
      vertexai: false,
    });

    const modelId =
      persona.modelId || process.env.GOOGLE_AI_MODEL_ID || "gemini-pro";

    try {
      this.model = await this.ai.models.get({
        model: modelId,
      });
    } catch (getError) {
      this.context.error(
        `Model ${modelId} not found in available models and direct get failed`,
        {
          error: getError,
          modelId,
          availableModelsCount: this.models ? "unknown" : 0,
        },
        "GoogleAIService.initializeClient"
      );
      throw new AIProviderError(
        `Model ${modelId} not found. Please check the model ID.`
      );
    }

    this.context.log(
      `Successfully initialized Google AI model: ${this.model.name}`,
      {
        modelId,
        modelName: this.model.name,
        displayName: this.model.displayName,
      },
      "GoogleAIService.initializeClient"
    );
  }

  /**
   * Determine if we should use custom fetch configuration
   */
  private shouldUseCustomFetch(): boolean {
    // Use custom fetch if Google AI SDK SSL bypass is enabled or other SSL/proxy settings
    return !!(
      process.env.GOOGLE_AI_BYPASS_SSL === "true" ||
      process.env.NODE_EXTRA_CA_CERTS ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY
    );
  }

  /**
   * Create a custom fetch function with proper SSL/TLS configuration
   */
  private createCustomFetch() {
    return (url: string | URL | Request, init?: RequestInit) => {
      // Clone the init object to avoid modifying the original
      const fetchInit: RequestInit = { ...init };

      // Configure HTTPS agent for SSL/TLS settings
      if (typeof url === "string" && url.startsWith("https://")) {
        const agentOptions: https.AgentOptions = {
          // Keep connections alive for better performance
          keepAlive: true,

          // Timeout settings
          timeout: 30000,

          // Handle SSL bypass for Google AI SDK specifically
          rejectUnauthorized:
            process.env.GOOGLE_AI_BYPASS_SSL === "true"
              ? false
              : process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
        };

        // Add extra CA certificates if provided (and not bypassing SSL)
        if (
          process.env.NODE_EXTRA_CA_CERTS &&
          process.env.GOOGLE_AI_BYPASS_SSL !== "true"
        ) {
          try {
            agentOptions.ca = fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS);
            this.context.debug(
              "Using custom CA certificate for SSL verification",
              {
                certPath: process.env.NODE_EXTRA_CA_CERTS,
              },
              "GoogleAIService.createCustomFetch"
            );
          } catch (error) {
            this.context.warn(
              "Failed to read custom CA certificate, falling back to system defaults",
              {
                certPath: process.env.NODE_EXTRA_CA_CERTS,
                error: error.message,
              },
              "GoogleAIService.createCustomFetch"
            );
          }
        }

        const agent = new https.Agent(agentOptions);
        (fetchInit as any).agent = agent;

        this.context.debug(
          "Using custom HTTPS agent for Google AI request",
          {
            url: typeof url === "string" ? url : "URL or Request object",
            rejectUnauthorized: agentOptions.rejectUnauthorized,
            hasCustomCA: !!agentOptions.ca,
            bypassSSL: process.env.GOOGLE_AI_BYPASS_SSL === "true",
          },
          "GoogleAIService.createCustomFetch"
        );
      }

      return fetch(url, fetchInit);
    };
  }

  // Always return lowercase type string for Gemini compatibility
  private getTypeEnum(type: string): Type {
    switch (type?.toLowerCase()) {
      case "string":
        return Type.STRING;
      case "number":
        return Type.NUMBER;
      case "boolean":
        return Type.BOOLEAN;
      case "object":
        return Type.OBJECT;
      case "array":
        return Type.ARRAY;
      default:
        return Type.STRING;
    }
  }

  private toPropertiesRecord(
    properties: Record<string, any>
  ): Record<string, GoogleGenAI.Schema> {
    const record: Record<string, GoogleGenAI.Schema> = {};
    for (const [key, value] of Object.entries(properties)) {
      record[key] = this.handleObjectProperties(value);
    }
    return record;
  }

  private handleObjectProperties(value: any): GoogleGenAI.Schema {
    const schema: GoogleGenAI.Schema = {
      type: this.getTypeEnum(value.type),
      description: value.description ?? "",
    };
    if (value.enum) schema.enum = value.enum;
    if (value.format) schema.format = value.format;
    if (
      value.type &&
      this.getTypeEnum(value.type) === Type.OBJECT &&
      value.properties
    ) {
      schema.properties = this.toPropertiesRecord(value.properties);
      if (value.required) schema.required = value.required;
    }
    if (
      value.type &&
      this.getTypeEnum(value.type) === Type.ARRAY &&
      value.items
    ) {
      schema.items = this.handleArrayItems(value.items);
    }
    return schema;
  }

  private handleArrayItems(items: any): any {
    if (Array.isArray(items)) {
      return items.map((item: any) => {
        if (
          item.type &&
          this.getTypeEnum(item.type) === Type.OBJECT &&
          item.properties
        ) {
          return {
            ...item,
            properties: this.toPropertiesRecord(item.properties),
          };
        }
        return item;
      });
    } else if (
      items.type &&
      this.getTypeEnum(items.type) === Type.OBJECT &&
      items.properties
    ) {
      return {
        ...items,
        properties: this.toPropertiesRecord(items.properties),
      };
    } else {
      return items;
    }
  }

  private async getAITools(): Promise<GoogleGenAI.ToolListUnion> {
    const functions: FunctionDeclaration[] = [];
    const tools: MacroToolDefinition[] = this.chatState?.tools ?? [];

    if (!Array.isArray(tools)) {
      this.context.warn(
        `getAITools: chatState.tools is not an array (got ${typeof tools}), defaulting to empty tool list`,
        { tools },
        "GoogleAIService.getAITools"
      );
      return [{ functionDeclarations: [] }];
    }

    tools.forEach((tool: MacroToolDefinition) => {
      const functionDeclaration: FunctionDeclaration = {
        name: tool.function.name,
        parameters: {
          type: Type.OBJECT,
          description: tool.function.description,
          properties: this.toPropertiesRecord(
            tool.function.parameters.properties
          ),
          required: tool.function.parameters.required,
        },
      };
      functions.push(functionDeclaration);
    });

    return [
      {
        // /** Optional. Retrieval tool type. System will always execute the provided retrieval tool(s) to get external knowledge to answer the prompt. Retrieval results are presented to the model for generation. */
        //     retrieval?: Retrieval;
        //     /** Optional. Google Search tool type. Specialized retrieval tool
        //      that is powered by Google Search. */
        //     googleSearch?: GoogleSearch;
        //     /** Optional. GoogleSearchRetrieval tool type. Specialized retrieval tool that is powered by Google search. */
        //     googleSearchRetrieval?: GoogleSearchRetrieval;
        //     /** Optional. Enterprise web search tool type. Specialized retrieval
        //      tool that is powered by Vertex AI Search and Sec4 compliance. */
        //     enterpriseWebSearch?: EnterpriseWebSearch;
        //     /** Optional. Google Maps tool type. Specialized retrieval tool
        //      that is powered by Google Maps. */
        //     googleMaps?: GoogleMaps;
        //     /** Optional. CodeExecution tool type. Enables the model to execute code as part of generation. This field is only used by the Gemini Developer API services. */
        //     codeExecution?: ToolCodeExecution;
        functionDeclarations: functions,
      },
    ];
  }

  private getPartsForAssistantMessage(
    msg:
      | (ChatCompletionMessage & {
          id: string | ObjectId;
          response?: ValidProviderResponseTypes;
          rating?: number;
          content?: any;
          component?: string;
          timestamp: Date;
          tool_name?: string;
          tool_args?: any;
          tool_call_id?: string;
          tool_results?: ReactorToolResult[];
        })
      | (ChatCompletionAssistantMessageParam & {
          id: string | ObjectId;
          response?: ValidProviderResponseTypes;
          content?: any;
          rating?: number;
          component?: string;
          timestamp: Date;
          tool_name?: string;
          tool_args?: any;
          tool_call_id?: string;
          tool_results?: ReactorToolResult[];
        })
      | (ChatCompletionToolMessageParam & {
          id: string | ObjectId;
          response?: ValidProviderResponseTypes;
          rating?: number;
          content?: any;
          component?: string;
          timestamp: Date;
          tool_name?: string;
          tool_args?: any;
          tool_call_id?: string;
          tool_results?: ReactorToolResult[];
        })
  ): any[] {
    /**
     * Converts an assistant or tool message to Google GenAI "parts" format.
     * Handles tool calls, tool results, and normal assistant responses.
     */
    const parts: any[] = [];

    // If the message contains tool calls, add them as functionCall parts
    if (
      "tool_calls" in msg &&
      msg.tool_calls &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0
    ) {
      for (const toolCall of msg.tool_calls) {
        // Google expects functionCall in a specific format
        let args =
          toolCall.function?.arguments ?? (toolCall as any).arguments ?? {};

        // If args is a string, try to parse it as JSON
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch (e) {
            // If parsing fails, use as-is
            this.context.warn(
              "Failed to parse function arguments as JSON",
              { args },
              "GoogleAIService"
            );
          }
        }

        parts.push({
          functionCall: {
            name: toolCall.function?.name || (toolCall as any).name,
            args: args,
          },
        });
      }
    }

    // If the message contains tool results (tool responses), add them as functionResponse parts
    if (
      msg.tool_results &&
      Array.isArray(msg.tool_results) &&
      msg.tool_results.length > 0
    ) {
      for (const toolResult of msg.tool_results) {
        let response = toolResult?.content ?? toolResult?.result ?? toolResult;

        // If response is a string, try to parse it as JSON
        if (typeof response === "string") {
          try {
            response = JSON.parse(response);
          } catch (e) {
            // If parsing fails, wrap in an object — Gemini requires
            // function_response.response to be a Struct (JSON object),
            // not a plain string.
            response = { result: response };
          }
        }

        // Ensure response is always an object (Gemini Struct requirement)
        if (typeof response !== "object" || response === null) {
          response = { result: response };
        }

        parts.push({
          functionResponse: {
            name: toolResult.tool_name || toolResult.name,
            response: response,
            // Optionally include tool_call_id if present
            ...(toolResult.tool_call_id
              ? { tool_call_id: toolResult.tool_call_id }
              : {}),
          },
        });
      }
    }

    // If the message has content (assistant/model response), add as text part
    if (msg.content) {
      // If content is an array, flatten to string
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (typeof c === "string") {
            parts.push({ text: c });
          } else if (
            c &&
            typeof c === "object" &&
            "text" in c &&
            typeof (c as any).text === "string"
          ) {
            parts.push({ text: (c as any).text });
          }
        }
      } else if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (
        msg.content &&
        typeof msg.content === "object" &&
        "text" in msg.content &&
        typeof (msg.content as any).text === "string"
      ) {
        parts.push({ text: (msg.content as any).text });
      }
    }

    // If no parts were added, add an empty text part to avoid Google API errors
    if (parts.length === 0) {
      parts.push({ text: "" });
    }

    return parts;
  }

  private getPartsForUserMessage(
    msg: ChatCompletionUserMessageParam & {
      id: string | ObjectId;
      response?: ValidProviderResponseTypes;
      rating?: number;
      component?: string;
      timestamp: Date;
      tool_name?: string;
      tool_args?: any;
      tool_call_id?: string;
      tool_results?: ReactorToolResult[];
    }
  ): any[] {
    // For a user message, Google expects an array of parts, each with a "text" property.
    // We'll handle the most common cases: string content, array of strings, or object with text.
    const parts: any[] = [];

    if (msg.content) {
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (typeof c === "string") {
            parts.push({ text: c });
          } else if (
            c &&
            typeof c === "object" &&
            "text" in c &&
            typeof (c as any).text === "string"
          ) {
            parts.push({ text: (c as any).text });
          }
        }
      } else if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (
        msg.content &&
        typeof msg.content === "object" &&
        "text" in msg.content &&
        typeof (msg.content as any).text === "string"
      ) {
        parts.push({ text: (msg.content as any).text });
      }
    }

    // If no parts were added, add an empty text part to avoid Google API errors
    if (parts.length === 0) {
      parts.push({ text: "" });
    }

    return parts;
  }

  private async createChatSession(history: ReactorConversationHistoryItem[]) {
    try {
      if (!this.model) {
        throw new AIProviderError("Google AI model not initialized");
      }

      if (!Array.isArray(history)) {
        this.context.warn(
          `createChatSession: history is not an array (got ${typeof history}), defaulting to empty history`,
          { history },
          "GoogleAIService.createChatSession"
        );
        history = [];
      }

      // Convert history to Google AI format
      // get the system instruction from the first message if it exists
      let systemInstruction =
        history.find((msg) => msg?.role === "system")?.content ?? "";

      const googleHistory: any[] = [];
      // add the system instruction to the history as a user message

      const user = this.chatState?.user;
      if (user) {
        systemInstruction = `
      ${systemInstruction}
      ## User Information
      name: ${user.firstName} ${user.lastName}.
      email: ${user.email}.
      id: ${user._id}.
      homeFolder: ${path.join(
        process.env.APP_DATA_ROOT || process.cwd(),
        "profiles",
        user._id.toString(),
        "home"
      )}.
      `;
      } else {
        this.context.warn(
          "createChatSession: chatState.user is undefined — skipping user context injection",
          { chatStateKeys: this.chatState ? Object.keys(this.chatState) : null },
          "GoogleAIService.createChatSession"
        );
      }

      if (this.chatState?.files && this.chatState.files.length > 0) {
        const fileManifest = this.chatState.files.map((f: any) =>
          `- id: "${f._id || f.id}", filename: "${f.filename}", path: "${f.path || 'N/A'}", type: "${f.mimetype || 'unknown'}", size: ${f.size || 0}`
        ).join("\n");

        systemInstruction += `\n## Attached Files\nThe user has the following files attached to this chat session. You can read their contents using the readChatFile tool with the file id.\n\n${fileManifest}\n`;
      }

      // googleHistory.push({
      //   role: "user",
      //   parts: [{ text: systemInstruction }],
      // });

      // // add a simulated assistant message to indicate a response to the system instruction
      // googleHistory.push({
      //   role: "model",
      //   parts: [{ text: "I'm ready to help you with your request." }],
      // });

      history.forEach((msg, idx) => {
        if (!msg) {
          this.context.warn(
            `createChatSession: history[${idx}] is null/undefined — skipping`,
            {},
            "GoogleAIService.createChatSession"
          );
          return;
        }
        let googleRole = "user";
        let parts: any[] = [];
        switch (msg.role) {
          case "assistant":
          case "tool":
            googleRole = "model";
            // check if the message has tool calls
            parts = this.getPartsForAssistantMessage(msg);
            break;
          default:
            googleRole = "user";
            //@ts-ignore
            parts = this.getPartsForUserMessage(msg);
            break;
        }

        let googleHistoryItem: any = {
          role: googleRole,
          parts,
        };

        googleHistory.push(googleHistoryItem);
      });

      const tools = await this.getAITools();

      // Create chat session with generation config
      return this.ai.chats.create({
        model: this.model.name,
        history: googleHistory,
        config: {
          candidateCount: 1,
          tools: tools,
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.AUTO, // Automatically determine when to call functions
            },
          },
          systemInstruction,
          temperature: 0.7,
          topP: 1.0,
          frequencyPenalty: 0.0,
          presencePenalty: 0.0,
          includeThoughts: true,
        },
      });
    } catch (error) {
      this.context.error(
        `Error creating chat session: ${error.message}`,
        {
          error,
          errorStack: error?.stack,
          historyLength: Array.isArray(history) ? history.length : typeof history,
          modelName: this.model?.name,
          personaId: this.chatState?.personaId,
          userId: this.chatState?.user?._id,
          hasTools: Array.isArray(this.chatState?.tools),
          toolCount: Array.isArray(this.chatState?.tools) ? this.chatState.tools.length : 'n/a',
        },
        "GoogleAIService.createChatSession"
      );

      // Return null instead of throwing to allow fallback handling
      return null;
    }
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
    return this.createStreamingEvent(
      StreamingEventType.TOKEN,
      tokenData,
      sessionId,
      sessionId
    ) as TokenStreamingEvent;
  }

  /**
   * Create a reasoning/thinking streaming event
   */
  private createReasoningEvent(
    content: string,
    delta: string,
    position: number,
    isComplete: boolean = false,
    sessionId?: string
  ): ReasoningStreamingEvent {
    const data: AITokenStreamingData = {
      content,
      delta,
      position,
      isComplete,
    };
    return this.createStreamingEvent(
      StreamingEventType.REASONING,
      data,
      sessionId,
      sessionId
    ) as ReasoningStreamingEvent;
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
    // Ensure we have a valid ID - if none provided, generate one
    const toolCallId = id || new ObjectId().toString();

    const toolData: AIToolCallStreamingData = {
      id: toolCallId,
      name,
      arguments: toolArguments,
      isComplete,
      result,
    };

    return this.createStreamingEvent(
      StreamingEventType.TOOL_CALL,
      toolData,
      sessionId,
      sessionId
    ) as ToolCallStreamingEvent;
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
    return this.createStreamingEvent(
      StreamingEventType.ERROR,
      errorData,
      sessionId
    ) as ErrorStreamingEvent;
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
    return this.createStreamingEvent(
      StreamingEventType.COMPLETE,
      completionData,
      sessionId,
      sessionId
    ) as CompletionStreamingEvent;
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
   * Process function calls and emit tool call events
   */
  private async *processFunctionCalls(
    functionCalls: any[],
    sessionId?: string
  ): AsyncIterable<AIStreamingEvent> {
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

  /**ß
   * Add assistant message to chat history
   */
  private addAssistantMessageToHistory(content: string): void {
    if (content) {
      this.chatState.history.push({
        id: new ObjectId(),
        role: "assistant",
        content,
        timestamp: new Date(),
        tool_calls: [],
        tool_results: [],
      } as ReactorConversationHistoryItem);
    }
  }

  private async handleStreamingRequest(args: {
    sessionId: string; // This is the conversation ID (chatSessionId)
    message: string;
    persona: IAIPersona;
    history: ReactorConversationHistory;
    chat: GoogleGenAI.Chat;
    messageId?: string;
  }): Promise<GoogleGenAI.GenerateContentResponse> {
    const { sessionId, message, persona, history, messageId } = args;
    const chat = args.chat;
    const logTag = "GoogleAIService.handleStreamingRequest";

    this.context.log(
      `Streaming request started for session ${sessionId}`,
      { messageLength: message.length, messageId, historyLength: history.length },
      logTag,
    );

    let result: GoogleGenAI.GenerateContentResponse = null;
    let accumulatedText = "";
    let accumulatedReasoning = "";
    let accumulatedFunctionCalls: any[] = [];
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: GoogleGenAI.FinishReason = GoogleGenAI.FinishReason.STOP;
    let modelName = "";

    const response = await chat.sendMessageStream({
      message,
      config: persona.messageConfig,
    });

    for await (const chunk of response) {
      let event: StreamingEvent;

      // Initialize result with the first chunk
      if (result === null) {
        result = chunk;
      }

      // Handle thought/reasoning parts
      if (chunk.candidates?.[0]?.content?.parts) {
        for (const part of chunk.candidates[0].content.parts) {
          if ((part as any).thought && part.text) {
            accumulatedReasoning += part.text;
            const reasoningEvent = this.createReasoningEvent(
              accumulatedReasoning,
              part.text,
              accumulatedReasoning.length,
              false,
              sessionId
            );
            reasoningEvent.messageId = messageId ?? "";
            reasoningEvent.conversationId = sessionId;
            try {
              await this.streamingTransportManager.sendEventToSession(
                sessionId,
                reasoningEvent
              );
            } catch (error) {
              this.context.error(
                `Failed to send reasoning event for session ${sessionId}`,
                { error },
                logTag,
              );
            }
          }
        }
      }

      // Handle text content
      if (chunk.text) {
        accumulatedText += chunk.text;
        event = this.createTokenEvent(
          chunk.text,
          chunk.text,
          accumulatedText.length,
          false,
          sessionId
        );
        event.messageId = messageId ?? "";
        event.conversationId = sessionId;

        try {
          await this.streamingTransportManager.sendEventToSession(
            sessionId,
            event as TokenStreamingEvent
          );
        } catch (error) {
          this.context.error(
            `Failed to send token event for session ${sessionId}`,
            { error },
            logTag,
          );
          throw error;
        }
      }

      // Handle function calls
      if (chunk.functionCalls && chunk.functionCalls.length > 0) {
        for (const functionCall of chunk.functionCalls) {
          const functionCallId = functionCall.id || new ObjectId().toString();

          // Check if we already have this function call
          const existingCallIndex = accumulatedFunctionCalls.findIndex(
            (fc) => fc.id === functionCallId
          );
          if (existingCallIndex >= 0) {
            accumulatedFunctionCalls[existingCallIndex] = {
              ...accumulatedFunctionCalls[existingCallIndex],
              ...functionCall,
              id: functionCallId,
            };
          } else {
            accumulatedFunctionCalls.push({
              ...functionCall,
              id: functionCallId,
            });
          }

          // Only send tool_call events to the client in PROMPT mode.
          // In AUTO mode, the server will execute tools directly.
          const toolApprovalMode = this.chatState?.toolApprovalMode;
          if (toolApprovalMode !== ToolApprovalMode.AUTO) {
            event = this.createToolCallEvent(
              functionCallId,
              functionCall.name,
              JSON.stringify(functionCall.args || {}),
              true,
              undefined,
              sessionId
            );
            event.messageId = messageId ?? "";
            event.conversationId = sessionId;

            try {
              await this.streamingTransportManager.sendEventToSession(
                sessionId,
                event as ToolCallStreamingEvent
              );
            } catch (error) {
              this.context.error(
                `Failed to send tool call event for ${functionCall.name}`,
                { error, sessionId },
                logTag,
              );
              throw error;
            }
          }
        }
      }

      // Handle candidates and metadata
      if (chunk.candidates && chunk.candidates.length > 0) {
        for (const candidate of chunk.candidates) {
          if (candidate.finishReason) {
            finishReason = candidate.finishReason;
          }
        }
      }
    }

    // In AUTO mode with pending tool calls, defer the completion event —
    // the server-side tool execution loop in ReactorConversationService will
    // send the final completion event after all tools have executed.
    const toolApprovalMode = this.chatState?.toolApprovalMode;
    const hasPendingAutoToolCalls =
      toolApprovalMode === ToolApprovalMode.AUTO &&
      accumulatedFunctionCalls.length > 0;

    if (!hasPendingAutoToolCalls) {
      const completionEvent = this.createCompletionEvent(
        accumulatedText,
        {
          totalTokens,
          promptTokens,
          completionTokens,
          finishReason,
          model: modelName,
          thinking: accumulatedReasoning || undefined,
        },
        sessionId
      );
      completionEvent.messageId = messageId ?? "";
      completionEvent.conversationId = sessionId;

      try {
        await this.streamingTransportManager.sendEventToSession(
          sessionId,
          completionEvent
        );
      } catch (error) {
        this.context.error(
          `Failed to send completion event for session ${sessionId}`,
          { error },
          logTag,
        );
        throw error;
      }
    }

    // Update the result with accumulated data
    if (result && result.candidates && result.candidates.length > 0) {
      const candidate = result.candidates[0];

      if (candidate.content && candidate.content.parts) {
        candidate.content.parts = [];
        if (accumulatedText) {
          candidate.content.parts.push({ text: accumulatedText });
        }

        for (const functionCall of accumulatedFunctionCalls) {
          candidate.content.parts.push({ functionCall });
        }
      }

      candidate.finishReason = finishReason;
    }

    // Attach accumulated reasoning for persistence by the caller
    if (accumulatedReasoning) {
      (result as any).__reasoning = accumulatedReasoning;
    }

    return result;
  }

  /**
   * Build a normalized AIChatCompletion from extracted Gemini response data.
   */
  private buildCompletion(
    responseText: string,
    functionCalls: any[],
    finishReason: string = "stop",
  ): AIChatCompletion {
    return {
      id: new ObjectId(),
      object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          content: responseText,
          role: "assistant",
          tool_calls: functionCalls && functionCalls.length > 0
            ? functionCalls.map((func) => ({
                id: new ObjectId().toString(),
                type: "function",
                function: {
                  name: func.name,
                  arguments: func.args,
                },
              }))
            : [],
        },
        finish_reason: finishReason,
      }],
      created: new Date(),
    };
  }

  private async getAIResponse(
    message: string,
    role: "user" | "assistant" | "tool" | "system" = "user",
    messageId?: string
  ): Promise<AIChatCompletion> {
    try {
      // get the persona from the chat state
      const persona: IAIPersona = await this.personaProvider.getPersona(
        this.chatState.personaId
      );

      // Handle tool results differently - add them to history and get next response
      if (role === "tool") {
        // Create a new chat session with updated history
        const chat = await this.createChatSession(this.chatState.history);
        if (!chat) {
          throw new AIProviderError("Failed to create chat session");
        }

        // Send an empty message to get the next response from the AI
        const result = await chat.sendMessage({
          config: persona.messageConfig,
          message: "",
        });

        this.context.log(
          `Received response from Google AI after tool result`,
          { result: JSON.stringify(result, null, 2) },
          "GoogleAIService.getAIResponse"
        );

        // Validate and extract response
        if (!result || typeof result !== "object") {
          throw new AIProviderError(
            "Invalid response from Google AI: result is not an object"
          );
        }
        if (
          !Array.isArray(result.candidates) ||
          result.candidates.length === 0
        ) {
          throw new AIProviderError("No candidates returned from Google AI");
        }
        const candidate = result.candidates[0];
        const { responseText, functionCalls } =
          this.extractGeminiCandidate(candidate);

        return this.buildCompletion(responseText, functionCalls);
      }

      // Handle user messages
      if (role === "user") {
        // Create a chat session with history
        const chat = await this.createChatSession(this.chatState.history);
        if (!chat) {
          throw new AIProviderError("Failed to create chat session");
        }

        // Send the message and get response
        this.context.log(
          `Sending message to Google AI: ${message}`,
          {},
          "GoogleAIService.getAIResponse"
        );

        let result: GoogleGenAI.GenerateContentResponse;
        if (this.streamingMode === StreamingMode.SSE) {
          result = await this.handleStreamingRequest({
            sessionId: this.chatState.id,
            message,
            persona: this.chatState.persona,
            history: this.chatState.history,
            chat: chat,
            messageId,
          });
        } else {
          result = await chat.sendMessage({
            config: persona.messageConfig,
            message,
          });
        }

        this.context.log(
          `Received response from Google AI`,
          { result: JSON.stringify(result, null, 2) },
          "GoogleAIService.getAIResponse"
        );

        // Improved Gemini response validation and extraction
        if (!result || typeof result !== "object") {
          this.context.error(
            "Invalid response from Google AI: result is not an object",
            { result },
            "GoogleAIService.getAIResponse"
          );
          throw new AIProviderError(
            "I received an invalid response from the AI service. Please try again."
          );
        }

        if (
          !Array.isArray(result.candidates) ||
          result.candidates.length === 0
        ) {
          this.context.error(
            "No candidates returned from Google AI",
            { result },
            "GoogleAIService.getAIResponse"
          );
          throw new AIProviderError(
            "I didn't receive a proper response from the AI service. Please try again."
          );
        }

        const candidate = result.candidates[0];

        try {
          const { responseText, functionCalls } =
            this.extractGeminiCandidate(candidate);

          if (functionCalls.length > 0) {
            this.context.log(
              `Function/tool call detected in Gemini response`,
              { functionCalls },
              "GoogleAIService.getAIResponse"
            );
          }

          // we add the user conversation history item after the
          // AI response, because we derive the history from the
          // chat state and we pass the user message to the AI which
          // sees it as part of the conversation. So if we added the
          // user message before the AI response, the user message
          // would already be in the history and the AI would see it as part of the conversation.
          const userConversationHistoryItem: ReactorConversationHistoryItem = {
            id: new ObjectId(),
            role: "user",
            content: message,
            timestamp: new Date(),
            tool_results: [],
          };

          // Add user message to history
          this.chatState.history.push(userConversationHistoryItem);

          return this.buildCompletion(responseText, functionCalls);
        } catch (extractError) {
          this.context.error(
            `Error extracting Gemini candidate: ${extractError.message}`,
            { candidate, error: extractError },
            "GoogleAIService.getAIResponse"
          );

          // Return a fallback response instead of throwing
          const userConversationHistoryItem: ReactorConversationHistoryItem = {
            id: new ObjectId(),
            role: "user",
            content: message,
            timestamp: new Date(),
            tool_results: [],
          };

          this.chatState.history.push(userConversationHistoryItem);

          return this.buildCompletion(
            "I encountered an issue processing the response. Let me try to help you in a different way.",
            [],
          );
        }
      }

      // Handle other roles (assistant, system) - just add to history without getting response
      const historyItem = {
        id: new ObjectId(),
        role,
        content: message,
        timestamp: new Date(),
        tool_results: [],
      } as ReactorConversationHistoryItem;

      this.chatState.history.push(historyItem);

      // Return empty completion for non-user/tool messages
      return this.buildCompletion("", []);
    } catch (error) {
      this.context.error(
        `Error in getAIResponse: ${error.message ?? error.toString()}`,
        { error },
        "GoogleAIService.getAIResponse"
      );
      throw error;
    }
  }

  private extractGeminiCandidate(candidate: any): {
    responseText: string;
    functionCalls: any[];
  } {
    if (!candidate || typeof candidate !== "object") {
      throw new AIProviderError("Invalid candidate in Google AI response");
    }

    // Handle special finish reasons that indicate issues
    if (candidate.finishReason) {
      switch (candidate.finishReason) {
        case "UNEXPECTED_TOOL_CALL":
          this.context.warn(
            "Gemini encountered an unexpected tool call - will retry",
            { candidate },
            "GoogleAIService.extractGeminiCandidate"
          );
          // Throw a retryable error instead of returning fallback
          throw new AIProviderError("UNEXPECTED_TOOL_CALL");

        case "MALFORMED_FUNCTION_CALL":
          this.context.warn(
            "Gemini encountered a malformed function call - will retry",
            { candidate },
            "GoogleAIService.extractGeminiCandidate"
          );
          // Throw a retryable error instead of returning fallback
          throw new AIProviderError("MALFORMED_FUNCTION_CALL");

        case "SAFETY":
          this.context.warn(
            "Gemini response blocked by safety filters",
            { candidate },
            "GoogleAIService.extractGeminiCandidate"
          );
          return {
            responseText:
              "I'm unable to provide a response due to safety considerations. Please try rephrasing your question.",
            functionCalls: [],
          };

        case "RECITATION":
          this.context.warn(
            "Gemini response blocked due to recitation concerns",
            { candidate },
            "GoogleAIService.extractGeminiCandidate"
          );
          return {
            responseText:
              "I'm unable to provide that specific information. Let me help you with a different approach.",
            functionCalls: [],
          };

        case "OTHER":
          this.context.warn(
            "Gemini response finished with OTHER reason - will retry",
            { candidate },
            "GoogleAIService.extractGeminiCandidate"
          );
          // Throw a retryable error for OTHER finish reasons
          throw new AIProviderError("OTHER_FINISH_REASON");
      }
    }

    // Check if content field exists
    if (!candidate.content) {
      this.context.warn(
        "Candidate missing content field - will retry",
        { candidate, finishReason: candidate.finishReason },
        "GoogleAIService.extractGeminiCandidate"
      );
      // Throw a retryable error for missing content
      throw new AIProviderError("MISSING_CONTENT_FIELD");
    }

    if (typeof candidate.content !== "object") {
      this.context.warn(
        "Candidate content is not an object - will retry",
        { candidate },
        "GoogleAIService.extractGeminiCandidate"
      );
      // Throw a retryable error for malformed content
      throw new AIProviderError("MALFORMED_CONTENT");
    }

    let responseText = "";
    let functionCalls: any[] = [];

    // Extract content from parts
    if (
      Array.isArray(candidate.content.parts) &&
      candidate.content.parts.length > 0
    ) {
      for (const part of candidate.content.parts) {
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        }
        if (part.text) {
          responseText += part.text;
        }
      }
    }

    // If no content was extracted, check if this is a valid terminal response
    if (functionCalls.length === 0 && !responseText.trim()) {
      // A STOP finish reason with empty text is valid — the model is done
      // (e.g. after processing tool results with nothing more to say)
      if (candidate.finishReason === "STOP") {
        return { responseText: "", functionCalls: [] };
      }

      this.context.warn(
        "No text or function call found in Gemini candidate response - will retry",
        { candidate },
        "GoogleAIService.extractGeminiCandidate"
      );
      // Throw a retryable error for empty responses
      throw new AIProviderError("EMPTY_RESPONSE");
    }

    return { responseText: responseText.trim(), functionCalls };
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
      persistState = true, // Default to true for backward compatibility
      streamingMode = StreamingMode.NONE,
    } = params;

    const maxRetries = 2;
    let lastError: any;
    this.streamingMode = streamingMode;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Initialize if needed
        if (
          !this.ai ||
          !this.model ||
          (chatSessionId && this.chatState?.id !== chatSessionId)
        ) {
          const persona = this.personaProvider.getPersona(personaId);
          if (!persona) {
            throw new AIProviderError(`Persona ${personaId} not found`);
          }
          await this.initialize(chatSessionId, persona);
        }

        // Modify message on retry to potentially avoid the same error
        const modifiedMessage =
          attempt > 1
            ? this.modifyMessageForRetry(message, lastError)
            : message;

        const messageId = new ObjectId();
        // Get response from AI
        const response = await this.getAIResponse(
          modifiedMessage,
          role,
          messageId.toString()
        );

        // Add AI response to history
        if (response.choices && response.choices.length > 0) {
          this.chatState.history.push({
            id: messageId,
            timestamp: new Date(),
            // @ts-ignore
            tool_calls: response.choices[0].message.tool_calls ?? [],
            tool_results: [],
            role: "assistant",
            content: response.choices[0].message.content,
          });
        }

        // Only persist chat state if explicitly requested
        // This prevents duplicate persistence when called from ReactorConversationService
        if (persistState) {
          await this.persistChatState();
        }

        return response;
      } catch (error: any) {
        lastError = error;

        // Check if this is a retryable error
        const isRetryable = this.isRetryableError(error);

        if (attempt < maxRetries && isRetryable) {
          this.context.warn(
            `Retry attempt ${attempt} for Google AI chat (${error.message})`,
            { error, attempt, maxRetries, isRetryable },
            "GoogleAIService.chat"
          );

          // Wait before retry with exponential backoff
          const backoffDelay = Math.pow(2, attempt) * 1000;
          this.context.log(
            `Waiting ${backoffDelay}ms before retry attempt ${attempt + 1}`,
            { backoffDelay, attempt },
            "GoogleAIService.chat"
          );
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          continue;
        }

        // If not retryable or max retries reached, break and throw
        break;
      }
    }

    // If we get here, all retries failed
    this.context.error(
      `Error in chat after ${maxRetries} attempts: ${
        lastError?.message ?? lastError?.toString()
      }`,
      { error: lastError, params },
      "GoogleAIService.chat"
    );

    // Return a graceful error response instead of throwing
    return {
      id: new ObjectId(),
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            content:
              "I'm experiencing some technical difficulties right now. Please try again in a moment, or rephrase your question.",
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
   * Modify the message on retry to potentially avoid the same error
   */
  private modifyMessageForRetry(message: string, lastError: any): string {
    const errorMessage = lastError?.message?.toLowerCase() || "";

    // For tool call related errors, try to simplify the request
    if (
      errorMessage.includes("unexpected_tool_call") ||
      errorMessage.includes("malformed_function_call")
    ) {
      this.context.log(
        "Modifying message for retry to avoid tool call issues",
        { originalMessage: message, error: lastError.message },
        "GoogleAIService.modifyMessageForRetry"
      );

      // Add a prefix to encourage a simpler response
      return `Please provide a simple, direct response to: ${message}`;
    }

    // For other errors, just return the original message
    return message;
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: any): boolean {
    if (!error) return false;

    const errorMessage = error.message?.toLowerCase() || "";
    const errorCode = error.code?.toLowerCase() || "";

    // Retryable errors
    const retryablePatterns = [
      "unexpected_tool_call",
      "malformed_function_call",
      "missing_content_field",
      "malformed_content",
      "empty_response",
      "other_finish_reason",
      "rate limit",
      "timeout",
      "network",
      "connection",
      "temporary",
      "service unavailable",
      "internal server error",
      "bad gateway",
      "gateway timeout",
    ];

    return retryablePatterns.some(
      (pattern) => errorMessage.includes(pattern) || errorCode.includes(pattern)
    );
  }

  // chatAudio and speech2Text are inherited from AIProviderBase
  // which delegates to the SpeechService

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

  setStreamingTransportManager(
    streamingTransportManager: StreamingTransportManager
  ) {
    this.streamingTransportManager = streamingTransportManager;
  }

  toString(includeVersion?: boolean): string {
    return `GoogleAIService${includeVersion ? "@1.0.0" : ""}`;
  }

  description = "Service for managing Google AI API requests";
  tags = ["ai", "google", "gemini"];
  nameSpace = "reactor";
  name = "GoogleAIService";
  version = "1.0.0";
}

export default GoogleAIService;
