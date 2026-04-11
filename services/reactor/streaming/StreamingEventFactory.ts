import { ObjectId } from "mongodb";
import {
  StreamingEvent,
  StreamingEventType,
  TokenStreamingEvent,
  ReasoningStreamingEvent,
  ToolCallStreamingEvent,
  CompletionStreamingEvent,
  ErrorStreamingEvent,
  ToolIterationLimitStreamingEvent,
  CompactionStreamingEvent,
} from "../types/streaming.types";
import {
  AITokenStreamingData,
  AIToolCallStreamingData,
  AIErrorStreamingData,
} from "../../../types/service.types";

/**
 * Shared factory for creating streaming events with guaranteed consistent
 * data shapes across all AI providers (OpenAI, Google AI, etc.).
 *
 * Every streaming event type has exactly one creation path through this
 * factory, eliminating the data-shape mismatches that occur when each
 * provider maintains its own event helpers.
 */
export class StreamingEventFactory {
  // ── Token ────────────────────────────────────────────────────────────

  /**
   * Create a token streaming event.
   *
   * @param delta    The incremental text produced by this chunk
   * @param position Byte-offset in the accumulated response so far
   * @param opts     Optional session / message identifiers
   */
  static createTokenEvent(
    delta: string,
    position: number,
    opts: StreamingEventIds = {},
  ): TokenStreamingEvent {
    const data: AITokenStreamingData = {
      content: delta,
      delta,
      position,
      isComplete: false,
    };
    return StreamingEventFactory.base(
      StreamingEventType.TOKEN,
      data,
      opts,
    ) as TokenStreamingEvent;
  }

  // ── Reasoning / Thinking ─────────────────────────────────────────────

  /**
   * Create a reasoning (chain-of-thought) streaming event.
   * Used by OpenAI o1/o3 (reasoning_content) and Gemini thinking models.
   */
  static createReasoningEvent(
    delta: string,
    position: number,
    opts: StreamingEventIds = {},
  ): ReasoningStreamingEvent {
    const data: AITokenStreamingData = {
      content: delta,
      delta,
      position,
      isComplete: false,
    };
    return StreamingEventFactory.base(
      StreamingEventType.REASONING,
      data,
      opts,
    ) as ReasoningStreamingEvent;
  }

  // ── Tool Call ────────────────────────────────────────────────────────

  /**
   * Create a tool-call streaming event.
   *
   * @param id            Tool call identifier (from the AI provider)
   * @param name          Function/tool name
   * @param toolArguments JSON-stringified arguments
   * @param isComplete    Whether the tool has been executed. false = pending
   *                      client-side approval/execution (PROMPT/PLAN/SAFE_AUTO).
   *                      true = already executed by the server (AUTO mode) or
   *                      signalling completion of a previously started tool.
   * @param result        Optional execution result (set after macro runs)
   */
  static createToolCallEvent(
    id: string,
    name: string,
    toolArguments: string,
    isComplete: boolean = false,
    result?: any,
    opts: StreamingEventIds = {},
  ): ToolCallStreamingEvent {
    const toolCallId = id || new ObjectId().toString();
    const data: AIToolCallStreamingData = {
      id: toolCallId,
      name,
      arguments: toolArguments,
      isComplete,
      result,
    };
    return StreamingEventFactory.base(
      StreamingEventType.TOOL_CALL,
      data,
      opts,
    ) as ToolCallStreamingEvent;
  }

  // ── Completion ───────────────────────────────────────────────────────

  /**
   * Create a completion streaming event.
   *
   * The data shape is **flat** `{ content, finishReason, thinking? }` to
   * match the client's `CompletionStreamingEvent` expectation.  Provider-
   * specific metadata (token counts, model name) should NOT be included
   * here — persist it separately if needed.
   */
  static createCompletionEvent(
    content: string,
    finishReason: string = "stop",
    thinking?: string,
    opts: StreamingEventIds = {},
    images?: Array<{ b64_json?: string; url?: string; mimeType?: string }>,
  ): CompletionStreamingEvent {
    const data: { content: string; finishReason: string; thinking?: string; images?: Array<{ b64_json?: string; url?: string; mimeType?: string }> } = {
      content,
      finishReason,
    };
    if (thinking) {
      data.thinking = thinking;
    }
    if (images && images.length > 0) {
      data.images = images;
    }
    return StreamingEventFactory.base(
      StreamingEventType.COMPLETE,
      data,
      opts,
    ) as CompletionStreamingEvent;
  }

  // ── Error ────────────────────────────────────────────────────────────

  /**
   * Create an error streaming event.
   *
   * Shape: `{ code, message, details? }` matching `AIErrorStreamingData`.
   */
  static createErrorEvent(
    code: string,
    message: string,
    details?: any,
    opts: StreamingEventIds = {},
  ): ErrorStreamingEvent {
    const data: AIErrorStreamingData = { code, message, details };
    return StreamingEventFactory.base(
      StreamingEventType.ERROR,
      data,
      opts,
    ) as ErrorStreamingEvent;
  }

  // ── Tool Iteration Limit ─────────────────────────────────────────────

  /**
   * Create a tool-iteration-limit event, sent when the AUTO tool loop
   * exhausts the configured maximum iterations.
   */
  static createToolIterationLimitEvent(
    iterationsCompleted: number,
    maxIterations: number,
    partialContent: string,
    opts: StreamingEventIds = {},
  ): ToolIterationLimitStreamingEvent {
    return StreamingEventFactory.base(
      StreamingEventType.TOOL_ITERATION_LIMIT,
      { iterationsCompleted, maxIterations, partialContent },
      opts,
    ) as ToolIterationLimitStreamingEvent;
  }

  // ── Compaction ───────────────────────────────────────────────────────

  static createCompactionStartEvent(
    reason: string,
    tokensBefore: number,
    maxTokens: number,
    percentageUsed: number,
    opts: StreamingEventIds = {},
  ): CompactionStreamingEvent {
    return StreamingEventFactory.base(
      StreamingEventType.COMPACTION,
      { phase: 'start', reason, tokensBefore, maxTokens, percentageUsed },
      opts,
    ) as CompactionStreamingEvent;
  }

  static createCompactionProgressEvent(
    messagesArchived: number,
    opts: StreamingEventIds = {},
  ): CompactionStreamingEvent {
    return StreamingEventFactory.base(
      StreamingEventType.COMPACTION,
      { phase: 'progress', messagesArchived },
      opts,
    ) as CompactionStreamingEvent;
  }

  static createCompactionCompleteEvent(
    tokensBefore: number,
    tokensAfter: number,
    maxTokens: number,
    messagesArchived: number,
    usedFallback: boolean,
    opts: StreamingEventIds = {},
  ): CompactionStreamingEvent {
    return StreamingEventFactory.base(
      StreamingEventType.COMPACTION,
      {
        phase: 'complete',
        tokensBefore,
        tokensAfter,
        maxTokens,
        messagesArchived,
        percentageAfter: maxTokens > 0 ? Math.round(tokensAfter / maxTokens * 100) : undefined,
        usedFallback,
      },
      opts,
    ) as CompactionStreamingEvent;
  }

  static createCompactionErrorEvent(
    errorMessage: string,
    opts: StreamingEventIds = {},
  ): CompactionStreamingEvent {
    return StreamingEventFactory.base(
      StreamingEventType.COMPACTION,
      { phase: 'error', errorMessage },
      opts,
    ) as CompactionStreamingEvent;
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private static base(
    type: StreamingEventType,
    data: any,
    opts: StreamingEventIds,
  ): StreamingEvent {
    return {
      type,
      timestamp: new Date(),
      sessionId: opts.sessionId ?? "",
      conversationId: opts.conversationId ?? "",
      messageId: opts.messageId ?? "",
      data,
    };
  }
}

/**
 * Common identifiers attached to every streaming event.
 */
export interface StreamingEventIds {
  sessionId?: string;
  conversationId?: string;
  messageId?: string;
}
