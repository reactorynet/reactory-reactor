import mongoose, { Schema } from 'mongoose';
import Reactory from '@reactorynet/reactory-core';
import { ObjectId } from 'mongodb';
import OpenAI from "openai"
import path from 'path';
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
  /**
   * Provider-native reasoning content blocks, stored verbatim.
   *
   * Anthropic requires the thinking blocks that preceded a tool_use to be
   * replayed unchanged (signature included) on the assistant turn carrying that
   * tool_use when the tool results are sent back; the flattened `thinking`
   * string above cannot satisfy that. Only populated for providers that need it.
   */
  thinking_blocks?: any[]
  /** Generated images from image-capable models */
  images?: Array<{ url?: string; b64_json?: string; mimeType?: string }>
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
  // The provider id used for the conversation (e.g. "openai", "google", "xai")
  providerId?: string
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
  // The maximum number of auto tool call iterations before pausing for user confirmation
  maxToolIterations?: number
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
  /**
   * Folders the user pinned to this session (paths under the user file root or absolute on desktop).
   */
  pinnedFolders?: { name: string; path: string }[]
  // The persisted side panel state for this conversation
  sidePanelState?: {
    items: {
      id: string;
      componentFqn: string;
      title: string;
      type: 'component' | 'form';
      props?: Record<string, any>;
      addedAt: Date;
      addedBy?: string;
    }[];
    activeItemId?: string;
    isOpen: boolean;
  } | null;
  // Optional reference to a parent session that provided context for this session
  parentSessionId?: string
  /**
   * What the conversation is being used for: "standalone", "workflow",
   * "content", "form", or any application defined string.
   *
   * Conversations are scoped by this, so a chat opened alongside a content
   * editor never resumes or lists a chat from somewhere else in the product.
   * Defaults to "standalone", which is the plain chat experience.
   */
  use_case?: string
  /**
   * Arbitrary links from this conversation to things outside it — the workflow
   * it belongs to, the content slug it is editing, a related conversation.
   *
   * Kept as a generic name/value/type triple rather than dedicated columns so
   * a new kind of association does not need a schema change.
   */
  edges?: {
    name: string;
    value: string;
    edge_type: string;
  }[]
  // Virtual: resolved session folder path (not persisted to DB)
  readonly sessionFolder?: string
  // Virtual: child conversations spawned from this session (sub-agent delegations)
  readonly chats?: ReactorConversationDocument[]
}



export type ReactorConversationDocumentStatics = {
  new(): ReactorConversation
}
export type ReactorConversation = ReactorConversationDocument & ReactorConversationDocumentStatics;

const ReactorConversationHistorySchema = new Schema({
  id: ObjectId,
  response: {},
  content: { type: Schema.Types.Mixed, default: null },
  refusal: String,
  thinking: String,
  thinking_blocks: { type: [Schema.Types.Mixed], default: undefined },
  images: { type: [Schema.Types.Mixed], default: undefined },
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
  providerId: {
    type: String,
    default: null,
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
  // The maximum number of auto tool call iterations before pausing for user confirmation
  maxToolIterations: {
    type: Number,
    default: null,
    min: 1,
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
  pinnedFolders: {
    type: [{ name: String, path: String }],
    default: [],
  },
  // The persisted side panel state for this conversation
  sidePanelState: {
    type: {
      items: [{
        id: String,
        componentFqn: String,
        title: String,
        type: { type: String, enum: ['component', 'form'] },
        props: { type: Schema.Types.Mixed, default: null },
        addedAt: Date,
        addedBy: String,
      }],
      activeItemId: String,
      isOpen: { type: Boolean, default: false },
    },
    default: null,
  },
  // The truncated history - messages removed to stay within token limits
  truncatedHistory: {
    type: [ReactorConversationHistorySchema],
    default: [],
  },
  // A short title for the conversation, generated from the user's first message
  title: {
    type: String,
    default: null,
  },
  // Optional reference to a parent session that provided context for this session
  parentSessionId: {
    type: String,
    default: null,
    index: true,
  },
  // What the conversation is being used for. Indexed because every list and
  // resume query filters on it.
  use_case: {
    type: String,
    default: 'standalone',
    index: true,
  },
  // Links from this conversation to workflows, content, other conversations.
  edges: {
    type: [{
      _id: false,
      name: { type: String, required: true },
      value: { type: String, required: true },
      edge_type: { type: String, required: true },
    }],
    default: [],
  },
});

// Resuming a conversation looks it up by user, persona and use case together,
// so the three are indexed as one.
ReactorConversationSchema.index({ user: 1, personaId: 1, use_case: 1, updated: -1 });
// Finding the conversation attached to a given workflow or content item.
ReactorConversationSchema.index({ 'edges.edge_type': 1, 'edges.value': 1 });

ReactorConversationSchema.virtual('sessionFolder').get(function () {
  const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT;
  if (!dataRoot) return undefined;

  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

  const rawUser = this.user;
  const userId = sanitize(
    (rawUser?._id ?? rawUser)?.toString() || ''
  );
  const personaId = sanitize(this.personaId || '');
  const conversationId = sanitize(this._id?.toString() || '');

  if (!userId || !personaId || !conversationId) return undefined;

  return path.join(dataRoot, 'profiles', userId, 'chats', personaId, conversationId);
});

ReactorConversationSchema.virtual('chats', {
  ref: 'ReactorConversation',
  localField: '_id',
  foreignField: 'parentSessionId',
  justOne: false,
});

ReactorConversationSchema.set('toJSON', { virtuals: true });
ReactorConversationSchema.set('toObject', { virtuals: true });

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