import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { ObjectId } from 'mongodb';
import ReactoryUsageEventModel from '../../models/ReactoryUsageEvent';
import ReactorConversationModel from '../../models/ReactorChatState';
import {
  AIChatCompletionUsage,
  BudgetPeriod,
  PricingSource,
  ReactoryUsageEventDocument,
  ReactoryUsageEventInput,
  ReactoryUserBudgetPricingOverride,
  UsageEventCosts,
  ConversationUsageSummary,
} from '../../types/usage.types';
import {
  getPricingLoader,
  resolveImageGenerationCost,
} from '../../ai/providers/PricingLoader';
import {
  ProviderModelPricing,
} from '../../ai/providers/provider-loader';

const DIMENSION_KEYS: (keyof UsageEventCosts)[] = [
  'inputUsdCents',
  'cachedInputUsdCents',
  'cacheWriteUsdCents',
  'outputUsdCents',
  'reasoningUsdCents',
  'audioInputUsdCents',
  'audioOutputUsdCents',
  'videoInputUsdCents',
  'videoOutputUsdCents',
  'imageGenerationUsdCents',
  'embeddingUsdCents',
];

/**
 * Build an effective pricing block by layering an override on top of the YAML pricing.
 * `null` in the override means "fall through to YAML"; a number wins.
 */
function applyPricingOverride(
  base: ProviderModelPricing,
  override: ReactoryUserBudgetPricingOverride | null
): { effective: ProviderModelPricing; overrideApplied: boolean } {
  if (!override) return { effective: base, overrideApplied: false };
  let overrideApplied = false;
  const effective: ProviderModelPricing = { ...base };
  const dims: (keyof ReactoryUserBudgetPricingOverride)[] = [
    'inputPerTokenUsdCents',
    'outputPerTokenUsdCents',
    'cachedInputPerTokenUsdCents',
    'cacheWritePerTokenUsdCents',
    'reasoningPerTokenUsdCents',
    'audioInputPerSecondUsdCents',
    'audioOutputPerSecondUsdCents',
    'videoInputPerSecondUsdCents',
    'videoOutputPerSecondUsdCents',
    'imageGenerationPerImageUsdCents',
    'embeddingPerTokenUsdCents',
  ];
  for (const dim of dims) {
    const v = override[dim];
    if (typeof v === 'number') {
      (effective as any)[dim] = v;
      overrideApplied = true;
    }
  }
  return { effective, overrideApplied };
}

export interface PricedUsage {
  pricingSnapshot: ProviderModelPricing;
  costs: UsageEventCosts;
  pricingSource: PricingSource;
}

/**
 * Pure pricing computation. Used by recordUsage at runtime and by the backfill CLI.
 */
export function priceUsage(
  pricing: ProviderModelPricing | null,
  usage: AIChatCompletionUsage,
  override: ReactoryUserBudgetPricingOverride | null = null
): PricedUsage {
  // No pricing at all for this model — record everything as unpriced.
  if (!pricing) {
    return {
      pricingSnapshot: makeEmptyPricing(),
      costs: emptyCosts(usage),
      pricingSource: 'unpriced',
    };
  }

  const { effective, overrideApplied } = applyPricingOverride(pricing, override);

  const costs: UsageEventCosts = {
    inputUsdCents: null,
    cachedInputUsdCents: null,
    cacheWriteUsdCents: null,
    outputUsdCents: null,
    reasoningUsdCents: null,
    audioInputUsdCents: null,
    audioOutputUsdCents: null,
    videoInputUsdCents: null,
    videoOutputUsdCents: null,
    imageGenerationUsdCents: null,
    embeddingUsdCents: null,
    totalUsdCents: 0,
    uncostedDimensions: [],
  };

  // Standard input tokens (excluding cached portion when reported separately).
  const totalPromptTokens = usage.promptTokens || 0;
  const cachedPromptTokens = usage.cachedPromptTokens || 0;
  const billableInputTokens = Math.max(0, totalPromptTokens - cachedPromptTokens);

  costs.inputUsdCents = billableInputTokens > 0
    ? priceDimension(effective.inputPerTokenUsdCents, billableInputTokens, 'input', costs)
    : 0;

  if (cachedPromptTokens > 0) {
    costs.cachedInputUsdCents = priceDimension(
      effective.cachedInputPerTokenUsdCents,
      cachedPromptTokens,
      'cachedInput',
      costs
    );
  }

  if ((usage.cacheWriteTokens || 0) > 0) {
    costs.cacheWriteUsdCents = priceDimension(
      effective.cacheWritePerTokenUsdCents,
      usage.cacheWriteTokens!,
      'cacheWrite',
      costs
    );
  }

  // Output / completion tokens.
  const completionTokens = usage.completionTokens || 0;
  const reasoningTokens = usage.reasoningTokens || 0;
  // If reasoning is billed separately, subtract from output to avoid double-counting.
  const billableOutputTokens = effective.reasoningPerTokenUsdCents !== null
    ? Math.max(0, completionTokens - reasoningTokens)
    : completionTokens;

  costs.outputUsdCents = billableOutputTokens > 0
    ? priceDimension(effective.outputPerTokenUsdCents, billableOutputTokens, 'output', costs)
    : 0;

  if (reasoningTokens > 0 && effective.reasoningPerTokenUsdCents !== null) {
    costs.reasoningUsdCents = priceDimension(
      effective.reasoningPerTokenUsdCents,
      reasoningTokens,
      'reasoning',
      costs
    );
  }

  if ((usage.audioInputSeconds || 0) > 0) {
    costs.audioInputUsdCents = priceDimension(
      effective.audioInputPerSecondUsdCents,
      usage.audioInputSeconds!,
      'audioInput',
      costs
    );
  }

  if ((usage.audioOutputSeconds || 0) > 0) {
    costs.audioOutputUsdCents = priceDimension(
      effective.audioOutputPerSecondUsdCents,
      usage.audioOutputSeconds!,
      'audioOutput',
      costs
    );
  }

  if ((usage.videoInputSeconds || 0) > 0) {
    costs.videoInputUsdCents = priceDimension(
      effective.videoInputPerSecondUsdCents,
      usage.videoInputSeconds!,
      'videoInput',
      costs
    );
  }

  if ((usage.videoOutputSeconds || 0) > 0) {
    costs.videoOutputUsdCents = priceDimension(
      effective.videoOutputPerSecondUsdCents,
      usage.videoOutputSeconds!,
      'videoOutput',
      costs
    );
  }

  if ((usage.imagesGenerated || []).length > 0) {
    let imageCost = 0;
    let imagePriced = false;
    let imageMissing = false;
    for (const img of usage.imagesGenerated!) {
      const perImage = resolveImageGenerationCost(effective, {
        size: img.size,
        quality: img.quality,
      });
      if (perImage === null) {
        imageMissing = true;
      } else {
        imageCost += perImage * (img.count || 0);
        imagePriced = true;
      }
    }
    if (imagePriced) {
      costs.imageGenerationUsdCents = imageCost;
    }
    if (imageMissing) {
      costs.uncostedDimensions.push('imageGeneration');
    }
  }

  // Embeddings — currently not tracked in AIChatCompletionUsage.totalTokens for embeddings,
  // but providers that expose them via promptTokens would already be priced via input.
  // Reserved for future when embedding-specific calls expose their own usage shape.

  // Sum
  let total = 0;
  for (const dim of DIMENSION_KEYS) {
    const v = costs[dim];
    if (typeof v === 'number') total += v;
  }
  costs.totalUsdCents = total;

  // Pricing source classification
  const anyRateSet = hasAnyRate(effective);
  let source: PricingSource;
  if (overrideApplied) {
    source = 'override';
  } else if (!anyRateSet && hasAnyUsage(usage)) {
    // Model has no priced dimensions at all
    source = 'unpriced';
  } else if (costs.uncostedDimensions.length > 0) {
    source = 'partial';
  } else {
    source = 'provider-yaml';
  }

  return { pricingSnapshot: { ...effective }, costs, pricingSource: source };
}

function priceDimension(
  rate: number | null,
  units: number,
  name: string,
  costs: UsageEventCosts
): number | null {
  if (rate === null || rate === undefined) {
    if (units > 0) costs.uncostedDimensions.push(name);
    return null;
  }
  return rate * units;
}

function emptyCosts(usage: AIChatCompletionUsage): UsageEventCosts {
  const uncosted: string[] = [];
  if (usage.promptTokens > 0) uncosted.push('input');
  if (usage.completionTokens > 0) uncosted.push('output');
  if ((usage.cachedPromptTokens || 0) > 0) uncosted.push('cachedInput');
  if ((usage.cacheWriteTokens || 0) > 0) uncosted.push('cacheWrite');
  if ((usage.reasoningTokens || 0) > 0) uncosted.push('reasoning');
  if ((usage.audioInputSeconds || 0) > 0) uncosted.push('audioInput');
  if ((usage.audioOutputSeconds || 0) > 0) uncosted.push('audioOutput');
  if ((usage.videoInputSeconds || 0) > 0) uncosted.push('videoInput');
  if ((usage.videoOutputSeconds || 0) > 0) uncosted.push('videoOutput');
  if ((usage.imagesGenerated || []).length > 0) uncosted.push('imageGeneration');
  return {
    inputUsdCents: null,
    cachedInputUsdCents: null,
    cacheWriteUsdCents: null,
    outputUsdCents: null,
    reasoningUsdCents: null,
    audioInputUsdCents: null,
    audioOutputUsdCents: null,
    videoInputUsdCents: null,
    videoOutputUsdCents: null,
    imageGenerationUsdCents: null,
    embeddingUsdCents: null,
    totalUsdCents: 0,
    uncostedDimensions: uncosted,
  };
}

function makeEmptyPricing(): ProviderModelPricing {
  return {
    inputPerTokenUsdCents: null,
    outputPerTokenUsdCents: null,
    cachedInputPerTokenUsdCents: null,
    cacheWritePerTokenUsdCents: null,
    reasoningPerTokenUsdCents: null,
    audioInputPerSecondUsdCents: null,
    audioOutputPerSecondUsdCents: null,
    videoInputPerSecondUsdCents: null,
    videoOutputPerSecondUsdCents: null,
    imageGenerationPerImageUsdCents: null,
    embeddingPerTokenUsdCents: null,
    currency: 'USD',
    pricingEffectiveFrom: null,
  };
}

function hasAnyRate(p: ProviderModelPricing): boolean {
  const rateKeys: (keyof ProviderModelPricing)[] = [
    'inputPerTokenUsdCents',
    'outputPerTokenUsdCents',
    'cachedInputPerTokenUsdCents',
    'cacheWritePerTokenUsdCents',
    'reasoningPerTokenUsdCents',
    'audioInputPerSecondUsdCents',
    'audioOutputPerSecondUsdCents',
    'videoInputPerSecondUsdCents',
    'videoOutputPerSecondUsdCents',
    'imageGenerationPerImageUsdCents',
    'embeddingPerTokenUsdCents',
  ];
  if (rateKeys.some(k => typeof p[k] === 'number')) return true;
  return (p.imageGenerationTiers || []).length > 0;
}

function hasAnyUsage(usage: AIChatCompletionUsage): boolean {
  return (
    (usage.promptTokens || 0) > 0 ||
    (usage.completionTokens || 0) > 0 ||
    (usage.cachedPromptTokens || 0) > 0 ||
    (usage.cacheWriteTokens || 0) > 0 ||
    (usage.reasoningTokens || 0) > 0 ||
    (usage.audioInputSeconds || 0) > 0 ||
    (usage.audioOutputSeconds || 0) > 0 ||
    (usage.videoInputSeconds || 0) > 0 ||
    (usage.videoOutputSeconds || 0) > 0 ||
    (usage.imagesGenerated || []).length > 0
  );
}

function toObjectId(id: ObjectId | string): ObjectId {
  return typeof id === 'string' ? new ObjectId(id) : id;
}

@service({
  id: 'reactor.ReactoryUsageService@1.0.0',
  name: 'Reactory Usage Service',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: 'Records per-call AI usage events and aggregates costs for budget queries',
  serviceType: 'data',
  lifeCycle: 'singleton',
})
class ReactoryUsageService implements Reactory.Service.IReactoryService {
  context: Reactory.Server.IReactoryContext;

  constructor(props: Reactory.Service.IReactoryServiceProps, context: Reactory.Server.IReactoryContext) {
    this.context = context;
  }

  description?: string = 'Records per-call AI usage events and aggregates costs for budget queries';
  tags?: string[] = ['ai', 'usage', 'cost', 'budget'];
  nameSpace: string = 'reactor';
  name: string = 'ReactoryUsageService';
  version: string = '1.0.0';

  toString?(includeVersion?: boolean): string {
    return `ReactoryUsageService${includeVersion ? '@1.0.0' : ''}`;
  }

  /**
   * Record a usage event for a single AI response. Idempotent against
   * (conversationId, messageId) — duplicate inserts are swallowed.
   * Returns the inserted document, or null when a duplicate was suppressed.
   */
  async recordUsage(
    input: ReactoryUsageEventInput,
    override: ReactoryUserBudgetPricingOverride | null = null
  ): Promise<ReactoryUsageEventDocument | null> {
    const pricing = getPricingLoader().getPricing(input.providerId, input.modelId);
    const priced = priceUsage(pricing, input.usage, override);

    const doc: Partial<ReactoryUsageEventDocument> = {
      userId: toObjectId(input.userId),
      conversationId: toObjectId(input.conversationId),
      messageId: toObjectId(input.messageId),
      personaId: input.personaId,
      providerId: input.providerId,
      modelId: input.modelId,
      modelVersion: input.modelVersion ?? null,
      usage: input.usage,
      pricingSnapshot: priced.pricingSnapshot,
      costs: priced.costs,
      pricingSource: input.backfilled ? 'backfilled' : priced.pricingSource,
      occurredAt: input.occurredAt || new Date(),
      finishReason: input.finishReason,
      toolCallCount: input.toolCallCount || 0,
      streamingMode: input.streamingMode || false,
      created: new Date(),
    };

    try {
      const created = await ReactoryUsageEventModel.create(doc as ReactoryUsageEventDocument);
      return created.toObject() as ReactoryUsageEventDocument;
    } catch (err: any) {
      if (err && err.code === 11000) {
        // Duplicate (conversationId, messageId) — idempotent path
        return null;
      }
      throw err;
    }
  }

  /**
   * Sum cost over a [start, end) window for a user. Optionally scope to providers/models.
   */
  async getUsageForPeriod(
    userId: ObjectId | string,
    period: { start: Date; end: Date },
    scope: { providerIds?: string[]; modelIds?: string[] } = {}
  ): Promise<{ totalUsdCents: number; eventCount: number }> {
    const match: Record<string, unknown> = {
      userId: toObjectId(userId),
      occurredAt: { $gte: period.start, $lt: period.end },
    };
    if (scope.providerIds && scope.providerIds.length > 0) {
      match.providerId = { $in: scope.providerIds };
    }
    if (scope.modelIds && scope.modelIds.length > 0) {
      match.modelId = { $in: scope.modelIds };
    }
    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: null,
          totalUsdCents: { $sum: '$costs.totalUsdCents' },
          eventCount: { $sum: 1 },
        },
      },
    ];
    const [row] = await ReactoryUsageEventModel.aggregate(pipeline);
    return {
      totalUsdCents: row?.totalUsdCents || 0,
      eventCount: row?.eventCount || 0,
    };
  }

  /**
   * Recompute the conversation's usageSummary cache from authoritative event rows.
   */
  async recomputeConversationSummary(
    conversationId: ObjectId | string
  ): Promise<ConversationUsageSummary> {
    const cid = toObjectId(conversationId);
    const pipeline = [
      { $match: { conversationId: cid } },
      {
        $group: {
          _id: null,
          totalPromptTokens: { $sum: '$usage.promptTokens' },
          totalCompletionTokens: { $sum: '$usage.completionTokens' },
          totalTokens: { $sum: '$usage.totalTokens' },
          totalCostUsdCents: { $sum: '$costs.totalUsdCents' },
          lastEventAt: { $max: '$occurredAt' },
        },
      },
    ];
    const [row] = await ReactoryUsageEventModel.aggregate(pipeline);
    const summary: ConversationUsageSummary = {
      totalPromptTokens: row?.totalPromptTokens || 0,
      totalCompletionTokens: row?.totalCompletionTokens || 0,
      totalTokens: row?.totalTokens || 0,
      totalCostUsdCents: row?.totalCostUsdCents || 0,
      lastEventAt: row?.lastEventAt || null,
    };
    await ReactorConversationModel.findByIdAndUpdate(cid, {
      $set: { usageSummary: summary, updated: new Date() },
    }).exec();
    return summary;
  }
}

export default ReactoryUsageService;
