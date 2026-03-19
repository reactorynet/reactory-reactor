/**
 * Type definitions for the ReactorTUI — a blessed-based terminal UI for
 * the Reactor AI assistant with feature parity to the ReactorChat PWA client.
 */
import { EventEmitter } from "events";
import {
  StreamingMode,
  StreamingEvent,
  StreamingEventType,
  TokenStreamingEvent,
  ReasoningStreamingEvent,
  ToolCallStreamingEvent,
  CompletionStreamingEvent,
  ErrorStreamingEvent,
  ToolIterationLimitStreamingEvent,
  RetryStreamingEvent,
} from "@reactory/server-modules/reactory-reactor/services/reactor/types/streaming.types";
import {
  ChatState,
  MacroToolDefinition,
  MacroComponentDefinition,
  ToolApprovalMode,
  IQuestion,
} from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IAIPersona } from "@reactory/server-modules/reactory-reactor/types/service.types";

// Re-export commonly used types
export {
  StreamingMode,
  StreamingEvent,
  StreamingEventType,
  ChatState,
  ToolApprovalMode,
  MacroToolDefinition,
  MacroComponentDefinition,
  IAIPersona,
};

// ── Network Status ─────────────────────────────────────────────────────

export type NetworkStatus = "idle" | "connected" | "reconnecting" | "error";

// ── Transport ──────────────────────────────────────────────────────────

export interface TransportEvent {
  type: StreamingEventType;
  sessionId: string;
  conversationId: string;
  messageId: string;
  timestamp: Date;
  data: any;
}

export interface ChatTransport extends EventEmitter {
  readonly mode: "direct" | "http";

  sendMessage(
    message: string,
    sessionId: string,
    options?: {
      images?: string[];
      streamingMode?: StreamingMode;
    }
  ): Promise<any>;

  newChat(
    personaId: string,
    options?: {
      systemPrompt?: string;
      tools?: Partial<MacroToolDefinition>[];
      macros?: Partial<MacroComponentDefinition<unknown>>;
      toolApprovalMode?: ToolApprovalMode;
      streamingMode?: StreamingMode;
      contextFromSessionId?: string;
    }
  ): Promise<any>;

  loadChat(sessionId: string): Promise<any>;
  listChats(filter?: { personaId?: string }): Promise<any[]>;
  deleteChat(sessionId: string): Promise<boolean>;

  setToolApprovalMode(
    sessionId: string,
    mode: ToolApprovalMode
  ): Promise<void>;
  setMaxToolIterations(
    sessionId: string,
    count: number
  ): Promise<void>;
  continueToolExecution(
    sessionId: string,
    personaId: string,
    maxIterations?: number
  ): Promise<any>;
  setModelProvider(
    sessionId: string,
    modelId?: string,
    providerId?: string
  ): Promise<void>;

  uploadFile(filePath: string, sessionId: string): Promise<any>;

  executeMacro(
    macro: string,
    personaId: string,
    sessionId: string,
    args?: any
  ): Promise<any>;

  disconnect(): void;
}

// ── Persona Session Cache ──────────────────────────────────────────────

export interface PersonaSessionCache {
  chatState: TUIState;
  isInitialized: boolean;
}

// ── TUI State ──────────────────────────────────────────────────────────

export interface TUIState {
  /** Current chat session ID (from server) */
  sessionId: string | null;
  /** Chat history for display */
  messages: TUIMessage[];
  /** Active persona */
  persona: IAIPersona | null;
  /** Current model override */
  modelOverride: { modelId?: string; providerId?: string } | null;
  /** Tool approval mode */
  toolApprovalMode: ToolApprovalMode;
  /** Max tool iterations */
  maxToolIterations: number | null;
  /** Token usage */
  tokenCount: number;
  maxTokens: number | null;
  tokenPressure: number;
  /** Streaming state */
  isStreaming: boolean;
  streamingEnabled: boolean;
  currentStreamingContent: string;
  currentThinkingContent: string;
  /** Network status */
  networkStatus: NetworkStatus;
  reconnectAttempt: number;
  /** Session variables (todos, etc.) */
  vars: Record<string, unknown>;
  /** Files attached to session */
  files: any[];
  /** Whether the chat is busy (awaiting response) */
  busy: boolean;
  /** Available tools */
  tools: Partial<MacroToolDefinition>[];
  /** Tool iteration limit info (when paused) */
  toolIterationLimitInfo: {
    iterationsCompleted: number;
    maxIterations: number;
    partialContent: string;
  } | null;
  /** Voice mode active */
  voiceModeActive: boolean;
}

// ── TUI Message ────────────────────────────────────────────────────────

export interface TUIMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "error";
  content: string;
  timestamp: Date;
  /** Reasoning/thinking content from extended thinking models */
  thinking?: string;
  /** Tool calls requested by assistant */
  tool_calls?: {
    id: string;
    name: string;
    arguments: any;
    status: "pending" | "running" | "success" | "error";
  }[];
  /** Tool results */
  tool_results?: {
    id: string;
    name?: string;
    content?: any;
  }[];
  /** Tool errors */
  tool_errors?: {
    id: string;
    name?: string;
    error?: string;
  }[];
  /** Activity notification rather than real message */
  isActivity?: boolean;
  /** User rating */
  rating?: number | null;
}

// ── Panel State ────────────────────────────────────────────────────────

export type PanelName =
  | "personas"
  | "tools"
  | "history"
  | "files"
  | "todos"
  | "debug"
  | "fileExplorer";

export type DockSide = "left" | "right";

export interface PanelState {
  open: boolean;
  dock: DockSide;
}

// ── Command ────────────────────────────────────────────────────────────

export interface TUICommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  handler: (args: string[], state: TUIState) => Promise<void>;
}

// ── Audio ──────────────────────────────────────────────────────────────

export type AudioPlatform = "darwin" | "linux" | "win32" | "unknown";

export interface AudioServiceOptions {
  platform?: AudioPlatform;
  sampleRate?: number;
  channels?: number;
  format?: "wav" | "raw";
}

export interface SpeechAdapterOptions {
  /** Direct mode: use service via DI context */
  context?: Reactory.Server.IReactoryContext;
  /** HTTP mode: base URL for speech service */
  baseUrl?: string;
  /** Default voice for TTS */
  defaultVoice?: string;
}

// ── Theme ──────────────────────────────────────────────────────────────

export interface TUITheme {
  primary: string;
  secondary: string;
  background: string;
  text: string;
  muted: string;
  error: string;
  warning: string;
  success: string;
  info: string;
  user: string;
  assistant: string;
  system: string;
  tool: string;
  thinking: string;
  border: string;
  highlight: string;
}
