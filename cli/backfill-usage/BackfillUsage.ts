import Reactory from '@reactorynet/reactory-core';
import { ObjectId } from 'mongodb';
import ReactorConversationModel, {
  ReactorConversationDocument,
} from '../../models/ReactorChatState';
import ReactoryUsageEventModel from '../../models/ReactoryUsageEvent';
import { priceUsage } from '../../services/reactor/ReactoryUsageService';
import { getPricingLoader } from '../../ai/providers/PricingLoader';
import { AIChatCompletionUsage } from '../../types/usage.types';

type ReactoryCliApp = (vargs: string[], context: Reactory.Server.IReactoryContext) => Promise<void>;

interface BackfillStats {
  conversationsScanned: number;
  conversationsUpdated: number;
  eventsCreated: number;
  eventsSkippedExisting: number;
  conversationsWithMissingUsage: number;
  errors: number;
}

interface ParsedArgs {
  dryRun: boolean;
  since: Date | null;
  userId: ObjectId | null;
  batchSize: number;
  verbose: boolean;
}

function parseArgs(kwargs: string[]): ParsedArgs {
  const args: ParsedArgs = {
    dryRun: false,
    since: null,
    userId: null,
    batchSize: 500,
    verbose: false,
  };
  for (const raw of kwargs) {
    const [key, value] = raw.includes('=') ? raw.split('=') : [raw, ''];
    switch (key) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      case '--since':
        args.since = new Date(value);
        if (Number.isNaN(args.since.getTime())) {
          throw new Error(`Invalid --since date: ${value}`);
        }
        break;
      case '--user':
        args.userId = new ObjectId(value);
        break;
      case '--batch':
        args.batchSize = Number(value);
        if (!Number.isFinite(args.batchSize) || args.batchSize < 1) {
          throw new Error(`Invalid --batch: ${value}`);
        }
        break;
      default:
        // ignore unknown args
        break;
    }
  }
  return args;
}

/**
 * Pull a normalized AIChatCompletionUsage out of an arbitrary persisted response.usage.
 * Different providers store slightly different shapes, so be liberal in extraction.
 */
function extractUsageFromHistory(historyItem: any): AIChatCompletionUsage | null {
  const raw = historyItem?.response?.usage;
  if (!raw) return null;

  // Already normalized (newer entries written by current provider services)
  if (typeof raw.promptTokens === 'number' || typeof raw.completionTokens === 'number') {
    return {
      promptTokens: raw.promptTokens || 0,
      completionTokens: raw.completionTokens || 0,
      totalTokens: raw.totalTokens || (raw.promptTokens || 0) + (raw.completionTokens || 0),
      ...(raw.cachedPromptTokens ? { cachedPromptTokens: raw.cachedPromptTokens } : {}),
      ...(raw.cacheWriteTokens ? { cacheWriteTokens: raw.cacheWriteTokens } : {}),
      ...(raw.reasoningTokens ? { reasoningTokens: raw.reasoningTokens } : {}),
    };
  }

  // OpenAI-style snake_case
  if (typeof raw.prompt_tokens === 'number' || typeof raw.completion_tokens === 'number') {
    const cached = raw.prompt_tokens_details?.cached_tokens;
    const reasoning = raw.completion_tokens_details?.reasoning_tokens;
    return {
      promptTokens: raw.prompt_tokens || 0,
      completionTokens: raw.completion_tokens || 0,
      totalTokens: raw.total_tokens || (raw.prompt_tokens || 0) + (raw.completion_tokens || 0),
      ...(typeof cached === 'number' ? { cachedPromptTokens: cached } : {}),
      ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
    };
  }

  // Anthropic-style input_tokens/output_tokens
  if (typeof raw.input_tokens === 'number' || typeof raw.output_tokens === 'number') {
    const cached = raw.cache_read_input_tokens || 0;
    const cacheWrite = raw.cache_creation_input_tokens || 0;
    return {
      promptTokens: raw.input_tokens || 0,
      completionTokens: raw.output_tokens || 0,
      totalTokens: (raw.input_tokens || 0) + (raw.output_tokens || 0),
      ...(cached > 0 ? { cachedPromptTokens: cached } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    };
  }

  return null;
}

// Exported for tests
export const __testing = { extractUsageFromHistory, parseArgs };

async function recomputeSummary(conversationId: ObjectId, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const pipeline = [
    { $match: { conversationId } },
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
  await ReactorConversationModel.findByIdAndUpdate(conversationId, {
    $set: {
      usageSummary: {
        totalPromptTokens: row?.totalPromptTokens || 0,
        totalCompletionTokens: row?.totalCompletionTokens || 0,
        totalTokens: row?.totalTokens || 0,
        totalCostUsdCents: row?.totalCostUsdCents || 0,
        lastEventAt: row?.lastEventAt || null,
      },
    },
  }).exec();
}

const BackfillUsageCli: ReactoryCliApp = async (kwargs, context) => {
  const args = parseArgs(kwargs);
  const log = (msg: string, meta?: any) => context.log(msg, meta, 'info', 'BackfillUsage');

  log(`Starting backfill (dryRun=${args.dryRun}, since=${args.since?.toISOString() || 'all'}, user=${args.userId?.toString() || 'all'}, batch=${args.batchSize})`);

  const pricingLoader = getPricingLoader();

  const filter: Record<string, unknown> = {};
  if (args.since) filter.created = { $gte: args.since };
  if (args.userId) filter.user = args.userId;

  const stats: BackfillStats = {
    conversationsScanned: 0,
    conversationsUpdated: 0,
    eventsCreated: 0,
    eventsSkippedExisting: 0,
    conversationsWithMissingUsage: 0,
    errors: 0,
  };

  const cursor = ReactorConversationModel.find(filter).cursor({ batchSize: args.batchSize });

  try {
    for await (const convDoc of cursor) {
      const conv = convDoc as unknown as ReactorConversationDocument;
      stats.conversationsScanned++;

      let conversationHadUsage = false;
      let conversationCreatedEvents = 0;

      for (const historyItem of conv.history || []) {
        const item = historyItem as any;
        if (item.role !== 'assistant') continue;

        const usage = extractUsageFromHistory(item);
        if (!usage) continue;
        conversationHadUsage = true;

        const messageId = item.id instanceof ObjectId
          ? item.id
          : (item.id ? new ObjectId(item.id) : new ObjectId());

        const pricing = pricingLoader.getPricing(conv.providerId || 'unknown', conv.modelId);
        const priced = priceUsage(pricing, usage);

        const userId = ((conv.user as any)?._id ?? conv.user) as ObjectId;
        const eventDoc = {
          userId,
          conversationId: conv._id,
          messageId,
          personaId: conv.personaId,
          providerId: conv.providerId || 'unknown',
          modelId: conv.modelId,
          modelVersion: null,
          usage,
          pricingSnapshot: priced.pricingSnapshot,
          costs: priced.costs,
          pricingSource: 'backfilled' as const,
          occurredAt: item.timestamp ? new Date(item.timestamp) : new Date(),
          finishReason: null,
          toolCallCount: (item.tool_calls || []).length,
          streamingMode: false,
          created: new Date(),
        };

        if (args.dryRun) {
          stats.eventsCreated++;
          conversationCreatedEvents++;
          if (args.verbose) {
            log(`[dry-run] Would emit event ${conv._id}::${messageId} cost=${priced.costs.totalUsdCents}`);
          }
          continue;
        }

        try {
          await ReactoryUsageEventModel.create(eventDoc);
          stats.eventsCreated++;
          conversationCreatedEvents++;
        } catch (err: any) {
          if (err?.code === 11000) {
            stats.eventsSkippedExisting++;
          } else {
            stats.errors++;
            context.error(`Failed to insert event for ${conv._id}::${messageId}: ${err.message}`, { err }, 'BackfillUsage');
          }
        }
      }

      if (!conversationHadUsage) {
        stats.conversationsWithMissingUsage++;
      } else if (conversationCreatedEvents > 0) {
        try {
          await recomputeSummary(conv._id, args.dryRun);
          stats.conversationsUpdated++;
        } catch (err: any) {
          stats.errors++;
          context.error(`Failed to recompute summary for ${conv._id}: ${err.message}`, { err }, 'BackfillUsage');
        }
      }

      if (stats.conversationsScanned % 100 === 0) {
        log(`Progress: ${JSON.stringify(stats)}`);
      }
    }
  } finally {
    await cursor.close().catch(() => undefined);
  }

  log(`Backfill complete: ${JSON.stringify(stats, null, 2)}`);
};

const BackfillUsageComponentDefinition: Reactory.IReactoryComponentDefinition<ReactoryCliApp> = {
  nameSpace: 'reactor',
  name: 'BackfillUsage',
  version: '1.0.0',
  description: 'Replay history[].response.usage on existing reactor_conversations into the reactor_usage_events collection.',
  component: BackfillUsageCli,
  domain: 'cli',
  features: [
    {
      feature: 'backfill',
      featureType: 'data',
      action: ['backfill', 'usage', 'cost', 'migration'],
      description: 'Backfill usage events from existing conversation history',
      stem: 'backfill-usage',
    },
  ],
  overwrite: false,
  roles: ['ADMIN'],
  stem: 'backfill-usage',
  tags: ['reactor', 'cli', 'backfill', 'usage', 'cost'],
  toString(includeVersion) {
    return includeVersion ? `${this.nameSpace}.${this.name}@${this.version}` : this.name;
  },
};

export default BackfillUsageComponentDefinition;
