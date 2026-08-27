import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import GoogleGenAI, {
  FunctionCallingConfigMode,
  FunctionDeclaration,
  FunctionResponse,
  Modality,
  Type,
} from "@google/genai";
import https from "https";
import fs from "fs";
import {
  AIChatParams,
  AIAudioChatParams,
  AIChatCompletion,
  AIChatCompletionUsage,
  AIImage,
  AIImageGenerationParams,
  AIListResponse,
} from "../../../types/model.types";
import {
  AIStreamingCapabilities,
  AIStreamingEventType,
  IAIPersona,
} from "../../../types/service.types";
import AIPersonaProvider from "../AIPersonaProvider";
import AIProviderBase from "./AIProviderBase";
import { AIProviderError } from "./AIProviderError";
import {
  toGeminiConfig,
  structuredOutputDisablesTools,
} from "./providerConfigTranslators";
import { ReactorProviderConfig } from "../../../types/model.types";
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
  ErrorStreamingEvent,
  StreamingMode,
} from "../types/streaming.types";
import { StreamingEventFactory, StreamingEventIds } from "../streaming/StreamingEventFactory";
import { ChatSessionResourceManager } from "../ChatSessionResourceManager";
import resolveImageUrls from "@reactory/server-modules/reactory-reactor/utils/resolveImageUrls";
import { TokenPacer } from "../streaming/TokenPacer";
import { StreamingSessionManager } from "../StreamingSessionManager";
import { StreamingTransportManager } from "../StreamingTransportManager";
import { IReactorProviderService } from "../../../types/service.types";

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
    {
      id: "reactor.ReactorProviderService@1.0.0",
      alias: "providerService",
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
  providerService!: IReactorProviderService;
  models: GoogleGenAI.Pager<GoogleGenAI.Model> | null = null;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    super(props, context);
    this.streamingMode = props.streamingMode || StreamingMode.NONE;
  }

  /**
   * Log to both the context logger and the per-session file logger.
   */
  private slog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    // Never let a log call be the reason a request fails — see the note on
    // ReactorConversationService.sessionLog.
    try {
      const safeLevel = typeof (this.context as any)?.[level] === 'function' ? level : 'error';
      this.context[safeLevel](`[GoogleAI] ${message}`, meta);
    } catch { /* swallow */ }
    const chatId = this.chatState?.id?.toString?.() || (this.chatState as any)?._id?.toString?.();
    if (chatId) {
      ChatSessionResourceManager.forSession(chatId)?.[level](`[GoogleAI] ${message}`, meta);
    }
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

  /** Cached model config from the provider registry, resolved during createChatSession */
  private _resolvedModelConfig: { supportedTools?: string[]; capabilities?: string[] } | null = null;

  /**
   * Resolve the model config from the provider registry.
   * Uses chatState.modelId + persona.providerId to look up the YAML config.
   */
  private async resolveModelConfig(): Promise<{ supportedTools?: string[]; capabilities?: string[] }> {
    if (this._resolvedModelConfig) return this._resolvedModelConfig;
    const modelId = this.chatState?.modelId || this.model?.name || "";
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
    } catch (err) {
      this.slog("warn", `Failed to resolve model config for ${modelId}`, { error: err });
    }
    return {};
  }

  /** Check if the active model supports function calling based on provider config */
  private async modelSupportsFunctionCalling(): Promise<boolean> {
    const config = await this.resolveModelConfig();
    return config.supportedTools?.includes("function-calling") ?? false;
  }

  /** Check if the active model supports image generation via responseModalities */
  private async isImageGenerationModel(): Promise<boolean> {
    const config = await this.resolveModelConfig();
    return config.capabilities?.includes("image-generation") ?? false;
  }

  protected async initializeClient(persona: IAIPersona): Promise<void> {
    // Reset cached model config for the new session/model
    this._resolvedModelConfig = null;
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
    // Gemini function calling does not support freeform/unstructured objects.
    // When a parameter is typed as "object" but has no "properties" defined,
    // convert it to a STRING type so the model emits a JSON string instead.
    // The consuming code already handles JSON-string-to-object parsing.
    if (
      value.type &&
      this.getTypeEnum(value.type) === Type.OBJECT &&
      !value.properties
    ) {
      const desc = value.description ?? "";
      return {
        type: Type.STRING,
        description: desc
          ? `${desc} (Provide as a JSON string)`
          : "A JSON object provided as a string",
      };
    }

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
          this.getTypeEnum(item.type) === Type.OBJECT
        ) {
          if (item.properties) {
            return {
              ...item,
              properties: this.toPropertiesRecord(item.properties),
            };
          }
          // Freeform object items without properties — convert to string
          return {
            type: Type.STRING,
            description: item.description
              ? `${item.description} (Provide as a JSON string)`
              : "A JSON object provided as a string",
          };
        }
        return item;
      });
    } else if (
      items.type &&
      this.getTypeEnum(items.type) === Type.OBJECT
    ) {
      if (items.properties) {
        return {
          ...items,
          properties: this.toPropertiesRecord(items.properties),
        };
      }
      // Freeform object items without properties — convert to string
      return {
        type: Type.STRING,
        description: items.description
          ? `${items.description} (Provide as a JSON string)`
          : "A JSON object provided as a string",
      };
    } else {
      return items;
    }
  }

  private async getAITools(): Promise<GoogleGenAI.ToolListUnion> {
    const functions: FunctionDeclaration[] = [];
    let tools: MacroToolDefinition[] = (this.chatState?.tools ?? []) as MacroToolDefinition[];

    // Dynamic fallback: if persisted tools are empty, fetch from macroService
    if (!Array.isArray(tools) || tools.length === 0) {
      if (this.macroService && this.chatState?.personaId) {
        try {
          const macros = await this.macroService.listMacrosForPersona(this.chatState.personaId);
          const dynamicTools: MacroToolDefinition[] = [];
          macros.forEach((macro: MacroComponentDefinition<unknown>) => {
            if (macro.tools) {
              macro.tools.forEach((tool: MacroToolDefinition) => {
                if (tool.type === "function") {
                  dynamicTools.push(tool);
                }
              });
            }
          });
          tools = dynamicTools;
        } catch (err) {
          this.context.warn(
            `getAITools: Failed to fetch tools from macroService, using empty list`,
            { error: err },
            "GoogleAIService.getAITools"
          );
          tools = [];
        }
      }
    }

    if (!Array.isArray(tools)) {
      return [{ functionDeclarations: [] }];
    }

    const seen = new Set<string>();
    tools.forEach((tool: MacroToolDefinition) => {
      if (!tool.function?.name || seen.has(tool.function.name)) return;
      seen.add(tool.function.name);
      const functionDeclaration: FunctionDeclaration = {
        name: tool.function.name,
        description: tool.function.description,
        parameters: {
          type: Type.OBJECT,
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

        const functionCallPart: any = {
          functionCall: {
            name: toolCall.function?.name || (toolCall as any).name,
            args: args,
          },
        };
        // Preserve thoughtSignature for Gemini thinking models — the API requires
        // it on functionCall parts when includeThoughts is enabled
        const sig = toolCall.thought_signature || (toolCall as any).thoughtSignature;
        if (sig) {
          functionCallPart.thoughtSignature = sig;
        }
        parts.push(functionCallPart);
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

    // Filter out empty text parts — Google API rejects empty text parts with 400 Bad Request
    const cleanParts = parts.filter((p: any) => {
      if (!p) return false;
      if (p.text !== undefined && typeof p.text === "string" && p.text.trim() === "") return false;
      return true;
    });

    return cleanParts;
  }

  /**
   * Converts an OpenAI-format content item to a Google GenAI Part.
   * Handles plain text strings, {type:'text'} objects, and {type:'image_url'} objects.
   */
  private contentItemToGooglePart(c: any): any | null {
    if (typeof c === "string") {
      return { text: c };
    }
    if (c && typeof c === "object") {
      if (c.type === "image_url" && c.image_url?.url) {
        const url: string = c.image_url.url;
        if (url.startsWith("data:")) {
          // data:<mimeType>;base64,<data>
          const semicolonIdx = url.indexOf(";");
          const commaIdx = url.indexOf(",");
          if (semicolonIdx > 0 && commaIdx > semicolonIdx) {
            const mimeType = url.substring(5, semicolonIdx);
            const data = url.substring(commaIdx + 1);
            return { inlineData: { mimeType, data } };
          }
        }
        // Non-data URL images are not supported as inlineData — skip silently
        return null;
      }
      if (typeof c.text === "string") {
        return { text: c.text };
      }
    }
    return null;
  }

  /**
   * Reads files attached to the current chatState session and converts supported
   * file types (PDFs, images, audio, text) to Google GenAI inlineData parts.
   */
  private getFilePartsForSession(): any[] {
    const fileParts: any[] = [];
    if (!this.chatState?.files || !Array.isArray(this.chatState.files)) {
      return fileParts;
    }

    for (const f of this.chatState.files) {
      const filePath = (f as any).path || (f as any).location;
      if (filePath && fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          // Inline base64 limit: 20MB
          if (stats.size > 0 && stats.size <= 20 * 1024 * 1024) {
            const buf = fs.readFileSync(filePath);
            const base64Data = buf.toString("base64");
            const mimeType = f.mimetype || (filePath.endsWith(".pdf") ? "application/pdf" : "application/octet-stream");
            fileParts.push({
              inlineData: {
                mimeType,
                data: base64Data,
              },
            });
            this.slog("info", `Attached file ${f.filename || f.alias} (${mimeType}, ${stats.size} bytes) as inlineData part to Gemini`);
          } else {
            this.slog("warn", `File ${f.filename || f.alias} exceeds 20MB limit for inlineData (${stats.size} bytes)`);
          }
        } catch (err: any) {
          this.slog("warn", `Failed to read file ${filePath} for inline attachment: ${err.message}`);
        }
      }
    }
    return fileParts;
  }

  /**
   * Converts a string or OpenAI-format content-parts array to Google GenAI Part[].
   */
  private convertMessageToGoogleParts(message: string | any[]): any[] {
    if (typeof message === "string") {
      const str = message.trim();
      return [{ text: str || " " }];
    }
    if (Array.isArray(message)) {
      const parts: any[] = [];
      for (const c of message) {
        const part = this.contentItemToGooglePart(c);
        if (part !== null && (part.text === undefined || (typeof part.text === "string" && part.text.trim() !== ""))) {
          parts.push(part);
        }
      }
      return parts.length > 0 ? parts : [{ text: " " }];
    }
    const str = String(message || "").trim();
    return [{ text: str || " " }];
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
    },
    isLatestUserMessage: boolean = false
  ): any[] {
    const parts = this.convertMessageToGoogleParts(msg.content as string | any[]);
    if (isLatestUserMessage) {
      const fileParts = this.getFilePartsForSession();
      if (fileParts.length > 0) {
        parts.push(...fileParts);
      }
    }
    return parts;
  }

  private async createChatSession(
    history: ReactorConversationHistoryItem[],
    providerConfig?: ReactorProviderConfig,
  ) {
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
      *name*: ${user.firstName}.
      *email*: ${user.email}.
      *id*: ${user._id}.
      *user home folder*: ${path.join(
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

      const lastUserMsgIdx = history.map((m) => m?.role).lastIndexOf("user");

      history.forEach((msg, idx) => {
        if (!msg) {
          this.context.warn(
            `createChatSession: history[${idx}] is null/undefined — skipping`,
            {},
            "GoogleAIService.createChatSession"
          );
          return;
        }

        let googleRole: string;
        let parts: any[] = [];

        if (msg.role === "tool") {
          // Tool result messages MUST be sent as "user" role in Gemini.
          // Gemini expects functionResponse parts under the "user" role.
          googleRole = "user";

          // Extract functionResponse parts from tool_results
          if (msg.tool_results && Array.isArray(msg.tool_results) && msg.tool_results.length > 0) {
            parts = this.getPartsForAssistantMessage(msg);
            // Filter to only functionResponse parts — text content from tool
            // messages is redundant (the actual data is in functionResponse).
            const fnResponseParts = parts.filter((p: any) => p.functionResponse);
            if (fnResponseParts.length > 0) {
              parts = fnResponseParts;
            }
          } else if ((msg as any).tool_call_id && msg.content) {
            // Tool message without tool_results (e.g. client-consolidated result).
            // Wrap content as a functionResponse so Gemini understands it's a tool reply.
            const toolName = (msg as any).tool_name || "unknown_tool";
            let responseBody: any;
            if (typeof msg.content === "string") {
              try {
                responseBody = JSON.parse(msg.content);
              } catch {
                responseBody = { result: msg.content };
              }
            } else {
              responseBody = msg.content;
            }
            if (typeof responseBody !== "object" || responseBody === null) {
              responseBody = { result: responseBody };
            }
            parts = [{
              functionResponse: {
                name: toolName,
                response: responseBody,
              },
            }];
          } else {
            // Fallback: skip tool messages with no useful content
            return;
          }
        } else if (msg.role === "assistant") {
          googleRole = "model";
          parts = this.getPartsForAssistantMessage(msg);
        } else {
          // user, system (system already extracted above, but handle gracefully)
          if (msg.role === "system") return; // system is handled via systemInstruction
          googleRole = "user";
          //@ts-ignore
          parts = this.getPartsForUserMessage(msg, idx === lastUserMsgIdx);
        }

        if (parts.length === 0) {
          return; // Skip empty messages
        }

        // Gemini requires strict user/model role alternation.
        // Merge consecutive same-role messages by appending parts.
        const lastEntry = googleHistory[googleHistory.length - 1];
        if (lastEntry && lastEntry.role === googleRole) {
          lastEntry.parts.push(...parts);
        } else {
          googleHistory.push({ role: googleRole, parts });
        }
      });

      // Gemini requires strict user/model role alternation. If googleHistory ends
      // with a "user" role (e.g. from an interrupted/canceled turn), remove trailing
      // user entries so that sendMessageStream(userMessage) alternates cleanly as model -> user.
      while (googleHistory.length > 0 && googleHistory[googleHistory.length - 1].role === "user") {
        googleHistory.pop();
      }

      // Create chat session with generation config
      const isImageModel = await this.isImageGenerationModel();
      const chatConfig: any = {
        candidateCount: 1,
        systemInstruction,
        temperature: 0.7,
        topP: 1.0,
        frequencyPenalty: 0.0,
        presencePenalty: 0.0,
      };

      // Thinking is not supported on image generation models
      if (!isImageModel) {
        chatConfig.thinkingConfig = {
          includeThoughts: true,
        };
      }

      // Only add tools if the model supports function calling. Gemini does not
      // allow responseSchema together with function-calling tools, so structured
      // output (without an explicit tool choice) suppresses tools for the turn.
      const supportsFunctionCalling = await this.modelSupportsFunctionCalling();
      if (supportsFunctionCalling && !structuredOutputDisablesTools(providerConfig)) {
        const tools = await this.getAITools();
        chatConfig.tools = tools;
        chatConfig.toolConfig = {
          functionCallingConfig: {
            mode: process.env.GOOGLE_AI_FUNCTION_CALLING_CONFIG_MODE || "VALIDATED",
          },
        };
      }

      // Enable image output for image generation models
      if (isImageModel) {
        chatConfig.responseModalities = [Modality.TEXT, Modality.IMAGE];
      }

      // Merge the normalized augmented config last (structured output, sampling,
      // response modalities). Caller-provided values override the defaults above.
      Object.assign(chatConfig, toGeminiConfig(providerConfig));

      return this.ai.chats.create({
        model: this.model.name,
        history: googleHistory,
        config: chatConfig,
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

  /**
   * Handles a streaming Google AI request using TokenPacer + StreamingEventFactory,
   * sending token, reasoning, tool_call, and completion events to the client
   * at a normalised cadence.
   */
  private async handleStreamingRequest(args: {
    sessionId: string;
    message: string | any[];
    persona: IAIPersona;
    history: ReactorConversationHistory;
    chat: GoogleGenAI.Chat;
    messageId?: string;
    /** When true, `message` already contains Google-native Part objects
     *  (e.g. functionResponse parts) and should NOT be run through
     *  convertMessageToGoogleParts. */
    rawParts?: boolean;
  }): Promise<GoogleGenAI.GenerateContentResponse> {
    const { sessionId, message, persona, history, messageId, rawParts } = args;
    const chat = args.chat;
    const logTag = "GoogleAIService.handleStreamingRequest";
    const ids: StreamingEventIds = {
      sessionId,
      conversationId: sessionId,
      messageId: messageId ?? "",
    };

    const messageLength = typeof message === "string" ? message.length : message.length;
    this.slog("info", `Streaming request started for session ${sessionId}`, {
      messageLength, messageId, historyLength: history.length,
    });

    // Resolve per-persona pacing configuration
    const pacerCfg = persona?.config?.streamingPace ?? {};

    let result: GoogleGenAI.GenerateContentResponse = null;
    let latestUsageMetadata: any = null;
    let accumulatedText = "";
    let accumulatedReasoning = "";
    let accumulatedFunctionCalls: any[] = [];
    let accumulatedImages: AIImage[] = [];
    let finishReason: GoogleGenAI.FinishReason = GoogleGenAI.FinishReason.STOP;
    let modelName = "";

    // -- Create pacers for tokens and reasoning --
    // Gemini sends large, infrequent chunks unlike OpenAI's tiny rapid deltas,
    // so we use aggressive defaults to avoid adding artificial latency.
    const tokenPacer = new TokenPacer({
      minChunkSize: 1,
      maxChunkSize: 200,
      targetIntervalMs: 0,
      flushTimeoutMs: 30,
      ...pacerCfg,
      onFlush: async (text) => {
        const event = StreamingEventFactory.createTokenEvent(
          text, accumulatedText.length, ids,
        );
        await this.streamingTransportManager.sendEventToSession(sessionId, event);
      },
    });

    const reasoningPacer = new TokenPacer({
      minChunkSize: 1,
      maxChunkSize: 200,
      targetIntervalMs: 0,
      flushTimeoutMs: 30,
      ...pacerCfg,
      onFlush: async (text) => {
        const event = StreamingEventFactory.createReasoningEvent(
          text, accumulatedReasoning.length, ids,
        );
        await this.streamingTransportManager.sendEventToSession(sessionId, event);
      },
    });

    // Convert message to Google Parts format unless the caller already
    // provided native Google parts (e.g. functionResponse parts from tool results).
    const googleParts = rawParts
      ? (Array.isArray(message) ? message : [message])
      : this.convertMessageToGoogleParts(message);

    try {
      const response = await chat.sendMessageStream({
        message: googleParts,
        config: persona.messageConfig,
      });

      for await (const chunk of response) {
        // Initialize result with the first chunk
        if (result === null) {
          result = chunk;
        }
        if (chunk.usageMetadata) {
          latestUsageMetadata = chunk.usageMetadata;
        }
        this.slog("debug", `Received chunk from Google AI stream`, {
          chunkPreview: JSON.stringify(chunk).substring(0, 200),
          accumulatedTextLength: accumulatedText.length,
          accumulatedReasoningLength: accumulatedReasoning.length,
          accumulatedFunctionCallsCount: accumulatedFunctionCalls.length,
          finishReason,
        });
        // Handle thought/reasoning parts and text content from parts
        let hasThoughtContent = false;
        if (chunk.candidates?.[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            if ((part as any).thought && part.text) {
              // Gemini thinking models send thought content as text parts with thought: true
              accumulatedReasoning += part.text;
              reasoningPacer.add(part.text);
              hasThoughtContent = true;
            }
          }
        }

        // Handle text content — feed into pacer.
        // When thought parts are present, extract only non-thought text to
        // avoid double-counting thought content in the regular text stream.
        if (hasThoughtContent && chunk.candidates?.[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            if (!(part as any).thought && part.text) {
              accumulatedText += part.text;
              tokenPacer.add(part.text);
            }
          }
        } else if (chunk.text) {
          accumulatedText += chunk.text;
          tokenPacer.add(chunk.text);
        }

        // Handle inline image data from image generation models
        if (chunk.candidates?.[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            if (part.inlineData && part.inlineData.mimeType?.startsWith("image/")) {
              accumulatedImages.push({
                b64_json: part.inlineData.data,
                mimeType: part.inlineData.mimeType,
              });
            }
          }
        }

        // Handle function calls — extract from raw parts to preserve thoughtSignature
        const rawParts = chunk.candidates?.[0]?.content?.parts ?? [];
        const functionCallParts = rawParts.filter((p: any) => p.functionCall);
        if (functionCallParts.length > 0) {
          for (const part of functionCallParts) {
            const functionCall = part.functionCall;
            const functionCallId = functionCall.id || new ObjectId().toString();

            const existingCallIndex = accumulatedFunctionCalls.findIndex(
              (fc) => fc.id === functionCallId,
            );
            if (existingCallIndex >= 0) {
              accumulatedFunctionCalls[existingCallIndex] = {
                ...accumulatedFunctionCalls[existingCallIndex],
                ...functionCall,
                id: functionCallId,
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              };
            } else {
              accumulatedFunctionCalls.push({
                ...functionCall,
                id: functionCallId,
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              });
            }

            // Send tool_call events to the client in non-AUTO modes so the
            // client can prompt the user or auto-execute based on approval mode.
            // isComplete must be false here — the tool call data is fully assembled
            // but the tool has NOT been executed yet. The client uses isComplete to
            // distinguish "pending approval/execution" (false) from "already executed
            // by the server" (true, used in AUTO mode).
            const toolApprovalMode = this.chatState?.toolApprovalMode;
            if (toolApprovalMode !== ToolApprovalMode.AUTO) {
              const event = StreamingEventFactory.createToolCallEvent(
                functionCallId,
                functionCall.name,
                JSON.stringify(functionCall.args || {}),
                false,
                undefined,
                ids,
              );
              try {
                await this.streamingTransportManager.sendEventToSession(sessionId, event);
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

        // Handle finish reason from candidates
        if (chunk.candidates && chunk.candidates.length > 0) {
          for (const candidate of chunk.candidates) {
            if (candidate.finishReason) {
              finishReason = candidate.finishReason;
            }
          }
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

      this.context.error(
        `Streaming failed for session ${sessionId}`,
        { error: streamError },
        logTag,
      );
      throw new AIProviderError(
        `AI provider stream interrupted: ${streamError.message || streamError.toString()}`,
      );
    } finally {
      tokenPacer.destroy();
      reasoningPacer.destroy();
    }

    // Defer completion event in AUTO mode with pending tool calls
    const toolApprovalMode = this.chatState?.toolApprovalMode;
    const hasPendingAutoToolCalls =
      toolApprovalMode === ToolApprovalMode.AUTO &&
      accumulatedFunctionCalls.length > 0;
          
    this.slog("debug", `Streaming completion decision`, {
      toolApprovalMode,
      hasPendingAutoToolCalls,
      accumulatedTextLength: accumulatedText.length,
      accumulatedTextPreview: accumulatedText ? accumulatedText.substring(0, 100) : '(empty)',
      accumulatedFunctionCallsCount: accumulatedFunctionCalls.length,
      finishReason,
      sessionId,
    });

    if (!hasPendingAutoToolCalls) {
      // If the stream terminated with a retryable failure (e.g. a malformed
      // function call), do NOT emit a completion event — it would be an empty,
      // dead-end message and the client would render it before the retry lands.
      // Throw instead so chat()'s retry loop re-prompts the model with coaching;
      // the successful attempt emits the real completion event. If every retry
      // is exhausted, chat()'s fallback emits a terminal event so we never hang.
      if (finishReason && this.isRetryableFinishReason(finishReason)) {
        this.context.warn(
          `Streaming response finished with retryable reason ${finishReason} - will retry`,
          { sessionId, finishReason },
          logTag,
        );
        throw new AIProviderError(finishReason, { finishReason });
      }

      // Save any accumulated images to disk and replace base64 with CDN URLs
      let completionImages: typeof accumulatedImages | undefined =
        accumulatedImages.length > 0 ? accumulatedImages : undefined;
      if (completionImages && completionImages.length > 0) {
        const logger = ChatSessionResourceManager.forSession(sessionId);
        if (logger) {
          completionImages = logger.saveImages(completionImages);
        }
      }

      const completionEvent = StreamingEventFactory.createCompletionEvent(
        accumulatedText,
        finishReason || "stop",
        accumulatedReasoning || undefined,
        ids,
        resolveImageUrls(completionImages),
      );
      try {
        await this.streamingTransportManager.sendEventToSession(sessionId, completionEvent);
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

        for (const img of accumulatedImages) {
          candidate.content.parts.push({
            inlineData: { data: img.b64_json, mimeType: img.mimeType || "image/png" },
          });
        }

        for (const functionCall of accumulatedFunctionCalls) {
          const { thoughtSignature, id, ...cleanFunctionCall } = functionCall;
          const part: any = { functionCall: cleanFunctionCall };
          if (thoughtSignature) {
            part.thoughtSignature = thoughtSignature;
          }
          if (id) {
            part._toolCallId = id;
          }
          candidate.content.parts.push(part);
        }
      }

      candidate.finishReason = finishReason;
    }

    // Attach accumulated reasoning for persistence by the caller
    if (accumulatedReasoning) {
      (result as any).__reasoning = accumulatedReasoning;
    }

    // Attach accumulated images for persistence by the caller
    if (accumulatedImages.length > 0) {
      (result as any).__images = accumulatedImages;
    }

    // Attach usage metadata for the caller to pass through buildCompletion
    const finalUsageMetadata = latestUsageMetadata || result?.usageMetadata;
    if (finalUsageMetadata) {
      (result as any).__usageMetadata = finalUsageMetadata;
    }

    this.slog("info", `Streaming request completed`, {
      accumulatedTextLength: accumulatedText.length,
      accumulatedTextPreview: accumulatedText ? accumulatedText.substring(0, 150) : '(empty)',
      accumulatedFunctionCallsCount: accumulatedFunctionCalls.length,
      finishReason,
      hasCandidateParts: result?.candidates?.[0]?.content?.parts?.length || 0,
    });

    return result;
  }

  /**
   * Build a normalized AIChatCompletion from extracted Gemini response data.
   */
  private extractUsageFromResponse(result: GoogleGenAI.GenerateContentResponse | null): AIChatCompletionUsage | undefined {
    const meta = (result as any)?.__usageMetadata || result?.usageMetadata;
    if (!meta) return undefined;
    return {
      promptTokens: meta.promptTokenCount || 0,
      completionTokens: meta.candidatesTokenCount || 0,
      totalTokens: meta.totalTokenCount || 0,
    };
  }

  private buildCompletion(
    responseText: string,
    functionCalls: any[],
    finishReason: string = "stop",
    reasoning?: string,
    images?: AIImage[],
    usage?: AIChatCompletionUsage,
  ): AIChatCompletion {
    const completion: any = {
      id: new ObjectId(),
      object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          content: responseText,
          role: "assistant",
          tool_calls: functionCalls && functionCalls.length > 0
            ? functionCalls.map((func) => ({
                id: func.id || new ObjectId().toString(),
                type: "function",
                function: {
                  name: func.name,
                  arguments: typeof func.args === "string"
                    ? func.args
                    : JSON.stringify(func.args ?? {}),
                },
                status: "pending",
                ...(func.thoughtSignature ? { thought_signature: func.thoughtSignature } : {}),
              }))
            : [],
        },
        finish_reason: finishReason,
      }],
      created: new Date(),
    };
    if (reasoning) {
      completion.__reasoning = reasoning;
    }
    if (images && images.length > 0) {
      completion.images = images;
    }
    if (usage) {
      completion.usage = usage;
    }
    return completion;
  }

  private async getAIResponse(
    message: string | any[],
    role: "user" | "assistant" | "tool" | "system" = "user",
    messageId?: string,
    providerConfig?: ReactorProviderConfig,
  ): Promise<AIChatCompletion> {
    try {
      // Use the persona already resolved and stored in chatState by initialize().
      const persona: IAIPersona = this.chatState.persona;
      if (!persona) {
        throw new AIProviderError(
          `No persona available in chat state for personaId ${this.chatState.personaId}`,
        );
      }

      // Handle tool results differently - add them to history and get next response
      if (role === "tool") {
        // Split history: everything up to the last tool result messages goes into
        // the chat session history, and the tool result messages themselves are sent
        // as the next user turn (functionResponse parts). This avoids sending an
        // empty message after tool results which confuses Gemini.
        const historyForSession: ReactorConversationHistoryItem[] = [];
        const pendingToolResults: any[] = [];

        // Walk backwards from the end to collect trailing tool messages
        let i = this.chatState.history.length - 1;
        while (i >= 0 && this.chatState.history[i]?.role === "tool") {
          pendingToolResults.unshift(this.chatState.history[i]);
          i--;
        }
        // Everything before the trailing tool messages is session history
        for (let j = 0; j <= i; j++) {
          historyForSession.push(this.chatState.history[j]);
        }

        const chat = await this.createChatSession(historyForSession, providerConfig);
        if (!chat) {
          throw new AIProviderError("Failed to create chat session");
        }

        // Build functionResponse parts from the pending tool results
        const functionResponseParts: any[] = [];
        for (const toolMsg of pendingToolResults) {
          if (toolMsg.tool_results && Array.isArray(toolMsg.tool_results) && toolMsg.tool_results.length > 0) {
            for (const tr of toolMsg.tool_results) {
              let response = tr?.content ?? tr?.result ?? tr;
              if (typeof response === "string") {
                try { response = JSON.parse(response); } catch { response = { result: response }; }
              }
              if (typeof response !== "object" || response === null) {
                response = { result: response };
              }
              functionResponseParts.push({
                functionResponse: {
                  name: tr.tool_name || tr.name || (toolMsg as any).tool_name || "unknown_tool",
                  response,
                },
              });
            }
          } else if ((toolMsg as any).tool_call_id && toolMsg.content) {
            const toolName = (toolMsg as any).tool_name || "unknown_tool";
            let responseBody: any;
            if (typeof toolMsg.content === "string") {
              try { responseBody = JSON.parse(toolMsg.content); } catch { responseBody = { result: toolMsg.content }; }
            } else {
              responseBody = toolMsg.content;
            }
            if (typeof responseBody !== "object" || responseBody === null) {
              responseBody = { result: responseBody };
            }
            functionResponseParts.push({
              functionResponse: { name: toolName, response: responseBody },
            });
          }
        }

        // Send the tool results as the next user message.
        // Use streaming when in SSE mode so the client receives token events
        // for the AI's follow-up response (e.g. in AUTO mode after server-side
        // tool execution). Without streaming, the client only gets a single
        // completion event and may not render the content.
        const toolMessage = functionResponseParts.length > 0 ? functionResponseParts : "";
        let result: GoogleGenAI.GenerateContentResponse;
        if (this.streamingMode === StreamingMode.SSE) {
          result = await this.handleStreamingRequest({
            sessionId: this.chatState.id,
            message: toolMessage,
            persona,
            history: historyForSession,
            chat,
            messageId,
            rawParts: true, // functionResponseParts are already Google-native
          });
        } else {
          result = await chat.sendMessage({
            config: persona.messageConfig,
            message: toolMessage,
          });
        }

        this.context.log(
          `Received response from Google AI after tool result`,
          { resultPreview: JSON.stringify(result, null, 2).substring(0, 500) },
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
        const { responseText, functionCalls, reasoning, images } =
          this.extractGeminiCandidate(candidate);

        return this.buildCompletion(responseText, functionCalls, undefined, reasoning, images, this.extractUsageFromResponse(result));
      }

      // Handle user messages
      if (role === "user") {
        // Create a chat session with history
        const chat = await this.createChatSession(this.chatState.history, providerConfig);
        if (!chat) {
          throw new AIProviderError("Failed to create chat session");
        }

        // Send the message and get response
        this.context.log(
          `Sending message to Google AI`,
          {},
          "GoogleAIService.getAIResponse"
        );

        let result: GoogleGenAI.GenerateContentResponse;
        const isImageModel = await this.isImageGenerationModel();
        if (this.streamingMode === StreamingMode.SSE && !isImageModel) {
          result = await this.handleStreamingRequest({
            sessionId: this.chatState.id,
            message,
            persona,
            history: this.chatState.history,
            chat: chat,
            messageId,
          });
        } else {
          // Image generation models do not support streaming — use sendMessage
          // and emit SSE events manually so the client receives the result.
          result = await chat.sendMessage({
            config: persona.messageConfig,
            message: this.convertMessageToGoogleParts(message as string | any[]),
          });

          if (this.streamingMode === StreamingMode.SSE && isImageModel) {
            const sessionId = this.chatState.id!;
            const ids: StreamingEventIds = {
              sessionId,
              conversationId: sessionId,
              messageId: messageId ?? "",
            };
            const candidate = result.candidates?.[0];
            const extracted = candidate ? this.extractGeminiCandidate(candidate) : null;

            // Save images to disk and replace base64 with CDN URLs
            let sseImages = extracted?.images && extracted.images.length > 0
              ? extracted.images
              : undefined;
            if (sseImages && sseImages.length > 0) {
              const logger = ChatSessionResourceManager.forSession(sessionId);
              if (logger) {
                sseImages = logger.saveImages(sseImages);
              }
            }

            const completionEvent = StreamingEventFactory.createCompletionEvent(
              extracted?.responseText || "",
              candidate?.finishReason || "stop",
              extracted?.reasoning || undefined,
              ids,
              resolveImageUrls(sseImages),
            );
            await this.streamingTransportManager.sendEventToSession(sessionId, completionEvent);
          }
        }

        this.context.log(
          `Received response from Google AI`,
          { resultPreview: JSON.stringify(result, null, 2).substring(0, 500) },
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
          const { responseText, functionCalls, reasoning, images } =
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

          this.slog("info", `buildCompletion result`, {
            responseTextLength: responseText.length,
            responseTextPreview: responseText ? responseText.substring(0, 150) : '(empty)',
            functionCallsCount: functionCalls.length,
            imagesCount: images.length,
            streamingMode: this.streamingMode,
          });

          return this.buildCompletion(responseText, functionCalls, undefined, reasoning, images, this.extractUsageFromResponse(result));
        } catch (extractError) {
          this.context.error(
            `Error extracting Gemini candidate: ${extractError.message}`,
            { candidate, error: extractError },
            "GoogleAIService.getAIResponse"
          );

          // Retryable extraction errors (MALFORMED_FUNCTION_CALL,
          // UNEXPECTED_TOOL_CALL, EMPTY_RESPONSE, …) MUST propagate so chat()'s
          // retry loop can re-prompt the model with corrective coaching.
          // Swallowing them here — as this path previously did — defeats the
          // retry mechanism entirely and returns a dead-end fallback to the
          // user. We deliberately do NOT push the user turn to history on a
          // failed attempt, so the retry rebuilds a clean chat session.
          if (this.isRetryableError(extractError)) {
            throw extractError;
          }

          // Non-retryable extraction failure — return a graceful fallback.
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
    reasoning: string;
    images: AIImage[];
  } {
    if (!candidate || typeof candidate !== "object") {
      throw new AIProviderError("Invalid candidate in Google AI response");
    }

    // Handle special finish reasons that indicate issues
    if (candidate.finishReason) {
      switch (candidate.finishReason) {
        case "UNEXPECTED_TOOL_CALL": {
          const malformedDetail = this.extractMalformedCallDetail(candidate);
          this.context.warn(
            "Gemini encountered an unexpected tool call - will retry",
            { candidate, malformedDetail },
            "GoogleAIService.extractGeminiCandidate"
          );
          // Throw a retryable error and carry the offending detail so the
          // retry can coach the model to self-correct.
          throw new AIProviderError("UNEXPECTED_TOOL_CALL", {
            finishReason: candidate.finishReason,
            malformedDetail,
          });
        }

        case "MALFORMED_FUNCTION_CALL": {
          const malformedDetail = this.extractMalformedCallDetail(candidate);
          this.context.warn(
            "Gemini encountered a malformed function call - will retry",
            { candidate, malformedDetail },
            "GoogleAIService.extractGeminiCandidate"
          );
          // Throw a retryable error and carry the offending detail so the
          // retry can coach the model to self-correct.
          throw new AIProviderError("MALFORMED_FUNCTION_CALL", {
            finishReason: candidate.finishReason,
            malformedDetail,
          });
        }

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
            reasoning: "",
            images: [],
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
            reasoning: "",
            images: [],
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
    let reasoning = "";
    let functionCalls: any[] = [];
    let images: AIImage[] = [];

    // Extract content from parts
    if (
      Array.isArray(candidate.content.parts) &&
      candidate.content.parts.length > 0
    ) {
      for (const part of candidate.content.parts) {
        if (part.functionCall) {
          // Preserve thoughtSignature from the part for Gemini thinking models
          const fc: any = { ...part.functionCall };
          if ((part as any).thoughtSignature) {
            fc.thoughtSignature = (part as any).thoughtSignature;
          }
          // Preserve _toolCallId from streaming handler so buildCompletion reuses
          // the same ID that was sent to the client via SSE events
          if ((part as any)._toolCallId) {
            fc.id = (part as any)._toolCallId;
          }
          functionCalls.push(fc);
        }
        if (part.inlineData && part.inlineData.mimeType?.startsWith("image/")) {
          images.push({
            b64_json: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          });
        }
        if (part.text) {
          if ((part as any).thought) {
            // Gemini thinking models return thought parts — keep them separate
            reasoning += part.text;
          } else {
            responseText += part.text;
          }
        }
      }
    }

    // If no content was extracted, check if this is a valid terminal response
    if (functionCalls.length === 0 && !responseText.trim() && !reasoning.trim() && images.length === 0) {
      // A STOP finish reason with empty text is valid — the model is done
      // (e.g. after processing tool results with nothing more to say)
      if (candidate.finishReason === "STOP") {
        return { responseText: "", functionCalls: [], reasoning: "", images: [] };
      }

      this.context.warn(
        "No text or function call found in Gemini candidate response - will retry",
        { candidate },
        "GoogleAIService.extractGeminiCandidate"
      );
      // Throw a retryable error for empty responses
      throw new AIProviderError("EMPTY_RESPONSE");
    }

    return { responseText: responseText.trim(), functionCalls, reasoning: reasoning.trim(), images };
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
      providerConfig,
    } = params;

    const maxRetries = 3;
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
          const persona = await this.personaProvider.getPersona(personaId);
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
          messageId.toString(),
          providerConfig
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

    const fallbackContent =
      "I'm experiencing some technical difficulties right now. Please try again in a moment, or rephrase your question.";

    // In streaming mode the failed attempts intentionally suppressed their
    // completion events (see handleStreamingRequest), so the client is still
    // waiting. Emit a terminal completion event with the graceful message so
    // the stream closes cleanly instead of hanging.
    if (this.streamingMode === StreamingMode.SSE && this.chatState?.id) {
      try {
        const sessionId = this.chatState.id;
        const completionEvent = StreamingEventFactory.createCompletionEvent(
          fallbackContent,
          "error",
          undefined,
          { sessionId, conversationId: sessionId },
        );
        await this.streamingTransportManager.sendEventToSession(
          sessionId,
          completionEvent
        );
      } catch (emitError) {
        this.context.error(
          "Failed to emit terminal completion event after exhausted retries",
          { error: emitError },
          "GoogleAIService.chat"
        );
      }
    }

    // Return a graceful error response instead of throwing
    return {
      id: new ObjectId(),
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            content: fallbackContent,
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
    const malformedDetail: string =
      typeof lastError?.meta?.malformedDetail === "string"
        ? lastError.meta.malformedDetail
        : "";

    // For tool-call related errors (common with Gemini 3.x, which is more
    // eager to call tools), don't just simplify — coach the model on how to
    // emit a well-formed call, and feed back its own failed attempt so it can
    // self-correct rather than repeat the same mistake.
    if (
      errorMessage.includes("unexpected_tool_call") ||
      errorMessage.includes("malformed_function_call")
    ) {
      this.context.log(
        "Modifying message for retry to correct malformed tool call",
        {
          originalMessage: typeof message === "string" ? message.substring(0, 100) + "..." : "complex message",
          error: lastError.message,
          hasDetail: !!malformedDetail,
        },
        "GoogleAIService.modifyMessageForRetry"
      );

      const instructions = [
        "SYSTEM NOTICE: Your previous reply contained a malformed function/tool call that could not be parsed and was discarded.",
        "If you call a tool you MUST:",
        "  1. Use only tools declared/available in this session, with their exact names.",
        "  2. Emit the call via the structured function-call mechanism — do NOT write it as free text, markdown, or a code block.",
        "  3. Provide arguments as a single valid JSON object matching the tool's parameter schema (quoted keys/strings, no trailing commas, no comments, no unescaped newlines).",
        "If you do not actually need a tool to answer, reply in plain natural-language text instead of calling one.",
      ];

      if (malformedDetail) {
        instructions.push(
          `For reference, your previous malformed attempt was:\n---\n${malformedDetail}\n---\nCorrect it and try again.`
        );
      }

      instructions.push(`Now respond to the original request: ${message}`);

      return instructions.join("\n");
    }

    // For other errors, just return the original message
    return message;
  }

  /**
   * Extract whatever detail Gemini provides about a malformed/unexpected
   * function call so it can be fed back to the model on retry. Gemini usually
   * populates `finishMessage` with the raw (unparseable) call text; we also
   * fall back to any text/functionCall parts present on the candidate. The
   * result is bounded so it never bloats the retry prompt.
   */
  private extractMalformedCallDetail(candidate: any): string {
    const pieces: string[] = [];

    if (typeof candidate?.finishMessage === "string" && candidate.finishMessage.trim()) {
      pieces.push(candidate.finishMessage.trim());
    }

    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.text === "string" && part.text.trim()) {
          pieces.push(part.text.trim());
        } else if (part?.functionCall) {
          try {
            pieces.push(JSON.stringify(part.functionCall));
          } catch {
            /* non-serialisable — skip */
          }
        }
      }
    }

    // Only need enough context for the model to self-correct.
    return pieces.join("\n").slice(0, 2000);
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: any): boolean {
    if (!error) return false;

    const errorMessage = error.message?.toLowerCase() || "";
    const errorCode = String(error.code || "").toLowerCase();

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

  /**
   * Gemini finish reasons that represent a recoverable failure of the current
   * attempt (rather than a valid terminal response). These are detected in the
   * streaming path so we can retry with coaching instead of emitting a bogus
   * completion event. Mirrors the throwing cases in extractGeminiCandidate.
   */
  private isRetryableFinishReason(finishReason: string): boolean {
    return (
      finishReason === "MALFORMED_FUNCTION_CALL" ||
      finishReason === "UNEXPECTED_TOOL_CALL" ||
      finishReason === "OTHER"
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

  async generateImage(params: AIImageGenerationParams): Promise<AIListResponse<AIImage>> {
    const persona = this.chatState?.persona;
    if (!this.ai) {
      await this.initializeClient(persona);
    }

    const modelId = process.env.GOOGLE_AI_IMAGE_GENERATION_MODEL_ID || "gemini-2.0-flash-image-generation";
    const response = await this.ai.models.generateContent({
      model: modelId,
      contents: [{ role: "user", parts: [{ text: params.prompt }] }],
      config: {
        responseModalities: [Modality.IMAGE, Modality.TEXT],
      },
    });

    const images: AIImage[] = [];
    if (response.candidates?.[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData && part.inlineData.mimeType?.startsWith("image/")) {
          images.push({
            b64_json: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          });
        }
      }
    }

    return { data: images };
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
