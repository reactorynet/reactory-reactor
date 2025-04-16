import OpenAI from "openai";
import { Interface as ReadLineInterface } from "readline";
import { Chat } from ".";
import { IAIPersona } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { ReactorConversationHistory } from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse";
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket';

// Tool approval modes
export enum ToolApprovalMode {
  AUTO = "auto",      // Execute all tools without asking
  PROMPT = "prompt",  // Ask for confirmation before executing any tool
  SAFE_AUTO = "safe_auto" // Auto-approve safe tools, prompt for potentially dangerous ones
}

export type Macro<TResult> = (params: any[], state: ChatState) => Promise<TResult>

export type MacroFunctions = {
  [macro: string]: Macro<unknown>
};

export type MacroToolDefinition = {
  type: "function",
  propsMap?: Record<string, string>,
  function: {
    name: string;
    description?: string;
    parameters: {
      type: "object";
      properties: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
        items?: {
          type: string;
          properties?: Record<string, unknown>;
        };
      }>;
      required?: string[];
    };
  }
};

export type MacroComponentDefinition<TMacro> = Reactory.IReactoryComponentDefinition<TMacro> & {
  mcp?: any
  tools?: MacroToolDefinition[]
  /**
   * An alias for a macro. The name of the macro and the alias won't always match.
   * We use this to provide a more human readable name for the macro.
   */
  alias?: string
};

export type KnownCannedMessages = 
  "welcome" | 
  "help" | 
  "goodbye" | 
  "error" |
  "givemeaccess"

export type CanedMessages = {
  [key in KnownCannedMessages]: string;
};

export type RatedChatCompletionResponseMessage = OpenAI.ChatCompletionMessage & { rating?: number };

export type ChatMessage = OpenAI.ChatCompletionMessage | RatedChatCompletionResponseMessage;

export interface MCPClient {
  id: string
  client: Client
  transports: {
    sse?: { 
      url: URL
      requestInit?: RequestInit
      eventSourceInit?: {
        fetch: (url: string, init?: RequestInit) => Promise<Response>
      }
    }
    stdio?: StdioClientTransport
    websocket?: WebSocketClientTransport    
  }
  name?: string
  description?: string
}

/**
 * Represents the state of a chat session.
 */
export type ChatState = {
  /**
   * The unique identifier for the chat session. This will be null
   * until the chat session is persisted to the database.
   */
  id?: string
  /**
   * The host that the chat session is running on. Default is server.
   * 
   * It is important that we know where the chat sessions is running so that we can 
   * determine what response format to use and what features we can include in the
   * chat responses.
   */
  host?: "server" | "cli" | "web" | "mobile"
  /**
   * The unique identifier for the bot that is being used for the chat session.
   * 
   * The id of the bot defines what configuration is used for the bot.
   * */
  personaId: string
  /**
   * The persona that is associated with the chat session.
   */
  persona: IAIPersona,
  /**
   * The date and time the chat session was started.
   */
  started: Date
  /**
   * The OpenAI API key used for the chat session.
   */
  apiKey: string
  /**
   * The OpenAI API organization used for the chat session.
   */
  apiOrg: string
  /**
   * The OpenAI API model used for the chat session.
   */
  modelId: string
  /**
   * The history of the chat session.
   */
  history: ReactorConversationHistory
  /**
   * The OpenAI API instance used for the chat session.
   */
  ai: OpenAI
  /**
   * The authentication token for the chat session, this is for authentication 
   * against the reactory server.
   */
  authToken?: string
  /**
   * The user that is associated with the chat session, this will be in the 
   * form of an API status object.
   */
  user?: Reactory.Models.IApiStatus
  /**
   * The context for the chat session.
   */
  context?: Reactory.Server.IReactoryContext
  /**
   * The date the chat session was persisted to the database.
   */
  created?: Date  
  /**
   * The date the chat session was last updated.
   */
  updated?: Date
  /**
   * 
   * The macros that are available for the chat session.
   * */
  macros: MacroComponentDefinition<unknown>[]
  /**
   * The readline interface for the chat session.
   * -- only used when running in the CLI
   */
  rl?: ReadLineInterface
  /**
   * Variables that are available for the chat session.
   * */
  vars: {
    [key: string]: unknown
  }
  /**
   * The tool approval mode for the chat session.
   */
  toolApprovalMode?: ToolApprovalMode; // Added field for tool approval mode

  /**
   * A list of MCP Clients
   */
  mcpClients?: MCPClient[]
  /**
   * A placeholder for a SSE session. This is used for the MCP client.
   */
  sseSession?: any;
}

export interface QuestionHandlerResponse {
  next: IQuestion | null,
  state: ChatState
}

export interface IQuestion {
  id?: number,
  when?: Date,
  askIf?: (state: ChatState) => boolean,
  question: string,
  response?: string,
  output?: unknown,
  valid?: boolean,
  next?: IQuestion,
  handler: (response: string, state: ChatState) => Promise<QuestionHandlerResponse>
}

export interface IQuestionGroup {
  [key: string | symbol]: IQuestion,
}

export interface IQuestionCollection {
  [key: string | symbol]: IQuestionGroup
}

export interface IToolCallRequest { 
  id: string
  function: {
    name: string
    arguments: string
  }
  type: "function"
}

export interface IToolCallResponse {
  role: "tool"
  content: string
  tool_call_id: string
}