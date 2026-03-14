import mongoose, { Schema } from 'mongoose';
import Reactory from '@reactorynet/reactory-core';
import { ObjectId } from 'mongodb';
import OpenAI from "openai"
import { MetaSchema } from '@reactory/server-modules/reactory-core/models/shared';
import { id } from 'schema/reflection';
import { MacroComponentDefinition, MacroToolDefinition, ToolApprovalMode } from '../ai/openai/types/chat';
import { McpSession } from '../types/model.types';
// Removed incorrect import as 'ChatCompletionResponseMessage' is not exported by 'openai'

export interface ConversationMeta { 
  summary: string
  title: string
}

export type ChatHistoryItem = OpenAI.Chat.Completions.ChatCompletionMessage |
  OpenAI.Chat.ChatCompletionMessageParam;

// Add more specific types for other providers if needed
export type ValidProviderResponseTypes = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Represents the execution status of a tool call.
 */
export type ReactorToolCallStatus = 'pending' | 'running' | 'success' | 'error';

/**
 * Represents a single tool call requested by the AI,
 * enriched with execution status when loaded from history.
 */
export type ReactorToolCallEntry = {
  id: string
  type?: string
  function?: {
    name: string
    arguments?: string
  }
  /** Execution status derived from correlating tool results/errors in history */
  status?: ReactorToolCallStatus
};

export type ReactorToolResult = {
  id?: string
  tool_call_id?: string
  name?: string
  role?: 'tool'  
  content: any
  result?: any
  timestamp?: Date
  [key: string]: any
};

export type ReactorToolError = {
  id?: string
  name?: string
  error?: string
  timestamp?: Date
};

export type ReactorConversationHistoryItem = ChatHistoryItem & {
  id: string | ObjectId
  // Original content of the message by the provider
  response?: ValidProviderResponseTypes;
  rating?: number
  component?: string
  timestamp: Date
  tool_name?: string
  tool_args?: any
  tool_call_id?: string
  tool_calls?: ReactorToolCallEntry[]
  tool_results?: ReactorToolResult[]
  tool_errors?: ReactorToolError[]
  /** Reasoning/thinking content from models with extended thinking (OpenAI o1/o3, Anthropic, Gemini) */
  thinking?: string
}

export type ReactorConversationHistory = ReactorConversationHistoryItem[];

export interface ReactorConversationDocument {
  _id: ObjectId
  // The bot persona id
  personaId: string
  // The date the conversation was started
  started: Date,
  // The model id used for the conversation
  modelId: string
  // The user associated with the conversation
  user: Reactory.Models.IUser
  // The meta data for the conversation
  meta: Reactory.Models.IRecordMeta<ConversationMeta>
  // The history of the conversation
  history: ReactorConversationHistory
  // The variables for the conversation
  vars: {
    [key: string]: any
  }
  // The SSE session id for the conversation 
  sseSessionId?: string
  // The date the conversation was created
  created: Date
  // The date the conversation was last
  updated: Date
  // The tool approval mode for the conversation
  toolApprovalMode: ToolApprovalMode  
  // The macros used in the conversation
  macros?: Partial<MacroComponentDefinition<any>>[]
  // The tools used in the conversation
  tools?: Partial<MacroToolDefinition>[]
  // The MCP sessions associated with the conversation
  mcpSessions?: McpSession[]
  // The estimated token count for the conversation
  tokenCount?: number
  // The maximum number of tokens this chat should be
  maxTokens?: number
  // The truncated history - messages removed to stay within token limits
  truncatedHistory?: ReactorConversationHistory
  // The user files attached to this conversation session
  files: Reactory.Models.IReactoryFile[]
  // Optional reference to a parent session that provided context for this session
  parentSessionId?: string
}



export type ReactorConversationDocumentStatics = {
  new(): ReactorConversation
}
export type ReactorConversation = ReactorConversationDocument & ReactorConversationDocumentStatics;

const ReactorConversationHistorySchema = new Schema({
  id: ObjectId,
  response: {},
  content: String,
  refusal: String,
  thinking: String,
  component: String,
  rating: Number,
  role: String,
  annotations: [{}],
  audio: {},
  tool_name: String,
  tool_args: {},
  tool_call_id: String,
  tool_calls: [{}],
  tool_results: [{}],
  tool_errors: [{}],
  timestamp: {
    type: Date,
    default: () => { return new Date() }
  },
});

const ReactorConversationSchema = new Schema({
  // the bot id is the persona id we are using for the conversation
  personaId: {
    type: String,
    required: true,
    default: 'Reactor',
  },
  started: {
    type: Date,
    required: true,
    default: () => { return new Date() }
  },
  modelId: {
    type: String,
    required: true,
    default: process.env.OPENAI_DEFAULT_MODEL_ID || 'grok-2-latest',
  },
  user: {
    type: ObjectId,
    ref: 'User',
  },
  meta: MetaSchema,
  history: [ReactorConversationHistorySchema],
  vars: {},
  sseSessionId: {
    type: String,
    default: null,
  },
  macros: {
    type: [Object],
    default: [],
  },
  tools: {
    type: [Object],
    default: [],
  },
  mcpSessions: {
    type: [Object],
    default: [],
  },
  created: {
    type: Date,
    default: () => { return new Date() }
  },
  updated: {
    type: Date,
    default: () => { return new Date() }
  },
  toolApprovalMode: {
    type: String,
    enum: Object.values(ToolApprovalMode),
    default: ToolApprovalMode.PROMPT,
  },
  // The estimated token count for the conversation
  tokenCount: {
    type: Number,
    default: 0,
    min: 0,
  },
  // The maximum number of tokens this chat should be
  maxTokens: {
    type: Number,
    default: null,
    min: 0,
  },
  files: {
    type: [ObjectId],
    ref: 'ReactoryFile',
    default: [],
  },
  // The truncated history - messages removed to stay within token limits
  truncatedHistory: {
    type: [ReactorConversationHistorySchema],
    default: [],
  },
  // Optional reference to a parent session that provided context for this session
  parentSessionId: {
    type: String,
    default: null,
    index: true,
  },
});

const ReactorConversationModelName = 'ReactorConversation';
const ReactorConversationModel = mongoose.model<ReactorConversationDocument>(ReactorConversationModelName, ReactorConversationSchema, 'reactor_conversations');

// Add unique indexes to prevent duplicate conversations
ReactorConversationSchema.index(
  { personaId: 1, user: 1, started: 1 }, 
  { 
    unique: true, 
    partialFilterExpression: { 
      started: { $exists: true },
      personaId: { $exists: true },
      user: { $exists: true }
    }
  }
);

// Add unique index on sseSessionId to prevent duplicates
ReactorConversationSchema.index(
  { sseSessionId: 1 }, 
  { 
    unique: true, 
    sparse: true,
    partialFilterExpression: { sseSessionId: { $exists: true, $ne: null } }
  }
);

export type TReactorConversationDocument = mongoose.Document & ReactorConversationDocument;
export type TReactorConversationModel = typeof ReactorConversationModel;
export const ReactorConversationModelComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorConversationModel> = { 
  name: 'ReactorConversationModel',
  nameSpace: 'reactor',
  description: 'Reactor Conversation Model',
  version: '1.0.0',
  component: ReactorConversationModel,
  features: [
    {
      feature: 'id',
      description: 'Reactor Conversation Id',
      featureType: Reactory.FeatureType.string,
      action: ['get'],
      stem: 'id',
    },
    {
      feature: 'botId',
      description: 'Reactor Conversation Bot Id',
      featureType: Reactory.FeatureType.string,
      action: ['get'],
      stem: 'botId',
    },
    {
      feature: 'started',
      description: 'Reactor Conversation Start Date',
      featureType: Reactory.FeatureType.date,
      action: ['get'],
      stem: 'started',
    },
    {
      feature: 'modelId',
      description: 'Reactor Conversation Model Id',
      featureType: Reactory.FeatureType.string,
      action: ['get'],
      stem: 'modelId',
    },
    {
      feature: 'user',
      description: 'Reactor Conversation User',
      featureType: Reactory.FeatureType.object,
      action: ['get'],
      stem: 'user',
    },
    {
      feature: 'meta',
      description: 'Reactor Conversation Meta',
      featureType: Reactory.FeatureType.object,
      action: ['get'],
      stem: 'meta',
    },
    {
      feature: 'history',
      description: 'Reactor Conversation History',
      featureType: Reactory.FeatureType.object,
      action: ['get'],
      stem: 'history',
    },
    {
      feature: 'created',
      description: 'Reactor Conversation Created Date',
      featureType: Reactory.FeatureType.date,
      action: ['get'],
      stem: 'created',
    },
    {
      feature: 'updated',
      description: 'Reactor Conversation Updated Date',
      featureType: Reactory.FeatureType.date,
      action: ['get'],
      stem: 'updated',
    },
    {
      feature: 'tokenCount',
      description: 'Reactor Conversation Token Count',
      featureType: Reactory.FeatureType.number,
      action: ['get', 'set'],
      stem: 'tokenCount',
    },
    {
      feature: 'maxTokens',
      description: 'Reactor Conversation Maximum Tokens',
      featureType: Reactory.FeatureType.number,
      action: ['get', 'set'],
      stem: 'maxTokens',
    },
    {
      feature: 'truncatedHistory',
      description: 'Reactor Conversation Truncated History',
      featureType: Reactory.FeatureType.object,
      action: ['get'],
      stem: 'truncatedHistory',
    },
  ]
}

export default ReactorConversationModel;