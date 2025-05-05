import mongoose, { Schema } from 'mongoose';
import Reactory from '@reactory/reactory-core';
import { ObjectId } from 'mongodb';
import OpenAI from "openai"
import { MetaSchema } from '@reactory/server-modules/reactory-core/models/shared';
import { id } from 'schema/reflection';
import { MacroComponentDefinition, MacroToolDefinition, ToolApprovalMode } from '../ai/openai/types/chat';
// Removed incorrect import as 'ChatCompletionResponseMessage' is not exported by 'openai'

export interface ConversationMeta { 
  summary: string
  title: string
}

// Add more specific types for other providers if needed
export type ValidProviderResponseTypes = OpenAI.Chat.Completions.ChatCompletion | unknown

export interface ChatCompletionResponseMessageStore extends OpenAI.Chat.ChatCompletionMessage {
  id: string | ObjectId
  // Original content of the message by the provider
  response?: ValidProviderResponseTypes;
  rating?: number
  component?: string
  timestamp: Date
  tool_results: any[]
}

export type ReactorConversationHistory = ChatCompletionResponseMessageStore[]

export interface ReactorConversationDocument {
  //unique id for the conversation
  id: string | ObjectId
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
}



export type ReactorConversationDocumentStatics = {
  new(): ReactorConversation
}
export type ReactorConversation = ReactorConversationDocument & ReactorConversationDocumentStatics;

const ReactorConversationHistorySchema: Schema<ChatCompletionResponseMessageStore> = new Schema<ChatCompletionResponseMessageStore>({
  id: ObjectId,
  response: {},
  content: String,
  refusal: String,
  component: String,
  rating: Number,
  role: String,
  annotations: [{}],
  audio: {},
  tool_calls: [{}],
  tool_results: [{}],
  timestamp: {
    type: Date,
    default: () => { return new Date() }
  },
});

const ReactorConversationSchema: Schema<ReactorConversation> = new Schema<ReactorConversation>({
  id: ObjectId,
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
});

const ReactorConversationModelName = 'ReactorConversation';
const ReactorConversationModel = mongoose.model<Schema<ReactorConversation>>(ReactorConversationModelName, ReactorConversationSchema, 'reactor_conversations');
export type TReactorConversationDocument = mongoose.Document<ReactorConversation> & ReactorConversation;
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
  ]
}

export default ReactorConversationModel;