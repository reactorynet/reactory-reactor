import mongoose, { Schema } from 'mongoose';
import { ReactoryUserBudgetDocument } from '../types/usage.types';

const PeriodConfigSchema = new Schema(
  {
    limitUsdCents: { type: Number, required: true, min: 0 },
    softThresholdPct: { type: Number, required: true, min: 0, max: 100, default: 80 },
    hardBlock: { type: Boolean, required: true, default: true },
  },
  { _id: false }
);

const PricingOverrideSchema = new Schema(
  {
    providerId: { type: String, required: true },
    modelId: { type: String, required: true },
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
    embeddingPerTokenUsdCents: { type: Number, default: null },
  },
  { _id: false }
);

const ReactoryUserBudgetSchema = new Schema<ReactoryUserBudgetDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    active: { type: Boolean, default: true },
    timezone: { type: String, default: 'UTC' },
    weekStartsOn: { type: String, enum: ['mon', 'sun'], default: 'mon' },
    periods: {
      day: { type: PeriodConfigSchema, default: null },
      week: { type: PeriodConfigSchema, default: null },
      month: { type: PeriodConfigSchema, default: null },
    },
    scope: {
      providerIds: { type: [String], default: undefined },
      modelIds: { type: [String], default: undefined },
    },
    pricingOverrides: { type: [PricingOverrideSchema], default: undefined },
    created: { type: Date, default: () => new Date() },
    updated: { type: Date, default: () => new Date() },
  },
  { collection: 'reactor_user_budgets' }
);

ReactoryUserBudgetSchema.pre('save', function (next) {
  this.updated = new Date();
  next();
});

const ReactoryUserBudgetModel = mongoose.model<ReactoryUserBudgetDocument>(
  'ReactoryUserBudget',
  ReactoryUserBudgetSchema
);

export const ReactoryUserBudgetModelComponentRegistryEntry = {
  nameSpace: 'reactor',
  name: 'ReactoryUserBudgetModel',
  version: '1.0.0',
  component: ReactoryUserBudgetModel,
};

export default ReactoryUserBudgetModel;
