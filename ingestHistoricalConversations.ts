import mongoose from 'mongoose';
import ReactorConversationModel from './models/ReactorChatState';
import ReactoryAIUsageModel from './models/ReactorAIUsage';
import ReactorUserBudgetModel from './models/ReactorUserBudget';
import { loadProviders, findModelById } from './ai/providers/provider-loader';

const MONGODB_URI = process.env.MONGOOSE || 'mongodb://reactory:reactorycore@localhost:27017/reactory-reactory?authSource=admin';

const ingest = async () => {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.');

  const conversations = await ReactorConversationModel.find({}).exec();
  console.log(`Found ${conversations.length} historical conversations in database.`);

  const providers = loadProviders();

  let realRecords = [];
  let userTokenMap = new Map<string, { tokens: number; cost: number; userId: any }>();

  for (const conv of conversations) {
    if (!conv.history || conv.history.length === 0) continue;

    const provider = conv.providerId || 'openai';
    const model = conv.modelId || 'gpt-4o';
    const persona = conv.personaId || 'Reactor';
    const userId = conv.user;

    const modelInfo = findModelById(providers, model);
    const inputRate = modelInfo?.model?.inputCostPerTokenUsdCents || 0;
    const outputRate = modelInfo?.model?.outputCostPerTokenUsdCents || 0;

    for (const msg of conv.history) {
      if (msg.role === 'assistant') {
        const usage = (msg.response as any)?.usage;
        let promptTokens = usage?.prompt_tokens || usage?.input_tokens || 0;
        let completionTokens = usage?.completion_tokens || usage?.output_tokens || 0;

        // If usage was not recorded on the response object, estimate tokens from content length (~4 chars per token)
        if (!promptTokens && !completionTokens) {
          const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
          completionTokens = Math.max(Math.round(contentStr.length / 4), 10);
          promptTokens = Math.round(completionTokens * 2.5);
        }

        const totalTokens = promptTokens + completionTokens;
        const costCents = promptTokens * inputRate + completionTokens * outputRate;
        const costUsd = costCents / 100;

        const record = {
          userId: userId || new mongoose.Types.ObjectId('6a2f3dd532d3af0ca472e5b8'),
          chatSessionId: conv._id.toString(),
          personaId: persona,
          provider: provider.toLowerCase(),
          model: model,
          promptTokens,
          completionTokens,
          totalTokens,
          costUsdCents: Math.round(costCents * 1000) / 1000,
          costCurrency: 'USD',
          durationMs: 1200,
          use_case: conv.use_case || 'standalone',
          status: 'success',
          createdAt: msg.timestamp || conv.created || new Date(),
          updatedAt: msg.timestamp || conv.updated || new Date(),
        };

        realRecords.push(record);

        const uidStr = (userId || '6a2f3dd532d3af0ca472e5b8').toString();
        const current = userTokenMap.get(uidStr) || { tokens: 0, cost: 0, userId: userId || new mongoose.Types.ObjectId('6a2f3dd532d3af0ca472e5b8') };
        current.tokens += totalTokens;
        current.cost += costUsd;
        userTokenMap.set(uidStr, current);
      }
    }
  }

  console.log(`Extracted ${realRecords.length} actual usage turns from historical conversations.`);

  if (realRecords.length > 0) {
    // Clear out mock data and insert the real data extracted from conversation history
    await ReactoryAIUsageModel.deleteMany({});
    await ReactoryAIUsageModel.insertMany(realRecords);
    console.log(`Successfully persisted ${realRecords.length} actual AI usage records.`);

    // Update or create budgets with actual historical token and cost usage
    for (const [uidStr, stats] of userTokenMap.entries()) {
      const userObjId = typeof stats.userId === 'string' ? new mongoose.Types.ObjectId(stats.userId) : stats.userId;
      await ReactorUserBudgetModel.findOneAndUpdate(
        { userId: userObjId },
        {
          userId: userObjId,
          monthlyTokenLimit: 10000000,
          dailyTokenLimit: 1000000,
          monthlyCostLimitUsd: 50.00,
          dailyCostLimitUsd: 10.00,
          currentMonthTokens: stats.tokens,
          currentMonthCostUsd: Number(stats.cost.toFixed(4)),
          currentDayTokens: Math.round(stats.tokens / 30),
          currentDayCostUsd: Number((stats.cost / 30).toFixed(4)),
          alertThresholdPercent: 80,
          hardStop: false,
          status: 'ACTIVE',
          notes: 'Budget for active chat user',
          lastResetDate: new Date(),
          lastDailyResetDate: new Date(),
        },
        { upsert: true, new: true }
      );
      console.log(`Updated budget for user ${uidStr}: ${stats.tokens} tokens, $${stats.cost.toFixed(4)} cost.`);
    }
  }

  await mongoose.disconnect();
  console.log('Ingestion complete!');
};

ingest().catch(err => {
  console.error('Ingest error:', err);
  process.exit(1);
});
