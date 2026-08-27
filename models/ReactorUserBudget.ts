import mongoose, { Schema } from 'mongoose';
import { ObjectId } from 'mongodb';
import Reactory from '@reactorynet/reactory-core';

export interface ReactorUserBudgetDocument extends mongoose.Document {
  _id: ObjectId;
  userId: ObjectId;
  organizationId?: ObjectId;
  monthlyTokenLimit?: number;
  dailyTokenLimit?: number;
  monthlyCostLimitUsd?: number;
  dailyCostLimitUsd?: number;
  currentMonthTokens: number;
  currentMonthCostUsd: number;
  currentDayTokens: number;
  currentDayCostUsd: number;
  alertThresholdPercent: number;
  hardStop: boolean;
  status: 'ACTIVE' | 'WARNING' | 'EXCEEDED' | 'DISABLED';
  lastResetDate: Date;
  lastDailyResetDate: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ReactorUserBudgetSchema = new Schema<ReactorUserBudgetDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'ReactoryOrganization',
      default: null,
      index: true,
    },
    monthlyTokenLimit: {
      type: Number,
      default: null,
      min: 0,
    },
    dailyTokenLimit: {
      type: Number,
      default: null,
      min: 0,
    },
    monthlyCostLimitUsd: {
      type: Number,
      default: null,
      min: 0,
    },
    dailyCostLimitUsd: {
      type: Number,
      default: null,
      min: 0,
    },
    currentMonthTokens: {
      type: Number,
      default: 0,
      min: 0,
    },
    currentMonthCostUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    currentDayTokens: {
      type: Number,
      default: 0,
      min: 0,
    },
    currentDayCostUsd: {
      type: Number,
      default: 0,
      min: 0,
    },
    alertThresholdPercent: {
      type: Number,
      default: 80,
      min: 1,
      max: 100,
    },
    hardStop: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'WARNING', 'EXCEEDED', 'DISABLED'],
      default: 'ACTIVE',
      index: true,
    },
    lastResetDate: {
      type: Date,
      default: () => new Date(),
    },
    lastDailyResetDate: {
      type: Date,
      default: () => new Date(),
    },
    notes: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const ReactorUserBudgetModelName = 'ReactorUserBudget';
const ReactorUserBudgetModel = mongoose.model<ReactorUserBudgetDocument>(
  ReactorUserBudgetModelName,
  ReactorUserBudgetSchema,
  'reactor_user_budgets'
);

export const ReactorUserBudgetModelComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorUserBudgetModel> = {
  name: 'ReactorUserBudgetModel',
  nameSpace: 'reactor',
  description: 'Reactor User AI Budget Model',
  version: '1.0.0',
  component: ReactorUserBudgetModel,
};

export default ReactorUserBudgetModel;
