import mongoose, { Schema } from 'mongoose';
import { ReactoryUsageAlertDocument } from '../types/usage.types';

const ReactoryUsageAlertSchema = new Schema<ReactoryUsageAlertDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    alertType: { type: String, enum: ['soft-warn', 'hard-block'], required: true },
    period: { type: String, enum: ['day', 'week', 'month'], required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    usedUsdCents: { type: Number, required: true },
    limitUsdCents: { type: Number, required: true },
    pctUsed: { type: Number, required: true },
    conversationId: { type: Schema.Types.ObjectId, default: null },
    triggeringEventId: { type: Schema.Types.ObjectId, default: null },
    triggeredAt: { type: Date, default: () => new Date(), index: true },
    consumed: { type: Boolean, default: false },
    consumedAt: { type: Date, default: null },
    consumedBy: { type: String, default: null },
  },
  { collection: 'reactor_usage_alerts' }
);

ReactoryUsageAlertSchema.index({ userId: 1, triggeredAt: -1 });
ReactoryUsageAlertSchema.index({ consumed: 1, triggeredAt: 1 });
// One alert per (user, period bucket, alertType) — prevents duplicate fires per period crossing
ReactoryUsageAlertSchema.index(
  { userId: 1, period: 1, periodStart: 1, alertType: 1 },
  { unique: true }
);

const ReactoryUsageAlertModel = mongoose.model<ReactoryUsageAlertDocument>(
  'ReactoryUsageAlert',
  ReactoryUsageAlertSchema
);

export const ReactoryUsageAlertModelComponentRegistryEntry = {
  nameSpace: 'reactor',
  name: 'ReactoryUsageAlertModel',
  version: '1.0.0',
  component: ReactoryUsageAlertModel,
};

export default ReactoryUsageAlertModel;
