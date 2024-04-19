import mongoose, { Schema } from 'mongoose';
import Reactory from '@reactory/reactory-core';
import { ObjectId } from 'mongodb';
import { ChatCompletionResponseMessage } from "openai"
import { MetaSchema } from '@reactory/server-modules/core/models/shared';

export interface ConversationMeta { 
  summary: string
  title: string
}

export interface ReactorConversationDocument {
  //unique id for the conversation
  id: string | ObjectId
  botId: string
  started: Date,
  modelId: string
  user: Reactory.Models.IUser
  meta: Reactory.Models.IRecordMeta<ConversationMeta>,
  history: ChatCompletionResponseMessage[]
  vars: any
  created: Date
  updated: Date
}

export interface ChatCompletionResponseMessageStore extends ChatCompletionResponseMessage {
  rating?: number
}

export interface ReactorConversationDocumentStatics {
  new(): ReactorConversation
}
export type ReactorConversation = ReactorConversationDocument & ReactorConversationDocumentStatics;

const ReactorConversationSchema: Schema<ReactorConversation> = new Schema<ReactorConversation>({
  id: ObjectId,
  botId: {
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
    default: 'gpt-3.5',
  },
  user: {
    type: ObjectId,
    ref: 'User',
  },
  meta: MetaSchema,
  history: [{
    timestamp: Date,
    role: String,
    content: String,
    rating: Number
  }],
  vars: {},
  created: {
    type: Date,
    default: () => { return new Date() }
  },
  updated: {
    type: Date,
    default: () => { return new Date() }
  },
});

const ReactorConversationModelName = 'ReactorConversation';
const ReactorConversationModel = mongoose.model<ReactorConversation>(ReactorConversationModelName, ReactorConversationSchema);
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