import mongoose, { Schema } from 'mongoose';
import { ObjectId } from 'mongodb';
import Reactory from '@reactorynet/reactory-core';

export interface ReactorAIUsageDocument extends mongoose.Document {
  _id: ObjectId;
  userId: ObjectId;
  organizationId?: ObjectId;
  businessUnitId?: ObjectId;
  chatSessionId?: string;
  parentSessionId?: string;
  personaId?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsdCents: number;
  costCurrency: string;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  use_case?: string;
  status: 'success' | 'error';
  errorCode?: string;
  errorMessage?: string;
  toolCallsCount?: number;
  toolsUsed?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const ReactorAIUsageSchema = new Schema<ReactorAIUsageDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'ReactoryOrganization',
      default: null,
      index: true,
    },
    businessUnitId: {
      type: Schema.Types.ObjectId,
      ref: 'ReactoryBusinessUnit',
      default: null,
      index: true,
    },
    chatSessionId: {
      type: String,
      default: null,
      index: true,
    },
    parentSessionId: {
      type: String,
      default: null,
      index: true,
    },
    personaId: {
      type: String,
      default: 'Reactor',
      index: true,
    },
    provider: {
      type: String,
      required: true,
      index: true,
    },
    model: {
      type: String,
      required: true,
      index: true,
    },
    promptTokens: {
      type: Number,
      default: 0,
      min: 0,
    },
    completionTokens: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalTokens: {
      type: Number,
      default: 0,
      min: 0,
    },
    costUsdCents: {
      type: Number,
      default: 0,
      min: 0,
    },
    costCurrency: {
      type: String,
      default: 'USD',
    },
    durationMs: {
      type: Number,
      default: null,
    },
    timeToFirstTokenMs: {
      type: Number,
      default: null,
    },
    use_case: {
      type: String,
      default: 'standalone',
      index: true,
    },
    status: {
      type: String,
      enum: ['success', 'error'],
      default: 'success',
      index: true,
    },
    errorCode: {
      type: String,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    toolCallsCount: {
      type: Number,
      default: 0,
    },
    toolsUsed: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for time-series analytics and query performance
ReactorAIUsageSchema.index({ userId: 1, createdAt: -1 });
ReactorAIUsageSchema.index({ provider: 1, model: 1, createdAt: -1 });
ReactorAIUsageSchema.index({ createdAt: -1 });
ReactorAIUsageSchema.index({ organizationId: 1, createdAt: -1 });

const ReactorAIUsageModelName = 'ReactorAIUsage';
const ReactorAIUsageModel = mongoose.model<ReactorAIUsageDocument>(
  ReactorAIUsageModelName,
  ReactorAIUsageSchema,
  'reactor_ai_usages'
);

export const ReactorAIUsageModelComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorAIUsageModel> = {
  name: 'ReactorAIUsageModel',
  nameSpace: 'reactor',
  description: 'Reactor AI Usage Telemetry Model',
  version: '1.0.0',
  component: ReactorAIUsageModel,
};

export default ReactorAIUsageModel;
