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
import {
  ReactorConversationHistory,
  ReactorConversationHistoryItem,
} from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import { CompletionStreamingEvent, ErrorStreamingEvent, StreamingEvent, StreamingEventType, StreamingMode, TokenStreamingEvent, ToolCallStreamingEvent } from "../types/streaming.types";
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
    return this.ensureMessageAlternation(messages);
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
  private buildRequestParams(
    messages: Anthropic.Messages.MessageParam[],
    persona: IAIPersona,
    options?: { stream?: boolean }
  ): Anthropic.Messages.MessageCreateParams {
    const tools = this.convertToolsToAnthropicFormat(persona.tools);
    const params: Anthropic.Messages.MessageCreateParams = {
      model: this.modelId,
      max_tokens: persona.modelConfig?.maxTokens || 8192,
      messages,
      system: this.createSystemPrompt(persona).content,
      temperature: persona.modelConfig?.temperature || 0.7,
      top_p: persona.modelConfig?.topP || 1.0,
    };

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
  }): Promise<{ content: string; finishReason: string; toolCalls: any[] }> {
    const { sessionId, message, persona, history, messageId } = args;

    const messages = this.convertHistoryToAnthropicFormat(history);
    messages.push({ role: "user", content: message });

    let accumulatedText = "";
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
          } else if (chunk.content_block?.type === "text") {
            currentBlocks.set(index, { type: "text", inputJson: "" });
          }
          break;
        }
        case "content_block_delta": {
          const index = chunk.index;
          const block = currentBlocks.get(index);
          if (!block) break;

          if (chunk.delta?.type === "text_delta") {
            const delta = chunk.delta.text || "";
            accumulatedText += delta;
            const event = this.createTokenEvent(
              accumulatedText,
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

    // Send completion event
    const completionEvent = this.createCompletionEvent(
      accumulatedText,
      { totalTokens, promptTokens, completionTokens, finishReason, model: this.modelId },
      sessionId
    );
    completionEvent.messageId = messageId;
    await this.streamingTransportManager.sendEventToSession(sessionId, completionEvent);

    return {
      content: accumulatedText,
      finishReason,
      toolCalls: collectedToolCalls,
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
      const persona: IAIPersona = await this.personaProvider.getPersona(
        this.chatState.personaId
      );

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
            persona: this.chatState.persona,
            history: this.chatState.history,
            messageId,
          });

          // If the stream ended with tool_use, run the tool loop
          if (streamResult.finishReason === "tool_use" && streamResult.toolCalls.length > 0) {
            // Add the streamed assistant message to messages context
            const assistantContent: any[] = [];
            if (streamResult.content) {
              assistantContent.push({ type: "text", text: streamResult.content });
            }
            for (const tc of streamResult.toolCalls) {
              assistantContent.push({
                type: "tool_use",
                id: tc.id,
                name: tc.function.name,
                input: this.safeParseJSON(tc.function.arguments),
              });
            }
            messages.push({ role: "assistant", content: assistantContent });

            // Execute tools and continue loop
            const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
            for (const tc of streamResult.toolCalls) {
              const result = await this.executeToolCall({
                type: "tool_use",
                id: tc.id,
                name: tc.function.name,
                input: this.safeParseJSON(tc.function.arguments),
              });
              toolResults.push(result);
            }
            messages.push({ role: "user", content: toolResults });

            const loopResult = await this.runToolLoop(messages, persona, this.chatState.id, messageId);
            return this.buildCompletion(loopResult.content, loopResult.finishReason, loopResult.toolCalls);
          }

          return this.buildCompletion(streamResult.content, streamResult.finishReason, streamResult.toolCalls);
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
    return this.buildCompletion(
      "I'm experiencing some technical difficulties right now. Please try again in a moment.",
      "stop",
      []
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
