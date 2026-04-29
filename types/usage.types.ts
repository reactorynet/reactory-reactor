import { ObjectId } from 'mongodb';
import { ProviderModelPricing } from '../ai/providers/provider-loader';

/**
 * Period bucket for budget windowing. Day/week/month are the only supported periods.
 */
export type BudgetPeriod = 'day' | 'week' | 'month';

/**
 * Outcome of a budget check at the start of a conversation message.
 *
 * - `no-budget`: user has not opted into budgeting; pre-flight passes immediately
 * - `ok`: under all configured limits
 * - `soft-warn`: crossed a soft threshold for at least one period; pre-flight still passes
 *                but a `reactor_usage_alerts` row is published on the first crossing per period
 * - `hard-block`: hit a hard limit on at least one period; pre-flight throws BudgetExceededError
 */
export type BudgetStatus = 'no-budget' | 'ok' | 'soft-warn' | 'hard-block';

// AIChatCompletionUsage is canonically defined in model.types.ts; re-export it for
// modules that import from usage.types.ts so callers don't need to know the distinction.
export type { AIChatCompletionUsage } from './model.types';
import { AIChatCompletionUsage } from './model.types';

/**
 * What pricing source produced the cost numbers on a usage event.
 *
 * - `provider-yaml`: every priced dimension came from providers.yaml
 * - `override`:      a per-user override won over the YAML for at least one dimension
 * - `partial`:       priced for some dimensions, unpriced for others
 * - `unpriced`:      no priced dimensions; totalUsdCents is 0
 * - `backfilled`:    pricing snapshot was taken at backfill time, may not match
 *                    what was true at occurredAt
 */
export type PricingSource =
  | 'provider-yaml'
  | 'override'
  | 'partial'
  | 'unpriced'
  | 'backfilled';

export interface UsageEventCosts {
  inputUsdCents: number | null;
  cachedInputUsdCents: number | null;
  cacheWriteUsdCents: number | null;
  outputUsdCents: number | null;
  reasoningUsdCents: number | null;
  audioInputUsdCents: number | null;
  audioOutputUsdCents: number | null;
  videoInputUsdCents: number | null;
  videoOutputUsdCents: number | null;
  imageGenerationUsdCents: number | null;
  embeddingUsdCents: number | null;
  /** Sum of all priced dimensions; null entries treated as 0. Used for budget aggregation. */
  totalUsdCents: number;
  /** Names of dimensions where usage was recorded but no price was available. */
  uncostedDimensions: string[];
}

export interface ReactoryUsageEventInput {
  userId: ObjectId | string;
  conversationId: ObjectId | string;
  messageId: ObjectId | string;
  personaId?: string;
  providerId: string;
  modelId: string;
  modelVersion?: string | null;
  usage: AIChatCompletionUsage;
  occurredAt?: Date;
  finishReason?: string;
  toolCallCount?: number;
  streamingMode?: boolean;
  /** Optional flag used by the backfill CLI to mark events with non-contemporaneous pricing. */
  backfilled?: boolean;
}

export interface ReactoryUsageEventDocument {
  _id: ObjectId;
  userId: ObjectId;
  conversationId: ObjectId;
  messageId: ObjectId;
  personaId?: string;
  providerId: string;
  modelId: string;
  modelVersion?: string | null;
  usage: AIChatCompletionUsage;
  pricingSnapshot: ProviderModelPricing;
  costs: UsageEventCosts;
  pricingSource: PricingSource;
  occurredAt: Date;
  finishReason?: string;
  toolCallCount?: number;
  streamingMode?: boolean;
  created: Date;
}

export interface ReactoryUserBudgetPeriodConfig {
  limitUsdCents: number;
  softThresholdPct: number;
  hardBlock: boolean;
}

export interface ReactoryUserBudgetPricingOverride {
  providerId: string;
  modelId: string;
  inputPerTokenUsdCents?: number | null;
  outputPerTokenUsdCents?: number | null;
  cachedInputPerTokenUsdCents?: number | null;
  cacheWritePerTokenUsdCents?: number | null;
  reasoningPerTokenUsdCents?: number | null;
  audioInputPerSecondUsdCents?: number | null;
  audioOutputPerSecondUsdCents?: number | null;
  videoInputPerSecondUsdCents?: number | null;
  videoOutputPerSecondUsdCents?: number | null;
  imageGenerationPerImageUsdCents?: number | null;
  embeddingPerTokenUsdCents?: number | null;
}

export interface ReactoryUserBudgetDocument {
  _id: ObjectId;
  userId: ObjectId;
  active: boolean;
  timezone: string;
  weekStartsOn: 'mon' | 'sun';
  periods: {
    day: ReactoryUserBudgetPeriodConfig | null;
    week: ReactoryUserBudgetPeriodConfig | null;
    month: ReactoryUserBudgetPeriodConfig | null;
  };
  scope?: { providerIds?: string[]; modelIds?: string[] };
  pricingOverrides?: ReactoryUserBudgetPricingOverride[];
  created: Date;
  updated: Date;
}

export type AlertType = 'soft-warn' | 'hard-block';

export interface ReactoryUsageAlertDocument {
  _id: ObjectId;
  userId: ObjectId;
  alertType: AlertType;
  period: BudgetPeriod;
  /** Period boundary, in UTC, used as the dedup key together with userId/alertType. */
  periodStart: Date;
  periodEnd: Date;
  usedUsdCents: number;
  limitUsdCents: number;
  pctUsed: number;
  conversationId?: ObjectId;
  triggeringEventId?: ObjectId;
  triggeredAt: Date;
  consumed: boolean;
  consumedAt: Date | null;
  consumedBy: string | null;
}

export interface BudgetCheckResult {
  status: BudgetStatus;
  /** Per-period detail. Empty when status === 'no-budget'. */
  periods: Array<{
    period: BudgetPeriod;
    usedUsdCents: number;
    limitUsdCents: number;
    pctUsed: number;
    softThresholdPct: number;
    breachedHard: boolean;
    breachedSoft: boolean;
  }>;
}

/**
 * Cached usage rollup stored on the conversation document. Recomputed by
 * ReactoryUsageService.recomputeConversationSummary; never authoritative.
 */
export interface ConversationUsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsdCents: number;
  lastEventAt: Date | null;
}
