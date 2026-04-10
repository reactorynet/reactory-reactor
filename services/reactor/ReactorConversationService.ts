import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import AnthropicService from "./providers/AnthropicService";
import OllamaAIService from "./providers/OllamaAIService";
import {
  IOpenAIService,
  IReactorProviderService,
  IAIPersona,
  IAIProviderService,
  KnownAIProviders,
  ReactorInitChatResponse,
  ReactorInitiateSSEResponse,
  ReactorChatState,
  IReactorConversationsService,
} from "../../types/service.types";
import ReactorConversationModel, {
  ReactorConversationDocument,
  TReactorConversationDocument,
  TReactorConversationModel,
  ValidProviderResponseTypes,
} from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import AIPersonaProvider from "./AIPersonaProvider";
import ReactorMessageProcessingService from "./ReactorMessageProcessingService";
import nodePath from "path";
import fs from "fs";
import GoogleAIService from "./providers/GoogleAIService";
import { v4 } from "uuid";
import { ObjectId } from "mongodb";
import safeUrl from "@reactory/server-core/utils/url/safeUrl";
import resolveImageUrls from "@reactory/server-modules/reactory-reactor/utils/resolveImageUrls";
import { ChatCompletion, ChatCompletionMessage } from "openai/resources";
import ReactorMacroService from "./providers/ReactorMacroService";
import DocumentChunkingService from "./DocumentChunkingService";
import { ReactorConversationHistoryItem } from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import ReactoryFile, {
  ReactoryFileDocument,
} from "@reactory/server-modules/reactory-core/models/CoreFile";
import { id } from "schema/reflection";
import { CompletionStreamingEvent, ToolCallStreamingEvent, ToolIterationLimitStreamingEvent, PromptMergeStrategy, StreamingEventType, StreamingMode } from "./types/streaming.types";
import Helpers from "authentication/strategies/helpers";
import { StreamingSessionManager } from "./StreamingSessionManager";
import { StreamingTransportManager } from "./StreamingTransportManager";
import { StreamingEventFactory } from "./streaming/StreamingEventFactory";
import { ChatSessionResourceManager } from "./ChatSessionResourceManager";
import { loadSessionMcpConfig } from "../../ai/macro/mcp/session-config";
/**
 * Enhanced error response interface with correlation tracking
 */
interface ReactorErrorResponse {
  __typename: "ReactorErrorResponse";
  code: string;
  message: string;
  details?: any;
  timestamp: Date;
  recoverable: boolean;
  suggestion?: string;
  correlationId: string;
  operation?: string;
  userId?: string;
  conversationId?: string;
  retryAfter?: number; // For rate limiting errors
  errorCategory:
    | "VALIDATION"
    | "PERMISSION"
    | "RESOURCE_NOT_FOUND"
    | "EXTERNAL_SERVICE"
    | "INTERNAL"
    | "RATE_LIMIT"
    | "TIMEOUT";
}

/**
 * Error classification enum for better error handling
 */
enum ErrorCategory {
  VALIDATION = "VALIDATION", // Input validation errors
  PERMISSION = "PERMISSION", // Authorization/permission errors
  RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND", // Resource not found errors
  EXTERNAL_SERVICE = "EXTERNAL_SERVICE", // External API/service errors
  INTERNAL = "INTERNAL", // Internal service errors
  RATE_LIMIT = "RATE_LIMIT", // Rate limiting errors
  TIMEOUT = "TIMEOUT", // Timeout errors
}

/**
 * Error codes for consistent error identification
 */
enum ReactorErrorCode {
  // Validation errors
  INVALID_INPUT = "INVALID_INPUT",
  MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD",
  INVALID_FORMAT = "INVALID_FORMAT",

  // Permission errors
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  INSUFFICIENT_PERMISSIONS = "INSUFFICIENT_PERMISSIONS",

  // Resource errors
  CONVERSATION_NOT_FOUND = "CONVERSATION_NOT_FOUND",
  PERSONA_NOT_FOUND = "PERSONA_NOT_FOUND",
  USER_NOT_FOUND = "USER_NOT_FOUND",
  MACRO_NOT_FOUND = "MACRO_NOT_FOUND",

  // External service errors
  AI_PROVIDER_ERROR = "AI_PROVIDER_ERROR",
  AI_PROVIDER_TIMEOUT = "AI_PROVIDER_TIMEOUT",
  AI_PROVIDER_RATE_LIMIT = "AI_PROVIDER_RATE_LIMIT",

  // Internal errors
  DATABASE_ERROR = "DATABASE_ERROR",
  TOKEN_CALCULATION_ERROR = "TOKEN_CALCULATION_ERROR",
  CONVERSATION_UPDATE_ERROR = "CONVERSATION_UPDATE_ERROR",

  // Message processing errors
  MESSAGE_ERROR = "MESSAGE_ERROR",
  MACRO_ERROR = "MACRO_ERROR",
  IMAGE_ERROR = "IMAGE_ERROR",
  FILE_ERROR = "FILE_ERROR",

  // System errors
  INTERNAL_ERROR = "INTERNAL_ERROR",
  CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
}
import OpenAI from "openai";
import {
  ChatState,
  MacroComponentDefinition,
  MacroToolDefinition,
  ToolApprovalMode,
} from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { session } from "passport";



/**
 * ReactorConversationService - Core AI Conversation Management Service
 *
 * This service orchestrates AI-powered conversations in the Reactory platform, providing
 * comprehensive conversation lifecycle management, multi-provider AI integration, and
 * advanced features like token management, tool execution, and error recovery.
 *
 * Key Features:
 * - Multi-provider AI support (OpenAI, xAI, Google AI)
 * - Atomic token counting and conversation truncation
 * - Race condition prevention through MongoDB aggregation pipelines
 * - Comprehensive error handling with correlation tracking
 * - Tool and macro execution with parallel/sequential modes
 * - File attachment and image processing capabilities
 *
 * @service reactor.ReactorConversationService@1.0.0
 * @author Reactory Development Team
 * @version 1.0.0
 * @since 2024
 */

// Business Logic Constants
const TOKEN_LIMITS = {
  /** Default maximum tokens for new conversations when persona doesn't specify */
  DEFAULT_MAX_TOKENS: 200000,

  /** Percentage over limit that triggers automatic truncation (120% of limit) */
  TRUNCATION_THRESHOLD_MULTIPLIER: 1.2,

  /** Target percentage of tokens to keep after truncation (80% of limit) */
  TRUNCATION_TARGET_MULTIPLIER: 0.8,

  /** Average characters per token used for rough estimation */
  CHARS_PER_TOKEN_ESTIMATE: 4,
} as const;

const RETRY_SETTINGS = {
  /** Maximum number of retry attempts for recoverable errors */
  MAX_RETRIES: 3,

  /** Base delay for exponential backoff in milliseconds */
  RETRY_BASE_DELAY_MS: 1000,

  /** Suggested retry delay for rate limit errors in seconds */
  RATE_LIMIT_RETRY_DELAY_SECONDS: 60,
} as const;

const DATABASE_CONSTANTS = {
  /** MongoDB duplicate key error code */
  DUPLICATE_KEY_ERROR_CODE: 11000,
} as const;

@service({
  id: "reactor.ReactorConversationService@1.0.0",
  name: "ReactorConversationService",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for managing reactor chat conversations",
  serviceType: "ai",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "reactor.OpenAIService@1.0.0", alias: "openaiService" },
    { id: "reactor.GoogleAIService@1.0.0", alias: "googleAIService" },
    { id: "reactor.AnthropicService@1.0.0", alias: "anthropicService" },
    { id: "reactor.OllamaAIService@1.0.0", alias: "ollamaService" },
    { id: "reactor.ReactorProviderService@1.0.0", alias: "providerService" },
    {
      id: "reactor.ReactorMessageProcessingService@1.0.0",
      alias: "messageProcessingService",
    },
    { id: "reactor.AIPersonaProvider@1.0.0", alias: "personaProvider" },
    { id: "reactor.ReactorMacroService@1.0.0", alias: "macroService" },
    { id: "reactor.DocumentChunkingService@1.0.0", alias: "chunkingService" },
    { id: "reactor.StreamingSessionManager@1.0.0", alias: "streamingSessionManager" },
    { id: "reactor.StreamingTransportManager@1.0.0", alias: "streamingTransportManager" },
  ],
})
export default class ReactorConversationService
  implements IReactorConversationsService
{
  /** Core Reactory context providing user, logging, and service access */
  private context: Reactory.Server.IReactoryContext;

  /** OpenAI service for OpenAI and xAI provider interactions */
  // @ts-ignore - injected via service dependencies
  private openaiService: IOpenAIService;

  /** Google AI service for Google Gemini interactions */
  // @ts-ignore - injected via service dependencies
  private googleAIService: GoogleAIService;

  /** Anthropic service for Anthropic AI interactions */
  // @ts-ignore - injected via service dependencies
  private anthropicService: AnthropicService;

  /** Ollama service for local Ollama model interactions */
  // @ts-ignore - injected via service dependencies
  private ollamaService: OllamaAIService;

  /** Provider service for managing multiple AI providers and adapters */
  // @ts-ignore - injected via service dependencies
  private providerService: IReactorProviderService;

  /** AI persona provider for persona definitions and configurations */
  // @ts-ignore - injected via service dependencies
  private personaProvider: AIPersonaProvider;

  /** Message processing service for advanced message handling */
  // @ts-ignore - injected via service dependencies
  private messageProcessingService: ReactorMessageProcessingService;

  /** Macro service for executing custom macros and tools */
  // @ts-ignore - injected via service dependencies
  private macroService: ReactorMacroService;

  /** Document chunking service for token estimation and text processing */
  private chunkingService: DocumentChunkingService;

  /** File service for handling file uploads and attachments */
  // @ts-ignore - injected via service dependencies
  private fileService: Reactory.Service.IReactoryFileService;

  /** Streaming session manager for managing streaming sessions */
  private streamingSessionManager: StreamingSessionManager;

  /** Streaming transport manager for managing streaming transports */
  private streamingTransportManager: StreamingTransportManager;

  /** Per-conversation file loggers keyed by conversationId */
  private sessionLoggers: Map<string, ChatSessionResourceManager> = new Map();

  /**
   * Initialize the ReactorConversationService with dependencies
   *
   * @param props - Service properties containing dependency injections
   * @param context - Reactory context with user session and logging capabilities
   */
  constructor(
    props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext
  ) {
    this.context = context;
    this.chunkingService = (props.dependencies as any)
      ?.chunkingService as DocumentChunkingService;
    this.streamingSessionManager = (props.dependencies as any)
      ?.streamingSessionManager as StreamingSessionManager;
    this.streamingTransportManager = (props.dependencies as any)
      ?.streamingTransportManager as StreamingTransportManager;
  }

  /**
   * Estimates the token count for a single conversation history item,
   * including content, tool_calls arguments, tool_results, tool_errors, and thinking.
   * Uses the same chars/4 heuristic as the chunking service.
   */
  private estimateHistoryItemTokens(msg: ReactorConversationHistoryItem): number {
    let tokens = 0;

    // 1. Content field (the only thing the old code counted)
    if (msg.content) {
      if (typeof msg.content === 'string') {
        tokens += Math.ceil(msg.content.length / TOKEN_LIMITS.CHARS_PER_TOKEN_ESTIMATE);
      } else {
        // content can be an object/array (e.g. multimodal parts)
        const serialized = JSON.stringify(msg.content);
        tokens += Math.ceil(serialized.length / TOKEN_LIMITS.CHARS_PER_TOKEN_ESTIMATE);
      }
    }

    // 2. Tool calls — each has function.name + function.arguments
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.name) {
          tokens += Math.ceil(tc.function.name.length / TOKEN_LIMITS.CHARS_PER_TOKEN_ESTIMATE);
        }
        if (tc.function?.arguments) {
          const args = typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments);
          tokens += Math.ceil(args.length / TOKEN_LIMITS.CHARS_PER_TOKEN_ESTIMATE);
        }
      }
    }

    // 3. Tool results — each has content and/or result
    if (msg.tool_results && msg.tool_results.length > 0) {
      for (const tr of msg.tool_results) {
        const resultPayload = tr.content ?? tr.result;
        if (resultPayload) {
          const text = typeof resultPayload === 'string'
            ? resultPayload
            : JSON.stringify(resultPayload);
          tokens += Math.ceil(text.length / TOKEN_LIMITS.CHARS_PER_TOKEN_ESTIMATE);
        }
      }
    }

    // 4. Tool errors
    if (msg.tool_errors && msg.tool_errors.length > 0) {
      for (const te of msg.tool_errors) {
        if (te.error) {
          tokens += Math.ceil(te.error.length / TOKEN_LIMITS.CHARS_PER_TOKEN_ESTIMATE);
        }
      }
    }

    // 5. Thinking/reasoning content
    if (msg.thinking && typeof msg.thinking === 'string') {
      tokens += Math.ceil(msg.thinking.length / TOKEN_LIMITS.CHARS_PER_TOKEN_ESTIMATE);
    }

    return tokens;
  }

  /**
   * MongoDB aggregation expression that estimates the total token count for a
   * history array field. Accounts for content (string or object), tool_calls
   * arguments, tool_results content/result, tool_errors, and thinking.
   *
   * Returns a $reduce expression to use inside $addFields.
   */
  private static get tokenCountAggregationExpression() {
    const charsPerToken = TOKEN_LIMITS.CHARS_PER_TOKEN_ESTIMATE;

    // Helper: estimate tokens for a value — if string, use strLenCP; otherwise 0
    const strTokens = (field: string) => ({
      $cond: {
        if: { $eq: [{ $type: field }, "string"] },
        then: { $divide: [{ $strLenCP: field }, charsPerToken] },
        else: {
          $cond: {
            if: { $in: [{ $type: field }, ["object", "array"]] },
            then: {
              $let: {
                vars: { serialized: { $toString: field } },
                in: {
                  $cond: {
                    if: { $eq: [{ $type: "$$serialized" }, "string"] },
                    then: { $divide: [{ $strLenCP: "$$serialized" }, charsPerToken] },
                    else: 0,
                  },
                },
              },
            },
            else: 0,
          },
        },
      },
    });

    return {
      $reduce: {
        input: "$history",
        initialValue: 0,
        in: {
          $add: [
            "$$value",
            // ── content field ──
            {
              $cond: {
                if: { $ne: ["$$this.content", null] },
                then: strTokens("$$this.content"),
                else: 0,
              },
            },
            // ── tool_calls: sum function.arguments lengths ──
            {
              $cond: {
                if: {
                  $and: [
                    { $ne: ["$$this.tool_calls", null] },
                    { $isArray: "$$this.tool_calls" },
                    { $gt: [{ $size: "$$this.tool_calls" }, 0] },
                  ],
                },
                then: {
                  $reduce: {
                    input: "$$this.tool_calls",
                    initialValue: 0,
                    in: {
                      $add: [
                        "$$value",
                        {
                          $cond: {
                            if: { $eq: [{ $type: "$$this.function.arguments" }, "string"] },
                            then: { $divide: [{ $strLenCP: "$$this.function.arguments" }, charsPerToken] },
                            else: 0,
                          },
                        },
                      ],
                    },
                  },
                },
                else: 0,
              },
            },
            // ── tool_results: sum content/result lengths ──
            {
              $cond: {
                if: {
                  $and: [
                    { $ne: ["$$this.tool_results", null] },
                    { $isArray: "$$this.tool_results" },
                    { $gt: [{ $size: "$$this.tool_results" }, 0] },
                  ],
                },
                then: {
                  $reduce: {
                    input: "$$this.tool_results",
                    initialValue: 0,
                    in: {
                      $add: [
                        "$$value",
                        {
                          $cond: {
                            if: {
                              $and: [
                                { $ne: ["$$this.content", null] },
                                { $eq: [{ $type: "$$this.content" }, "string"] },
                              ],
                            },
                            then: { $divide: [{ $strLenCP: "$$this.content" }, charsPerToken] },
                            else: {
                              $cond: {
                                if: {
                                  $and: [
                                    { $ne: ["$$this.result", null] },
                                    { $eq: [{ $type: "$$this.result" }, "string"] },
                                  ],
                                },
                                then: { $divide: [{ $strLenCP: "$$this.result" }, charsPerToken] },
                                else: 0,
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
                else: 0,
              },
            },
            // ── thinking field ──
            {
              $cond: {
                if: {
                  $and: [
                    { $ne: ["$$this.thinking", null] },
                    { $eq: [{ $type: "$$this.thinking" }, "string"] },
                  ],
                },
                then: { $divide: [{ $strLenCP: "$$this.thinking" }, charsPerToken] },
                else: 0,
              },
            },
          ],
        },
      },
    };
  }

  /**
   * Get or create a ChatSessionResourceManager for a given conversation.
   * Logs are written to REACTORY_DATA/profiles/{userId}/chats/{personaId}/{conversationId}/
   */
  private getSessionLogger(
    conversationId: string,
    personaId: string
  ): ChatSessionResourceManager | null {
    if (!conversationId || !personaId) return null;

    const existing = this.sessionLoggers.get(conversationId);
    if (existing) return existing;

    const userId = this.context.user?._id?.toString();
    if (!userId) return null;

    try {
      const logger = new ChatSessionResourceManager(userId, personaId, conversationId);
      this.sessionLoggers.set(conversationId, logger);
      // Register globally so other services (StreamingTransportManager, etc.) can find it
      ChatSessionResourceManager.register(conversationId, logger);
      return logger;
    } catch (e: any) {
      this.context.warn(`Failed to create session logger: ${e.message}`);
      return null;
    }
  }

  /**
   * Log to both the global context logger and the session-specific file logger.
   * Falls back to context-only logging when no session logger is available.
   *
   * If personaId is omitted but conversationId is provided and a logger
   * was already created for that conversation, the cached logger is used.
   */
  private sessionLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
    conversationId?: string,
    personaId?: string
  ): void {
    // Always log to the global context logger
    this.context[level](message, meta);

    // Additionally log to the session-specific file if available
    if (conversationId) {
      // Try cached logger first (avoids requiring personaId for internal helpers)
      let sessionLogger = this.sessionLoggers.get(conversationId) || null;
      if (!sessionLogger && personaId) {
        sessionLogger = this.getSessionLogger(conversationId, personaId);
      }
      if (sessionLogger) {
        sessionLogger[level](message, meta);
      }
    }
  }

  /**
   * Create a standardized error response with correlation tracking
   *
   * @param code - Error code from ReactorErrorCode enum
   * @param message - Human-readable error message
   * @param options - Additional error context and options
   * @returns Standardized ReactorErrorResponse object
   */
  private createErrorResponse(
    code: ReactorErrorCode,
    message: string,
    options: {
      details?: any;
      recoverable?: boolean;
      suggestion?: string;
      operation?: string;
      conversationId?: string;
      retryAfter?: number;
      errorCategory?: ErrorCategory;
      correlationId?: string;
    } = {}
  ): ReactorErrorResponse {
    const correlationId = options.correlationId || v4();
    const errorCategory = options.errorCategory || this.categorizeError(code);

    // Log error with correlation ID for debugging
    this.context.error(`[${correlationId}] ${message}`, {
      code,
      operation: options.operation,
      conversationId: options.conversationId,
      userId: this.context.user?._id,
      details: options.details,
      errorCategory,
      timestamp: new Date().toISOString(),
    });

    return {
      __typename: "ReactorErrorResponse",
      code,
      message,
      details: options.details,
      timestamp: new Date(),
      recoverable: options.recoverable ?? this.isRecoverableError(code),
      suggestion: options.suggestion || this.getErrorSuggestion(code),
      correlationId,
      operation: options.operation,
      userId: this.context.user?._id?.toString(),
      conversationId: options.conversationId,
      retryAfter: options.retryAfter,
      errorCategory,
    };
  }

  /**
   * Categorize error codes into error categories
   */
  private categorizeError(code: ReactorErrorCode): ErrorCategory {
    const validationErrors = [
      ReactorErrorCode.INVALID_INPUT,
      ReactorErrorCode.MISSING_REQUIRED_FIELD,
      ReactorErrorCode.INVALID_FORMAT,
    ];

    const permissionErrors = [
      ReactorErrorCode.UNAUTHORIZED,
      ReactorErrorCode.FORBIDDEN,
      ReactorErrorCode.INSUFFICIENT_PERMISSIONS,
    ];

    const resourceErrors = [
      ReactorErrorCode.CONVERSATION_NOT_FOUND,
      ReactorErrorCode.PERSONA_NOT_FOUND,
      ReactorErrorCode.USER_NOT_FOUND,
      ReactorErrorCode.MACRO_NOT_FOUND,
    ];

    const externalServiceErrors = [
      ReactorErrorCode.AI_PROVIDER_ERROR,
      ReactorErrorCode.AI_PROVIDER_TIMEOUT,
    ];

    const rateLimitErrors = [ReactorErrorCode.AI_PROVIDER_RATE_LIMIT];

    if (validationErrors.includes(code)) return ErrorCategory.VALIDATION;
    if (permissionErrors.includes(code)) return ErrorCategory.PERMISSION;
    if (resourceErrors.includes(code)) return ErrorCategory.RESOURCE_NOT_FOUND;
    if (externalServiceErrors.includes(code))
      return ErrorCategory.EXTERNAL_SERVICE;
    if (rateLimitErrors.includes(code)) return ErrorCategory.RATE_LIMIT;

    return ErrorCategory.INTERNAL;
  }

  /**
   * Determine if an error is recoverable based on error code
   */
  private isRecoverableError(code: ReactorErrorCode): boolean {
    const recoverableErrors = [
      ReactorErrorCode.AI_PROVIDER_ERROR,
      ReactorErrorCode.AI_PROVIDER_TIMEOUT,
      ReactorErrorCode.AI_PROVIDER_RATE_LIMIT,
      ReactorErrorCode.DATABASE_ERROR,
      ReactorErrorCode.MESSAGE_ERROR,
      ReactorErrorCode.INTERNAL_ERROR,
    ];

    return recoverableErrors.includes(code);
  }

  /**
   * Get appropriate suggestion based on error code
   */
  private getErrorSuggestion(code: ReactorErrorCode): string {
    const suggestions: Record<ReactorErrorCode, string> = {
      [ReactorErrorCode.INVALID_INPUT]:
        "Please check your input parameters and try again",
      [ReactorErrorCode.MISSING_REQUIRED_FIELD]:
        "Please provide all required fields",
      [ReactorErrorCode.INVALID_FORMAT]:
        "Please check the format of your input",
      [ReactorErrorCode.UNAUTHORIZED]: "Please log in and try again",
      [ReactorErrorCode.FORBIDDEN]:
        "You don't have permission to perform this action",
      [ReactorErrorCode.INSUFFICIENT_PERMISSIONS]:
        "Contact an administrator for the required permissions",
      [ReactorErrorCode.CONVERSATION_NOT_FOUND]:
        "Please check the conversation ID and try again",
      [ReactorErrorCode.PERSONA_NOT_FOUND]: "Please select a valid AI persona",
      [ReactorErrorCode.USER_NOT_FOUND]:
        "User session may have expired, please log in again",
      [ReactorErrorCode.MACRO_NOT_FOUND]:
        "Please check if the macro exists and you have access to it",
      [ReactorErrorCode.AI_PROVIDER_ERROR]: "Please try again in a few moments",
      [ReactorErrorCode.AI_PROVIDER_TIMEOUT]:
        "The AI service is taking longer than expected, please try again",
      [ReactorErrorCode.AI_PROVIDER_RATE_LIMIT]:
        "Too many requests, please wait before trying again",
      [ReactorErrorCode.DATABASE_ERROR]:
        "Database operation failed, please try again",
      [ReactorErrorCode.TOKEN_CALCULATION_ERROR]:
        "Error calculating tokens, please try again",
      [ReactorErrorCode.CONVERSATION_UPDATE_ERROR]:
        "Failed to update conversation, please try again",
      [ReactorErrorCode.MESSAGE_ERROR]:
        "Failed to send message, please try again",
      [ReactorErrorCode.MACRO_ERROR]:
        "Macro execution failed, please check the macro and try again",
      [ReactorErrorCode.IMAGE_ERROR]:
        "Image processing failed, please check the image format and size",
      [ReactorErrorCode.FILE_ERROR]:
        "File processing failed, please check the file formats and sizes",
      [ReactorErrorCode.INTERNAL_ERROR]:
        "An internal error occurred, please try again",
      [ReactorErrorCode.CONFIGURATION_ERROR]:
        "Service configuration error, please contact support",
    };

    return (
      suggestions[code] ||
      "Please try again or contact support if the problem persists"
    );
  }

  /**
   * Enhanced method to handle and wrap errors consistently
   */
  private handleError(
    error: any,
    operation: string,
    conversationId?: string,
    defaultCode: ReactorErrorCode = ReactorErrorCode.INTERNAL_ERROR
  ): ReactorErrorResponse {
    const correlationId = v4();

    // Extract error information
    let code = defaultCode;
    let message = error?.message || "An unexpected error occurred";
    let category = ErrorCategory.INTERNAL;
    let recoverable = true;
    let retryAfter: number | undefined;

    // Map common error patterns to specific error codes
    if (error?.message?.toLowerCase().includes("not found")) {
      if (error.message.includes("conversation")) {
        code = ReactorErrorCode.CONVERSATION_NOT_FOUND;
        category = ErrorCategory.RESOURCE_NOT_FOUND;
        recoverable = false;
      } else if (error.message.includes("persona")) {
        code = ReactorErrorCode.PERSONA_NOT_FOUND;
        category = ErrorCategory.RESOURCE_NOT_FOUND;
        recoverable = false;
      } else if (error.message.includes("user")) {
        code = ReactorErrorCode.USER_NOT_FOUND;
        category = ErrorCategory.PERMISSION;
        recoverable = false;
      }
    } else if (error?.message?.toLowerCase().includes("permission")) {
      code = ReactorErrorCode.INSUFFICIENT_PERMISSIONS;
      category = ErrorCategory.PERMISSION;
      recoverable = false;
    } else if (error?.message?.toLowerCase().includes("rate limit")) {
      code = ReactorErrorCode.AI_PROVIDER_RATE_LIMIT;
      category = ErrorCategory.RATE_LIMIT;
      retryAfter = RETRY_SETTINGS.RATE_LIMIT_RETRY_DELAY_SECONDS;
    } else if (error?.message?.toLowerCase().includes("timeout")) {
      code = ReactorErrorCode.AI_PROVIDER_TIMEOUT;
      category = ErrorCategory.EXTERNAL_SERVICE;
    } else if (error?.code === DATABASE_CONSTANTS.DUPLICATE_KEY_ERROR_CODE) {
      code = ReactorErrorCode.DATABASE_ERROR;
      message = "Duplicate entry detected";
      recoverable = false;
    }

    return this.createErrorResponse(code, message, {
      details: {
        originalError: error?.message,
        stack: error?.stack,
        errorCode: error?.code,
      },
      operation,
      conversationId,
      errorCategory: category,
      recoverable,
      retryAfter,
      correlationId,
    });
  }

  /**
   * Validate conversation document for common issues and inconsistencies
   *
   * This method performs comprehensive validation of conversation documents,
   * checking for missing required fields, inconsistent state, and potential
   * data corruption issues. It logs detailed information for debugging.
   *
   * @param conversation - The conversation document to validate
   * @param operation - The operation context (for logging)
   * @param context - Additional context information (for logging)
   *
   * @remarks
   * This method is called at critical points in conversation lifecycle:
   * - After creating new conversations
   * - Before and after database updates
   * - During token count operations
   * - When loading conversations for processing
   *
   * @since 1.0.0
   */
  private validateConversationDocument(
    conversation: any,
    operation: string,
    context: string = ""
  ): void {
    if (!conversation) {
      this.context.error(
        `Conversation document is null/undefined during ${operation}`,
        {
          operation,
          context,
          user: this.context.user?._id,
          timestamp: new Date().toISOString(),
        }
      );
      return;
    }

    const issues: string[] = [];
    const metadata: any = {
      operation,
      context,
      timestamp: new Date().toISOString(),
      user: this.context.user?._id,
    };

    // Critical: Check for missing MongoDB _id field
    // This can cause cascading failures in database operations
    if (!conversation._id) {
      issues.push("Missing _id field");
      metadata.missingId = true;
      // Enhanced logging for null _id cases - these are critical issues
      this.context.error("CRITICAL: Conversation document has null _id", {
        operation,
        context,
        conversationKeys: Object.keys(conversation),
        conversationType: typeof conversation,
        isDocument: conversation instanceof Object,
        timestamp: new Date().toISOString(),
      });
    } else {
      metadata.conversationId = conversation._id.toString();
    }

    // Validate user assignment - conversations must be associated with a user
    // This is critical for security and data isolation
    if (!conversation.user) {
      issues.push("Missing user assignment");
      metadata.missingUser = true;
    } else {
      const {
        _id: userId, email, firstName, lastName
      } = conversation.user;
      metadata.conversationUser = `${firstName} ${lastName} <${email}> (${userId})`;
    }

    // Check for required business fields
    if (!conversation.personaId) {
      issues.push("Missing personaId");
      metadata.missingPersonaId = true;
    }

    // Validate conversation lifecycle timestamps
    if (!conversation.started) {
      issues.push("Missing started timestamp");
      metadata.missingStarted = true;
    }

    // Log validation results for monitoring and debugging
    if (issues.length > 0) {
      this.context.error(`Conversation validation failed during ${operation}`, {
        ...metadata,
        issues,
        conversationKeys: Object.keys(conversation),
        conversationType: typeof conversation,
        isDocument: conversation instanceof Object,
      });
    } else {
      this.context.debug(
        `Conversation validation passed during ${operation}`,
        metadata
      );
    }
  }

  /**
   * Calculate and update the token count for a conversation using atomic aggregation
   * This method uses MongoDB's aggregation pipeline to calculate tokens atomically
   */
  private async updateConversationTokenCount(
    conversationId: string
  ): Promise<number> {
    this.sessionLog("debug", "Updating conversation token count", {
      conversationId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    }, conversationId);

    if (
      conversationId === null ||
      conversationId === undefined ||
      conversationId === ""
    ) {
      throw new Error(
        "Conversation ID is required for updateConversationTokenCount"
      );
    }

    try {
      // Use aggregation pipeline to calculate token count atomically
      const result = await ReactorConversationModel.aggregate([
        {
          $match: {
            _id: new ObjectId(conversationId),
            user: this.context.user._id,
          },
        },
        {
          $addFields: {
            // Calculate total tokens for all messages in history
            // Includes content, tool_calls arguments, tool_results, thinking
            calculatedTokenCount:
              ReactorConversationService.tokenCountAggregationExpression,
          },
        },
      ]).exec();

      if (!result || result.length === 0) {
        this.sessionLog("error", "Conversation not found during token count update", {
          conversationId,
          userId: this.context.user?._id,
        }, conversationId);
        throw new Error("Conversation not found");
      }

      const calculatedTokens = Math.ceil(result[0].calculatedTokenCount || 0);

      // Atomically update the conversation with the new token count
      const updatedConversation =
        await ReactorConversationModel.findOneAndUpdate(
          {
            _id: conversationId,
            user: this.context.user._id,
          },
          {
            $set: {
              tokenCount: calculatedTokens,
              updated: new Date(),
            },
          },
          {
            new: true,
            runValidators: true,
          }
        ).exec();

      if (!updatedConversation) {
        const errorResponse = this.createErrorResponse(
          ReactorErrorCode.CONVERSATION_UPDATE_ERROR,
          "Failed to update conversation token count",
          {
            operation: "updateConversationTokenCount",
            conversationId,
            recoverable: true,
          }
        );
        throw new Error(errorResponse.message);
      }

      // Validate the updated conversation
      this.validateConversationDocument(
        updatedConversation,
        "updateConversationTokenCount",
        "after_update"
      );

      this.sessionLog("debug", "Token count updated successfully", {
        conversationId,
        oldTokenCount: result[0].tokenCount,
        newTokenCount: calculatedTokens,
        userId: this.context.user?._id,
      }, conversationId);

      return calculatedTokens;
    } catch (error: any) {
      this.sessionLog("error", "Error updating conversation token count", {
        conversationId,
        userId: this.context.user?._id,
        error: error.message,
      }, conversationId);
      throw new Error(`Failed to update token count: ${error.message}`);
    }
  }

  /**
   * Check if conversation exceeds max tokens and handle accordingly
   */
  private async checkTokenLimit(conversationId: string): Promise<{
    exceedsLimit: boolean;
    currentTokens: number;
    maxTokens: number;
    shouldTruncate: boolean;
  }> {
    this.sessionLog("debug", "Checking token limit", {
      conversationId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    }, conversationId);

    const conversation = await ReactorConversationModel.findOne({
      _id: conversationId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.sessionLog("error", "Conversation not found during token limit check", {
        conversationId,
        userId: this.context.user?._id,
      }, conversationId);
      throw new Error("Conversation not found");
    }

    // Validate the conversation before checking token limits
    this.validateConversationDocument(
      conversation,
      "checkTokenLimit",
      "before_check"
    );

    const currentTokens = conversation.tokenCount || 0;
    const maxTokens = conversation.maxTokens;

    if (!maxTokens) {
      return {
        exceedsLimit: false,
        currentTokens,
        maxTokens: 0,
        shouldTruncate: false,
      };
    }

    const exceedsLimit = currentTokens > maxTokens;
    const shouldTruncate =
      exceedsLimit &&
      currentTokens > maxTokens * TOKEN_LIMITS.TRUNCATION_THRESHOLD_MULTIPLIER;

    return {
      exceedsLimit,
      currentTokens,
      maxTokens,
      shouldTruncate,
    };
  }

  /**
   * Atomically update token count and check limits in a single operation
   * This prevents race conditions between token count updates and limit checks
   */
  private async updateTokenCountAndCheckLimits(
    conversationId: string
  ): Promise<{
    currentTokens: number;
    maxTokens: number | null;
    exceedsLimit: boolean;
    shouldTruncate: boolean;
    percentageUsed: number;
  }> {
    this.sessionLog("debug", "Updating token count and checking limits atomically", {
      conversationId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    }, conversationId);

    try {
      // Use aggregation pipeline to calculate tokens and check limits atomically
      const result = await ReactorConversationModel.aggregate([
        {
          $match: {
            _id: new ObjectId(conversationId),
            user: this.context.user._id,
          },
        },
        {
          $addFields: {
            // Calculate total tokens for all messages in history
            // Includes content, tool_calls arguments, tool_results, thinking
            calculatedTokenCount:
              ReactorConversationService.tokenCountAggregationExpression,
          },
        },
      ]).exec();

      if (!result || result.length === 0) {
        throw new Error("Conversation not found");
      }

      const conversationData = result[0];
      const calculatedTokens = Math.ceil(
        conversationData.calculatedTokenCount || 0
      );
      const maxTokens = conversationData.maxTokens;
      const percentageUsed = maxTokens
        ? (calculatedTokens / maxTokens) * 100
        : 0;

      const exceedsLimit = maxTokens ? calculatedTokens > maxTokens : false;
      const shouldTruncate = maxTokens
        ? calculatedTokens >
          maxTokens * TOKEN_LIMITS.TRUNCATION_THRESHOLD_MULTIPLIER
        : false;

      // Atomically update the conversation with the new token count
      await ReactorConversationModel.findOneAndUpdate(
        {
          _id: conversationId,
          user: this.context.user._id,
        },
        {
          $set: {
            tokenCount: calculatedTokens,
            updated: new Date(),
          },
        },
        {
          new: true,
          runValidators: true,
        }
      ).exec();

      this.sessionLog("debug", "Token count and limits updated successfully", {
        conversationId,
        calculatedTokens,
        maxTokens,
        exceedsLimit,
        shouldTruncate,
        percentageUsed,
        userId: this.context.user?._id,
      }, conversationId);

      return {
        currentTokens: calculatedTokens,
        maxTokens,
        exceedsLimit,
        shouldTruncate,
        percentageUsed,
      };
    } catch (error: any) {
      this.sessionLog("error", "Error updating token count and checking limits", {
        conversationId,
        userId: this.context.user?._id,
        error: error.message,
      }, conversationId);
      throw new Error(
        `Failed to update token count and check limits: ${error.message}`
      );
    }
  }

  /**
   * Truncate conversation history to stay within token limits
   * This method removes older messages while preserving system messages and recent context
   * Removed messages are stored in truncatedHistory for analysis
   */
  private async truncateConversationHistory(
    conversationId: string,
    targetTokens: number
  ): Promise<{
    removedMessages: number;
    remainingTokens: number;
    movedToTruncated: number;
  }> {
    this.sessionLog("debug", "Truncating conversation history", {
      conversationId,
      targetTokens,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    }, conversationId);

    const conversation = await ReactorConversationModel.findOne({
      _id: conversationId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.sessionLog("error", "Conversation not found during history truncation", {
        conversationId,
        userId: this.context.user?._id,
      }, conversationId);
      throw new Error("Conversation not found");
    }

    // Validate the conversation before truncation
    this.validateConversationDocument(
      conversation,
      "truncateConversationHistory",
      "before_truncation"
    );

    const history = [...conversation.history];
    const existingTruncatedHistory = conversation.truncatedHistory || [];
    let currentTokens = conversation.tokenCount || 0;
    let removedMessages = 0;
    let movedToTruncated = 0;

    // Keep system messages and recent messages, remove older user/assistant messages
    const systemMessages = history.filter((msg) => msg.role === "system");
    const nonSystemMessages = history.filter((msg) => msg.role !== "system");

    // Calculate tokens for system messages
    let systemTokens = 0;
    systemMessages.forEach((msg) => {
      systemTokens += this.estimateHistoryItemTokens(msg as ReactorConversationHistoryItem);
    });

    // If system messages alone exceed the limit, we have a problem
    if (systemTokens > targetTokens) {
      this.context.warn(
        `System messages exceed token limit for conversation ${conversationId}`,
        { systemTokens, targetTokens }
      );
      return {
        removedMessages: 0,
        remainingTokens: systemTokens,
        movedToTruncated: 0,
      };
    }

    // Remove messages from the beginning (oldest) until we're under the limit
    const messagesToKeep = [];
    const messagesToMove = [];
    let tokensUsed = systemTokens;

    // Add system messages first
    messagesToKeep.push(...systemMessages);

    // Add recent messages, working backwards
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const message = nonSystemMessages[i];
      const messageTokens = this.estimateHistoryItemTokens(
        message as ReactorConversationHistoryItem
      );

      if (tokensUsed + messageTokens <= targetTokens) {
        messagesToKeep.unshift(message); // Add to beginning to maintain order
        tokensUsed += messageTokens;
      } else {
        // Move message to truncated history instead of discarding
        messagesToMove.unshift(message);
        removedMessages++;
        movedToTruncated++;
      }
    }

    // Combine existing truncated history with new messages to move
    const updatedTruncatedHistory = [
      ...existingTruncatedHistory,
      ...messagesToMove,
    ];

    // Update the conversation with truncated history and moved messages
    await ReactorConversationModel.findOneAndUpdate(
      { _id: conversationId },
      {
        history: messagesToKeep,
        truncatedHistory: updatedTruncatedHistory,
        tokenCount: tokensUsed,
        updated: new Date(),
      },
      { new: true }
    ).exec();

    this.sessionLog("info", `Truncated conversation ${conversationId}`, {
      originalTokens: currentTokens,
      remainingTokens: tokensUsed,
      removedMessages,
      movedToTruncated,
      totalTruncatedMessages: updatedTruncatedHistory.length,
      targetTokens,
    }, conversationId);

    return {
      removedMessages,
      remainingTokens: tokensUsed,
      movedToTruncated,
    };
  }

  /**
   * Get the complete conversation history including truncated messages
   *
   * This method retrieves both active and truncated conversation history,
   * providing comprehensive statistics and chronologically ordered messages.
   * Useful for analysis, debugging, or displaying full conversation context.
   *
   * @param chatSessionId - The conversation ID to retrieve history for
   *
   * @returns Promise resolving to comprehensive history data
   * @returns returns.fullHistory - All messages sorted chronologically
   * @returns returns.activeHistory - Currently active messages in conversation
   * @returns returns.truncatedHistory - Messages that were truncated due to token limits
   * @returns returns.statistics - Detailed statistics about message and token counts
   *
   * @throws {Error} When conversation not found or permission denied
   *
   * @example
   * ```typescript
   * const history = await service.getFullConversationHistory("session123");
   *
   * console.log(`Total messages: ${history.statistics.totalMessages}`);
   * console.log(`Active: ${history.statistics.activeMessages}`);
   * console.log(`Truncated: ${history.statistics.truncatedMessages}`);
   *
   * // Display all messages in chronological order
   * history.fullHistory.forEach(msg => {
   *   console.log(`${msg.role}: ${msg.content}`);
   * });
   * ```
   *
   * @remarks
   * - Messages are sorted chronologically across both active and truncated history
   * - Token counts are calculated for both active and truncated portions
   * - Useful for conversation analysis and debugging token management
   *
   * @since 1.0.0
   */
  async getFullConversationHistory(chatSessionId: string): Promise<{
    fullHistory: ReactorConversationHistoryItem[];
    activeHistory: ReactorConversationHistoryItem[];
    truncatedHistory: ReactorConversationHistoryItem[];
    statistics: {
      totalMessages: number;
      activeMessages: number;
      truncatedMessages: number;
      totalTokens: number;
      activeTokens: number;
      truncatedTokens: number;
    };
  }> {
    // Validate chatSessionId
    this.validateChatSessionId(chatSessionId, "getFullConversationHistory");

    this.context.debug("Getting full conversation history", {
      chatSessionId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    const conversation = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.context.error(
        "Conversation not found during getFullConversationHistory",
        {
          chatSessionId,
          userId: this.context.user?._id,
        }
      );
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`
      );
    }

    // Validate the conversation before retrieving full history
    this.validateConversationDocument(
      conversation,
      "getFullConversationHistory",
      "before_retrieval"
    );

    const activeHistory = conversation.history || [];
    const truncatedHistory = conversation.truncatedHistory || [];

    // Combine histories in chronological order based on timestamp
    const allMessages = [...activeHistory, ...truncatedHistory];
    const sortedHistory = allMessages.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeA - timeB;
    });

    // Calculate token statistics
    const calculateTokens = (
      messages: ReactorConversationHistoryItem[]
    ): number => {
      return messages.reduce((total, msg) => {
        return total + this.estimateHistoryItemTokens(msg);
      }, 0);
    };

    const activeTokens = calculateTokens(activeHistory);
    const truncatedTokens = calculateTokens(truncatedHistory);
    const totalTokens = activeTokens + truncatedTokens;

    return {
      fullHistory: sortedHistory,
      activeHistory,
      truncatedHistory,
      statistics: {
        totalMessages: allMessages.length,
        activeMessages: activeHistory.length,
        truncatedMessages: truncatedHistory.length,
        totalTokens,
        activeTokens,
        truncatedTokens,
      },
    };
  }

  /**
   * Clear the truncated history for a conversation
   * This can be used for cleanup or when you want to free up storage
   */
  async clearTruncatedHistory(chatSessionId: string): Promise<{
    clearedMessages: number;
    clearedTokens: number;
  }> {
    // Validate chatSessionId
    this.validateChatSessionId(chatSessionId, "clearTruncatedHistory");

    this.context.debug("Clearing truncated history", {
      chatSessionId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    const conversation = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.context.error(
        "Conversation not found during clearTruncatedHistory",
        {
          chatSessionId,
          userId: this.context.user?._id,
        }
      );
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`
      );
    }

    // Validate the conversation before clearing truncated history
    this.validateConversationDocument(
      conversation,
      "clearTruncatedHistory",
      "before_clear"
    );

    const truncatedHistory = conversation.truncatedHistory || [];
    const clearedTokens = truncatedHistory.reduce((total, msg) => {
      return total + this.estimateHistoryItemTokens(
        msg as ReactorConversationHistoryItem
      );
    }, 0);

    await ReactorConversationModel.findOneAndUpdate(
      { _id: chatSessionId },
      {
        truncatedHistory: [],
        updated: new Date(),
      },
      { new: true }
    ).exec();

    this.context.info(
      `Cleared truncated history for conversation ${chatSessionId}`,
      {
        clearedMessages: truncatedHistory.length,
        clearedTokens,
      }
    );

    return {
      clearedMessages: truncatedHistory.length,
      clearedTokens,
    };
  }



  async rateMessage(chatSessionId: string, messageId: string, rating: string): Promise<any> {
    const session = await this.storage.loadSession(chatSessionId);
    if (!session) {
      throw new Error(`Session ${chatSessionId} not found`);
    }
    
    let messageFound = false;
    if (session.history && session.history.length > 0) {
      const messageIndex = session.history.findIndex((msg: any) => msg.id?.toString() === messageId || msg.id === messageId);
      if (messageIndex >= 0) {
        session.history[messageIndex].rating = rating;
        messageFound = true;
      }
    }
    
    if (!messageFound) {
      throw new Error(`Message ${messageId} not found in session ${chatSessionId}`);
    }
    
    await this.storage.saveSession(session);
    return session;
  }

  async patchSystemPrompt(chatSessionId: string, systemPrompt: string): Promise<any> {
    const session = await this.storage.loadSession(chatSessionId);
    if (!session) {
      throw new Error(`Session ${chatSessionId} not found`);
    }
    
    // Update the persona in the session state
    if (!session.persona) {
      session.persona = {} as any;
    }
    session.persona.persona = systemPrompt;

    // Update the system message in the history if it exists
    if (session.history && session.history.length > 0) {
      const systemMessageIndex = session.history.findIndex((msg: any) => msg.role === 'system');
      if (systemMessageIndex >= 0) {
        session.history[systemMessageIndex].content = systemPrompt;
      } else {
        // If no system message exists, unshift it to the beginning
        session.history.unshift({
          id: new ObjectId(),
          role: 'system',
          content: systemPrompt,
          timestamp: new Date(),
          tool_results: [],
        } as any);
      }
    }
    
    await this.storage.saveSession(session);
    
    return session;
  }

  async setChatToolApprovalMode(
    chatSessionId: string,
    toolApprovalMode: ToolApprovalMode
  ): Promise<any> {
    // Validate chatSessionId
    this.validateChatSessionId(chatSessionId, "setChatToolApprovalMode");

    this.sessionLog("info", "Setting tool approval mode", {
      chatSessionId,
      toolApprovalMode,
      userId: this.context.user?._id,
    }, chatSessionId);

    // load the chat session
    const chatState = await ReactorConversationModel.findOneAndUpdate(
      { _id: chatSessionId, user: this.context.user },
      { toolApprovalMode },
      { new: true }
    ).exec();

    if (!chatState) {
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to modify it.`
      );
    }

    return chatState;
  }

  /**
   * Persist the side panel state for a chat session.
   * Only serializable metadata is stored (props are excluded).
   */
  async setSidePanelState(
    chatSessionId: string,
    sidePanelState: {
      items: { id: string; componentFqn: string; title: string; type: string; addedAt?: Date; addedBy?: string }[];
      activeItemId?: string;
      isOpen: boolean;
    }
  ): Promise<any> {
    this.validateChatSessionId(chatSessionId, "setSidePanelState");

    this.sessionLog("info", "Saving side panel state", {
      chatSessionId,
      itemCount: sidePanelState.items.length,
      userId: this.context.user?._id,
    }, chatSessionId);

    const chatState = await ReactorConversationModel.findOneAndUpdate(
      { _id: chatSessionId, user: this.context.user },
      { sidePanelState, updated: new Date() },
      { new: true }
    ).exec();

    if (!chatState) {
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to modify it.`
      );
    }

    return chatState;
  }

  /**
   * Set the maximum number of auto tool call iterations for a conversation.
   * When set, the agent will pause after this many iterations and signal the client.
   */
  async setChatMaxToolIterations(
    chatSessionId: string,
    maxToolIterations: number
  ): Promise<any> {
    this.validateChatSessionId(chatSessionId, "setChatMaxToolIterations");

    this.sessionLog("info", "Setting max tool iterations", {
      chatSessionId,
      maxToolIterations,
      userId: this.context.user?._id,
    }, chatSessionId);

    if (maxToolIterations < 1) {
      throw new Error("maxToolIterations must be at least 1");
    }

    const chatState = await ReactorConversationModel.findOneAndUpdate(
      { _id: chatSessionId, user: this.context.user },
      { maxToolIterations, updated: new Date() },
      { new: true }
    ).exec();

    if (!chatState) {
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to modify it.`
      );
    }

    return chatState;
  }

  /**
   * Continue tool execution after the agent paused due to reaching the max tool iteration limit.
   * Reloads the conversation, checks for pending tool_calls in the last assistant message,
   * and re-enters the tool execution loop respecting the (optionally updated) maxToolIterations.
   */
  async continueToolExecution(
    chatSessionId: string,
    personaId: string,
    maxToolIterations?: number,
    streamingMode?: StreamingMode,
  ): Promise<any> {
    this.validateChatSessionId(chatSessionId, "continueToolExecution");

    this.sessionLog("info", "Continuing tool execution", {
      chatSessionId,
      personaId,
      maxToolIterations,
      streamingMode,
      userId: this.context.user?._id,
    }, chatSessionId, personaId);

    // Optionally update maxToolIterations before resuming
    if (maxToolIterations != null && maxToolIterations >= 1) {
      await ReactorConversationModel.findOneAndUpdate(
        { _id: chatSessionId, user: this.context.user },
        { maxToolIterations, updated: new Date() },
      ).exec();
    }

    // Re-send an empty continuation message. sendMessage already handles
    // the AUTO tool execution loop and will run another batch of iterations
    // with the conversation's (potentially updated) maxToolIterations.
    return this.sendMessage({
      personaId,
      chatSessionId,
      message: 'Continue executing tool calls — the user has approved additional iterations.',
      role: 'user',
      streamingMode: streamingMode || StreamingMode.NONE,
    });
  }

  /**
   * Set the model and/or provider for an existing conversation.
   * Persists the override so it is used for subsequent messages and tool executions.
   */
  async setChatModelProvider(
    chatSessionId: string,
    modelId?: string,
    providerId?: string
  ): Promise<any> {
    this.validateChatSessionId(chatSessionId, "setChatModelProvider");

    this.sessionLog("info", "Setting chat model/provider", {
      chatSessionId,
      modelId,
      providerId,
      userId: this.context.user?._id,
    }, chatSessionId);

    if (!modelId && !providerId) {
      throw new Error("At least one of modelId or providerId must be provided.");
    }

    const update: Record<string, any> = { updated: new Date() };
    if (modelId) update.modelId = modelId;
    if (providerId) update.providerId = providerId;

    // Look up the model's contextLength from the provider registry
    // and update maxTokens so the conversation reflects the new model's capacity.
    if (modelId) {
      try {
        const effectiveProviderId = providerId
          || (await ReactorConversationModel.findOne({ _id: chatSessionId, user: this.context.user }).select('providerId').lean().exec())?.providerId;
        const provider = effectiveProviderId
          ? await this.providerService.getProvider(effectiveProviderId)
          : null;
        const model = provider?.models?.find((m: any) => m.id === modelId);

        if (model?.contextLength) {
          update.maxTokens = model.contextLength;
        } else {
          // Model not found on specified provider — search across all providers
          const allProviders = await this.providerService.getProviders();
          for (const p of allProviders) {
            const found = p.models?.find((m: any) => m.id === modelId);
            if (found?.contextLength) {
              update.maxTokens = found.contextLength;
              break;
            }
          }
        }
      } catch (err) {
        this.context.warn?.(
          `[setChatModelProvider] Failed to resolve contextLength for model ${modelId}: ${(err as Error)?.message}`,
          {},
          "ReactorConversationService.setChatModelProvider"
        );
      }
    }

    const chatState = await ReactorConversationModel.findOneAndUpdate(
      { _id: chatSessionId, user: this.context.user },
      { $set: update },
      { new: true }
    ).exec();

    if (!chatState) {
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to modify it.`
      );
    }

    return chatState;
  }

  /**
   * Set the maximum token limit for a conversation
   *
   * This method updates the token limit for a conversation and validates the input.
   * It also checks if the current conversation exceeds the new limit and logs
   * warnings accordingly.
   *
   * @param chatSessionId - The conversation ID to update
   * @param maxTokens - The new maximum token limit (must be > 0)
   *
   * @returns Promise resolving to updated conversation document
   *
   * @throws {ReactorErrorResponse} When session not found, invalid input, or permission denied
   *
   * @example
   * ```typescript
   * // Set token limit to 4000 tokens
   * const updatedSession = await service.setChatMaxTokens("session123", 4000);
   * console.log(updatedSession.maxTokens); // 4000
   * ```
   *
   * @remarks
   * - Validates that maxTokens is greater than 0
   * - Checks user permissions for the conversation
   * - Logs warnings if current conversation exceeds new limit
   * - Does not automatically truncate when limit is lowered
   *
   * @since 1.0.0
   */
  async setChatMaxTokens(
    chatSessionId: string,
    maxTokens: number
  ): Promise<any> {
    this.sessionLog("info", "Setting chat max tokens", {
      chatSessionId,
      maxTokens,
      userId: this.context.user?._id,
    }, chatSessionId);

    // Validate input parameters
    if (!chatSessionId) {
      const errorResponse = this.createErrorResponse(
        ReactorErrorCode.MISSING_REQUIRED_FIELD,
        "Chat session ID is required",
        {
          operation: "setChatMaxTokens",
          recoverable: false,
        }
      );
      throw new Error(errorResponse.message);
    }

    if (maxTokens <= 0) {
      const errorResponse = this.createErrorResponse(
        ReactorErrorCode.INVALID_INPUT,
        "Max tokens must be greater than 0",
        {
          operation: "setChatMaxTokens",
          conversationId: chatSessionId,
          recoverable: false,
          details: { providedValue: maxTokens },
        }
      );
      throw new Error(errorResponse.message);
    }

    // load the chat session
    const chatState = await ReactorConversationModel.findOneAndUpdate(
      { _id: chatSessionId, user: this.context.user },
      { maxTokens },
      { new: true }
    ).exec();

    if (!chatState) {
      const errorResponse = this.createErrorResponse(
        ReactorErrorCode.CONVERSATION_NOT_FOUND,
        `Chat session with id ${chatSessionId} not found or you do not have permission to modify it.`,
        {
          operation: "setChatMaxTokens",
          conversationId: chatSessionId,
          recoverable: false,
        }
      );
      throw new Error(errorResponse.message);
    }

    // Validate the updated conversation
    this.validateConversationDocument(
      chatState,
      "setChatMaxTokens",
      "after_update"
    );

    // Check if current conversation exceeds the new limit
    const tokenCheck = await this.checkTokenLimit(chatSessionId);
    if (tokenCheck.exceedsLimit) {
      this.context.warn(
        `Conversation ${chatSessionId} exceeds new max token limit`,
        {
          currentTokens: tokenCheck.currentTokens,
          maxTokens: tokenCheck.maxTokens,
          exceedsBy: tokenCheck.currentTokens - tokenCheck.maxTokens,
        }
      );
    }

    return chatState;
  }

  /**
   * Get comprehensive token count information for a conversation
   *
   * This method provides detailed token usage statistics including current count,
   * maximum limit, whether the limit is exceeded, and percentage used.
   *
   * @param chatSessionId - The conversation ID to analyze
   *
   * @returns Promise resolving to token count statistics
   * @returns returns.currentTokens - Current token count in conversation
   * @returns returns.maxTokens - Maximum token limit (null if no limit set)
   * @returns returns.exceedsLimit - Whether current count exceeds the limit
   * @returns returns.percentageUsed - Percentage of limit used (0 if no limit)
   *
   * @throws {Error} When conversation not found or permission denied
   *
   * @example
   * ```typescript
   * const tokenInfo = await service.getChatTokenCount("session123");
   * console.log(`Used ${tokenInfo.currentTokens}/${tokenInfo.maxTokens} tokens`);
   * console.log(`Usage: ${tokenInfo.percentageUsed.toFixed(1)}%`);
   *
   * if (tokenInfo.exceedsLimit) {
   *   console.warn("Token limit exceeded!");
   * }
   * ```
   *
   * @since 1.0.0
   */
  async getChatTokenCount(chatSessionId: string): Promise<{
    currentTokens: number;
    maxTokens: number | null;
    exceedsLimit: boolean;
    percentageUsed: number;
  }> {
    // Validate chatSessionId
    this.validateChatSessionId(chatSessionId, "getChatTokenCount");

    this.sessionLog("debug", "Getting chat token count", {
      chatSessionId,
      userId: this.context.user?._id,
    }, chatSessionId);

    const conversation = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      this.context.error("Conversation not found during getChatTokenCount", {
        chatSessionId,
        userId: this.context.user?._id,
      });
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`
      );
    }

    // Validate the conversation before getting token count
    this.validateConversationDocument(
      conversation,
      "getChatTokenCount",
      "before_count"
    );

    const currentTokens = conversation.tokenCount || 0;
    const maxTokens = conversation.maxTokens;
    const exceedsLimit = maxTokens ? currentTokens > maxTokens : false;
    const percentageUsed = maxTokens ? (currentTokens / maxTokens) * 100 : 0;

    return {
      currentTokens,
      maxTokens,
      exceedsLimit,
      percentageUsed,
    };
  }

  setOpenAIService(service: IOpenAIService) {
    this.openaiService = service;
  }

  setAnthropicsService(service: IAnthropicService) {
    this.anthropicService = service;
  }

  setProviderService(service: IReactorProviderService) {
    this.providerService = service;
  }

  setMessageProcessingService(service: ReactorMessageProcessingService) {
    this.messageProcessingService = service;
  }

  setMacroService(service: ReactorMacroService) {
    this.macroService = service;
  }

  setStreamingSessionManager(service: StreamingSessionManager) {
    this.streamingSessionManager = service;
  }

  setFileService(service: Reactory.Service.IReactoryFileService) {
    this.fileService = service;
  } 

  /**
   * Retrieve conversations based on filter criteria
   *
   * This method allows querying conversations with various filters while ensuring
   * proper user access control. Anonymous users are automatically excluded.
   *
   * @param filter - Filter criteria for conversation search
   * @param filter.personaId - Optional persona ID to filter conversations
   * @param filter.userId - Optional user ID to filter conversations
   * @param filter.modelId - Optional model ID to filter conversations
   *
   * @returns Promise resolving to array of conversation documents
   *
   * @throws {Error} When database query fails
   *
   * @example
   * ```typescript
   * // Get all conversations for current user
   * const conversations = await service.getConversations({});
   *
   * // Get conversations for specific persona
   * const personaConversations = await service.getConversations({
   *   personaId: "persona123"
   * });
   * ```
   *
   * @since 1.0.0
   */
  async getConversations(filter: any): Promise<TReactorConversationDocument[]> {
    this.sessionLog("debug", "Fetching conversations", {
      filter,
      userId: this.context.user?._id,
    });

    const { personaId, userId, modelId } = filter || {};
    const query: any = {};

    // check if the user is logged in or an anoymous user.
    if (this.context.user) {
      if (this.context.user.anon) return [];
    } else {
      return [];
    }

    if (personaId) query.personaId = personaId;
    if (userId) query.userId = userId;
    if (modelId) query.modelId = modelId;

    // If no filter specified, get all conversations for current user
    if (!filter || Object.keys(filter).length === 0) {
      query.user = this.context.user;
    }

    // ensure the query doesn't return any
    // results that don't have an _id.
    query._id = { $ne: null };

    return await ReactorConversationModel.find(query)
      .populate("user")      
      .exec();
  }

  /**
   * Retrieve a specific chat session by ID
   *
   * This method loads a conversation document and injects the current context
   * for use in other operations. The conversation is populated with user data.
   *
   * @param args - Arguments containing the session ID
   * @param args.id - The conversation/session ID to retrieve
   *
   * @returns Promise resolving to conversation document with injected context
   *
   * @throws {Error} When chat session is not found
   *
   * @example
   * ```typescript
   * const session = await service.getChatSession({ id: "session123" });
   * console.log(session.personaId); // Access persona ID
   * console.log(session.history.length); // Check message count
   * ```
   *
   * @since 1.0.0
   */
  async getChatSession(args: { id: string }): Promise<
    TReactorConversationDocument & {
      context?: Reactory.Server.IReactoryContext;
    }
  > {
    const { id } = args;

    this.sessionLog("debug", "Retrieving chat session", {
      chatSessionId: id,
      userId: this.context.user?._id,
    }, id);

    // Validate that the ID is a valid ObjectId
    if (!ObjectId.isValid(id)) {
      throw new Error(`Invalid conversation ID format: ${id}`);
    }

    const session: any = await ReactorConversationModel.findOne({
      _id: new ObjectId(id),
    })
      .populate("user")
      .populate("files")
      .exec();

    if (!session) {
      throw new Error("Chat session not found");
    }

    session.context = this.context;

    return session;
  }

  /**
   * Generate a context summary from a previous conversation session.
   * Used for cross-agent context sharing when a user switches personas.
   *
   * For short conversations (<500 estimated tokens), includes the full
   * user/assistant messages. For longer conversations, builds a condensed
   * summary of the key points.
   */
  private async generateContextSummary(sessionId: string): Promise<string | null> {
    const previousConversation = await ReactorConversationModel.findById(sessionId)
      .populate('user', 'firstName lastName')
      .exec();

    if (!previousConversation) {
      this.context.warn("Previous session not found for context sharing", { sessionId });
      return null;
    }

    // Filter to only user and assistant messages (skip system messages, tool calls)
    const relevantMessages = previousConversation.history.filter(
      (msg) => msg.role === "user" || msg.role === "assistant"
    );

    if (relevantMessages.length === 0) {
      return null;
    }

    const previousPersonaId = previousConversation.personaId;

    // Estimate token count of the relevant messages
    let estimatedTokens = 0;
    for (const msg of relevantMessages) {
      if (typeof msg.content === "string") {
        estimatedTokens += this.chunkingService.estimateTokenCount(msg.content);
      }
    }

    const TOKEN_THRESHOLD = 500;

    if (estimatedTokens <= TOKEN_THRESHOLD) {
      // Short conversation — include full messages
      const messageLines = relevantMessages.map((msg) => {
        const role = msg.role === "user" ? "User" : `Agent (${previousPersonaId})`;
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        return `${role}: ${content}`;
      });

      return [
        `Context from previous conversation with agent "${previousPersonaId}" (session: ${sessionId}):`,
        ...messageLines,
      ].join("\n");
    }

    // Longer conversation — build a condensed summary from the messages
    // Take the first and last few messages to capture the topic and most recent state
    const firstMessages = relevantMessages.slice(0, 3);
    const lastMessages = relevantMessages.slice(-3);
    const summaryMessages = [
      ...firstMessages,
      ...(relevantMessages.length > 6 ? lastMessages : []),
    ];

    // Deduplicate in case conversation is short enough that slices overlap
    const seen = new Set<string>();
    const uniqueMessages = summaryMessages.filter((msg) => {
      const key = `${msg.role}:${msg.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const messageLines = uniqueMessages.map((msg) => {
      const role = msg.role === "user" ? "User" : `Agent (${previousPersonaId})`;
      const content = typeof msg.content === "string"
        ? (msg.content.length > 300 ? msg.content.substring(0, 300) + "..." : msg.content)
        : JSON.stringify(msg.content).substring(0, 300);
      return `${role}: ${content}`;
    });

    const totalMessages = relevantMessages.length;
    const omitted = totalMessages - uniqueMessages.length;

    return [
      `Context summary from previous conversation with agent "${previousPersonaId}" (session: ${sessionId}, ${totalMessages} messages):`,
      ...(omitted > 0 ? [`[${omitted} messages omitted for brevity]`] : []),
      ...messageLines,
    ].join("\n");
  }

  // Create a new conversation
  private async getNewConversation(
    persona: IAIPersona
  ): Promise<TReactorConversationDocument> {
    this.context.debug("Creating new conversation", {
      personaId: persona?.id,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    });

    // Check if the persona is valid
    if (!persona || !persona.id) {
      this.context.error("Invalid persona provided for new conversation", {
        persona: persona,
        personaId: persona?.id,
        userId: this.context.user?._id,
      });
      throw new Error("Invalid persona");
    }

    // Check if the user is valid
    if (!this.context.user) {
      this.context.error("No user context found for new conversation", {
        personaId: persona.id,
      });
      throw new Error("User not found");
    }

    // Check if there's an existing empty conversation for this persona and user
    // Use findOneAndUpdate with atomic operation to prevent race conditions
    const lastConversation = await ReactorConversationModel.findOneAndUpdate(
      {
        _id: { $ne: null },
        personaId: persona.id,
        user: this.context.user._id,
        $or: [
          { history: { $size: 0 } }, // Empty history
          {
            history: { $size: 1 },
            "history.0.role": "system", // Only system message
          },
        ],
      },
      {
        $set: {
          started: new Date(),
          updated: new Date(),
        },
        $setOnInsert: {
          // These fields will only be set if no document is found and a new one is created
          sseSessionId: new ObjectId().toString(),
        },
      },
      {
        new: true,
        sort: { started: -1 }, // Get the most recent one
        populate: "user",
      }
    ).exec();

    if (lastConversation) {
      // Ensure SSE session ID is properly set
      if (!lastConversation.sseSessionId) {
        lastConversation.sseSessionId = lastConversation._id.toString();
        await lastConversation.save();
      }

      this.sessionLog("info", "Reusing existing empty conversation", {
        conversationId: lastConversation._id?.toString(),
        personaId: persona.id,
        userId: this.context.user._id,
        historyLength: lastConversation.history?.length || 0,
      }, lastConversation._id?.toString(), persona.id);

      return lastConversation;
    }

    const conversationData: any = {
      personaId: persona.id,
      user: this.context.user,
      modelId: persona.modelId,
      providerId: persona.providerId,
      history: [],
      vars: {},
      meta: {
        summary: "Reactor Chat Session with agent " + persona.name,
        title: "Chat with " + persona.name,
      },
      macros: [],
      tools: [],
      started: new Date(),
      toolApprovalMode: ToolApprovalMode.PROMPT,
      tokenCount: 0,
      maxTokens: persona.maxTokens || TOKEN_LIMITS.DEFAULT_MAX_TOKENS,
    };

    try {
      // Create conversation data with all required fields including sessionId
      const sessionId = new ObjectId();
      const conversationData: any = {
        _id: sessionId, // Set the _id explicitly to avoid multiple saves
        personaId: persona.id,
        user: this.context.user,
        modelId: persona.modelId,
        providerId: persona.providerId,
        history: [],
        vars: {},
        meta: {
          summary: "Reactor Chat Session with agent " + persona.name,
          title: "Chat with " + persona.name,
        },
        macros: [],
        tools: [],
        started: new Date(),
        toolApprovalMode: ToolApprovalMode.PROMPT,
        tokenCount: 0,
        maxTokens: persona.maxTokens || TOKEN_LIMITS.DEFAULT_MAX_TOKENS,
        sseSessionId: sessionId.toString(),
        updated: new Date(),
      };

      this.sessionLog("debug", "Creating new conversation with pre-set IDs", {
        sessionId: sessionId.toString(),
        personaId: conversationData.personaId,
        userId: conversationData.user?.toString(),
        timestamp: new Date().toISOString(),
      }, sessionId.toString(), persona.id);

      // Create and save conversation in single atomic operation
      const conversation = (await ReactorConversationModel.create(
        conversationData
      )) as unknown as TReactorConversationDocument;

      // Validate the saved conversation
      this.validateConversationDocument(
        conversation,
        "getNewConversation",
        "after_save"
      );

      this.context.info("Successfully created new conversation", {
        conversationId: conversation._id?.toString(),
        sessionId: conversation._id?.toString(),
        personaId: conversation.personaId,
        userId: conversation.user?.toString(),
        tokenCount: conversation.tokenCount,
        maxTokens: conversation.maxTokens,
      });

      return conversation;
    } catch (error: any) {
      // Handle duplicate key errors gracefully
      if (error.code === 11000) {
        this.context.warn(
          "Duplicate conversation detected, attempting to find existing conversation",
          {
            personaId: persona.id,
            userId: this.context.user._id,
            error: error.message,
          }
        );

        // Try to find the existing conversation that was just created
        const existingConversation = await ReactorConversationModel.findOne({
          personaId: persona.id,
          user: this.context.user,
          started: conversationData.started,
        })
          .populate("user")
          .exec();

        if (existingConversation) {
          return existingConversation;
        }
      }

      // Re-throw the error if it's not a duplicate key error or if we can't find the existing conversation
      throw error;
    }
  }

  /**
   * Execute chat with the specified provider
   *
   * @param provider - The AI provider to use
   * @param chatSessionId - The chat session ID
   * @param persona - The AI persona configuration
   * @param chatArgs - The chat arguments
   * @returns The AI provider response
   */
  private async executeProviderChat(
    provider: string,
    chatSessionId: string | undefined,
    persona: IAIPersona,
    chatArgs: {
      personaId: string;
      chatSessionId?: string;
      message: string | any;
      role?: "user" | "assistant" | "tool" | "system";
      tool_name?: string;
      tool_args?: any;
      tool_call_id?: string;
      streamingMode?: StreamingMode;
    }
  ): Promise<any> {
    switch (provider) {
      case "xai":
      case "openai":
      case "copilot":
      case "azure-openai":
        // x-ai, openai, copilot, and azure-openai use the same OpenAI-compatible service
        await this.openaiService.initialize(chatSessionId, persona);
        return await this.openaiService.chat({
          ...chatArgs,
          persistState: false, // Don't persist here since we handle it in ReactorConversationService
        });

      case "ollama":
        // Ollama uses the native Ollama Node SDK via OllamaAIService
        await this.ollamaService.initialize(chatSessionId, persona);
        return await this.ollamaService.chat({
          ...chatArgs,
          persistState: false, // Don't persist here since we handle it in ReactorConversationService
        });

      case "google":
        // Google AI service implementation
        await this.googleAIService.initialize(chatSessionId, persona);
        return await this.googleAIService.chat({
          ...chatArgs,
          persistState: false, // Don't persist here since we handle it in ReactorConversationService
        });
      case "anthropic":
        // Anthropic service implementation
        await this.anthropicService.initialize(chatSessionId, persona);
        return await this.anthropicService.chat({
          ...chatArgs,
          persistState: false, // Don't persist here since we handle it in ReactorConversationService
        });
      default:
        this.sessionLog("error", `Provider ${provider} not implemented`, {
          provider,
        }, chatSessionId, persona?.id);
        throw new Error(`Provider ${provider} not implemented`);
    }
  }

  /**
   * Send a message to an AI persona and get a response
   *
   * This is the core method for AI conversation handling. It supports creating new
   * conversations or continuing existing ones, with comprehensive error handling,
   * token management, and retry logic.
   *
   * Key Features:
   * - Atomic message history updates to prevent race conditions
   * - Automatic token counting and conversation truncation
   * - Multi-provider AI support (OpenAI, xAI, Google AI)
   * - Tool call processing and response adaptation
   * - Comprehensive error handling with retry logic
   *
   * @param args - Message sending arguments
   * @param args.personaId - ID of the AI persona to interact with
   * @param args.chatSessionId - Optional existing session ID, creates new if not provided
   * @param args.message - The message content (string or structured object)
   * @param args.role - Message role: "user", "assistant", "system", or "tool" (default: "user")
   * @param args.tool_name - Optional tool name for tool response messages
   * @param args.tool_args - Optional tool arguments for tool response messages
   * @param args.tool_call_id - Optional tool call ID for linking tool responses
   *
   * @returns Promise resolving to AI response with session information
   *
   * @throws {ReactorErrorResponse} When validation fails, conversation not found, or provider errors
   *
   * @example
   * ```typescript
   * // Send a simple user message
   * const response = await service.sendMessage({
   *   personaId: "assistant-v1",
   *   message: "Hello, how are you?",
   *   role: "user"
   * });
   *
   * // Continue existing conversation
   * const followUp = await service.sendMessage({
   *   personaId: "assistant-v1",
   *   chatSessionId: response.sessionId,
   *   message: "Tell me a joke",
   *   role: "user"
   * });
   *
   * // Send tool response
   * const toolResponse = await service.sendMessage({
   *   personaId: "assistant-v1",
   *   chatSessionId: "session123",
   *   message: "Tool executed successfully",
   *   role: "tool",
   *   tool_name: "search_database",
   *   tool_call_id: "call_abc123"
   * });
   * ```
   *
   * @remarks
   * - The method automatically handles token counting and conversation truncation
   * - Retries up to 3 times for retryable errors (network issues, rate limits)
   * - Creates new conversations when chatSessionId is not provided
   * - Validates user permissions for existing conversations
   * - Supports all configured AI providers with unified response format
   *
   * @since 1.0.0
   */
  async sendMessage(args: {
    personaId: string;
    chatSessionId?: string;
    message: string | any;
    role?: string;
    tool_name?: string;
    tool_args?: any;
    tool_call_id?: string;
    streamingMode?: StreamingMode;
    modelId?: string;
    providerId?: string;
    continueAfterTools?: boolean;
    images?: string[];
    toolApprovalMode?: ToolApprovalMode;
    parentSessionId?: string;
  }): Promise<any> {
    const {
      personaId,
      chatSessionId,
      message,
      // the message could be user or tool.
      role = "user",
      tool_name,
      tool_args,
      tool_call_id,
      streamingMode = StreamingMode.NONE,
      modelId: modelIdOverride,
      providerId: providerIdOverride,
      continueAfterTools = false,
      images,
      toolApprovalMode: toolApprovalModeOverride,
      parentSessionId,
    } = args;
    const { user } = this.context;

    // Validate chatSessionId if provided
    if (chatSessionId) {
      this.validateChatSessionId(chatSessionId, "sendMessage");
    }

    this.sessionLog("debug", "Sending message", {
      personaId,
      chatSessionId,
      messageLength: typeof message === "string" ? message.length : "object",
      role,
      userId: user?._id,
      timestamp: new Date().toISOString(),
    }, chatSessionId, personaId);

    const maxRetries = 3;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get the persona's provider
        const persona = await this.context
          .getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0", {
            chatSessionId,
          })
          .getPersona(personaId);

        // When resuming a conversation, the stored modelId/providerId take
        // precedence over persona defaults but are overridden by per-message values.
        let storedModelId: string | undefined;
        let storedProviderId: string | undefined;
        if (chatSessionId) {
          const stored = await ReactorConversationModel.findOne(
            { _id: chatSessionId, user: this.context.user },
            { modelId: 1, providerId: 1 }
          ).lean().exec();
          storedModelId = stored?.modelId || undefined;
          storedProviderId = stored?.providerId || undefined;
        }

        const effectiveModelId = modelIdOverride || storedModelId || persona.modelId;
        const provider = providerIdOverride || storedProviderId || persona.providerId || "xai";
        // Apply overrides: if caller specified a different model/provider, use it
        const hasOverride = effectiveModelId !== persona.modelId || provider !== persona.providerId;
        const effectivePersona = hasOverride
          ? { ...persona, modelId: effectiveModelId, providerId: provider }
          : persona;

        // if we added a persona model / provider override we need to 
        // remove the persona.config since it may contain provider/model specific settings that are no longer valid.
        if (hasOverride) {
          delete effectivePersona.config;
        }

        // Save message to conversation history
        let conversation;
        if (chatSessionId) {
          // For SSE streaming on a resumed session, check that the SSE transport
          // is connected *before* persisting the message.  If the session/transport
          // is missing we return a ReactorInitiateSSE response so the client can
          // establish the SSE connection first, then re-send the message.
          if (streamingMode === "SSE") {
            const sseSessionId = this.streamingSessionManager.getSessionId(chatSessionId);
            const sseSession = sseSessionId
              ? await this.streamingSessionManager.getSession(sseSessionId)
              : null;
            const hasTransport = sseSession
              ? await this.streamingTransportManager.hasTransport(sseSessionId!)
              : false;

            if (!sseSessionId || !sseSession || !hasTransport) {
              // Fetch the conversation without modifying it so we can build the SSE init response
              const existingConversation = await ReactorConversationModel.findOne(
                { _id: chatSessionId, user: this.context.user },
              ).populate("user").exec();

              if (!existingConversation) {
                const errorResponse = this.createErrorResponse(
                  ReactorErrorCode.CONVERSATION_NOT_FOUND,
                  `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`,
                  {
                    operation: "sendMessage",
                    conversationId: chatSessionId,
                    recoverable: false,
                  },
                );
                throw new Error(errorResponse.message);
              }

              return this.createInitiateSSEResponse(
                chatSessionId,
                existingConversation as unknown as ReactorConversationDocument,
              );
            }
          }

          // Guard: an empty user message is a lightweight SSE re-establishment probe
          // sent by the client to (re)connect the SSE transport.  We must NOT add
          // it to history or call the AI provider — doing so causes the AI to
          // "hallucinate" a response with no real user input.
          const isEmptyProbe =
            role === "user" &&
            !continueAfterTools &&
            (!message || (typeof message === "string" && message.trim() === ""));

          if (isEmptyProbe) {
            const probeConv = await ReactorConversationModel.findOne(
              { _id: chatSessionId, user: this.context.user },
            ).populate("user").exec();

            if (!probeConv) {
              throw new Error(
                `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`
              );
            }

            this.sessionLog(
              "debug",
              "Empty user-message probe — returning SSE init without calling AI",
              { chatSessionId, streamingMode },
              chatSessionId,
              personaId,
            );

            return this.createInitiateSSEResponse(
              chatSessionId,
              probeConv as unknown as ReactorConversationDocument,
            );
          }

          this.sessionLog("debug", "Finding existing conversation", {
            chatSessionId,
            userId: this.context.user?._id,
            timestamp: new Date().toISOString(),
            continueAfterTools,
          }, chatSessionId, personaId);

          if (continueAfterTools) {
            // Tool results were already persisted by executeMacro — just load
            // the conversation and call the AI provider without adding a duplicate message.
            conversation = await ReactorConversationModel.findOne(
              { _id: chatSessionId, user: this.context.user },
            ).populate("user").exec();
          } else {
            // Use findOneAndUpdate to atomically find and update the conversation
            // This prevents race conditions that could lead to duplicate creation
            // Build content-parts array when images are provided (vision models)
            const messageContent: string | any[] =
              images && images.length > 0 && typeof message === "string"
                ? [
                    { type: "text", text: message },
                    ...images.map((url) => ({
                      type: "image_url",
                      image_url: { url },
                    })),
                  ]
                : message;
            const messageToAdd = {
              id: new ObjectId(),
              role: role as any,
              content: messageContent,
              timestamp: new Date(),
              tool_name,
              tool_args,
              tool_call_id,
            };

            conversation = await ReactorConversationModel.findOneAndUpdate(
              { _id: chatSessionId, user: this.context.user },
              {
                $push: { history: messageToAdd },
                $set: {
                  updated: new Date(),
                  ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
                  ...(providerIdOverride ? { providerId: providerIdOverride } : {}),
                },
              },
              { new: true, upsert: false }
            )
              .populate("user")
              .exec();
          }

          // Validate the found/updated conversation
          this.validateConversationDocument(
            conversation,
            "sendMessage",
            "existing_conversation"
          );

          if (!conversation) {
            const errorResponse = this.createErrorResponse(
              ReactorErrorCode.CONVERSATION_NOT_FOUND,
              `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`,
              {
                operation: "sendMessage",
                conversationId: chatSessionId,
                recoverable: false,
              }
            );
            throw new Error(errorResponse.message);
          }

          // Update token count and check limits in single atomic operation
          const tokenStatus = await this.updateTokenCountAndCheckLimits(
            conversation._id.toString()
          );

          // Check if truncation is needed based on updated token count
          if (tokenStatus.shouldTruncate) {
            this.sessionLog("warn",
              "Token limit exceeded, truncating conversation history",
              {
                conversationId: conversation._id.toString(),
                currentTokens: tokenStatus.currentTokens,
                maxTokens: tokenStatus.maxTokens,
                exceedsBy:
                  tokenStatus.currentTokens - (tokenStatus.maxTokens || 0),
              }, conversation._id.toString(), personaId
            );

            await this.truncateConversationHistory(
              conversation._id.toString(),
              (tokenStatus.maxTokens || TOKEN_LIMITS.DEFAULT_MAX_TOKENS) *
                TOKEN_LIMITS.TRUNCATION_TARGET_MULTIPLIER
            );
          }
        } else {
          // Create new conversation only when no chatSessionId is provided
          const sessionId = new ObjectId();
          conversation = new ReactorConversationModel({
            personaId,
            user,
            modelId: modelIdOverride || persona.modelId,
            providerId: provider,
            history: [
              {
                id: new ObjectId(),
                role: role as any,
                content: message,
                timestamp: new Date(),
                tool_name,
                tool_args,
                tool_call_id,
              },
            ],
            vars: {},
            meta: {
              summary: "Reactor Chat Session with agent " + persona.name,
              title: "Chat with " + persona.name,
            },
            macros: persona.macros || [],
            tools: persona.tools || [],
            started: new Date(),
            sseSessionId: sessionId,
            toolApprovalMode: toolApprovalModeOverride || ToolApprovalMode.PROMPT,
            parentSessionId: parentSessionId || null,
          });

          this.sessionLog("debug", "Saving new conversation in sendMessage", {
            sessionId: sessionId.toString(),
            personaId: conversation.personaId,
            userId: conversation.user?.toString(),
            timestamp: new Date().toISOString(),
          }, sessionId.toString(), personaId);

          await conversation.save();

          // Validate the newly created conversation
          this.validateConversationDocument(
            conversation,
            "sendMessage",
            "new_conversation"
          );

          // Update token count for new conversation
          await this.updateConversationTokenCount(conversation._id.toString());
        }

        // Get provider adapter
        const adapter = await this.providerService.getAdapter(provider);

        // For new conversations with SSE, ensure the streaming session is set up.
        // (Resumed sessions are checked earlier, before the message is persisted.)
        if (streamingMode === 'SSE' && !chatSessionId) {
          const conversationId = conversation._id.toString();

          let sessionId = this.streamingSessionManager.getSessionId(conversationId);
          if (!sessionId) {
            return this.createInitiateSSEResponse(conversationId, conversation as unknown as ReactorConversationDocument);
          }

          let chatSession = await this.streamingSessionManager.getSession(sessionId);
          if (!chatSession) {
            return this.createInitiateSSEResponse(conversationId, conversation as unknown as ReactorConversationDocument);
          }

          let hasTransport = await this.streamingTransportManager.hasTransport(sessionId);
          if (!hasTransport) {
            return this.createInitiateSSEResponse(conversationId, conversation as unknown as ReactorConversationDocument);
          }
        }

        // Execute chat with the specified provider
        // Resolve user/app credentials and inject into persona config
        const resolvedCreds = await this.providerService.resolveProviderCredentials(
          provider,
          effectivePersona.config
        );
        if (resolvedCreds.source !== "none" && resolvedCreds.source !== "persona") {
          effectivePersona.config = {
            ...effectivePersona.config,
            apiKey: resolvedCreds.apiKey || effectivePersona.config?.apiKey,
            apiOrg: resolvedCreds.organization || effectivePersona.config?.apiOrg,
            apiBaseURL: resolvedCreds.endpoint || effectivePersona.config?.apiBaseURL,
          };
        }

        let response = await this.executeProviderChat(
          provider,
          chatSessionId,
          effectivePersona,
          {
            personaId,
            chatSessionId,
            message: images && images.length > 0 && typeof message === "string"
              ? [
                  { type: "text", text: message },
                  ...images.map((url) => ({
                    type: "image_url",
                    image_url: { url },
                  })),
                ]
              : message,
            role: role as "user" | "assistant" | "tool" | "system",
            tool_name,
            tool_args,
            tool_call_id,
            streamingMode,
          }
        );

        // Process AI response and update conversation history
        response = await this.processAIResponse(
          response,
          conversation,
          message,
          streamingMode
        );

        // Server-side auto tool execution loop for AUTO mode.
        // When the AI returns tool calls and the conversation is in AUTO mode,
        // execute tools directly on the server instead of round-tripping to the client.
        const effectiveConversationId = chatSessionId || conversation._id.toString();
        const responseToolCalls = response?.tool_calls || response?.choices?.[0]?.message?.tool_calls || [];
        if (
          conversation.toolApprovalMode === ToolApprovalMode.AUTO &&
          responseToolCalls.length > 0
        ) {
          const MAX_TOOL_ITERATIONS = (conversation as any).maxToolIterations
            || parseInt(process.env.REACTOR_MAX_TOOL_ITERATIONS || '100', 10);
          let iteration = 0;

          // Send periodic SSE heartbeats to keep the connection alive while
          // the server executes tools. Without this, proxies/browsers may
          // close idle connections before the tool loop finishes.
          const heartbeatInterval = streamingMode === StreamingMode.SSE
            ? setInterval(() => {
                this.streamingTransportManager.sendHeartbeatToSession(effectiveConversationId);
              }, 15_000)
            : null;

          try {
            while (
            (response?.tool_calls?.length > 0 || response?.choices?.[0]?.message?.tool_calls?.length > 0) &&
            iteration < MAX_TOOL_ITERATIONS
          ) {
            iteration++;
            const toolCalls = response.tool_calls || response.choices[0].message.tool_calls;

            this.sessionLog("info", `[sendMessage] AUTO mode: executing ${toolCalls.length} tool(s) server-side (iteration ${iteration})`, {
              tools: toolCalls.map((tc: any) => tc.function?.name),
              conversationId: effectiveConversationId,
            }, effectiveConversationId, personaId);

            // Partition tool calls into server-executable and client-only.
            // Client tools (runat: 'client') cannot be executed on the server —
            // persist a placeholder and forward to the client via SSE.
            // If any client tools are present in this batch, the AUTO loop will
            // pause after executing server tools, waiting for the client to
            // report results via ReactorCompleteClientToolCalls.
            const clientToolNames = new Set<string>();
            for (const t of (conversation.tools || [])) {
              if ((t as any).runat === 'client' || (t as any).function?.runat === 'client') {
                const name = (t as any).function?.name || (t as any).name;
                if (name) clientToolNames.add(name);
              }
            }
            // Also check conversation.macros for client-only entries
            for (const m of (conversation.macros || [])) {
              if ((m as any).runat === 'client') {
                const name = (m as any).alias || (m as any).name;
                if (name) clientToolNames.add(name);
              }
            }

            let hasClientToolsPending = false;

            for (const toolCall of toolCalls) {
              const toolName = toolCall.function?.name;
              const toolArgs = typeof toolCall.function?.arguments === 'string'
                ? JSON.parse(toolCall.function.arguments)
                : toolCall.function?.arguments;

              // Skip client-only tools — they can only run in the browser.
              // Store a placeholder tool result so the AI provider receives a
              // response for this tool_call_id and the conversation can proceed.
              if (clientToolNames.has(toolName)) {
                hasClientToolsPending = true;
                this.sessionLog("info", `[sendMessage] AUTO mode: skipping client-side tool "${toolName}" — will be forwarded to client`, {
                  toolName,
                  conversationId: effectiveConversationId,
                }, effectiveConversationId, personaId);

                // Persist a placeholder tool result in conversation history
                await ReactorConversationModel.findOneAndUpdate(
                  { _id: effectiveConversationId },
                  {
                    $push: {
                      history: {
                        id: new ObjectId(),
                        role: 'tool',
                        content: `[Client-side tool "${toolName}" will be executed in the user\'s browser. The result is not available server-side.]`,
                        tool_call_id: toolCall.id,
                        tool_name: toolName,
                        timestamp: new Date(),
                        tool_results: [],
                      },
                    },
                    $set: { updated: new Date() },
                  },
                  { new: true }
                ).exec();

                // Forward the tool call to the client via SSE so the client can execute it
                if (streamingMode === StreamingMode.SSE) {
                  try {
                    const clientToolEvent = StreamingEventFactory.createToolCallEvent(
                      toolCall.id,
                      toolName,
                      typeof toolCall.function?.arguments === 'string'
                        ? toolCall.function.arguments
                        : JSON.stringify(toolCall.function?.arguments || {}),
                      false,
                      undefined,
                      {
                        sessionId: effectiveConversationId,
                        conversationId: effectiveConversationId,
                        messageId: new ObjectId().toString(),
                      },
                    );
                    await this.streamingTransportManager.sendEventToSession(effectiveConversationId, clientToolEvent);
                  } catch (sseError: any) {
                    this.sessionLog("warn", `[sendMessage] AUTO mode: failed to forward client tool via SSE: ${sseError.message}`, {
                      toolName,
                      conversationId: effectiveConversationId,
                    }, effectiveConversationId, personaId);
                  }
                }
                continue; // Skip to next tool call
              }

              // Notify the client that a tool is being invoked so it can show progress in AUTO mode
              if (streamingMode === StreamingMode.SSE) {
                try {
                  const toolCallEvent = StreamingEventFactory.createToolCallEvent(
                    toolCall.id,
                    toolName,
                    typeof toolCall.function?.arguments === 'string'
                      ? toolCall.function.arguments
                      : JSON.stringify(toolCall.function?.arguments || {}),
                    false,
                    undefined,
                    {
                      sessionId: effectiveConversationId,
                      conversationId: effectiveConversationId,
                      messageId: new ObjectId().toString(),
                    },
                  );
                  await this.streamingTransportManager.sendEventToSession(effectiveConversationId, toolCallEvent);
                } catch (sseError: any) {
                  this.sessionLog("warn", `[sendMessage] AUTO mode: failed to send tool_call SSE event: ${sseError.message}`, {
                    toolName,
                    conversationId: effectiveConversationId,
                  }, effectiveConversationId, personaId);
                }
              }

              try {
                const macroResult = await this.executeMacro({
                  macro: toolName,
                  personaId,
                  chatSessionId: effectiveConversationId,
                  calledBy: 'server-auto',
                  callId: toolCall.id,
                  args: toolArgs,
                });

                // Send tool_call completion event so the client knows this tool finished
                if (streamingMode === StreamingMode.SSE) {
                  try {
                    // Extract a displayable result from the macro response.
                    // The adapted response may wrap the actual output in tool_results.
                    const toolResultContent = macroResult?.tool_results?.[0]?.content
                      ?? macroResult?.tool_results?.[0]?.result
                      ?? macroResult?.content
                      ?? undefined;
                    const toolCompleteEvent = StreamingEventFactory.createToolCallEvent(
                      toolCall.id,
                      toolName,
                      typeof toolCall.function?.arguments === 'string'
                        ? toolCall.function.arguments
                        : JSON.stringify(toolCall.function?.arguments || {}),
                      true, // isComplete: true
                      toolResultContent,
                      {
                        sessionId: effectiveConversationId,
                        conversationId: effectiveConversationId,
                        messageId: new ObjectId().toString(),
                      },
                    );
                    await this.streamingTransportManager.sendEventToSession(effectiveConversationId, toolCompleteEvent);
                  } catch (sseError: any) {
                    this.sessionLog("warn", `[sendMessage] AUTO mode: failed to send tool_call complete SSE event: ${sseError.message}`, {
                      toolName,
                      conversationId: effectiveConversationId,
                    }, effectiveConversationId, personaId);
                  }
                }
              } catch (toolError: any) {
                this.sessionLog("warn", `[sendMessage] AUTO tool execution failed for ${toolName}: ${toolError.message}`, {
                  toolName,
                  conversationId: effectiveConversationId,
                });
                // Add an error tool result to history so the AI knows the tool failed
                await ReactorConversationModel.findOneAndUpdate(
                  { _id: effectiveConversationId },
                  {
                    $push: {
                      history: {
                        id: new ObjectId(),
                        role: 'tool',
                        content: `Error executing tool ${toolName}: ${toolError.message}`,
                        tool_call_id: toolCall.id,
                        tool_name: toolName,
                        timestamp: new Date(),
                        tool_results: [],
                      },
                    },
                    $set: { updated: new Date() },
                  },
                  { new: true }
                ).exec();
              }
            }

            // If any client tools are pending, pause the AUTO loop.
            // The client will execute these tools and call
            // ReactorCompleteClientToolCalls to persist results and
            // continue the AI processing loop.
            if (hasClientToolsPending) {
              this.sessionLog("info", `[sendMessage] AUTO mode: pausing — client-side tool(s) pending. Server will resume when client reports results via ReactorCompleteClientToolCalls.`, {
                conversationId: effectiveConversationId,
              }, effectiveConversationId, personaId);
              break;
            }

            // Send tool results back to AI to get the next response
            response = await this.executeProviderChat(
              provider,
              effectiveConversationId,
              effectivePersona,
              {
                personaId,
                chatSessionId: effectiveConversationId,
                message: '',
                role: 'tool',
                streamingMode,
              }
            );
            response = await this.processAIResponse(
              response,
              conversation,
              '',
              streamingMode
            );
          }

          if (iteration >= MAX_TOOL_ITERATIONS) {
            this.sessionLog("warn", `[sendMessage] AUTO tool execution reached max iterations (${MAX_TOOL_ITERATIONS})`, {
              conversationId: effectiveConversationId,
            }, effectiveConversationId, personaId);

            const partialContent = response?.choices?.[0]?.message?.content || response?.content || '';

            // Add assistant message so the user sees the pause
            await ReactorConversationModel.findOneAndUpdate(
              { _id: effectiveConversationId },
              {
                $push: {
                  history: {
                    id: new ObjectId(),
                    role: 'assistant',
                    content: `I've completed ${iteration} tool call iterations and reached the configured limit of ${MAX_TOOL_ITERATIONS}. You can adjust the limit and continue, or accept the current results.`,
                    timestamp: new Date(),
                  },
                },
                $set: { updated: new Date() },
              }
            ).exec();

            // Signal the client via SSE or flag the response for GraphQL mode
            if (streamingMode === StreamingMode.SSE) {
              try {
                const sseSessionId = this.streamingSessionManager.getSessionId(effectiveConversationId);
                if (sseSessionId) {
                  const limitEvent: ToolIterationLimitStreamingEvent = {
                    type: StreamingEventType.TOOL_ITERATION_LIMIT,
                    sessionId: effectiveConversationId,
                    conversationId: effectiveConversationId,
                    messageId: new ObjectId().toString(),
                    timestamp: new Date(),
                    data: {
                      iterationsCompleted: iteration,
                      maxIterations: MAX_TOOL_ITERATIONS,
                      partialContent,
                    },
                  };
                  await this.streamingTransportManager.sendEventToSession(
                    effectiveConversationId,
                    limitEvent
                  );
                }
              } catch (sseError: any) {
                this.sessionLog("warn", `[sendMessage] Failed to send tool iteration limit SSE event: ${sseError.message}`, {
                  conversationId: effectiveConversationId,
                }, effectiveConversationId, personaId);
              }
              // Skip the normal completion event — the client will handle the limit event
              return adapter.adaptResponse(response);
            }

            // For non-streaming mode, flag the response so the client can detect it
            if (response?.choices?.[0]?.message) {
              (response.choices[0].message as any).toolIterationLimitReached = true;
              (response.choices[0].message as any).iterationsCompleted = iteration;
              (response.choices[0].message as any).maxToolIterations = MAX_TOOL_ITERATIONS;
            }
          }

          // In SSE mode, the provider may have already streamed the final
          // response (including a completion event) if the last executeProviderChat
          // call used streaming and the response had no tool calls. In that case,
          // skip sending a duplicate completion event — the client already has it.
          //
          // We detect this by checking whether the final response has no tool
          // calls (meaning the provider sent its own completion) AND has content
          // (meaning tokens were streamed).
          const lastResponseToolCalls = response?.tool_calls || response?.choices?.[0]?.message?.tool_calls || [];
          const providerAlreadySentCompletion = lastResponseToolCalls.length === 0
            && (response?.content || response?.choices?.[0]?.message?.content);
          if (streamingMode === StreamingMode.SSE && !providerAlreadySentCompletion) {
            // processAIResponse normalizes the response to { __typename, content, ... }
            // so response.choices no longer exists. Read content from both formats.
            let finalContent = response?.choices?.[0]?.message?.content
              || response?.content
              || '';
            let finalThinking = response?.thinking || response?.__reasoning || undefined;

            // DB fallback: if the in-memory response has empty content,
            // read the last assistant message from MongoDB. This handles
            // edge cases where the content was persisted by processAIResponse
            // but the response object lost it during normalization.
            if (!finalContent) {
              this.sessionLog("warn", `[sendMessage] AUTO final response content is empty — falling back to DB`, {
                conversationId: effectiveConversationId,
              }, effectiveConversationId, personaId);
              try {
                const conv = await ReactorConversationModel.findById(effectiveConversationId).lean();
                if (conv?.history?.length) {
                  for (let hi = conv.history.length - 1; hi >= 0; hi--) {
                    const entry = conv.history[hi] as any;
                    if (entry.role === 'assistant' && entry.content) {
                      finalContent = entry.content;
                      if (!finalThinking && entry.thinking) finalThinking = entry.thinking;
                      break;
                    }
                  }
                }
              } catch (dbErr: any) {
                this.sessionLog("error", `[sendMessage] DB fallback failed: ${dbErr.message}`, {
                  conversationId: effectiveConversationId,
                }, effectiveConversationId, personaId);
              }
            }

            this.sessionLog("debug", `[sendMessage] AUTO final response content`, {
              contentLength: finalContent.length,
              contentPreview: finalContent ? `${finalContent.substring(0, 100)}...` : '(empty)',
              hasThinking: !!finalThinking,
            }, effectiveConversationId, personaId);
            try {
              const sseSessionId = this.streamingSessionManager.getSessionId(effectiveConversationId);
              if (sseSessionId) {
                const completionEvent: CompletionStreamingEvent = {
                  type: StreamingEventType.COMPLETE,
                  sessionId: effectiveConversationId,
                  conversationId: effectiveConversationId,
                  messageId: new ObjectId().toString(),
                  timestamp: new Date(),
                  data: {
                    content: finalContent,
                    finishReason: 'stop',
                    thinking: finalThinking,
                  },
                };
                await this.streamingTransportManager.sendEventToSession(
                  effectiveConversationId,
                  completionEvent
                );
                this.sessionLog("info", `[sendMessage] AUTO mode: sent final completion event via SSE`, {
                  conversationId: effectiveConversationId,
                  contentLength: finalContent.length,
                }, effectiveConversationId, personaId);
              } else {
                this.sessionLog("warn", `[sendMessage] AUTO mode: no SSE session found for conversation ${effectiveConversationId}`, {
                  conversationId: effectiveConversationId,
                }, effectiveConversationId, personaId);
              }
            } catch (sseError: any) {
              this.sessionLog("warn", `[sendMessage] AUTO mode: failed to send final SSE completion event: ${sseError.message}`, {
                conversationId: effectiveConversationId,
              }, effectiveConversationId, personaId);
            }
          }
          } finally {
            // Always clear the heartbeat interval when the tool loop exits
            if (heartbeatInterval) clearInterval(heartbeatInterval);
          }
        }

        // Return adapted response
        return adapter.adaptResponse(response);
      } catch (error: any) {
        lastError = error;

        // Check if this is a retryable error
        const isRetryable = this.isRetryableError(error);

        this.sessionLog("warn",
          `SendMessage attempt ${attempt} failed: ${error.message}`,
          {
            error: error.message,
            attempt,
            maxRetries,
            isRetryable,
            personaId,
            chatSessionId,
          }, chatSessionId, personaId
        );

        if (attempt < maxRetries && isRetryable) {
          // Wait before retry with exponential backoff
          const backoffDelay = Math.pow(2, attempt) * 1000;
          this.sessionLog("debug",
            `Waiting ${backoffDelay}ms before retry attempt ${attempt + 1}`,
            { backoffDelay, attempt },
            chatSessionId, personaId
          );
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          continue;
        }

        // If not retryable or max retries reached, break and throw
        break;
      }
    }

    // If we get here, all retries failed
    this.sessionLog("error",
      `Error sending message after ${maxRetries} attempts: ${
        lastError?.message ?? lastError?.toString()
      }`,
      { error: lastError, args },
      chatSessionId, personaId
    );

    return this.createErrorResponse(
      ReactorErrorCode.MESSAGE_ERROR,
      lastError?.message || "Error sending message after multiple attempts",
      {
        details: lastError,
        operation: "sendMessage",
        conversationId: chatSessionId,
        recoverable: true,
      }
    );
  }

  /**
   * Process AI response and update conversation history
   *
   * @param response - The AI provider response
   * @param conversation - The conversation document
   * @param message - The original user message for context
   * @returns The processed response with sessionId added
   */
  private async processAIResponse(
    response: any,
    conversation: any,
    message: string | any,
    streamingMode: StreamingMode = StreamingMode.NONE
  ): Promise<any> {
    // Add AI response if available
    if (response?.choices && response?.choices?.length > 0) {
      // When the provider streamed tool_calls, it may have already persisted
      // the assistant message to avoid a race condition with executeMacro
      // (the client starts executing tools as soon as the SSE completion event
      // arrives, which can happen before this method runs). Skip the duplicate
      // persist in that case.
      if (!(response as any).__persisted) {
        const aiMessage = response.choices[0].message;
        // Extract reasoning/thinking from provider response
        const thinking = response.reasoning || response.__reasoning || undefined;
        // Extract generated images from provider response
        let images = response.images || response.__images || undefined;

        // Save base64 images to the session folder and replace with CDN URLs
        if (images && Array.isArray(images) && images.length > 0) {
          const conversationId = conversation._id?.toString();
          const personaId = conversation.personaId;
          const sessionLogger = conversationId && personaId
            ? this.getSessionLogger(conversationId, personaId)
            : null;
          if (sessionLogger) {
            const saved = sessionLogger.saveImages(images);
            images = saved;
            // Update the response so downstream consumers (GraphQL, SSE) see URLs
            if (response.images) response.images = saved;
            if (response.__images) response.__images = saved;
          }
        }

        // Use findOneAndUpdate for atomic update
        await ReactorConversationModel.findOneAndUpdate(
          { _id: conversation._id },
          {
            $push: {
              history: {
                id: new ObjectId(),
                response, // add the original response for debugging
                role: aiMessage.role,
                content: aiMessage.content,
                thinking,
                images,
                timestamp: new Date(),
                tool_calls: aiMessage.tool_calls,
                tool_results: [],
              },
            },
            $set: { updated: new Date() },
          },
          { new: true }
        ).exec();
      }

      // Update token count after adding AI response
      await this.updateConversationTokenCount(conversation._id.toString());
    } else {
      this.sessionLog("warn", `No AI response received for message: ${message}`, {
        response,
      }, conversation._id?.toString(), conversation.personaId);

      await ReactorConversationModel.findOneAndUpdate(
        { _id: conversation._id },
        {
          $push: {
            history: {
              id: new ObjectId(),
              role: "system",
              content: "No AI response received",
              timestamp: new Date(),
              tool_results: [],
            },
          },
          $set: { updated: new Date() },
        },
        { new: true }
      ).exec();

      // Update token count after adding system message
      await this.updateConversationTokenCount(conversation._id.toString());
    }

    // Normalize the response into a flat ReactorChatMessage shape so the
    // GraphQL union resolver can identify it (it relies on __typename).
    // Provider responses arrive as { choices: [{ message: {...} }] } but
    // the GraphQL schema expects { __typename, sessionId, role, content, tool_calls, ... }.
    const sessionId = conversation._id.toString();
    if (response?.choices?.[0]?.message && !response.__typename) {
      const msg = response.choices[0].message;
      return {
        __typename: 'ReactorChatMessage',
        sessionId,
        id: response.id || new ObjectId().toString(),
        role: msg.role,
        content: msg.content,
        thinking: response.reasoning || response.__reasoning || undefined,
        images: resolveImageUrls(response.images || response.__images) || undefined,
        timestamp: new Date(),
        tool_calls: (msg.tool_calls || []).map((tc: any) => ({
          ...tc,
          status: tc.status || 'pending',
        })),
        tool_results: [],
        tool_errors: [],
      };
    }

    // @ts-ignore — fallback for already-normalized or non-standard responses
    response.sessionId = sessionId;
    if (!response.__typename) {
      response.__typename = 'ReactorChatMessage';
    }

    return response;
  }

  /**
   * Execute a macro/tool within a conversation context
   *
   * This method executes macros (custom tools) that are available to the AI persona
   * within the context of a conversation. It handles permission checking, execution,
   * and result processing with proper error handling.
   *
   * @param args - Macro execution arguments
   * @param args.macro - Name or alias of the macro to execute
   * @param args.personaId - ID of the persona context for execution
   * @param args.chatSessionId - ID of the conversation session
   * @param args.calledBy - Who initiated the macro call (default: "assistant")
   * @param args.callId - Unique identifier for this macro call (auto-generated if not provided)
   * @param args.args - Arguments to pass to the macro function
   *
   * @returns Promise resolving to adapted macro execution result
   *
   * @throws {ReactorErrorResponse} When macro not found, permission denied, or execution fails
   *
   * @example
   * ```typescript
   * // Execute a database search macro
   * const result = await service.executeMacro({
   *   macro: "search_database",
   *   personaId: "assistant-v1",
   *   chatSessionId: "session123",
   *   args: { query: "users", limit: 10 }
   * });
   *
   * // Execute with custom call tracking
   * const trackedResult = await service.executeMacro({
   *   macro: "send_email",
   *   personaId: "assistant-v1",
   *   chatSessionId: "session123",
   *   callId: "email_call_001",
   *   calledBy: "user",
   *   args: { to: "user@example.com", subject: "Test" }
   * });
   * ```
   *
   * @remarks
   * - Validates macro availability in conversation context
   * - Checks user role permissions if macro has role restrictions
   * - Automatically calculates token count for results
   * - Handles token limit exceeded scenarios with chunking
   * - Updates conversation history with tool execution results
   * - Returns provider-adapted responses for consistency
   *
   * @since 1.0.0
   */
  async executeMacro(args: {
    macro: string;
    personaId: string;
    chatSessionId: string;
    calledBy?: string;
    callId?: string;
    args?: any;
  }): Promise<any> {
    const {
      macro,
      personaId,
      chatSessionId,
      calledBy = "assistant",
      callId = v4(),
    } = args;

    // Validate chatSessionId
    this.validateChatSessionId(chatSessionId, "executeMacro");

    try {
      // Get the persona's provider
      const persona = await this.context
        .getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0")
        .getPersona(personaId);

      // Get provider adapter
      // Use conversation-level override if stored, otherwise fall back to persona default
      const conversation = await ReactorConversationModel.findOne({
        _id: chatSessionId,
        user: this.context.user,
      }).exec();

      if (!conversation) {
        throw new Error("Conversation not found");
      }

      const provider = conversation.providerId || persona.providerId || "openai";
      const adapter = await this.providerService.getAdapter(provider);

      // @ts-ignore
      conversation.context = this.context;

      // check if the macro is available on the chat session
      let macroDef = conversation.macros.find((m) => m.name === macro);
      if (!macroDef) {
        // check using the alias
        macroDef = (conversation as TReactorConversationDocument).macros.find(
          (m: { alias: string }) => m.alias === macro
        );
      }

      // Fallback: if the macro isn't on the conversation (e.g. YAML-defined personas
      // where macros weren't fully resolved), check the global macro service registry.
      // Also check if a matching tool exists on the conversation to authorize execution.
      if (!macroDef) {
        const hasMatchingTool = conversation.tools?.some(
          (t: any) => t.function?.name === macro && t.runat === 'server'
        );
        if (hasMatchingTool && this.macroService.getMacro(macro)) {
          macroDef = { name: macro, runat: 'server', roles: [] } as any;
        }
      }

      if (!macroDef) {
        throw new Error(`Macro ${macro} not found in chat session`);
      }

      // Guard: client-side macros cannot be executed on the server
      if ((macroDef as any).runat === 'client') {
        throw new Error(
          `Macro ${macro} is a client-side macro (runat: 'client') and cannot be executed on the server`
        );
      }

      // check if the macro has roles and if the user has permission to execute
      // in theory this should not be needed as only macros that the user has access to should be available
      // to the user in the first place.
      if (macroDef.roles && macroDef.roles.length > 0) {
        const allowed = this.context.hasAnyRole(macroDef.roles);
        if (!allowed) {
          throw new Error(
            `User does not have permission to execute macro ${macro}`
          );
        }
      }

      // Execute the macro
      const macroFunction = this.macroService.getMacro(macroDef.name);
      if (!macroFunction) {
        throw new Error(`Macro ${macro} not found in macro registry`);
      }
      // @ts-ignore
      let result: any = await macroFunction(
        args.args,
        conversation as any,
        this.context
      );
      if (!result) {
        throw new Error(`Macro ${macro} returned no result`);
      }

      // we need to calculate token count of the result, and add it to the conversation
      let resultString = JSON.stringify(result);
      const tokenCount = await this.chunkingService.estimateTokenCount(
        resultString
      );

      if (conversation.maxTokens != null && tokenCount > conversation.maxTokens) {
        throw new Error(
          `Macro ${macro} result is too large. Max tokens: ${conversation.maxTokens}, Token count: ${tokenCount}`
        );
      }

      if (conversation.maxTokens != null && tokenCount + conversation.tokenCount > conversation.maxTokens) {
        // create a copy of the original history, in the event that
        // the truncation is not enough to fit the result.
        // first check what size the new history would be if we truncate it.
        throw new Error(
          `Macro ${macro} result is too large. Max tokens: ${
            conversation.maxTokens
          }, Token count: ${tokenCount + conversation.tokenCount}`
        );
      }

      // Build a content string that includes the actual result data so the AI
      // provider can see tool output (not just a status message).
      let toolContentString: string;
      try {
        toolContentString = resultString;
      } catch {
        toolContentString = `Tool ${macro} (${callId || "no call id"}) executed successfully.`;
      }

      const toolResult = {
        __typename: "ReactorChatMessage",
        role: "tool",
        content: toolContentString,
        tool_results: [
          {
            id: callId,
            name: macro,
            result: result,
          },
        ],
        tool_call_id: callId,
        tool_name: macro,
        tool_args: args.args,
        id: new ObjectId(),
        timestamp: new Date(),
      };

      // Use atomic update to add macro result to conversation history.
      // Persist conversation.vars — macros (e.g. todoMacro, variableMacro) mutate
      // state.vars in-memory. A JSON round-trip strips any Mongoose Mixed-type
      // internal wrappers and produces a plain POJO that BSON serializes correctly,
      // including nested arrays such as TodoList.items[].
      let persistedVars: Record<string, unknown>;
      try {
        persistedVars = JSON.parse(JSON.stringify(conversation.vars ?? {}));
      } catch {
        persistedVars = {};
      }

      await ReactorConversationModel.findOneAndUpdate(
        { _id: chatSessionId },
        {
          $push: { history: toolResult },
          $set: { updated: new Date(), vars: persistedVars },
        },
        { new: true }
      ).exec();

      // Backfill tool_results on the original assistant message that initiated this tool call
      if (callId) {
        await ReactorConversationModel.findOneAndUpdate(
          {
            _id: chatSessionId,
            "history.tool_calls.id": callId,
          },
          {
            $push: {
              "history.$.tool_results": {
                id: callId,
                name: macro,
                content: result,
                timestamp: new Date(),
              },
            },
          }
        ).exec();
      }

      return adapter.adaptResponse(toolResult);
    } catch (error: any) {
      this.sessionLog("error", `Error executing macro: ${error.message}`, {
        error: error.message,
        macro,
        personaId,
        chatSessionId,
        correlationId: v4(),
      }, chatSessionId, personaId);

      return this.createErrorResponse(
        ReactorErrorCode.MACRO_ERROR,
        error.message || "Error executing macro",
        {
          details: error,
          operation: "executeMacro",
          conversationId: chatSessionId,
          recoverable: true,
        }
      );
    }
  }

  async executeTool(args: {
    tool: string;
    toolArgs?: any;
    personaId: string;
    chatSessionId: string;
    callId?: string;
  }): Promise<any> {
    const { tool, personaId, chatSessionId } = args;

    // Validate chatSessionId
    this.validateChatSessionId(chatSessionId, "executeTool");

    return this.executeMacro({
      macro: tool,
      personaId,
      chatSessionId,
      args: args.toolArgs,
      callId: args.callId,
    });
  }

  /**
   * Reports the completion of client-side tool executions.
   * Replaces placeholder tool results in the conversation history with
   * the real results, then optionally continues the AI processing loop.
   */
  async completeClientToolCalls(args: {
    chatSessionId: string;
    personaId: string;
    results: Array<{
      toolCallId: string;
      toolName: string;
      result?: any;
      isError?: boolean;
      error?: string;
    }>;
    continueProcessing?: boolean;
    streamingMode?: StreamingMode;
  }): Promise<any> {
    const {
      chatSessionId,
      personaId,
      results,
      continueProcessing = true,
      streamingMode = StreamingMode.NONE,
    } = args;

    this.validateChatSessionId(chatSessionId, "completeClientToolCalls");

    const conversation = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    }).populate("user").exec();

    if (!conversation) {
      throw new Error("Conversation not found or you do not have permission to access it");
    }

    this.sessionLog("info", `[completeClientToolCalls] Receiving ${results.length} client tool result(s)`, {
      toolNames: results.map(r => r.toolName),
      conversationId: chatSessionId,
    }, chatSessionId, personaId);

    // Persist each tool result: replace the placeholder history entry (if one
    // exists from the AUTO+SSE path) or insert a new tool message (for
    // PROMPT/SAFE_AUTO paths where no placeholder was created).
    // Also backfill into the assistant message's tool_results array.
    for (const toolResult of results) {
      const content = toolResult.isError
        ? `Error executing client tool ${toolResult.toolName}: ${toolResult.error}`
        : typeof toolResult.result === 'string'
          ? toolResult.result
          : JSON.stringify(toolResult.result ?? 'No result');

      // 1. Try to replace the placeholder tool message in history
      const updateResult = await ReactorConversationModel.findOneAndUpdate(
        {
          _id: chatSessionId,
          "history.tool_call_id": toolResult.toolCallId,
          "history.role": "tool",
        },
        {
          $set: {
            "history.$.content": content,
            "history.$.tool_results": [{
              id: toolResult.toolCallId,
              name: toolResult.toolName,
              content: toolResult.isError ? toolResult.error : toolResult.result,
              timestamp: new Date(),
            }],
            "history.$.timestamp": new Date(),
            updated: new Date(),
          },
        },
      ).exec();

      // If no placeholder was found (e.g. client tool executed via PROMPT mode
      // where the server never created a placeholder), insert a new tool message.
      if (!updateResult) {
        await ReactorConversationModel.findOneAndUpdate(
          { _id: chatSessionId },
          {
            $push: {
              history: {
                id: new ObjectId(),
                role: 'tool',
                content,
                tool_call_id: toolResult.toolCallId,
                tool_name: toolResult.toolName,
                timestamp: new Date(),
                tool_results: [{
                  id: toolResult.toolCallId,
                  name: toolResult.toolName,
                  content: toolResult.isError ? toolResult.error : toolResult.result,
                  timestamp: new Date(),
                }],
              },
            },
            $set: { updated: new Date() },
          },
          { new: true },
        ).exec();
      }

      // 2. Backfill tool_results in the original assistant message that had tool_calls
      await ReactorConversationModel.findOneAndUpdate(
        {
          _id: chatSessionId,
          "history.tool_calls.id": toolResult.toolCallId,
        },
        {
          $push: {
            "history.$.tool_results": {
              id: toolResult.toolCallId,
              name: toolResult.toolName,
              content: toolResult.isError ? toolResult.error : toolResult.result,
              timestamp: new Date(),
            },
          },
        },
      ).exec();

      this.sessionLog("debug", `[completeClientToolCalls] Persisted result for tool "${toolResult.toolName}" (callId: ${toolResult.toolCallId})`, {
        isError: toolResult.isError,
        hasPlaceholder: !!updateResult,
        conversationId: chatSessionId,
      }, chatSessionId, personaId);
    }

    if (!continueProcessing) {
      // Return the last assistant message from the conversation
      const updated = await ReactorConversationModel.findById(chatSessionId).lean().exec();
      const lastAssistant = [...(updated?.history || [])].reverse().find((h: any) => h.role === 'assistant');
      return {
        __typename: "ReactorChatMessage",
        id: lastAssistant?.id?.toString() || new ObjectId().toString(),
        role: lastAssistant?.role || "assistant",
        content: lastAssistant?.content || "Client tool results received.",
        timestamp: lastAssistant?.timestamp || new Date(),
        tool_calls: lastAssistant?.tool_calls || [],
        tool_results: lastAssistant?.tool_results || [],
        tool_errors: [],
        sessionId: chatSessionId,
      };
    }

    // Continue the AI processing loop: send the tool results to the provider
    // so the agent can see the real outputs and respond.
    const persona = await this.context
      .getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0")
      .getPersona(personaId);
    const provider = persona.providerId || "openai";
    const adapter = await this.providerService.getAdapter(provider);

    if (streamingMode === StreamingMode.SSE) {
      // Initiate SSE and run the continuation in the background
      const updatedConversation = await ReactorConversationModel.findById(chatSessionId)
        .populate("user").exec();

      // Fire-and-forget: execute the provider chat and stream results
      (async () => {
        try {
          let response = await this.executeProviderChat(
            provider,
            chatSessionId,
            persona,
            {
              personaId,
              chatSessionId,
              message: '',
              role: 'tool',
              streamingMode,
            }
          );
          response = await this.processAIResponse(
            response,
            updatedConversation,
            '',
            streamingMode,
          );
        } catch (err: any) {
          this.sessionLog("error", `[completeClientToolCalls] SSE continuation failed: ${err.message}`, {
            conversationId: chatSessionId,
          }, chatSessionId, personaId);
        }
      })();

      return this.createInitiateSSEResponse(
        chatSessionId,
        updatedConversation as unknown as ReactorConversationDocument,
      );
    }

    // Non-streaming: execute provider chat synchronously
    let response = await this.executeProviderChat(
      provider,
      chatSessionId,
      persona,
      {
        personaId,
        chatSessionId,
        message: '',
        role: 'tool',
        streamingMode: StreamingMode.NONE,
      }
    );

    // Reload conversation to get the updated history
    const updatedConversation = await ReactorConversationModel.findById(chatSessionId)
      .populate("user").exec();

    response = await this.processAIResponse(
      response,
      updatedConversation,
      '',
      StreamingMode.NONE,
    );

    return adapter.adaptResponse(response);
  }

  async attachImage(args: {
    image: string;
    personaId: string;
    chatSessionId: string;
  }): Promise<any> {
    const { image, personaId, chatSessionId } = args;

    // Validate chatSessionId
    this.validateChatSessionId(chatSessionId, "attachImage");

    try {
      const persona = await this.context
        .getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0")
        .getPersona(personaId);
      const provider = persona.providerId || "openai";
      const adapter = await this.providerService.getAdapter(provider);

      // Validate conversation exists and user has access
      const conversation = await ReactorConversationModel.findOne({
        _id: chatSessionId,
        user: this.context.user,
      }).exec();

      if (!conversation) {
        throw new Error(
          "Conversation not found or you do not have permission to access it"
        );
      }

      // Use atomic update to add image message to history
      await ReactorConversationModel.findOneAndUpdate(
        { _id: chatSessionId },
        {
          $push: {
            history: {
              id: new ObjectId(),
              role: "user",
              content: "[Image attached]",
              timestamp: new Date(),
              // @ts-ignore
              imageData: image,
            },
          },
          $set: { updated: new Date() },
        },
        { new: true }
      ).exec();

      // Process image with AI if supported
      let response;
      if (provider === "openai" && persona.modelId === "gpt-4-vision-preview") {
        // @ts-ignore
        response = await this.openaiService.chat({
          personaId,
          chatSessionId,
          message: "What do you see in this image?",
        });

        if (response.choices && response.choices.length > 0) {
          const aiMessage = response.choices[0].message;
          // Use atomic update to add AI response
          await ReactorConversationModel.findOneAndUpdate(
            { _id: chatSessionId },
            {
              $push: {
                history: {
                  id: new ObjectId(),
                  role: aiMessage.role,
                  content: aiMessage.content,
                  timestamp: new Date(),
                  tool_calls: aiMessage.tool_calls,
                },
              },
              $set: { updated: new Date() },
            },
            { new: true }
          ).exec();
        }
      }

      if (response) {
        return adapter.adaptResponse(response);
      } else {
        return {
          __typename: "ReactorChatMessage",
          id: Math.random().toString(36).substring(2, 15),
          role: "system",
          content: "Image attached successfully",
          timestamp: new Date(),
        };
      }
    } catch (error: any) {
      this.sessionLog("error", `Error attaching image: ${error.message}`, {
        error: error.message,
        personaId,
        chatSessionId,
        correlationId: v4(),
      }, chatSessionId, personaId);

      return this.createErrorResponse(
        ReactorErrorCode.IMAGE_ERROR,
        error.message || "Error attaching image",
        {
          details: error,
          operation: "attachImage",
          conversationId: chatSessionId,
          recoverable: true,
        }
      );
    }
  }

  async attachFiles(args: {
    files: ReactoryFileDocument[];
    chatSessionId: string;
  }): Promise<any> {
    const { files, chatSessionId } = args;

    this.sessionLog("info", "Attaching files to chat session", {
      chatSessionId,
      filesCount: files?.length || 0,
      userId: this.context.user?._id,
    }, chatSessionId);

    try {
      // Validate chatSessionId
      this.validateChatSessionId(chatSessionId, "attachFiles");

      if (files === null || files === undefined || files.length === 0) {
        throw new Error("Files are required for attachFiles");
      }

      // Validate conversation exists and user has access
      const conversation = await ReactorConversationModel.findOne({
        _id: chatSessionId,
        user: this.context.user,
      }).exec();

      if (!conversation) {
        throw new Error(
          "Conversation not found or you do not have permission to access it"
        );
      }

      const fileDetails = files.map((f) =>
        `- "${f.filename || f.alias || 'Unknown'}" (${f.mimetype || 'unknown type'}, ${f.size ? Math.round(f.size / 1024) + 'KB' : 'unknown size'}, path: ${f.path || 'N/A'}, id: ${f._id || f.id})`
      ).join("\n");

      const fileMessage = {
        id: new ObjectId(),
        role: "user" as const,
        content: `I have attached ${files.length} file(s) to this chat session:\n${fileDetails}\n\nYou can read the contents of any attached file using the readChatFile tool with the file id.`,
        timestamp: new Date(),
      };

      // extract all the file ids from the files array
      const fileIds = files.map((file) => {
        if (file._id) {
          return file._id;
        } else if (file.id) {
          return file.id;
        } else {
          // skip files that do not have an id
          this.context.warn("File does not have an ID, skipping", {
            file,
            chatSessionId,
          });
          return null;
        }
      }).filter((id) => id !== null);

      // Use atomic $push operation instead of push + save to avoid race conditions
      const updatedConversation =
        await ReactorConversationModel.findOneAndUpdate(
          {
            _id: chatSessionId,
            user: this.context.user._id,
          },
          {
            $push: { history: fileMessage, files: { $each: fileIds } },
            $set: { updated: new Date() },
          },
          {
            new: true,
            runValidators: true,
          }
        ).exec();

      if (!updatedConversation) {
        throw new Error("Failed to update conversation with file attachment");
      }

      // Update token count after adding file attachment message
      await this.updateConversationTokenCount(chatSessionId);

      return {
        __typename: "ReactorChatMessage",
        sessionId: chatSessionId,
        ...fileMessage,
      };
    } catch (error: any) {
      this.context.error(`Error attaching files: ${error.message}`, {
        error,
        chatSessionId,
        filesCount: files?.length || 0,
        correlationId: v4(),
      });

      return this.createErrorResponse(
        ReactorErrorCode.FILE_ERROR,
        error.message || "Error attaching files",
        {
          details: error,
          operation: "attachFiles",
          conversationId: chatSessionId,
          recoverable: true,
        }
      );
    }
  }

  async attachUserFileToSession(
    sessionId: string,
    userFileId: string,
    path: string,
    options?: { description?: string; referenceOnly?: boolean }
  ): Promise<any> {
    const referenceOnly = options?.referenceOnly === true;

    this.sessionLog("info", "Attaching user file to session", {
      sessionId,
      userFileId,
      path,
      referenceOnly,
      userId: this.context.user?._id,
    }, sessionId);

    try {
      this.validateChatSessionId(sessionId, "attachUserFileToSession");

      if (!userFileId) {
        throw new Error("User file ID is required");
      }

      if (!path) {
        throw new Error("File path is required");
      }

      const conversation = await ReactorConversationModel.findOne({
        _id: sessionId,
        user: this.context.user,
      }).exec();

      if (!conversation) {
        throw new Error(
          "Conversation not found or you do not have permission to access it"
        );
      }

      let fileModel = await this.fileService.getFileModel(userFileId);

      if (!fileModel && referenceOnly) {
        const fileOid = ObjectId.isValid(userFileId)
          ? ObjectId.createFromHexString(userFileId)
          : new ObjectId();
        const baseName = nodePath.basename(path);
        let size = 0;
        try {
          if (fs.existsSync(path)) {
            size = fs.statSync(path).size;
          }
        } catch {
          // path may be virtual or inaccessible from server
        }
        fileModel = await ReactoryFile.create({
          _id: fileOid,
          id: fileOid,
          path,
          alias: baseName,
          filename: baseName,
          mimetype: "application/octet-stream",
          size,
          uploadContext: "desktop_local_reference",
          status: "reference",
          tags: ["desktop_local_reference"],
          owner: this.context.user._id,
          uploadedBy: this.context.user._id,
          created: new Date(),
        });
      }

      if (!fileModel) {
        fileModel = await this.fileService.getUserFileByPath(path);
        if (fileModel === null || fileModel === undefined) {
          throw new Error(`File not found: ${userFileId} or ${path}`);
        }
        if (fileModel.isNew === true) {
          fileModel._id = ObjectId.createFromHexString(userFileId);
          fileModel.id = ObjectId.createFromHexString(userFileId);
          await fileModel.save();
        }
        if (!referenceOnly) {
          fileModel = await this.fileService.catalogFile(
            fileModel.filename,
            fileModel.mimetype,
            fileModel.alias,
            `chat::${sessionId}`,
            this.context.partner,
            this.context.user
          );
        }
      }

      const resolvedFileId = fileModel._id.toString();

      const existingAttachment = conversation.files?.find(
        (f: any) =>
          f._id?.toString() === resolvedFileId ||
          (f as any)?.path === path
      );

      if (existingAttachment) {
        return {
          __typename: "ReactorAttachFileResponse",
          success: true,
          message: "File is already attached to this session",
          sessionId,
          fileId: resolvedFileId,
          path,
        };
      }

      const desc = options?.description?.trim();
      const fileMessage = {
        id: new ObjectId(),
        role: "user" as const,
        content: `I have attached a file from my files to this chat session:\n- "${fileModel.filename}" (${fileModel.mimetype || "unknown type"}, path: ${path}, id: ${resolvedFileId})${desc ? `\n\nContext: ${desc}` : ""}\n\nYou can read the contents using the readChatFile tool.`,
        timestamp: new Date(),
      };

      const updatedConversation = await ReactorConversationModel.findOneAndUpdate(
        {
          _id: sessionId,
          user: this.context.user._id,
        },
        {
          $push: {
            files: fileModel._id,
            history: fileMessage,
          },
          $set: { updated: new Date() },
        },
        {
          new: true,
          runValidators: true,
        }
      ).exec();

      if (!updatedConversation) {
        throw new Error("Failed to attach user file to session");
      }

      this.context.info("User file attached to session", {
        sessionId,
        userFileId: resolvedFileId,
        path,
        userId: this.context.user._id,
        referenceOnly,
      });

      return {
        __typename: "ReactorAttachFileResponse",
        success: true,
        message: "File successfully attached to session",
        sessionId,
        fileId: resolvedFileId,
        path,
      };
    } catch (error: any) {
      this.context.error(`Error attaching user file to session: ${error.message}`, {
        error,
        sessionId,
        userFileId,
        path,
        correlationId: v4(),
      });

      return this.createErrorResponse(
        ReactorErrorCode.FILE_ERROR,
        error.message || "Error attaching user file to session",
        {
          details: error,
          operation: "attachUserFileToSession",
          conversationId: sessionId,
          recoverable: true,
        }
      );
    }
  }

  async pinFolderToSession(
    sessionId: string,
    folderPath: string,
    folderName: string
  ): Promise<any> {
    this.sessionLog("info", "Pinning folder to session", {
      sessionId,
      folderPath,
      folderName,
      userId: this.context.user?._id,
    }, sessionId);

    try {
      this.validateChatSessionId(sessionId, "pinFolderToSession");
      if (!folderPath) {
        throw new Error("Folder path is required");
      }

      const conversation = await ReactorConversationModel.findOne({
        _id: sessionId,
        user: this.context.user,
      }).exec();

      if (!conversation) {
        throw new Error(
          "Conversation not found or you do not have permission to access it"
        );
      }

      const pins = conversation.pinnedFolders || [];
      if (pins.some((p) => p.path === folderPath)) {
        return {
          __typename: "ReactorPinFolderResponse",
          success: true,
          message: "Folder is already pinned to this session",
          sessionId,
          path: folderPath,
        };
      }

      const folderMessage = {
        id: new ObjectId(),
        role: "user" as const,
        content: `I have pinned a folder for this chat session:\n- "${folderName}" (path: ${folderPath})\n\nUse list/read tools with this path when working with files in this folder.`,
        timestamp: new Date(),
      };

      const updated = await ReactorConversationModel.findOneAndUpdate(
        {
          _id: sessionId,
          user: this.context.user._id,
        },
        {
          $push: {
            pinnedFolders: { path: folderPath, name: folderName || folderPath },
            history: folderMessage,
          },
          $set: { updated: new Date() },
        },
        { new: true, runValidators: true }
      ).exec();

      if (!updated) {
        throw new Error("Failed to pin folder to session");
      }

      return {
        __typename: "ReactorPinFolderResponse",
        success: true,
        message: "Folder pinned to session",
        sessionId,
        path: folderPath,
      };
    } catch (error: any) {
      this.context.error(`Error pinning folder: ${error.message}`, {
        error,
        sessionId,
        folderPath,
        correlationId: v4(),
      });
      return this.createErrorResponse(
        ReactorErrorCode.FILE_ERROR,
        error.message || "Error pinning folder to session",
        {
          details: error,
          operation: "pinFolderToSession",
          conversationId: sessionId,
          recoverable: true,
        }
      );
    }
  }

  async unpinFolderFromSession(sessionId: string, folderPath: string): Promise<any> {
    this.sessionLog("info", "Unpinning folder from session", {
      sessionId,
      folderPath,
      userId: this.context.user?._id,
    }, sessionId);

    try {
      this.validateChatSessionId(sessionId, "unpinFolderFromSession");
      if (!folderPath) {
        throw new Error("Folder path is required");
      }

      const conversation = await ReactorConversationModel.findOne({
        _id: sessionId,
        user: this.context.user,
      }).exec();

      if (!conversation) {
        throw new Error(
          "Conversation not found or you do not have permission to access it"
        );
      }

      const updated = await ReactorConversationModel.findOneAndUpdate(
        {
          _id: sessionId,
          user: this.context.user._id,
        },
        {
          $pull: { pinnedFolders: { path: folderPath } },
          $set: { updated: new Date() },
        },
        { new: true, runValidators: true }
      ).exec();

      if (!updated) {
        throw new Error("Failed to unpin folder from session");
      }

      return {
        __typename: "ReactorPinFolderResponse",
        success: true,
        message: "Folder unpinned from session",
        sessionId,
        path: folderPath,
      };
    } catch (error: any) {
      this.context.error(`Error unpinning folder: ${error.message}`, {
        error,
        sessionId,
        folderPath,
        correlationId: v4(),
      });
      return this.createErrorResponse(
        ReactorErrorCode.FILE_ERROR,
        error.message || "Error unpinning folder from session",
        {
          details: error,
          operation: "unpinFolderFromSession",
          conversationId: sessionId,
          recoverable: true,
        }
      );
    }
  }

  async detachUserFileFromSession(sessionId: string, 
    userFileId: string, 
    path: string, 
    deleteFile?: boolean): Promise<any> {
    this.sessionLog("info", "Detaching user file from session", {
      sessionId,
      userFileId,
      path,
      deleteFile,
      userId: this.context.user?._id,
    }, sessionId);

    try {
      // Validate inputs
      this.validateChatSessionId(sessionId, "detachUserFileFromSession");
      
      if (!userFileId) {
        throw new Error("User file ID is required");
      }
      
      if (!path) {
        throw new Error("File path is required");
      }

      // Validate conversation exists and user has access
      const conversation = await ReactorConversationModel.findOne({
        _id: sessionId,
        user: this.context.user,
      }).exec();

      if (!conversation) {
        throw new Error(
          "Conversation not found or you do not have permission to access it"
        );
      }

      // Use atomic update to remove the file attachment
      const updatedConversation = await ReactorConversationModel.findOneAndUpdate(
        {
          _id: sessionId,
          user: this.context.user._id,
        },
        {
          $pull: { 
            files: new ObjectId(userFileId)
          },
          $set: { updated: new Date() },
        },
        {
          new: true,
          runValidators: true,
        }
      ).exec();

      if (!updatedConversation) {
        throw new Error("Failed to detach user file from session");
      }

      if (deleteFile) {
        // If deleteFile is true, delete the file from the user's profile
        const fileModel = await this.fileService.getFileModel(userFileId);
        if (!fileModel) {
          this.context.warn(`File model not found for ID ${userFileId}`, {
            userId: this.context.user._id,
            sessionId,
            path,
          });

          return {
            __typename: "ReactorDetachFileResponse",
            success: true,
            message: "File successfully detached from session, but file model not found",
            sessionId,
            userFileId,
            path
          };
        }

        // Proceed to delete the file
        await this.fileService.deleteFile(fileModel);
      }

      this.context.info("User file detached from session", {
        sessionId,
        userFileId,
        path,
        userId: this.context.user._id
      });

      return {
        __typename: "ReactorDetachFileResponse",
        success: true,
        message: "File successfully detached from session",
        sessionId,
        userFileId,
        path
      };

    } catch (error: any) {
      this.context.error(`Error detaching user file from session: ${error.message}`, {
        error,
        sessionId,
        userFileId,
        path,
        correlationId: v4(),
      });

      return this.createErrorResponse(
        ReactorErrorCode.FILE_ERROR,
        error.message || "Error detaching user file from session",
        {
          details: error,
          operation: "detachUserFileFromSession",
          conversationId: sessionId,
          recoverable: true,
        }
      );
    }
  }

  async deleteChatSession(args: { id: string }): Promise<boolean> {
    const { id } = args;

    this.sessionLog("info", "Deleting chat session", {
      chatSessionId: id,
      userId: this.context.user?._id,
    }, id);

    try {
      const result = await ReactorConversationModel.deleteOne({
        _id: id,
        user: this.context.user,
      }).exec();

      this.sessionLog(result.deletedCount > 0 ? "info" : "warn",
        result.deletedCount > 0 ? "Chat session deleted" : "Chat session not found for deletion",
        { chatSessionId: id, deletedCount: result.deletedCount }, id);

      return result.deletedCount > 0;
    } catch (error) {
      this.sessionLog("error", `Error deleting chat session: ${(error as Error).message}`, {
        error: (error as Error).message,
        chatSessionId: id,
      }, id);
      return false;
    }
  }

  async loadChatSession(
    chatSessionId: string
  ): Promise<TReactorConversationDocument | null> {
    this.sessionLog("debug", "Loading chat session", {
      chatSessionId,
      userId: this.context.user?._id,
      timestamp: new Date().toISOString(),
    }, chatSessionId);

    if (!chatSessionId) {
      const errorResponse = this.createErrorResponse(
        ReactorErrorCode.MISSING_REQUIRED_FIELD,
        "Chat session ID is required for loadChatSession",
        {
          operation: "loadChatSession",
          recoverable: false,
        }
      );
      throw new Error(errorResponse.message);
    }

    // Load the chat session by ID
    const chatSession = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!chatSession) {
      this.sessionLog("error", "Chat session not found during loadChatSession", {
        chatSessionId,
        userId: this.context.user?._id,
      }, chatSessionId);
      throw new Error(
        `Chat session with ID ${chatSessionId} not found or you do not have permission to access it.`
      );
    }

    // Validate the loaded conversation
    this.validateConversationDocument(
      chatSession,
      "loadChatSession",
      "loaded_session"
    );

    // Hydrate persisted MCP connections from session mcp.yaml
    const sessionFolder = (chatSession as any).sessionFolder;
    if (sessionFolder) {
      try {
        const mcpConfig = loadSessionMcpConfig(sessionFolder);
        if (mcpConfig.connections.length > 0) {
          const hydratedSessions = mcpConfig.connections.map((conn) => ({
            ...conn,
            status: 'inactive' as const,
          }));
          chatSession.mcpSessions = hydratedSessions;
          this.sessionLog("info", "Hydrated MCP sessions from mcp.yaml", {
            sessionFolder,
            connectionCount: hydratedSessions.length,
          }, chatSession._id?.toString(), chatSession.personaId);
        }
      } catch (err) {
        this.sessionLog("warn", "Failed to hydrate MCP sessions from mcp.yaml", {
          sessionFolder,
          error: err?.message || err,
        }, chatSession._id?.toString(), chatSession.personaId);
      }
    }

    this.sessionLog("info", "Successfully loaded chat session", {
      chatSessionId: chatSession._id?.toString(),
      personaId: chatSession.personaId,
      userId: chatSession.user?.toString(),
      historyLength: chatSession.history?.length || 0,
      tokenCount: chatSession.tokenCount,
      maxTokens: chatSession.maxTokens,
    }, chatSession._id?.toString(), chatSession.personaId);

    return chatSession;
  }

  private collectMacrosAndTools(args: {
    macros: Partial<MacroComponentDefinition<unknown>>[];
    tools: Partial<MacroToolDefinition>[];
    persona: IAIPersona;
  }): {
    macros: MacroComponentDefinition<unknown>[];
    tools: MacroToolDefinition[];    
  } {

    let macros: MacroComponentDefinition<unknown>[] = [];
    let tools: MacroToolDefinition[] = [];

     // add the macros and tools to the conversation
     if (args.macros) {
      args.macros.forEach((macro) => {
        macros.push({
          name: macro.name,
          nameSpace: macro.nameSpace,
          description: macro.description,
          version: macro.version,
          component: macro.component,
          runat: "client", // these are client side macros
          roles: macro?.roles ?? [],
          alias: macro.alias,
        });
      });
    }

    // only add the macros defined on the persona.
    args.persona.macros?.forEach((macro) => {
      macros.push({
        name: macro.name,
        nameSpace: macro.nameSpace,
        description: macro.description,
        version: macro.version,
        runat: "server", // these are server side macros
        roles: macro.roles ?? [],
        alias: macro.alias || macro.name,
        enabled: macro.enabled ?? true,
      });
    });

    // add the client side tools to the conversation
    if (args.tools) {
      args.tools.forEach((tool) => {
        tools.push({
          type: tool.type ?? "function",
          runat: tool.runat ?? "client",
          enabled: tool.enabled ?? true,
          roles: tool.roles ?? [],
          function: tool.function,
        });
      });
    }

    // only add the tools defined on the persona.
    args.persona.tools?.forEach((tool) => {
      tools.push({
        type: tool.type ?? "function",
        runat: tool.runat ?? "server", // these are server side tools
        enabled: tool.enabled ?? true,
        roles: tool.roles ?? [],
        function: tool.function,
      });
    });

    return { macros, tools };
  }

  private async createInitiateSSEResponse(chatSessionId: string, conversation: ReactorConversationDocument): Promise<ReactorInitiateSSEResponse> {
    console.log(`🔌 [ReactorConversationService] createInitiateSSEResponse called:`, {
      chatSessionId,
      conversationId: conversation._id?.toString(),
      hasStreamingSessionManager: !!this.streamingSessionManager,
      hasStreamingTransportManager: !!this.streamingTransportManager
    });

    const session = await this.streamingSessionManager.createSession({
      conversationId: chatSessionId,
      userId: this.context.user._id.toString(),          
      transport: "sse",
      capabilities: {
        supportsTokenStreaming: true,
        supportsToolStreaming: true,
        bufferSize: 1024,
        timeoutMs: 10000,
      }
    });
    
    console.log(`🔌 [ReactorConversationService] Streaming session created:`, {
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      status: session.status,
      userId: session.userId,
      transport: session.transport,
      capabilities: session.capabilities
    });
    
    const sseUrl = new URL(safeUrl([process.env.API_URI_ROOT || "http://localhost:4000", `reactor-chat/streaming/sse/${session.sessionId}`]));
    const clientKeyString = `${this.context.partner.key.toUpperCase().replace(/-/g, "_")}_APPLICATION_USERNAME`;
    const clientPasswordString = `${this.context.partner.key.toUpperCase().replace(/-/g, "_")}_APPLICATION_PASSWORD`;
    sseUrl.searchParams.set('transport', 'sse');
    sseUrl.searchParams.set('no-upgrade', 'true');
    sseUrl.searchParams.set('jwt', Helpers.getJwtTokenForUser(this.context.user));
    sseUrl.searchParams.set('expiry', new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString());
    sseUrl.searchParams.set('x-client-key', process.env[clientKeyString] as string || "");
    sseUrl.searchParams.set('x-client-pwd', process.env[clientPasswordString] as string || "");
    
    console.log(`🔌 [ReactorConversationService] SSE URL constructed:`, {
      baseUrl: sseUrl.toString(),
      sessionId: session.sessionId,
      conversationId: chatSessionId,
      hasJWT: !!sseUrl.searchParams.get('jwt'),
      hasClientKey: !!sseUrl.searchParams.get('x-client-key')
    });
    
    const response = {
      __typename: "ReactorInitiateSSE",
      sessionId: chatSessionId,
      endpoint: sseUrl.toString(),
      token: Helpers.getJwtTokenForUser(this.context.user),
      status: "active",
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 hours          
      chatState: {
        __typename: "ReactorChatState",
        ...conversation,
      } as unknown as ReactorChatState,
    } as unknown as ReactorInitiateSSEResponse;
    
    console.log(`✅ [ReactorConversationService] SSE response created successfully:`, {
      sessionId: chatSessionId,
      endpoint: sseUrl.toString(),
      hasToken: !!response.token
    });
    
    return response;
  }

  async startChatSession(args: {
    personaId: string;
    macros: Partial<MacroComponentDefinition<unknown>>[];
    tools: Partial<MacroToolDefinition>[];
    systemPrompt: string;
    streamingMode: StreamingMode;
    promptMergeStrategy: PromptMergeStrategy;
    toolApprovalMode: ToolApprovalMode;
    contextFromSessionId?: string;
    modelId?: string;
    providerId?: string;
  }): Promise<ReactorInitChatResponse> {
    this.sessionLog("debug", "Starting chat session", {
      personaId: args.personaId,
      userId: this.context.user?._id,
      macrosCount: args.macros?.length || 0,
      toolsCount: args.tools?.length || 0,
      timestamp: new Date().toISOString(),
    });

    try {
      //
      const persona = await this.personaProvider.getPersona(args.personaId);
      if (!persona) {
        this.sessionLog("error", "Persona not found during startChatSession", {
          personaId: args.personaId,
          userId: this.context.user?._id,
        });
        throw new Error(`Persona with id ${args.personaId} not found`);
      }

      const conversation = await this.getNewConversation(persona);
      if (!conversation || !conversation._id) {
        this.sessionLog("error",
          "Failed to create new conversation in startChatSession",
          {
            personaId: args.personaId,
            userId: this.context.user?._id,
          }
        );
        throw new Error("Failed to create new conversation");
      }

      // Apply model/provider overrides if specified
      if (args.modelId) {
        conversation.modelId = args.modelId;
      }
      if (args.providerId) {
        conversation.providerId = args.providerId;
      }
      if (args.modelId || args.providerId) {
        await conversation.save();
      }

      const { macros, tools } = this.collectMacrosAndTools({
        macros: args.macros,
        tools: args.tools,
        persona,
      });

      conversation.macros = macros;
      conversation.tools = tools;

      // Get the system prompt from the persona.
      const systemPromptTemplate = persona?.prompts?.["system"];

      if (systemPromptTemplate) {
        // The prompt content may already be fully compiled (e.g. from buildSystemPrompt()).
        // Attempt lodash template interpolation for user/persona context, but fall back
        // to the raw content if it contains literal ${...} patterns that fail to compile.
        let promptText: string;
        try {
          promptText = this.context.utils.lodash.template(
            systemPromptTemplate.content
          )({
            user: {
              _id: this.context?.user?._id?.toString() || "unknown_user",
              name:
                (this.context?.user?.firstName || "") + " " + (this.context?.user?.lastName || ""),
              email: this.context?.user?.email || "unknown_email",
              avatar: this.context?.user?.avatar || "unknown_avatar",
              createdAt: this.context?.user?.createdAt || new Date(0),
            },
            session_id: conversation._id?.toString() || "unknown_session",
            user_id: this.context?.user?._id?.toString() || "unknown_user",
            persona_id: persona?.id || "unknown_persona",
            persona: persona,
            macros: macros,
            tools: tools,
          });
        } catch {
          // Template compilation failed — content likely contains literal
          // template syntax from code examples. Use as-is.
          this.sessionLog("warn", "System prompt template interpolation failed, using raw content", {
            personaId: args.personaId,
            userId: this.context?.user?._id?.toString() || "unknown_user",
            systemPromptContent: systemPromptTemplate.content,
          }, conversation._id?.toString(), args.personaId);
          promptText = systemPromptTemplate.content;
        }

        conversation.history.push({
          id: new ObjectId(),
          role: "system",
          content: promptText,
          timestamp: new Date(),
          tool_results: [],
        });
      }

      // Load context from a previous session if requested (cross-agent context sharing)
      if (args.contextFromSessionId) {
        try {
          const contextSummary = await this.generateContextSummary(args.contextFromSessionId);
          if (contextSummary) {
            conversation.parentSessionId = args.contextFromSessionId;
            conversation.history.push({
              id: new ObjectId(),
              role: "system",
              content: contextSummary,
              timestamp: new Date(),
              tool_results: [],
            });
            this.sessionLog("info", "Loaded context from previous session", {
              parentSessionId: args.contextFromSessionId,
              newSessionId: conversation._id?.toString(),
            }, conversation._id?.toString(), args.personaId);
          }
        } catch (contextError) {
          this.sessionLog("warn", "Failed to load context from previous session, continuing without it", {
            contextFromSessionId: args.contextFromSessionId,
            error: contextError?.message || contextError,
          }, conversation._id?.toString(), args.personaId);
        }
      }

      // @ts-ignore
      await conversation.save();

      // Validate the final conversation after all modifications
      this.validateConversationDocument(
        conversation,
        "startChatSession",
        "final_conversation"
      );

      this.sessionLog("info", "Successfully started chat session", {
        conversationId: conversation._id?.toString(),
        personaId: conversation.personaId,
        userId: conversation.user?.toString(),
        macrosCount: conversation.macros?.length || 0,
        toolsCount: conversation.tools?.length || 0,
        historyLength: conversation.history?.length || 0,
        tokenCount: conversation.tokenCount,
        maxTokens: conversation.maxTokens,
      }, conversation._id?.toString(), conversation.personaId);

      // Fix: StreamingMode is a type, not a value. Use the string literal instead.
      if (args.streamingMode === StreamingMode.SSE) {
        return this.createInitiateSSEResponse(conversation._id.toString(), conversation as unknown as ReactorConversationDocument);
      }

      (conversation as unknown as ReactorChatState).__typename = "ReactorChatState";

      return conversation as unknown as ReactorInitChatResponse;
    } catch (error) {
      this.sessionLog("error", "Error starting chat session", {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        personaId: args.personaId,
        userId: this.context.user?._id,
      }, undefined, args.personaId);
      
      return {
        __typename: "ReactorErrorResponse",
        code: ReactorErrorCode.INTERNAL_ERROR,
        message: "Error starting chat session",
        details: error,
        timestamp: new Date(),
        recoverable: false,
        suggestion: "Please try again later.",
      } as unknown as ReactorInitChatResponse;
    }
  }

  /**
   * Process multiple tool calls with proper orchestration
   * This method handles the execution of multiple tools in sequence or parallel
   */
  async processToolCalls(args: {
    toolCalls: any[];
    personaId: string;
    chatSessionId: string;
    executionMode?: "sequential" | "parallel";
    maxRetries?: number;
  }): Promise<any> {
    const {
      toolCalls,
      personaId,
      chatSessionId,
      executionMode = "sequential",
      maxRetries = 3,
    } = args;

    // Validate chatSessionId
    this.validateChatSessionId(chatSessionId, "processToolCalls");

    if (!toolCalls || toolCalls.length === 0) {
      return { results: [], errors: [] };
    }

    const results = [];
    const errors = [];

    // Get conversation once to validate it exists
    const conversation = await ReactorConversationModel.findOne({
      _id: chatSessionId,
      user: this.context.user,
    })
      .populate("user")
      .exec();

    if (!conversation) {
      throw new Error(
        `Chat session with id ${chatSessionId} not found or you do not have permission to access it.`
      );
    }

    try {
      if (executionMode === "parallel") {
        // Execute tools in parallel for better performance
        const toolPromises = toolCalls.map(async (toolCall, index) => {
          return this.executeSingleToolCall(
            toolCall,
            conversation,
            index,
            maxRetries
          );
        });

        const toolResults = await Promise.allSettled(toolPromises);

        toolResults.forEach((result, index) => {
          if (result.status === "fulfilled") {
            results.push(result.value);
          } else {
            errors.push({
              toolCall: toolCalls[index],
              error: result.reason,
              index,
            });
          }
        });
      } else {
        // Execute tools sequentially for dependency management
        for (let i = 0; i < toolCalls.length; i++) {
          try {
            const result = await this.executeSingleToolCall(
              toolCalls[i],
              conversation,
              i,
              maxRetries
            );
            results.push(result);
            // Note: executeSingleToolCall → executeMacro already pushes
            // the tool result to conversation history, so no additional
            // history push is needed here.
          } catch (error) {
            errors.push({
              toolCall: toolCalls[i],
              error: error.message,
              index: i,
            });

            // Add error entry to history — executeMacro only pushes on success,
            // so we need to record failures here.
            await ReactorConversationModel.findOneAndUpdate(
              { _id: chatSessionId },
              {
                $push: {
                  history: {
                    id: new ObjectId(),
                    role: "tool",
                    content: `Tool ${toolCalls[i].function?.name} failed: ${error.message}`,
                    timestamp: new Date(),
                    tool_errors: [
                      {
                        name: toolCalls[i].function?.name,
                        error: error.message,
                      },
                    ],
                    tool_call_id: toolCalls[i].id,
                  },
                },
                $set: { updated: new Date() },
              },
              { new: true }
            ).exec();

            // Continue with next tool even if one fails
            this.sessionLog("warn",
              `Tool execution failed: ${toolCalls[i].function?.name}`,
              { error: error?.message },
              chatSessionId, personaId
            );
          }
        }
      }

      // Send consolidated results back to AI provider
      if (results.length > 0) {
        const consolidatedResults = this.consolidateToolResults(results);
        const response = await this.sendMessage({
          personaId,
          chatSessionId,
          message: consolidatedResults,
          role: "tool",
          tool_name: "consolidated_results",
          tool_args: { results, errors },
          tool_call_id: `consolidated_${Date.now()}`,
        });

        return {
          results,
          errors,
          consolidatedResponse: response,
        };
      }

      return { results, errors };
    } catch (error) {
      this.sessionLog("error", `Error processing tool calls: ${error.message}`, {
        error: error?.message,
      }, chatSessionId, personaId);
      throw error;
    }
  }

  /**
   * Execute a single tool call with retry logic
   */
  private async executeSingleToolCall(
    toolCall: any,
    conversation: any,
    index: number,
    maxRetries: number
  ): Promise<any> {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { function: func } = toolCall;
        if (!func || !func.name) {
          throw new Error("Invalid tool call: missing function name");
        }

        // Check if tool exists in conversation
        const toolDef = conversation.tools.find(
          (t: any) => t.function?.name === func.name
        );
        if (!toolDef) {
          throw new Error(`Tool ${func.name} not found in conversation`);
        }

        // Execute the tool
        const result = await this.executeMacro({
          macro: func.name,
          personaId: conversation.personaId,
          chatSessionId: conversation._id.toString(),
          args: func.arguments || {},
          calledBy: "assistant",
          callId: toolCall.id,
        });

        return {
          id: toolCall.id,
          name: func.name,
          result,
          index,
          attempt,
          timestamp: new Date(),
        };
      } catch (error) {
        lastError = error;
        this.sessionLog("warn",
          `Tool execution attempt ${attempt} failed: ${toolCall.function?.name}`,
          { error: error?.message },
          conversation._id?.toString(), conversation.personaId
        );

        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, attempt) * 1000)
          );
        }
      }
    }

    throw new Error(
      `Tool ${toolCall.function?.name} failed after ${maxRetries} attempts: ${lastError?.message}`
    );
  }

  /**
   * Check if an AI response is actually an error response
   */
  private isErrorResponse(response: any): boolean {
    if (!response) return true;

    // Check if it's a ReactorErrorResponse
    if (response.__typename === "ReactorErrorResponse") {
      return true;
    }

    // Check if it's an error response from AI providers
    if (response.choices && response.choices.length > 0) {
      const choice = response.choices[0];
      const content = choice.message?.content || "";

      // Check for error indicators in content
      const errorIndicators = [
        "i'm experiencing some technical difficulties",
        "i'm unable to provide",
        "error occurred",
        "something went wrong",
        "please try again",
        "technical difficulties",
      ];

      return errorIndicators.some((indicator) =>
        content.toLowerCase().includes(indicator)
      );
    }

    return false;
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
      "ai provider error",
      "retryable",
      "overloaded",
      "throttled",
      "throttling",
    ];

    return retryablePatterns.some(
      (pattern) => errorMessage.includes(pattern) || errorCode.includes(pattern)
    );
  }

  /**
   * Consolidate multiple tool results into a single response
   */
  private consolidateToolResults(results: any[]): string {
    if (results.length === 1) {
      return results[0].result?.content || JSON.stringify(results[0].result);
    }

    const consolidated = results
      .map((result, index) => {
        const content = result.result?.content || JSON.stringify(result.result);
        return `Tool ${index + 1} (${result.name}): ${content}`;
      })
      .join("\n\n");

    return `Multiple tools executed successfully:\n\n${consolidated}`;
  }

  /**
   * Process large documents with chunking and summarization
   */
  async processLargeDocument(args: {
    content: string;
    personaId: string;
    chatSessionId: string;
    options?: {
      maxChunkSize?: number;
      overlapSize?: number;
      chunkBy?: "tokens" | "sentences";
      preserveStructure?: boolean;
      includeSummary?: boolean;
      summaryStrategy?: "individual" | "hierarchical" | "final";
    };
  }): Promise<{
    results: any[];
    summary: {
      totalChunks: number;
      processedChunks: number;
      failedChunks: number;
      totalTokens: number;
      originalSize: number;
      processingTime: number;
      finalSummary?: string;
    };
  }> {
    const { content, personaId, chatSessionId, options = {} } = args;

    // Validate chatSessionId
    this.validateChatSessionId(chatSessionId, "processLargeDocument");

    if (!this.chunkingService) {
      throw new Error("DocumentChunkingService not available");
    }

    // Monitor document size first
    const sizeInfo = this.chunkingService.monitorDocumentSize(content);
    if (sizeInfo.warnings.length > 0) {
      this.sessionLog("warn",
        "Large document detected",
        {
          warnings: sizeInfo.warnings,
          recommendations: sizeInfo.recommendations,
        }, chatSessionId, personaId
      );
    }

    // Process the document using the chunking service
    return await this.chunkingService.processLargeDocumentWithAI(
      content,
      this.sendMessage.bind(this),
      { personaId, _id: chatSessionId },
      options
    );
  }

  toString?(includeVersion?: boolean): string {
    return `ReactorConversationService${includeVersion ? "@1.0.0" : ""}`;
  }

  description?: string = "Service for managing reactor chat conversations";
  tags?: string[] = ["ai", "chat", "conversations"];
  nameSpace: string = "reactor";
  name: string = "Reactor Conversation Service";
  version: string = "1.0.0";

  /**
   * Validate chatSessionId parameter
   *
   * @param chatSessionId - The chat session ID to validate
   * @param operation - The operation name for error context
   * @throws {Error} When chatSessionId is invalid
   */
  private validateChatSessionId(
    chatSessionId: string | undefined,
    operation: string
  ): void {
    if (!chatSessionId || chatSessionId.trim() === "") {
      const errorResponse = this.createErrorResponse(
        ReactorErrorCode.MISSING_REQUIRED_FIELD,
        "Chat session ID is required",
        {
          operation,
          recoverable: false,
        }
      );
      throw new Error(errorResponse.message);
    }

    // Validate ObjectId format if it's not a new conversation
    if (chatSessionId !== "new" && !ObjectId.isValid(chatSessionId)) {
      const errorResponse = this.createErrorResponse(
        ReactorErrorCode.INVALID_FORMAT,
        "Invalid chat session ID format",
        {
          operation,
          conversationId: chatSessionId,
          recoverable: false,
          details: { providedValue: chatSessionId },
        }
      );
      throw new Error(errorResponse.message);
    }
  }
}
