import Reactory from "@reactorynet/reactory-core";
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
import { CompletionStreamingEvent, ErrorStreamingEvent, ReasoningStreamingEvent, StreamingEvent, StreamingEventType, StreamingMode, TokenStreamingEvent, ToolCallStreamingEvent } from "../types/streaming.types";
import { StreamingSessionManager } from "../StreamingSessionManager";
import { StreamingTransportManager } from "../StreamingTransportManager";

const MAX_TOOL_ITERATIONS = 25;

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
  private convertHistoryToAnthropicFormat(history: ReactorConversationHistoryItem[]): Anthropic.Messages.MessageParam[] {
    const messages: Anthropic.Messages.MessageParam[] = [];

    for (const msg of history) {
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
          messages.push({ role: "assistant", content: contentBlocks });
        }
        continue;
      }

      // Handle tool result messages
      if (msg.role === "tool" || ((msg as any).tool_results && (msg as any).tool_results.length > 0)) {
        const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];

        if ((msg as any).tool_results && (msg as any).tool_results.length > 0) {
          for (const toolResult of (msg as any).tool_results) {
            const resultContent = toolResult.content || toolResult.result || "";
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: toolResult.tool_call_id || toolResult.id,
              content: typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent),
              is_error: toolResult.is_error || false,
            });
          }
        }

        // If this is a tool-role message with direct content (single tool result)
        if (msg.role === "tool" && toolResultBlocks.length === 0) {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: (msg as any).tool_call_id || new ObjectId().toHexString(),
            content: this.extractTextContent(msg.content) || "",
          });
        }

        if (toolResultBlocks.length > 0) {
          messages.push({ role: "user", content: toolResultBlocks });
        }
        continue;
      }

      // Handle regular user messages
      const textContent = this.extractTextContent(msg.content);
      if (textContent) {
        messages.push({ role: "user", content: textContent });
      }
    }

    // Ensure messages alternate correctly (Anthropic requires user/assistant alternation)
    const alternated = this.ensureMessageAlternation(messages);

    // Strip orphaned tool_result blocks whose tool_use_id doesn't appear
    // in the immediately preceding assistant message. Anthropic rejects these.
    return this.sanitizeToolResults(alternated);
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
  private sanitizeToolResults(messages: Anthropic.Messages.MessageParam[]): Anthropic.Messages.MessageParam[] {
    const result: Anthropic.Messages.MessageParam[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "user" && Array.isArray(msg.content)) {
        const hasToolResults = (msg.content as any[]).some(
          (block: any) => block.type === "tool_result",
        );

        if (hasToolResults) {
          // Collect valid tool_use IDs from the immediately preceding assistant message
          const prev = result[result.length - 1];
          const validToolUseIds = new Set<string>();
          if (prev?.role === "assistant" && Array.isArray(prev.content)) {
            for (const block of prev.content as any[]) {
              if (block.type === "tool_use" && block.id) {
                validToolUseIds.add(block.id);
              }
            }
          }

          // Keep only tool_result blocks with valid IDs, plus any non-tool_result blocks
          const filtered = (msg.content as any[]).filter((block: any) => {
            if (block.type === "tool_result") {
              const valid = validToolUseIds.has(block.tool_use_id);
              if (!valid) {
                this.context.log(
                  `Removing orphaned tool_result block with tool_use_id=${block.tool_use_id} at message index ${i}`,
                  { validToolUseIds: [...validToolUseIds] },
                  "AnthropicService.sanitizeToolResults",
                );
              }
              return valid;
            }
            return true;
          });

          // Skip the message entirely if nothing remains after filtering
          if (filtered.length > 0) {
            result.push({ ...msg, content: filtered });
          }
          continue;
        }
      }

      result.push(msg);
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
        arguments: JSON.stringify(block.input),
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
    const tokenData: AITokenStreamingData = {
      content,
      delta,
      position,
      isComplete,
    };
    return this.createStreamingEvent(StreamingEventType.TOKEN, tokenData, sessionId) as TokenStreamingEvent;
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
    return this.createStreamingEvent(StreamingEventType.REASONING, data, sessionId) as ReasoningStreamingEvent;
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
   * Build the common request parameters for Anthropic messages.create()
   */
  /**
   * Check if the current model supports extended thinking.
   */
  private supportsThinking(): boolean {
    const thinkingModels = ["claude-sonnet-4", "claude-3-7-sonnet", "claude-3-5-sonnet"];
    return thinkingModels.some((m) => this.modelId.includes(m));
  }

  private buildRequestParams(
    messages: Anthropic.Messages.MessageParam[],
    persona: IAIPersona,
    options?: { stream?: boolean }
  ): Anthropic.Messages.MessageCreateParams {
    const tools = this.convertToolsToAnthropicFormat(persona.tools);
    const enableThinking = this.supportsThinking() && persona.modelConfig?.enableThinking !== false;
    const params: Anthropic.Messages.MessageCreateParams = {
      model: this.modelId,
      max_tokens: persona.modelConfig?.maxTokens || 16000,
      messages,
      system: this.createSystemPrompt(persona).content,
    };

    if (enableThinking) {
      // Extended thinking requires budget_tokens and disallows temperature/top_p
      (params as any).thinking = {
        type: "enabled",
        budget_tokens: persona.modelConfig?.thinkingBudget || 10000,
      };
    } else {
      // Anthropic does not allow both temperature and top_p simultaneously
      if (persona.modelConfig?.topP != null && persona.modelConfig?.temperature == null) {
        (params as any).top_p = persona.modelConfig.topP;
      } else {
        params.temperature = persona.modelConfig?.temperature ?? 0.7;
      }
    }

    if (tools && tools.length > 0) {
      params.tools = tools;
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
  }): Promise<{ content: string; finishReason: string; toolCalls: any[]; reasoning?: string; assistantPersisted?: boolean }> {
    const { sessionId, message, persona, history, messageId } = args;

    const messages = this.convertHistoryToAnthropicFormat(history);
    messages.push({ role: "user", content: message });

    let accumulatedText = "";
    let accumulatedReasoning = "";
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason = "stop";
    const collectedToolCalls: any[] = [];

    // Track current content blocks being streamed
    const currentBlocks: Map<number, { type: string; id?: string; name?: string; inputJson: string }> = new Map();

    const params = this.buildRequestParams(messages, persona, { stream: true });
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
            currentBlocks.set(index, { type: "thinking", inputJson: "" });
          } else if (chunk.content_block?.type === "text") {
            currentBlocks.set(index, { type: "text", inputJson: "" });
          }
          break;
        }
        case "content_block_delta": {
          const index = chunk.index;
          const block = currentBlocks.get(index);
          if (!block) break;

          if (chunk.delta?.type === "thinking_delta" && block.type === "thinking") {
            const delta = chunk.delta.thinking || "";
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
          if (block?.type === "tool_use" && block.id && block.name) {
            const parsedInput = this.safeParseJSON(block.inputJson);
            collectedToolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: block.inputJson,
              },
            });
            // Emit tool call complete event
            const toolEvent = this.createToolCallEvent(
              block.id,
              block.name,
              block.inputJson,
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

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const params = this.buildRequestParams(messages, persona);
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
          { toolId: toolBlock.id, input: toolBlock.input },
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
    messageId?: string
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
        const result = await this.runToolLoop(messages, persona, this.chatState.id, messageId);

        return this.buildCompletion(result.content, result.finishReason, result.toolCalls);
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
          });

          // When streaming via SSE, tool_call events have already been sent
          // to the client. The client will execute the tools and call back
          // with role='tool' + continueAfterTools. Do NOT execute tools
          // server-side here — that causes dual execution and corrupted
          // conversation history.
          const completion = this.buildCompletion(streamResult.content, streamResult.finishReason, streamResult.toolCalls);
          // If the assistant message was already persisted before the SSE completion event
          // (to prevent race conditions with executeMacro), flag the completion so
          // processAIResponse in ReactorConversationService can skip the duplicate persist.
          if (streamResult.assistantPersisted) {
            (completion as any).__persisted = true;
          }
          return completion;
        }

        // Non-streaming path with tool loop
        const result = await this.runToolLoop(messages, persona, this.chatState.id, messageId);
        return this.buildCompletion(result.content, result.finishReason, result.toolCalls);
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
  private buildCompletion(content: string, finishReason: string, toolCalls: any[]): AIChatCompletion {
    return {
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
          const persona = await this.personaProvider.getPersona(personaId);
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
