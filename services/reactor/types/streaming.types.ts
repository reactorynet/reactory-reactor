/**
 * Streaming mode options for conversation service
 */
export type StreamingMode = 'none' | 'sse' | 'websocket';

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

/**
 * Base streaming event interface
 */
export interface StreamingEvent {
  /** Event type discriminator */
  type: 'token' | 'tool_call' | 'complete' | 'error';
  /** Session ID this event belongs to */
  sessionId: string;
  /** Conversation ID this event belongs to */
  conversationId: string;
  /** Event timestamp */
  timestamp: Date;
  /** Event-specific data */
  data: any;
}

/**
 * Token streaming event
 */
export interface TokenStreamingEvent extends StreamingEvent {
  type: 'token';
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
export interface ToolCallStreamingEvent extends StreamingEvent {
  type: 'tool_call';
  data: {
    toolName: string;
    arguments: any;
    callId: string;
    status: 'started' | 'progress' | 'completed' | 'error';
  };
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
}
