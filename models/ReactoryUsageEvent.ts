import mongoose, { Schema } from 'mongoose';
import { ReactoryUsageEventDocument } from '../types/usage.types';

const PricingSnapshotSchema = new Schema(
  {
    inputPerTokenUsdCents: { type: Number, default: null },
    outputPerTokenUsdCents: { type: Number, default: null },
    cachedInputPerTokenUsdCents: { type: Number, default: null },
    cacheWritePerTokenUsdCents: { type: Number, default: null },
    reasoningPerTokenUsdCents: { type: Number, default: null },
    audioInputPerSecondUsdCents: { type: Number, default: null },
    audioOutputPerSecondUsdCents: { type: Number, default: null },
    videoInputPerSecondUsdCents: { type: Number, default: null },
    videoOutputPerSecondUsdCents: { type: Number, default: null },
    imageGenerationPerImageUsdCents: { type: Number, default: null },
    imageGenerationTiers: {
      type: [
        {
          match: { size: String, quality: String },
          usdCents: Number,
          _id: false,
        },
      ],
      default: undefined,
    },
    embeddingPerTokenUsdCents: { type: Number, default: null },
    currency: { type: String, default: 'USD' },
    pricingEffectiveFrom: { type: String, default: null },
  },
  { _id: false }
);

const UsageBreakdownSchema = new Schema(
  {
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    cachedPromptTokens: { type: Number, default: undefined },
    cacheWriteTokens: { type: Number, default: undefined },
    reasoningTokens: { type: Number, default: undefined },
    audioInputSeconds: { type: Number, default: undefined },
    audioOutputSeconds: { type: Number, default: undefined },
    videoInputSeconds: { type: Number, default: undefined },
    videoOutputSeconds: { type: Number, default: undefined },
    imagesGenerated: {
      type: [
        {
          size: String,
          quality: String,
          count: Number,
          _id: false,
        },
      ],
      default: undefined,
    },
  },
  { _id: false }
);

const CostsSchema = new Schema(
  {
    inputUsdCents: { type: Number, default: null },
    cachedInputUsdCents: { type: Number, default: null },
    cacheWriteUsdCents: { type: Number, default: null },
    outputUsdCents: { type: Number, default: null },
    reasoningUsdCents: { type: Number, default: null },
    audioInputUsdCents: { type: Number, default: null },
    audioOutputUsdCents: { type: Number, default: null },
    videoInputUsdCents: { type: Number, default: null },
    videoOutputUsdCents: { type: Number, default: null },
    imageGenerationUsdCents: { type: Number, default: null },
    embeddingUsdCents: { type: Number, default: null },
    totalUsdCents: { type: Number, default: 0 },
    uncostedDimensions: { type: [String], default: [] },
  },
  { _id: false }
);

const ReactoryUsageEventSchema = new Schema<ReactoryUsageEventDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'ReactorConversation', required: true },
    messageId: { type: Schema.Types.ObjectId, required: true },
    personaId: { type: String, default: null },
    providerId: { type: String, required: true },
    modelId: { type: String, required: true },
    modelVersion: { type: String, default: null },
    usage: { type: UsageBreakdownSchema, required: true },
    pricingSnapshot: { type: PricingSnapshotSchema, required: true },
    costs: { type: CostsSchema, required: true },
    pricingSource: {
      type: String,
      enum: ['provider-yaml', 'override', 'partial', 'unpriced', 'backfilled'],
      required: true,
    },
    occurredAt: { type: Date, required: true, index: true },
    finishReason: { type: String, default: null },
    toolCallCount: { type: Number, default: 0 },
    streamingMode: { type: Boolean, default: false },
    created: { type: Date, default: () => new Date() },
  },
  { collection: 'reactor_usage_events' }
);

ReactoryUsageEventSchema.index({ userId: 1, occurredAt: -1 });
ReactoryUsageEventSchema.index({ conversationId: 1, occurredAt: 1 });
ReactoryUsageEventSchema.index({ providerId: 1, modelId: 1, occurredAt: -1 });
// Idempotency anchor for backfill — one event per (conversation, message)
ReactoryUsageEventSchema.index({ conversationId: 1, messageId: 1 }, { unique: true });

const ReactoryUsageEventModel = mongoose.model<ReactoryUsageEventDocument>(
  'ReactoryUsageEvent',
  ReactoryUsageEventSchema
);

export const ReactoryUsageEventModelComponentRegistryEntry = {
  nameSpace: 'reactor',
  name: 'ReactoryUsageEventModel',
  version: '1.0.0',
  component: ReactoryUsageEventModel,
};

export default ReactoryUsageEventModel;
