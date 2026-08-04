import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import {
  AIChatParams,
  AIAudioChatParams,
  AIChatCompletion,
  AIChatCompletionUsage,
  ReactorProviderConfig,
} from "../../../types/model.types";
import {
  toAnthropicParams,
  structuredOutputDisablesTools,
} from "./providerConfigTranslators";
import {
  loadProviders,
  findModelById,
  resolveSamplingSupport,
  resolveThinkingSupport,
  type ProviderConfig,
  type ModelThinkingMode,
} from "../../../ai/providers/provider-loader";
import {
  AICompletionStreamingData,
  AIErrorStreamingData,
  AIStreamingCapabilities,
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
  MacroToolDefinition,
} from "modules/reactory-reactor/ai/openai/types/chat";
import ReactorConversationModel, {
  ReactorConversationHistory,
  ReactorConversationHistoryItem,
} from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import { CompletionStreamingEvent, ErrorStreamingEvent, ReasoningStreamingEvent, RetryStreamingEvent, StreamingEvent, StreamingEventType, StreamingMode, TokenStreamingEvent, ToolCallStreamingEvent } from "../types/streaming.types";
import { StreamingSessionManager } from "../StreamingSessionManager";
import { StreamingTransportManager } from "../StreamingTransportManager";
import { StreamingEventFactory } from "../streaming/StreamingEventFactory";

const MAX_TOOL_ITERATIONS = 25;

// Provider/model registry is loaded from providers.yaml once and cached for the
// process. It's the source of truth for per-model capabilities such as which
// sampling parameters a model accepts (see resolveSamplingSupport).
let cachedProviderRegistry: ProviderConfig[] | null = null;
function getProviderRegistry(): ProviderConfig[] {
  if (cachedProviderRegistry === null) {
    try {
      cachedProviderRegistry = loadProviders();
    } catch {
      cachedProviderRegistry = [];
    }
  }
  return cachedProviderRegistry;
}

// Fallback deny-list for models whose config isn't found in providers.yaml.
// The Anthropic Opus 4.7+/Sonnet 5/Fable 5 (and Mythos 5) family reject
// temperature/top_p/top_k with a 400. Matched by substring against the model id.
const NO_SAMPLING_MODEL_PATTERNS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-5",
];

// Fallback thinking classification for models not found in providers.yaml.
// Adaptive families use `thinking: {type: "adaptive"}`; legacy families use
// `budget_tokens`. Anything else defaults to no thinking. Matched by substring.
const ADAPTIVE_THINKING_MODEL_PATTERNS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-mythos-5",
];
const BUDGET_THINKING_MODEL_PATTERNS = [
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-3-7-sonnet",
  "claude-3-5-sonnet",
];

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

    this.modelId = persona.modelId || process.env.ANTHROPIC_MODEL_ID || "claude-sonnet-4-5-20250929";
  }

  /**
   * Convert MacroToolDefinition[] to Anthropic tool format.
   * Anthropic tools use { name, description, input_schema } instead of OpenAI's
   * { type: "function", function: { name, description, parameters } } format.
   */
  private convertToolsToAnthropicFormat(tools?: MacroToolDefinition[]): Anthropic.Messages.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools
      .filter(t => t.type === "function" && t.function?.name)
      .map(tool => ({
        name: tool.function.name,
        description: tool.function.description || "",
        input_schema: (tool.function.parameters || { type: "object", properties: {} }) as Anthropic.Messages.Tool.InputSchema,
      }));
  }

  /**
   * Convert chat history to Anthropic format.
   *
   * Key differences from OpenAI format:
   * - No "system" role in messages (handled via the `system` parameter)
   * - Tool calls are `tool_use` content blocks within assistant messages
   * - Tool results are `tool_result` content blocks within user messages
   * - A single message can contain multiple content blocks (text + tool_use)
   * - tool_use_id must match between tool_use and tool_result blocks
   */
    /**
   * Translate OpenAI-style/generic content blocks to Anthropic-compatible content blocks.
   * Specifically, translates type: "image_url" to type: "image" with base64 source.
   */
  private translateContentBlocks(content: any): any {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(block => {
        if (typeof block === "string") {
          return { type: "text", text: block };
        }
        if (block.type === "text") {
          return block;
        }
        if (block.type === "image_url" && block.image_url?.url) {
          const url = block.image_url.url;
          if (url.startsWith("data:")) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              const media_type = match[1];
              const data = match[2];
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: media_type as any,
                  data: data,
                },
              };
            }
          }
          // Fallback if it is a standard HTTP URL (not supported directly by Anthropic Messages API)
          return {
            type: "text",
            text: `[Image: ${url}]`,
          };
        }
        return block;
      });
    }
    if (typeof content === "object") {
      if (content.type === "image_url" && content.image_url?.url) {
        const url = content.image_url.url;
        if (url.startsWith("data:")) {
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const media_type = match[1];
            const data = match[2];
            return [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: media_type as any,
                  data: data,
                },
              }
            ];
          }
        }
        return [
          {
            type: "text",
            text: `[Image: ${url}]`,
          }
        ];
      }
      return content;
    }
    return content;
  }

  /**
   * Reads files attached to the current chatState session and converts supported
   * file types (PDFs, images) to Anthropic content blocks.
   */
  private getFileContentBlocksForSession(): any[] {
    const blocks: any[] = [];
    if (!this.chatState?.files || !Array.isArray(this.chatState.files)) {
      return blocks;
    }

    for (const f of this.chatState.files) {
      const filePath = (f as any).path || (f as any).location;
      if (filePath && fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          // 32MB limit for Anthropic inline document blocks
          if (stats.size > 0 && stats.size <= 32 * 1024 * 1024) {
            const buf = fs.readFileSync(filePath);
            const base64Data = buf.toString("base64");
            const mimeType = f.mimetype || (filePath.endsWith(".pdf") ? "application/pdf" : "application/octet-stream");

            if (mimeType === "application/pdf") {
              blocks.push({
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: base64Data,
                },
              });
              this.context.log(`Attached PDF ${f.filename || f.alias} (${stats.size} bytes) as document block to Anthropic`, {}, "AnthropicService");
            } else if (mimeType.startsWith("image/")) {
              blocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: base64Data,
                },
              });
              this.context.log(`Attached Image ${f.filename || f.alias} (${stats.size} bytes) as image block to Anthropic`, {}, "AnthropicService");
            }
          }
        } catch (err: any) {
          this.context.warn(`Failed to read file ${filePath} for Anthropic attachment: ${err.message}`, {}, "AnthropicService");
        }
      }
    }
    return blocks;
  }

  private convertHistoryToAnthropicFormat(history: ReactorConversationHistoryItem[]): Anthropic.Messages.MessageParam[] {
    const messages: Anthropic.Messages.MessageParam[] = [];

    // Track tool_use_ids that already have a tool_result so we never
    // send duplicates — Anthropic rejects requests with more than one
    // tool_result per tool_use_id.
    const seenToolResultIds = new Set<string>();
    const lastUserMsgIdx = history.map(m => m?.role).lastIndexOf("user");

    for (let idx = 0; idx < history.length; idx++) {
      const msg = history[idx];
      // Skip system messages - handled via the system parameter
      if (msg.role === "system") continue;

      // Handle assistant messages (may contain text + tool_use blocks)
      if (msg.role === "assistant") {
        const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [];

        // Add text content if present
        const textContent = this.extractTextContent(msg.content);
        if (textContent) {
          contentBlocks.push({ type: "text", text: textContent });
        }

        // Add tool_use blocks from tool_calls
        if ((msg as any).tool_calls && (msg as any).tool_calls.length > 0) {
          for (const toolCall of (msg as any).tool_calls) {
            const name = toolCall.function?.name || toolCall.name;
            const rawArgs = toolCall.function?.arguments || toolCall.arguments || {};
            // Anthropic expects input as an object, not a JSON string
            const input = typeof rawArgs === "string" ? this.safeParseJSON(rawArgs) : rawArgs;

            contentBlocks.push({
              type: "tool_use",
              id: toolCall.id || toolCall.tool_call_id || new ObjectId().toHexString(),
              name,
              input,
            });
          }
        }

        if (contentBlocks.length > 0) {
          // Anthropic requires the assistant turn that carries a tool_use to
          // start with the thinking block(s) that produced it, replayed verbatim,
          // whenever thinking is enabled. Rebuilding the turn as [text, tool_use]
          // fails the follow-up (tool_result) request with
          // "Expected `thinking` or `redacted_thinking`, but found ...".
          // buildRequestParams strips these again if thinking is off for the request.
          const thinkingBlocks = this.extractThinkingBlocks(msg);
          messages.push({
            role: "assistant",
            content: [...thinkingBlocks, ...contentBlocks],
          });
        }
        continue;
      }

      // Handle tool result messages
      if (msg.role === "tool" || ((msg as any).tool_results && (msg as any).tool_results.length > 0)) {
        const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];

        if ((msg as any).tool_results && (msg as any).tool_results.length > 0) {
          for (const toolResult of (msg as any).tool_results) {
            const toolUseId = toolResult.tool_call_id || toolResult.id;
            // Skip duplicate results for the same tool_use_id
            if (seenToolResultIds.has(toolUseId)) continue;
            seenToolResultIds.add(toolUseId);

            const resultContent = toolResult.content || toolResult.result || "";
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: toolUseId,
              content: typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent),
              is_error: toolResult.is_error || false,
            });
          }
        }

        // If this is a tool-role message with direct content (single tool result)
        if (msg.role === "tool" && toolResultBlocks.length === 0) {
          const toolUseId = (msg as any).tool_call_id || new ObjectId().toHexString();
          if (!seenToolResultIds.has(toolUseId)) {
            seenToolResultIds.add(toolUseId);
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: toolUseId,
              content: this.extractTextContent(msg.content) || "",
            });
          }
        }

        if (toolResultBlocks.length > 0) {
          messages.push({ role: "user", content: toolResultBlocks });
        }
        continue;
      }

      // Handle regular user messages
      let translatedContent: any = this.translateContentBlocks(msg.content);
      if (idx === lastUserMsgIdx) {
        const fileBlocks = this.getFileContentBlocksForSession();
        if (fileBlocks.length > 0) {
          if (typeof translatedContent === "string") {
            translatedContent = [{ type: "text", text: translatedContent }, ...fileBlocks];
          } else if (Array.isArray(translatedContent)) {
            translatedContent = [...translatedContent, ...fileBlocks];
          } else if (translatedContent) {
            translatedContent = [translatedContent, ...fileBlocks];
          } else {
            translatedContent = fileBlocks;
          }
        }
      }
      if (translatedContent) {
        messages.push({ role: "user", content: translatedContent });
      }
    }

    // Ensure messages alternate correctly (Anthropic requires user/assistant alternation)
    const alternated = this.ensureMessageAlternation(messages);

    // Strip orphaned tool_result blocks whose tool_use_id doesn't appear
    // in the immediately preceding assistant message. Anthropic rejects these.
    return this.sanitizeToolCallsAndResults(alternated);
  }

  /**
   * Remove tool_result content blocks that reference tool_use_ids not present
   * in the immediately preceding assistant message. Anthropic requires each
   * tool_result to match a tool_use in the previous message.
   *
   * Also handles edge cases:
   * - tool_results in the very first message (no preceding assistant)
   * - tool_results merged with text blocks by ensureMessageAlternation
   * - empty messages after filtering
   */
  /**
   * Ensure all tool_use blocks in assistant messages have a matching tool_result
   * block in the immediately following user message. Strips any unpaired tool_use
   * or tool_result blocks to ensure Anthropic never rejects the history.
   */
  private sanitizeToolCallsAndResults(messages: Anthropic.Messages.MessageParam[]): Anthropic.Messages.MessageParam[] {
    const result: Anthropic.Messages.MessageParam[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const nextMsg = messages[i + 1];
        const validToolUseIds = new Set<string>();

        // Collect all valid tool_result IDs from the immediately following user message (if any)
        if (nextMsg && nextMsg.role === "user" && Array.isArray(nextMsg.content)) {
          for (const block of nextMsg.content as any[]) {
            if (block.type === "tool_result" && block.tool_use_id) {
              validToolUseIds.add(block.tool_use_id);
            }
          }
        }

        // Keep only tool_use blocks that have a matching tool_result in the next message,
        // plus any non-tool_use blocks (like text)
        const filteredContent = (msg.content as any[]).filter((block: any) => {
          if (block.type === "tool_use") {
            const hasResult = validToolUseIds.has(block.id);
            if (!hasResult) {
              this.context.log(
                `Stripping uncompleted tool_use block with id=${block.id} (name=${block.name}) because no matching tool_result was found in the next message.`,
                {},
                "AnthropicService.sanitizeToolCallsAndResults"
              );
            }
            return hasResult;
          }
          return true;
        });

        // If the assistant message has non-empty content after filtering, push it
        if (filteredContent.length > 0) {
          result.push({ ...msg, content: filteredContent });
        } else {
          this.context.log(
            `Removing empty assistant message at index ${i} after filtering uncompleted tool calls.`,
            {},
            "AnthropicService.sanitizeToolCallsAndResults"
          );
        }
        continue;
      }

      if (msg.role === "user" && Array.isArray(msg.content)) {
        // Collect valid tool_use IDs from the immediately preceding assistant message (if any)
        const prevMsg = result[result.length - 1];
        const validToolUseIds = new Set<string>();
        if (prevMsg && prevMsg.role === "assistant" && Array.isArray(prevMsg.content)) {
          for (const block of prevMsg.content as any[]) {
            if (block.type === "tool_use" && block.id) {
              validToolUseIds.add(block.id);
            }
          }
        }

        // Keep only tool_result blocks that have a matching tool_use in the preceding message,
        // plus any non-tool_result blocks
        const filteredContent = (msg.content as any[]).filter((block: any) => {
          if (block.type === "tool_result") {
            const hasUse = validToolUseIds.has(block.tool_use_id);
            if (!hasUse) {
              this.context.log(
                `Stripping orphaned tool_result block with tool_use_id=${block.tool_use_id} because no matching tool_use was found in the preceding assistant message.`,
                {},
                "AnthropicService.sanitizeToolCallsAndResults"
              );
            }
            return hasUse;
          }
          return true;
        });

        if (filteredContent.length > 0) {
          result.push({ ...msg, content: filteredContent });
        }
        continue;
      }

      result.push(msg);
    }

    return result;
  }



  /**
   * Recover the provider-native reasoning blocks stored on a history item.
   *
   * Only signed `thinking` blocks and `redacted_thinking` blocks can be replayed —
   * anything else (notably the flattened `thinking` string, which carries no
   * signature) is rejected by the API and is therefore dropped here rather than
   * being reconstructed into an invalid block.
   */
  private extractThinkingBlocks(msg: ReactorConversationHistoryItem): Anthropic.Messages.ContentBlockParam[] {
    const stored = (msg as any).thinking_blocks;
    if (!Array.isArray(stored) || stored.length === 0) return [];

    return stored
      .filter((block: any) => {
        if (!block) return false;
        if (block.type === "thinking") return typeof block.signature === "string" && block.signature.length > 0;
        if (block.type === "redacted_thinking") return typeof block.data === "string" && block.data.length > 0;
        return false;
      })
      .map((block: any) =>
        block.type === "thinking"
          ? { type: "thinking", thinking: block.thinking ?? "", signature: block.signature }
          : { type: "redacted_thinking", data: block.data }
      ) as Anthropic.Messages.ContentBlockParam[];
  }

  /**
   * Remove replayed reasoning blocks from the outbound messages.
   *
   * Thinking blocks are only valid when the request itself enables thinking; sending
   * them with thinking disabled (structured output, or a model/persona with thinking
   * off) is a 400. Assistant messages left with no content after stripping are
   * dropped, since an empty content array is also rejected.
   */
  private stripThinkingBlocks(
    messages: Anthropic.Messages.MessageParam[]
  ): Anthropic.Messages.MessageParam[] {
    const result: Anthropic.Messages.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
        result.push(msg);
        continue;
      }

      const filtered = (msg.content as any[]).filter(
        (block: any) => block?.type !== "thinking" && block?.type !== "redacted_thinking"
      );

      if (filtered.length === (msg.content as any[]).length) {
        result.push(msg);
      } else if (filtered.length > 0) {
        result.push({ ...msg, content: filtered as any });
      }
    }

    return result;
  }

  /**
   * Extract text content from various content formats
   */
  private extractTextContent(content: any): string | null {
    if (!content) return null;
    if (typeof content === "string") return content.trim() || null;
    if (Array.isArray(content)) {
      const texts = content
        .map(c => {
          if (typeof c === "string") return c;
          if (c.type === "text" && c.text) return c.text;
          return "";
        })
        .filter(Boolean);
      return texts.length > 0 ? texts.join("\n") : null;
    }
    if (typeof content === "object" && "text" in content) {
      return (content as any).text?.trim() || null;
    }
    return null;
  }

  /**
   * Safely parse JSON, returning the original string wrapped in an object on failure
   */
  private safeParseJSON(str: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(str);
      return typeof parsed === "object" && parsed !== null ? parsed : { value: parsed };
    } catch {
      return { raw: str };
    }
  }

  /**
   * Ensure messages alternate between user and assistant roles.
   * Anthropic requires strict alternation - consecutive same-role messages must be merged.
   */
  private ensureMessageAlternation(messages: Anthropic.Messages.MessageParam[]): Anthropic.Messages.MessageParam[] {
    if (messages.length === 0) return messages;

    const result: Anthropic.Messages.MessageParam[] = [];

    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role) {
        // Merge consecutive same-role messages
        const lastContent = Array.isArray(last.content)
          ? last.content
          : [{ type: "text" as const, text: last.content as string }];
        const currentContent = Array.isArray(msg.content)
          ? msg.content
          : [{ type: "text" as const, text: msg.content as string }];
        last.content = [...lastContent, ...currentContent] as any;
      } else {
        result.push({ ...msg });
      }
    }

    return result;
  }

  /**
   * Extract tool_use blocks from an Anthropic response
   */
  private extractToolUseBlocks(response: Anthropic.Messages.Message): Anthropic.Messages.ToolUseBlock[] {
    return response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use"
    );
  }

  /**
   * Extract text content from an Anthropic response
   */
  private extractResponseText(response: Anthropic.Messages.Message): string {
    return response.content
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
      .map(block => block.text)
      .join("");
  }

  /**
   * Execute a tool call via the macro service and return the result
   */
  private async executeToolCall(toolUseBlock: Anthropic.Messages.ToolUseBlock): Promise<Anthropic.Messages.ToolResultBlockParam> {
    try {
      const result = await this.macroService.executeTool(
        toolUseBlock.name,
        toolUseBlock.input as Record<string, unknown>,
        this.chatState
      );

      const content = typeof result === "string" ? result : JSON.stringify(result);
      return {
        type: "tool_result",
        tool_use_id: toolUseBlock.id,
        content,
      };
    } catch (error: any) {
      this.context.error(
        `Tool execution failed: ${toolUseBlock.name}`,
        { error, input: toolUseBlock.input },
        "AnthropicService.executeToolCall"
      );
      return {
        type: "tool_result",
        tool_use_id: toolUseBlock.id,
        content: `Error executing tool ${toolUseBlock.name}: ${error.message || error.toString()}`,
        is_error: true,
      };
    }
  }

  /**
   * Convert Anthropic tool_use blocks to the internal tool_calls format for history storage
   */
  private toolUseBlocksToToolCalls(blocks: Anthropic.Messages.ToolUseBlock[]): any[] {
    return blocks.map(block => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        // Default to {} so a no-argument tool never yields JSON.stringify(undefined)
        // === the JS value undefined (not a string), which is invalid downstream.
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));
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
    // Delegate to the shared factory so the emitted event matches the shape all
    // other providers produce (flat data + conversationId populated).
    return StreamingEventFactory.createTokenEvent(
      delta,
      position,
      { sessionId, conversationId: sessionId },
    );
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
    return StreamingEventFactory.createReasoningEvent(
      delta,
      position,
      { sessionId, conversationId: sessionId },
    );
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
    return StreamingEventFactory.createToolCallEvent(
      id,
      name,
      toolArguments,
      isComplete,
      result,
      { sessionId, conversationId: sessionId },
    );
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
   * Create a retry streaming event to inform the client of an upcoming retry
   */
  private createRetryEvent(
    attempt: number,
    maxAttempts: number,
    retryAfterMs: number,
    reason: string,
    sessionId?: string
  ): RetryStreamingEvent {
    return this.createStreamingEvent(StreamingEventType.RETRY, {
      attempt,
      maxAttempts,
      retryAfterMs,
      reason,
    }, sessionId) as RetryStreamingEvent;
  }

  /**
   * Extract a backoff delay from an Anthropic error.
   * Checks for a `retry-after` header (seconds) on 429 responses,
   * otherwise falls back to exponential backoff with jitter.
   */
  private getBackoffDelay(error: any, attempt: number): number {
    // Anthropic SDK errors expose headers on the error object
    const retryAfterHeader = error?.headers?.get?.('retry-after')
      ?? error?.headers?.['retry-after'];
    if (retryAfterHeader) {
      const seconds = Number(retryAfterHeader);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }
    // Exponential backoff: 2s, 4s, 8s, 16s, 32s capped at 60s
    const baseDelay = Math.min(Math.pow(2, attempt) * 1000, 60_000);
    // Add jitter: ±25%
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    return Math.max(1000, Math.round(baseDelay + jitter));
  }

  /**
   * Determine max retries based on error type.
   * Rate-limit errors (429) get more retries than other transient errors.
   */
  private getMaxRetries(error: any): number {
    if (error?.status === 429) return 5;
    return 2;
  }

  /**
   * Human-readable reason string for a retryable error
   */
  private getRetryReason(error: any): string {
    if (error?.status === 429) return 'Rate limited by provider';
    if (error?.status === 529 || error?.status === 503) return 'Provider overloaded';
    if (error?.status >= 500) return 'Provider server error';
    const msg = error?.message?.toLowerCase() || '';
    if (msg.includes('timeout')) return 'Request timed out';
    if (msg.includes('network') || msg.includes('connection')) return 'Network error';
    return 'Transient error';
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
      thinking?: string;
    },
    sessionId?: string
  ): CompletionStreamingEvent {
    // Delegate to the shared factory. The client's CompletionStreamingEvent
    // expects a FLAT { content, finishReason, thinking? } payload — the old
    // nested { content, metadata } shape caused the client to read an undefined
    // finishReason/thinking and fail to finalize the streamed message. Token
    // counts / model are carried on the method's return value and persisted
    // separately, so they are intentionally omitted from the SSE event.
    return StreamingEventFactory.createCompletionEvent(
      content,
      metadata.finishReason || "stop",
      metadata.thinking,
      { sessionId, conversationId: sessionId },
    );
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
      sessionId: sessionId ?? "",
      // Default conversationId to the sessionId (matches StreamingEventFactory
      // and the other providers) so the client can route/group the event.
      conversationId: conversationId ?? sessionId ?? "",
      messageId: messageId ?? "",
      data,
    } as StreamingEvent;
  }

  /**
   * Build the common request parameters for Anthropic messages.create()
   */
  /**
   * Check if the current model supports extended thinking.
   */
  /**
   * Resolves how the current model does thinking (adaptive / budget / none),
   * plus adaptive effort/display. Consults providers.yaml first; on a config
   * miss, falls back to substring pattern matching. Cached per process.
   */
  private getThinkingSupport(): {
    mode: ModelThinkingMode;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    display?: "summarized" | "omitted";
  } {
    const found = findModelById(getProviderRegistry(), this.modelId);
    if (found) {
      return resolveThinkingSupport(found.model);
    }
    // Config miss — classify by known model families.
    if (ADAPTIVE_THINKING_MODEL_PATTERNS.some((m) => this.modelId.includes(m))) {
      return { mode: "adaptive", effort: "high", display: "summarized" };
    }
    if (BUDGET_THINKING_MODEL_PATTERNS.some((m) => this.modelId.includes(m))) {
      return { mode: "budget" };
    }
    return { mode: "none" };
  }

  /**
   * Resolves which sampling parameters (temperature / top_p / top_k) the current
   * model accepts. Consults providers.yaml first (the source of truth); if the
   * model isn't found there, falls back to a substring deny-list of known
   * families that reject sampling params with a 400. Cached per process.
   */
  private getSamplingSupport(): { temperature: boolean; topP: boolean; topK: boolean } {
    const found = findModelById(getProviderRegistry(), this.modelId);
    if (found) {
      return resolveSamplingSupport(found.model);
    }
    // Config miss — deny sampling for known no-sampling families, allow otherwise.
    const denied = NO_SAMPLING_MODEL_PATTERNS.some((m) => this.modelId.includes(m));
    return { temperature: !denied, topP: !denied, topK: !denied };
  }

  private buildRequestParams(
    messages: Anthropic.Messages.MessageParam[],
    persona: IAIPersona,
    options?: { stream?: boolean; providerConfig?: ReactorProviderConfig }
  ): Anthropic.Messages.MessageCreateParams {
    const providerConfig = options?.providerConfig;
    // Normalized augmented config → synthetic schema tool, tool_choice, sampling.
    const augmented = toAnthropicParams(providerConfig);
    
    const toolsList = (this.chatState?.tools !== undefined && this.chatState?.tools !== null)
      ? (this.chatState.tools as MacroToolDefinition[])
      : persona.tools;
    const personaTools = this.convertToolsToAnthropicFormat(toolsList);

    // Which sampling params this model accepts (temperature/top_p/top_k). Newer
    // Anthropic models (Opus 4.7+, Sonnet 5, Fable 5) reject them with a 400.
    const samplingSupport = this.getSamplingSupport();

    // How this model does thinking (adaptive / budget / none). Thinking is
    // disabled for structured output (forced tool_choice conflicts with it) and
    // whenever the caller's requested sampling will actually be sent — thinking
    // and explicit temperature/top_p are mutually exclusive. If the requested
    // sampling isn't supported by the model it gets stripped below, so it poses
    // no conflict and thinking stays on.
    const thinkingSupport = this.getThinkingSupport();
    const wantsSampling =
      !!providerConfig &&
      (providerConfig.temperature != null || providerConfig.topP != null);
    const samplingActuallyApplies =
      (providerConfig?.temperature != null && samplingSupport.temperature) ||
      (providerConfig?.topP != null && samplingSupport.topP);
    const enableThinking =
      thinkingSupport.mode !== "none" &&
      persona.modelConfig?.enableThinking !== false &&
      !providerConfig?.structuredOutput &&
      !samplingActuallyApplies;

    const params: Anthropic.Messages.MessageCreateParams = {
      model: this.modelId,
      max_tokens: persona.modelConfig?.maxTokens || 16000,
      // Replayed reasoning blocks are only legal when this request enables
      // thinking; with thinking off they are a 400, so drop them here.
      messages: enableThinking ? messages : this.stripThinkingBlocks(messages),
      system: this.createSystemPrompt(persona).content,
    };

    if (enableThinking && thinkingSupport.mode === "adaptive") {
      // Adaptive thinking: Claude decides depth. budget_tokens is rejected (400);
      // depth is controlled via output_config.effort. display defaults to
      // "omitted" (empty reasoning text) on newer models, so honour the config.
      const thinking: Record<string, unknown> = { type: "adaptive" };
      if (thinkingSupport.display) thinking.display = thinkingSupport.display;
      (params as any).thinking = thinking;
      if (thinkingSupport.effort) {
        (params as any).output_config = { effort: thinkingSupport.effort };
      }
    } else if (enableThinking && thinkingSupport.mode === "budget") {
      // Legacy extended thinking. budget_tokens must be < max_tokens (min 1024).
      const requested = persona.modelConfig?.thinkingBudget || 10000;
      const budget = Math.max(
        1024,
        Math.min(requested, (params.max_tokens as number) - 1024)
      );
      (params as any).thinking = { type: "enabled", budget_tokens: budget };
    } else if (!wantsSampling && !providerConfig?.structuredOutput) {
      // Persona-driven sampling (only when the caller hasn't supplied its own).
      // Anthropic does not allow both temperature and top_p simultaneously, and
      // only sends a sampling param the model actually accepts.
      if (
        samplingSupport.topP &&
        persona.modelConfig?.topP != null &&
        persona.modelConfig?.temperature == null
      ) {
        (params as any).top_p = persona.modelConfig.topP;
      } else if (samplingSupport.temperature) {
        params.temperature = persona.modelConfig?.temperature ?? 0.7;
      }
    }
    // else: sampling (if any) comes from the caller's providerConfig, merged below.

    // Tools: structured output (without an explicit tool choice) replaces the
    // persona tools with the single forced schema tool.
    if (structuredOutputDisablesTools(providerConfig)) {
      params.tools = augmented.tool ? [augmented.tool as any] : undefined;
    } else {
      const merged = [
        ...(personaTools || []),
        ...(augmented.tool ? [augmented.tool as any] : []),
      ];
      if (merged.length > 0) {
        params.tools = merged;
      }
    }

    if (augmented.tool_choice) {
      (params as any).tool_choice = augmented.tool_choice;
    }

    // Caller sampling / max_tokens / stop_sequences override persona defaults.
    Object.assign(params, augmented.params);

    // Defensive final sweep: strip any sampling param the model rejects. This
    // catches both persona defaults and caller-supplied overrides merged above,
    // so an unsupported temperature/top_p/top_k can never reach the API (which
    // returns a 400 "`temperature` is deprecated for this model" on newer models).
    const stripped: string[] = [];
    if (!samplingSupport.temperature && (params as any).temperature != null) {
      delete (params as any).temperature;
      stripped.push("temperature");
    }
    if (!samplingSupport.topP && (params as any).top_p != null) {
      delete (params as any).top_p;
      stripped.push("top_p");
    }
    if (!samplingSupport.topK && (params as any).top_k != null) {
      delete (params as any).top_k;
      stripped.push("top_k");
    }
    if (stripped.length > 0) {
      this.context.debug(
        `Stripped unsupported sampling param(s) [${stripped.join(", ")}] for model ${this.modelId}`,
        {},
        "AnthropicService.buildRequestParams"
      );
    }

    if (options?.stream) {
      (params as any).stream = true;
    }

    return params;
  }

  /**
   * Handle streaming request for Anthropic with tool support
   */
  private async handleStreamingRequest(args: {
    sessionId: string;
    message: string;
    persona: IAIPersona;
    history: ReactorConversationHistory;
    messageId?: string;
    providerConfig?: ReactorProviderConfig;
  }): Promise<{ content: string; finishReason: string; toolCalls: any[]; reasoning?: string; assistantPersisted?: boolean; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    const { sessionId, message, persona, history, messageId, providerConfig } = args;
    const structuredToolName = toAnthropicParams(providerConfig).structuredToolName;

    // getAIResponse appends the incoming user message to chatState.history before
    // calling us, so `history` already carries this turn — unconditionally pushing
    // it again sent the user's message to the API twice (duplicated context, and
    // billed twice). Only append it when the caller passed a history that does not
    // already end in a user turn.
    const messages = this.convertHistoryToAnthropicFormat(history);
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") {
      messages.push({ role: "user", content: this.translateContentBlocks(message) });
    }

    let accumulatedText = "";
    let accumulatedReasoning = "";
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason = "stop";
    const collectedToolCalls: any[] = [];
    // Reasoning blocks captured verbatim (text + signature). Anthropic rejects a
    // tool-result turn whose assistant message dropped these, so they are
    // persisted alongside the tool_calls and replayed on the next request.
    const collectedThinkingBlocks: any[] = [];

    // Track current content blocks being streamed
    const currentBlocks: Map<number, {
      type: string;
      id?: string;
      name?: string;
      inputJson: string;
      thinkingText?: string;
      signature?: string;
      redactedData?: string;
    }> = new Map();

    const params = this.buildRequestParams(messages, persona, { stream: true, providerConfig });
    const stream = await this.anthropic.messages.create(params as any);

    for await (const chunk of stream as AsyncIterable<any>) {
      switch (chunk.type) {
        case "message_start": {
          // Extract input token usage from message_start
          if (chunk.message?.usage) {
            promptTokens = chunk.message.usage.input_tokens || 0;
          }
          break;
        }
        case "content_block_start": {
          const index = chunk.index;
          if (chunk.content_block?.type === "tool_use") {
            currentBlocks.set(index, {
              type: "tool_use",
              id: chunk.content_block.id,
              name: chunk.content_block.name,
              inputJson: "",
            });
            // Emit tool call start event
            const toolEvent = this.createToolCallEvent(
              chunk.content_block.id,
              chunk.content_block.name,
              "",
              false,
              undefined,
              sessionId
            );
            toolEvent.messageId = messageId;
            await this.streamingTransportManager.sendEventToSession(sessionId, toolEvent);
          } else if (chunk.content_block?.type === "thinking") {
            currentBlocks.set(index, {
              type: "thinking",
              inputJson: "",
              // Adaptive thinking with display:"omitted" streams a thinking block
              // whose text is empty but whose signature still must be replayed.
              thinkingText: chunk.content_block.thinking || "",
              signature: chunk.content_block.signature || undefined,
            });
          } else if (chunk.content_block?.type === "redacted_thinking") {
            currentBlocks.set(index, {
              type: "redacted_thinking",
              inputJson: "",
              redactedData: chunk.content_block.data,
            });
          } else if (chunk.content_block?.type === "text") {
            currentBlocks.set(index, { type: "text", inputJson: "" });
          }
          break;
        }
        case "content_block_delta": {
          const index = chunk.index;
          const block = currentBlocks.get(index);
          if (!block) break;

          if (chunk.delta?.type === "signature_delta") {
            // The signature arrives as its own delta on the thinking block and is
            // mandatory when the block is replayed — without it Anthropic 400s.
            block.signature = (block.signature || "") + (chunk.delta.signature || "");
            break;
          }

          if (chunk.delta?.type === "thinking_delta" && block.type === "thinking") {
            const delta = chunk.delta.thinking || "";
            block.thinkingText = (block.thinkingText || "") + delta;
            accumulatedReasoning += delta;
            const event = this.createReasoningEvent(
              delta,
              delta,
              accumulatedReasoning.length,
              false,
              sessionId
            );
            event.messageId = messageId;
            await this.streamingTransportManager.sendEventToSession(sessionId, event);
          } else if (chunk.delta?.type === "text_delta") {
            const delta = chunk.delta.text || "";
            accumulatedText += delta;
            const event = this.createTokenEvent(
              delta,
              delta,
              accumulatedText.length,
              false,
              sessionId
            );
            event.messageId = messageId;
            await this.streamingTransportManager.sendEventToSession(sessionId, event);
          } else if (chunk.delta?.type === "input_json_delta") {
            block.inputJson += chunk.delta.partial_json || "";
          }
          break;
        }
        case "content_block_stop": {
          const index = chunk.index;
          const block = currentBlocks.get(index);
          if (block?.type === "thinking") {
            // Only a signed block can be replayed; an unsigned one would be
            // rejected, so drop it rather than poison the next request.
            if (block.signature) {
              collectedThinkingBlocks.push({
                type: "thinking",
                thinking: block.thinkingText || "",
                signature: block.signature,
              });
            }
            currentBlocks.delete(index);
            break;
          }
          if (block?.type === "redacted_thinking" && block.redactedData) {
            collectedThinkingBlocks.push({
              type: "redacted_thinking",
              data: block.redactedData,
            });
            currentBlocks.delete(index);
            break;
          }
          if (block?.type === "tool_use" && block.id && block.name) {
            // Structured-output terminal bypass: the forced schema tool's accumulated
            // JSON is the response content, not an executable tool call.
            if (structuredToolName && block.name === structuredToolName) {
              accumulatedText += block.inputJson;
              currentBlocks.delete(index);
              break;
            }
            // Anthropic emits NO input_json_delta events for a tool_use block
            // that takes no arguments, so block.inputJson stays "". Emitting
            // arguments:"" produces invalid JSON downstream — the client and
            // executeMacro both call JSON.parse(arguments), and JSON.parse("")
            // throws "Unexpected end of JSON input". Normalize empty/whitespace
            // accumulations to "{}" so arguments is ALWAYS a valid JSON string.
            const normalizedArgs =
              block.inputJson && block.inputJson.trim().length > 0
                ? block.inputJson
                : "{}";
            collectedToolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: normalizedArgs,
              },
            });
            // Emit tool call complete event
            const toolEvent = this.createToolCallEvent(
              block.id,
              block.name,
              normalizedArgs,
              true,
              undefined,
              sessionId
            );
            toolEvent.messageId = messageId;
            await this.streamingTransportManager.sendEventToSession(sessionId, toolEvent);
          }
          currentBlocks.delete(index);
          break;
        }
        case "message_delta": {
          // Extract output token usage and stop reason
          if (chunk.usage) {
            completionTokens = chunk.usage.output_tokens || 0;
          }
          if (chunk.delta?.stop_reason) {
            finishReason = chunk.delta.stop_reason;
          }
          break;
        }
        case "message_stop": {
          // Message is complete
          break;
        }
      }
    }

    totalTokens = promptTokens + completionTokens;

    // When tool_calls are present, the client will receive the completion SSE event
    // and immediately start executing tools via executeMacro, which persists tool_result
    // entries to the conversation history. If we don't persist the assistant message
    // BEFORE the completion event, there's a race condition: executeMacro may persist
    // tool_results before processAIResponse persists the assistant message, resulting
    // in orphaned tool_result blocks in the DB.
    let assistantPersisted = false;
    if (collectedToolCalls.length > 0 && this.chatState?.id) {
      await ReactorConversationModel.findOneAndUpdate(
        { _id: this.chatState.id },
        {
          $push: {
            history: {
              id: new ObjectId(),
              role: "assistant",
              content: accumulatedText,
              thinking: accumulatedReasoning || undefined,
              // Verbatim reasoning blocks — required to build a valid tool-result
              // turn on the follow-up request (see convertHistoryToAnthropicFormat).
              thinking_blocks: collectedThinkingBlocks.length > 0 ? collectedThinkingBlocks : undefined,
              timestamp: new Date(),
              tool_calls: collectedToolCalls,
              tool_results: [],
            },
          },
          $set: { updated: new Date() },
        },
        { new: true }
      ).exec();
      assistantPersisted = true;
    }

    // Send completion event
    const completionEvent = this.createCompletionEvent(
      accumulatedText,
      { totalTokens, promptTokens, completionTokens, finishReason, model: this.modelId, thinking: accumulatedReasoning || undefined },
      sessionId
    );
    completionEvent.messageId = messageId;
    await this.streamingTransportManager.sendEventToSession(sessionId, completionEvent);

    return {
      content: accumulatedText,
      finishReason,
      toolCalls: collectedToolCalls,
      reasoning: accumulatedReasoning || undefined,
      assistantPersisted,
      usage: { promptTokens, completionTokens, totalTokens },
    };
  }

  /**
   * Run the agentic tool loop: send message, execute any tool calls,
   * feed results back until the model produces a final response.
   */
  private async runToolLoop(
    messages: Anthropic.Messages.MessageParam[],
    persona: IAIPersona,
    sessionId?: string,
    messageId?: string,
    providerConfig?: ReactorProviderConfig,
  ): Promise<{
    content: string;
    finishReason: string;
    toolCalls: any[];
    toolResults: any[];
    usage: { promptTokens: number; completionTokens: number };
  }> {
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    const allToolCalls: any[] = [];
    const allToolResults: any[] = [];
    // When structured output is requested we force a synthetic schema tool. Its
    // tool_use is the structured result — never an executable macro.
    const structuredToolName = toAnthropicParams(providerConfig).structuredToolName;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const params = this.buildRequestParams(messages, persona, { providerConfig });
      const response = await this.anthropic.messages.create(params);

      // Accumulate usage
      if (response.usage) {
        totalPromptTokens += response.usage.input_tokens;
        totalCompletionTokens += response.usage.output_tokens;
      }

      const responseText = this.extractResponseText(response);
      const toolUseBlocks = this.extractToolUseBlocks(response);

      // Add assistant response to messages for context
      messages.push({ role: "assistant", content: response.content });

      // Store tool calls in history format
      if (toolUseBlocks.length > 0) {
        allToolCalls.push(...this.toolUseBlocksToToolCalls(toolUseBlocks));
      }

      // Structured-output terminal bypass: surface the forced schema tool's input
      // as the JSON result instead of dispatching it to the macro executor.
      if (structuredToolName) {
        const structuredBlock = toolUseBlocks.find(
          (b: any) => b.name === structuredToolName,
        );
        if (structuredBlock) {
          return {
            content: JSON.stringify((structuredBlock as any).input ?? {}),
            finishReason: "end_turn",
            toolCalls: allToolCalls,
            toolResults: allToolResults,
            usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
          };
        }
      }

      // If no tool calls or stop reason is not tool_use, we're done
      if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
        return {
          content: responseText,
          finishReason: response.stop_reason || "end_turn",
          toolCalls: allToolCalls,
          toolResults: allToolResults,
          usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
        };
      }

      // Execute all tool calls and collect results
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const toolBlock of toolUseBlocks) {
        this.context.log(
          `Executing tool: ${toolBlock.name}`,
          { toolId: toolBlock.id },
          "AnthropicService.runToolLoop"
        );

        // Emit streaming event for tool execution if streaming
        if (this.streamingMode === StreamingMode.SSE && sessionId) {
          const toolEvent = this.createToolCallEvent(
            toolBlock.id,
            toolBlock.name,
            JSON.stringify(toolBlock.input),
            false,
            undefined,
            sessionId
          );
          toolEvent.messageId = messageId;
          await this.streamingTransportManager.sendEventToSession(sessionId, toolEvent);
        }

        const result = await this.executeToolCall(toolBlock);
        toolResults.push(result);

        allToolResults.push({
          tool_call_id: toolBlock.id,
          name: toolBlock.name,
          content: result.content,
          is_error: result.is_error || false,
        });

        // Emit streaming event for tool result
        if (this.streamingMode === StreamingMode.SSE && sessionId) {
          const toolEvent = this.createToolCallEvent(
            toolBlock.id,
            toolBlock.name,
            JSON.stringify(toolBlock.input),
            true,
            result.content,
            sessionId
          );
          toolEvent.messageId = messageId;
          await this.streamingTransportManager.sendEventToSession(sessionId, toolEvent);
        }
      }

      // Add tool results as a user message
      messages.push({ role: "user", content: toolResults });
    }

    // Exceeded max iterations
    this.context.warn(
      `Tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations`,
      {},
      "AnthropicService.runToolLoop"
    );
    return {
      content: "I've reached the maximum number of tool iterations. Here's what I have so far based on the tools I've used.",
      finishReason: "max_tool_iterations",
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
    };
  }

  private async getAIResponse(
    message: string,
    role: "user" | "assistant" | "tool" | "system" = "user",
    messageId?: string,
    providerConfig?: ReactorProviderConfig
  ): Promise<AIChatCompletion> {
    try {
      // Use the persona already resolved and stored in chatState by initialize().
      // Re-fetching from personaProvider is fragile (may return a different shape
      // or fail for personas not registered at startup).
      const persona: IAIPersona = this.chatState.persona;
      if (!persona) {
        throw new AIProviderError(
          `No persona available in chat state for personaId ${this.chatState.personaId}`,
        );
      }

      // Handle tool results - feed them back into the tool loop
      if (role === "tool") {
        const messages = this.convertHistoryToAnthropicFormat(this.chatState.history);
        const result = await this.runToolLoop(messages, persona, this.chatState.id, messageId, providerConfig);
        const toolLoopUsage: AIChatCompletionUsage | undefined = result.usage ? {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.promptTokens + result.usage.completionTokens,
        } : undefined;
        return this.buildCompletion(result.content, result.finishReason, result.toolCalls, toolLoopUsage);
      }

      // Handle user messages
      if (role === "user") {
        // Add user message to history first
        const userConversationHistoryItem: ReactorConversationHistoryItem = {
          id: new ObjectId(),
          role: "user",
          content: message,
          timestamp: new Date(),
          tool_results: [],
        };
        this.chatState.history.push(userConversationHistoryItem);

        const messages = this.convertHistoryToAnthropicFormat(this.chatState.history);

        if (this.streamingMode === StreamingMode.SSE) {
          const streamResult = await this.handleStreamingRequest({
            sessionId: this.chatState.id,
            message,
            persona,
            history: this.chatState.history,
            messageId,
            providerConfig,
          });

          // When streaming via SSE, tool_call events have already been sent
          // to the client. The client will execute the tools and call back
          // with role='tool' + continueAfterTools. Do NOT execute tools
          // server-side here — that causes dual execution and corrupted
          // conversation history.
          const streamUsage: AIChatCompletionUsage | undefined = streamResult.usage ? {
            promptTokens: streamResult.usage.promptTokens,
            completionTokens: streamResult.usage.completionTokens,
            totalTokens: streamResult.usage.totalTokens,
          } : undefined;
          const completion = this.buildCompletion(streamResult.content, streamResult.finishReason, streamResult.toolCalls, streamUsage);
          // If the assistant message was already persisted before the SSE completion event
          // (to prevent race conditions with executeMacro), flag the completion so
          // processAIResponse in ReactorConversationService can skip the duplicate persist.
          if (streamResult.assistantPersisted) {
            (completion as any).__persisted = true;
          }
          return completion;
        }

        // Non-streaming path with tool loop
        const result = await this.runToolLoop(messages, persona, this.chatState.id, messageId, providerConfig);
        const loopUsage: AIChatCompletionUsage | undefined = result.usage ? {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.promptTokens + result.usage.completionTokens,
        } : undefined;
        return this.buildCompletion(result.content, result.finishReason, result.toolCalls, loopUsage);
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

      return this.buildCompletion("", "stop", []);
    } catch (error) {
      this.context.error(
        `Error in getAIResponse: ${error.message ?? error.toString()}`,
        { error },
        "AnthropicService.getAIResponse"
      );
      throw error;
    }
  }

  /**
   * Build a standardized AIChatCompletion response
   */
  private buildCompletion(content: string, finishReason: string, toolCalls: any[], usage?: AIChatCompletionUsage): AIChatCompletion {
    const completion: AIChatCompletion = {
      id: new ObjectId(),
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            content,
            role: "assistant",
            tool_calls: toolCalls,
          },
          finish_reason: finishReason,
        },
      ],
      created: new Date(),
    };
    if (usage) {
      completion.usage = usage;
    }
    return completion;
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
      providerConfig,
    } = params;

    let lastError: any;
    let maxRetries = 2;
    this.streamingMode = streamingMode;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Initialize if needed
        if (
          !this.anthropic ||
          (chatSessionId && this.chatState?.id !== chatSessionId)
        ) {
          const persona = await this.personaProvider.getPersona(personaId);
          if (!persona) {
            throw new AIProviderError(`Persona ${personaId} not found`);
          }
          await this.initialize(chatSessionId, persona);
        }

        const messageId = new ObjectId();
        const response = await this.getAIResponse(message, role, messageId.toString(), providerConfig);

        // Add AI response to history (only when NOT already persisted by
        // handleStreamingRequest — otherwise we create duplicate entries
        // that produce duplicate tool_result blocks on the next turn).
        if (response.choices && response.choices.length > 0 && !(response as any).__persisted) {
          this.chatState.history.push({
            id: messageId,
            timestamp: new Date(),
            tool_calls: response.choices[0].message.tool_calls ?? [],
            tool_results: [],
            role: "assistant",
            content: response.choices[0].message.content,
          } as ReactorConversationHistoryItem);
        }

        // Skip persistChatState when processAIResponse in the conversation
        // service will handle persistence.  The full-document overwrite in
        // persistChatState races with the $push operations done by
        // processAIResponse and executeMacro, causing duplicate history
        // entries on the next load.
        if (persistState && !(response as any).__persisted) {
          await this.persistChatState();
        }

        return response;
      } catch (error: any) {
        lastError = error;

        // On first retryable error, adjust maxRetries based on error type
        // (rate-limit errors get more retries)
        if (attempt === 1) {
          maxRetries = this.getMaxRetries(error);
        }

        if (attempt < maxRetries && this.isRetryableError(error)) {
          const backoffDelay = this.getBackoffDelay(error, attempt);
          const reason = this.getRetryReason(error);

          this.context.warn(
            `${reason} — retry ${attempt}/${maxRetries} in ${backoffDelay}ms (${error.message})`,
            { error, attempt, maxRetries, backoffDelay },
            "AnthropicService.chat"
          );

          // Send retry event to client via SSE so they see feedback
          if (this.streamingMode === StreamingMode.SSE && chatSessionId) {
            const retryEvent = this.createRetryEvent(
              attempt,
              maxRetries,
              backoffDelay,
              reason,
              chatSessionId
            );
            await this.streamingTransportManager.sendEventToSession(chatSessionId, retryEvent)
              .catch((err) => this.context.warn(
                `Failed to send retry SSE event: ${err.message}`,
                { err },
                "AnthropicService.chat"
              ));
          }

          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          continue;
        }

        break;
      }
    }

    this.context.error(
      `Error in chat after ${maxRetries} attempts: ${lastError?.message ?? lastError?.toString()}`,
      { error: lastError, params },
      "AnthropicService.chat",
    );

    // Surface the error to the caller so the conversation service can
    // return a proper ReactorErrorResponse to the client.
    throw new AIProviderError(
      lastError?.message || "AI provider request failed after retries",
    );
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: any): boolean {
    if (!error) return false;

    // Check for Anthropic SDK error status codes
    if (error.status) {
      const retryableStatuses = [429, 500, 502, 503, 504, 529];
      if (retryableStatuses.includes(error.status)) return true;
    }

    const errorMessage = error.message?.toLowerCase() || "";
    const errorCode = String(error.code || "").toLowerCase();

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
      "overloaded",
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
