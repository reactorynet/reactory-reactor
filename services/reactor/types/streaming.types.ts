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
  TOOL_ITERATION_LIMIT = 'tool_iteration_limit'
}
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
    content: string;
    delta: string;
    position: number;
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

export type StreamingEvent = TokenStreamingEvent | ToolCallStreamingEvent | ReasoningStreamingEvent | CompletionStreamingEvent | ErrorStreamingEvent | ToolIterationLimitStreamingEvent;

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
