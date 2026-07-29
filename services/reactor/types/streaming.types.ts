/**
 * Streaming mode options for conversation service
 */
export enum StreamingMode {
  NONE = 'NONE',
  SSE = 'SSE',
  WEBSOCKET = 'WEBSOCKET'
}

export type PromptMergeStrategy = 'append' | 'prepend' | 'replace';

/**
 * Client capabilities for streaming support
 */
export interface StreamingClientCapabilities {
  /** Whether the client supports token-by-token streaming */
  supportsTokenStreaming: boolean;
  /** Whether the client supports tool execution streaming */
  supportsToolStreaming: boolean;
  /** Buffer size for streaming data (optional) */
  bufferSize?: number;
  /** Timeout in milliseconds for streaming operations (optional) */
  timeoutMs?: number;
}

/**
 * Arguments for sending a message with streaming support
 */
export interface SendMessageWithStreamingArgs {
  /** ID of the persona to use for the conversation */
  personaId: string;
  /** Optional chat session ID for continuity */
  chatSessionId?: string;
  /** Message content to send */
  message: string;
  /** Streaming mode preference */
  streamingMode: StreamingMode;
  /** Client streaming capabilities */
  clientCapabilities?: StreamingClientCapabilities;
}

/**
 * Streaming session state and metadata
 */
export interface StreamingSession {
  /** Unique session identifier */
  sessionId: string;
  /** Associated conversation ID */
  conversationId: string;
  /** User ID owning the session */
  userId: string;
  /** Transport type being used */
  transport: 'sse' | 'websocket';
  /** Current session status */
  status: 'active' | 'paused' | 'completed' | 'error';
  /** Session creation timestamp */
  createdAt: Date;
  /** Last activity timestamp */
  lastActivity: Date;
  /** Session expiration timestamp */
  expiresAt: Date;
  
  /** Current streaming message state */
  currentMessage?: {
    id: string;
    content: string;
    isComplete: boolean;
    tokens: StreamingToken[];
  };
  
  /** Active tool execution state */
  activeTool?: {
    name: string;
    callId: string;
    status: 'running' | 'completed' | 'error';
    result?: any;
  };
  
  /** Client streaming capabilities */
  capabilities: StreamingClientCapabilities;

  /** Voice session configuration (present when voice is enabled) */
  voice?: {
    /** Whether TTS is enabled for AI responses */
    ttsEnabled: boolean;
    /** Whether STT is enabled for user input */
    sttEnabled: boolean;
    /** The voice ID to use for TTS synthesis */
    voiceId?: string;
    /** The language for STT transcription */
    sttLanguage?: string;
  };
}

/**
 * Individual streaming token with metadata
 */
export interface StreamingToken {
  /** Token content */
  content: string;
  /** Position in the message */
  position: number;
  /** Timestamp when token was generated */
  timestamp: Date;
  /** Whether this is the final token */
  isFinal?: boolean;
}

export enum StreamingEventType {
  TOKEN = 'token',
  TOOL_CALL = 'tool_call',
  REASONING = 'reasoning',
  COMPLETE = 'complete',
  ERROR = 'error',
  TOOL_ITERATION_LIMIT = 'tool_iteration_limit',
  RETRY = 'retry',
  COMPACTION = 'compaction',
  INTERRUPTED = 'interrupted',
  SHELL = 'shell'
}

/**
 * The lifecycle phase of a shell stream event.
 * - `start`  : a command / interactive session began (carries `command`, `cwd`, `pid`)
 * - `stdout` : an incremental chunk of standard output (carries `chunk`)
 * - `stderr` : an incremental chunk of standard error (carries `chunk`)
 * - `exit`   : the process terminated (carries `exitCode`)
 */
export type ShellStreamPhase = 'start' | 'stdout' | 'stderr' | 'exit';

/**
 * Identifies where a shell stream originates so the UI can route/group it:
 * - `macro`    : a one-shot `shell` tool call executed by the LLM
 * - `widget`   : an interactive PTY session driven by a human via the shell widget
 * - `workflow` : a `cli_command` step running inside the YamlFlow workflow engine
 */
export type ShellStreamSource = 'macro' | 'widget' | 'workflow';
/**
 * Base streaming event interface
 */
export interface StreamingEventBase {
  /** Event type discriminator */
  type: StreamingEventType;
  /** Session ID this event belongs to */
  sessionId: string;
  /** Conversation ID this event belongs to */
  conversationId: string;
  /** Message ID this event belongs to */
  messageId: string;
  /** Event timestamp */
  timestamp: Date;
  /** Event-specific data */
  data: any;
}

/**
 * Token streaming event
 */
export interface TokenStreamingEvent extends StreamingEventBase {
  type: StreamingEventType.TOKEN;
  data: {
    /**
     * The incremental text produced by this chunk (same as `delta`).
     * NOTE: This is NOT the accumulated response — it is the per-event
     * delta.  Both `content` and `delta` carry the same value for
     * symmetry with the client's `event.data.content || event.data.delta`
     * fallback pattern.
     */
    content: string;
    /** Incremental text produced by this chunk */
    delta: string;
    /** Byte-offset in the accumulated response so far */
    position: number;
    /** Whether this is the final token */
    isComplete: boolean;
  };
}

/**
 * Tool call streaming event
 */
export interface ToolCallStreamingEvent extends StreamingEventBase {
  type: StreamingEventType.TOOL_CALL;
  data: {
    name: string;           // Changed from toolName to match actual data
    arguments: any;
    id: string;             // Changed from callId to match actual data
    isComplete: boolean;     // Changed from status to match actual data
    /** The execution result, included when isComplete is true */
    result?: any;
  };
}

/**
 * Reasoning/thinking streaming event — emitted for AI models that produce
 * a visible chain-of-thought before the final response (e.g. OpenAI o1/o3,
 * Anthropic extended thinking, Google Gemini thinking mode).
 */
export interface ReasoningStreamingEvent extends StreamingEventBase {
  type: StreamingEventType.REASONING;
  data: {
    content: string;
    delta: string;
    position: number;
    isComplete: boolean;
  };
}

export interface CompletionStreamingEvent extends StreamingEventBase {
  type: StreamingEventType.COMPLETE;
  data: {
    content: string;
    finishReason: 'stop' | 'error';
    /** Full reasoning/thinking content accumulated during streaming (if any) */
    thinking?: string;
    /** Generated images (base64 or URL) returned by image generation models */
    images?: Array<{ b64_json?: string; url?: string; mimeType?: string }>;
  };
}

export interface ErrorStreamingEvent extends StreamingEventBase {
  type: StreamingEventType.ERROR;
  data: {
    message: string;
    error: Error;
  };
}

export interface ToolIterationLimitStreamingEvent extends StreamingEventBase {
  type: StreamingEventType.TOOL_ITERATION_LIMIT;
  data: {
    iterationsCompleted: number;
    maxIterations: number;
    partialContent: string;
  };
}

/**
 * Retry streaming event — emitted when the provider hits a retryable error
 * (e.g. rate limiting) and will automatically retry after a backoff period.
 * Allows the client to surface "Retrying in Xs…" feedback to the user.
 */
export interface RetryStreamingEvent extends StreamingEventBase {
  type: StreamingEventType.RETRY;
  data: {
    /** Current retry attempt (1-based) */
    attempt: number;
    /** Maximum number of retries that will be attempted */
    maxAttempts: number;
    /** Backoff delay in milliseconds before the next attempt */
    retryAfterMs: number;
    /** Human-readable reason for the retry (e.g. "Rate limited") */
    reason: string;
  };
}

/**
 * Compaction streaming event — emitted when the conversation context window
 * is approaching capacity and auto-compaction is triggered. The LLM summarizes
 * older messages so they can be archived and replaced with a compact summary.
 */
export interface CompactionStreamingEvent extends StreamingEventBase {
  type: StreamingEventType.COMPACTION;
  data: {
    /** Current phase of the compaction process */
    phase: 'start' | 'progress' | 'complete' | 'error';
    /** Human-readable reason for compaction (start phase) */
    reason?: string;
    /** Token count before compaction */
    tokensBefore?: number;
    /** Conversation maxTokens limit */
    maxTokens?: number;
    /** Percentage of maxTokens used before compaction */
    percentageUsed?: number;
    /** Number of messages archived during compaction */
    messagesArchived?: number;
    /** Token count after compaction (complete phase) */
    tokensAfter?: number;
    /** Percentage of maxTokens used after compaction (complete phase) */
    percentageAfter?: number;
    /** Error message if compaction failed (error phase) */
    errorMessage?: string;
    /** Whether the system fell back to dumb truncation (error phase) */
    usedFallback?: boolean;
  };
}

/**
 * Interrupted streaming event — emitted when the user interrupts an ongoing
 * auto tool execution loop. The server stops tool execution at the next
 * iteration boundary and persists a summary message.
 */
export interface InterruptedStreamingEvent extends StreamingEventBase {
  type: StreamingEventType.INTERRUPTED;
  data: {
    /** Number of tool iterations completed before interruption */
    iterationsCompleted: number;
    /** User-provided reason for the interruption, if any */
    reason?: string;
  };
}

/**
 * Shell streaming event — emitted while a shell process (one-shot macro,
 * interactive PTY widget session, or workflow cli_command step) produces
 * output. Every event carries a `shellSessionId` so a single streaming
 * channel (chat conversation or workflow run) can multiplex many terminals;
 * the client filters/groups by that id.
 */
export interface ShellStreamingEvent extends StreamingEventBase {
  type: StreamingEventType.SHELL;
  data: {
    /** Terminal identity — groups all events for one process/session */
    shellSessionId: string;
    /** Lifecycle phase of this event */
    phase: ShellStreamPhase;
    /** Origin of the stream (drives UI grouping / affordances) */
    source: ShellStreamSource;
    /** Incremental output bytes (stdout / stderr phases) */
    chunk?: string;
    /** The command line that started the process (start phase) */
    command?: string;
    /** Working directory the process runs in (start phase) */
    cwd?: string;
    /** OS process id, when known (start phase) */
    pid?: number;
    /** Process exit code (exit phase) */
    exitCode?: number;
    /** Whether the process timed out (exit phase) */
    timedOut?: boolean;
  };
}

export type StreamingEvent = TokenStreamingEvent | ToolCallStreamingEvent | ReasoningStreamingEvent | CompletionStreamingEvent | ErrorStreamingEvent | ToolIterationLimitStreamingEvent | RetryStreamingEvent | CompactionStreamingEvent | InterruptedStreamingEvent | ShellStreamingEvent;

/**
 * Per-persona token pacing configuration.
 * Controls how fast streamed tokens are delivered to the client via SSE.
 * All fields are optional — omitted values use system defaults (~250 WPM).
 */
export interface TokenPacerConfig {
  /** Minimum characters to accumulate before flushing (default: 8) */
  minChunkSize?: number;
  /** Maximum characters per flush; large chunks split at word boundaries (default: 80) */
  maxChunkSize?: number;
  /** Target interval in ms between flushes (default: 80) */
  targetIntervalMs?: number;
  /** Hard deadline: flush no later than this many ms after first un-flushed char (default: 100) */
  flushTimeoutMs?: number;
}

/**
 * Arguments for creating a streaming session
 */
export interface CreateStreamingSessionArgs {
  /** Conversation ID to associate with the session */
  conversationId: string;
  /** User ID owning the session */
  userId: string;
  /** Transport type to use */
  transport: 'sse' | 'websocket';
  /** Client streaming capabilities */
  capabilities: StreamingClientCapabilities;
  /** Optional voice session configuration */
  voice?: {
    ttsEnabled: boolean;
    sttEnabled: boolean;
    voiceId?: string;
    sttLanguage?: string;
  };
}
