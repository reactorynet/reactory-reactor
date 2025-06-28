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

export type Macro<TResult, TParams = any> = (params: TParams, state: ChatState, context?: Reactory.Server.IReactoryContext) => Promise<TResult>

export type MacroFunctions = {
  [macro: string]: Macro<unknown>
};

/** Optional. The type of the data. */
export declare enum Type {
    TYPE_UNSPECIFIED = "TYPE_UNSPECIFIED",
    STRING = "STRING",
    NUMBER = "NUMBER",
    INTEGER = "INTEGER",
    BOOLEAN = "BOOLEAN",
    ARRAY = "ARRAY",
    OBJECT = "OBJECT"
}

/** Schema is used to define the format of input/output data. Represents a select subset of an [OpenAPI 3.0 schema object](https://spec.openapis.org/oas/v3.0.3#schema-object). More fields may be added in the future as needed. */
export declare interface Schema {
    /** Optional. The value should be validated against any (one or more) of the subschemas in the list. */
    anyOf?: Schema[];
    /** Optional. Default value of the data. */
    default?: unknown;
    /** Optional. The description of the data. */
    description?: string;
    /** Optional. Possible values of the element of primitive type with enum format. Examples: 1. We can define direction as : {type:STRING, format:enum, enum:["EAST", NORTH", "SOUTH", "WEST"]} 2. We can define apartment number as : {type:INTEGER, format:enum, enum:["101", "201", "301"]} */
    enum?: string[];
    /** Optional. Example of the object. Will only populated when the object is the root. */
    example?: unknown;
    /** Optional. The format of the data. Supported formats: for NUMBER type: "float", "double" for INTEGER type: "int32", "int64" for STRING type: "email", "byte", etc */
    format?: string;
    /** Optional. SCHEMA FIELDS FOR TYPE ARRAY Schema of the elements of Type.ARRAY. */
    items?: Schema;
    /** Optional. Maximum number of the elements for Type.ARRAY. */
    maxItems?: string;
    /** Optional. Maximum length of the Type.STRING */
    maxLength?: string;
    /** Optional. Maximum number of the properties for Type.OBJECT. */
    maxProperties?: string;
    /** Optional. Maximum value of the Type.INTEGER and Type.NUMBER */
    maximum?: number;
    /** Optional. Minimum number of the elements for Type.ARRAY. */
    minItems?: string;
    /** Optional. SCHEMA FIELDS FOR TYPE STRING Minimum length of the Type.STRING */
    minLength?: string;
    /** Optional. Minimum number of the properties for Type.OBJECT. */
    minProperties?: string;
    /** Optional. SCHEMA FIELDS FOR TYPE INTEGER and NUMBER Minimum value of the Type.INTEGER and Type.NUMBER */
    minimum?: number;
    /** Optional. Indicates if the value may be null. */
    nullable?: boolean;
    /** Optional. Pattern of the Type.STRING to restrict a string to a regular expression. */
    pattern?: string;
    /** Optional. SCHEMA FIELDS FOR TYPE OBJECT Properties of Type.OBJECT. */
    properties?: Record<string, Schema>;
    /** Optional. The order of the properties. Not a standard field in open api spec. Only used to support the order of the properties. */
    propertyOrdering?: string[];
    /** Optional. Required properties of Type.OBJECT. */
    required?: string[];
    /** Optional. The title of the Schema. */
    title?: string;
    /** Optional. The type of the data. */
    type?: Type | string; // Type can be a string for custom types
}

export type MacroToolDefinition = {
  type: "function",
  propsMap?: Record<string, string>,
  runat?: "server" | "client",
  enabled?: boolean,
  roles?: string[],
  function: {
    icon?: string;
    name: string;
    description?: string;
    parameters: Schema
  }
};

export type MacroComponentDefinition<TMacro> = Reactory.IReactoryComponentDefinition<TMacro> & {
  mcp?: any
  icon?: string
  runat?: "server" | "client"
  tools?: MacroToolDefinition[]
  parameters?: Schema
  /**
   * An alias for a macro. The name of the macro and the alias won't always match.
   * We use this to provide a more human readable name for the macro.
   */
  alias?: string,
  enabled?: boolean
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
   * The user that is associated with the chat session
   */
  user?: Partial<Reactory.Models.IUser> | Reactory.Models.IUserDocument
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
  macros: Partial<MacroComponentDefinition<unknown>>[]
  /**
   * The tools that are available for the chat session.
   * 
   * Tools are defined as macros that can be executed in the chat session.
   * */
  tools: Partial<MacroToolDefinition>[]
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

export interface IReactorModule extends Reactory.Server.IReactoryModule {
  reactor: {
    macros?: MacroComponentDefinition<unknown>[]
    tools?: MacroToolDefinition[]
    providers?: any[],
    personas?: IAIPersona[]
  }
}