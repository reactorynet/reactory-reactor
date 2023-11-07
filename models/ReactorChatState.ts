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
  created: Date
  updated: Date
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
    role: String,
    content: String,
    rating: Number
  }],
  created: {
    type: Date,
    default: () => { return new Date() }
  },
  updated: {
    type: Date,
    default: () => { return new Date() }
  },
});

const ReactorConversationModel = mongoose.model<ReactorConversation>('ReactorConversation', ReactorConversationSchema);

export default ReactorConversationModel;