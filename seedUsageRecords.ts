import mongoose from 'mongoose';
import ReactoryAIUsageRecord from './models/ReactorAIUsage';
import ReactoryAIUserBudget from './models/ReactorUserBudget';

const MONGODB_URI = process.env.MONGOOSE || 'mongodb://reactory:reactorycore@localhost:27017/reactory-reactory?authSource=admin';

const seed = async () => {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.');

  const userId = new mongoose.Types.ObjectId('6a2f3dd532d3af0ca472e5b8'); // Werner Weber
  const orgId = new mongoose.Types.ObjectId('6a2f3dd532d3af0ca472e5b9');

  // Clear existing mock/test records if any
  await ReactoryAIUsageRecord.deleteMany({ userId });
  await ReactoryAIUserBudget.deleteMany({ userId });

  const providers = [
    { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219', inputRate: 3.0, outputRate: 15.0 },
    { provider: 'openai', model: 'gpt-4o', inputRate: 2.5, outputRate: 10.0 },
    { provider: 'google', model: 'gemini-2.5-pro', inputRate: 1.25, outputRate: 5.0 },
    { provider: 'llamacpp', model: 'Ornith-1.0-9B', inputRate: 0.0, outputRate: 0.0 },
  ];

  const personas = ['ReactorAIPersona', 'GitGuardian', 'WorkflowWill', 'SecuritySam', 'DataAnalytics'];

  const now = new Date();
  const records = [];

  // Generate 45 realistic activity records over the last 14 days
  for (let i = 0; i < 45; i++) {
    const daysAgo = Math.floor(Math.random() * 14);
    const date = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000 - Math.random() * 12 * 3600 * 1000);
    const p = providers[Math.floor(Math.random() * providers.length)];
    const persona = personas[Math.floor(Math.random() * personas.length)];
    const promptTokens = Math.floor(Math.random() * 3500) + 800;
    const completionTokens = Math.floor(Math.random() * 1200) + 200;
    const totalTokens = promptTokens + completionTokens;
    const cost = (promptTokens / 1_000_000) * p.inputRate + (completionTokens / 1_000_000) * p.outputRate;
    const duration = Math.floor(Math.random() * 3000) + 800;

    records.push({
      userId,
      organizationId: orgId,
      chatSessionId: new mongoose.Types.ObjectId().toString(),
      personaId: persona,
      provider: p.provider,
      model: p.model,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsdCents: Math.round(cost * 10000) / 100,
      costCurrency: 'USD',
      durationMs: duration,
      timeToFirstTokenMs: Math.floor(duration * 0.3),
      use_case: 'chat',
      status: 'success',
      createdAt: date,
      updatedAt: date,
    });
  }

  await ReactoryAIUsageRecord.insertMany(records);
  console.log(`Inserted ${records.length} AI usage records for user ${userId}.`);

  // Create a User Budget for Werner
  const totalTokensUsed = records.reduce((acc, r) => acc + r.totalTokens, 0);
  const totalCostUsed = records.reduce((acc, r) => acc + (r.costUsdCents / 100), 0);

  await ReactoryAIUserBudget.create({
    userId,
    organizationId: orgId,
    monthlyTokenLimit: 10000000,
    dailyTokenLimit: 1000000,
    monthlyCostLimitUsd: 50.00,
    dailyCostLimitUsd: 10.00,
    currentMonthTokens: totalTokensUsed,
    currentMonthCostUsd: Number(totalCostUsed.toFixed(4)),
    currentDayTokens: Math.floor(totalTokensUsed / 14),
    currentDayCostUsd: Number((totalCostUsed / 14).toFixed(4)),
    alertThresholdPercent: 80,
    hardStop: false,
    status: 'ACTIVE',
    notes: 'Developer tier budget allocation for Werner Weber',
    lastResetDate: new Date(now.getFullYear(), now.getMonth(), 1),
    lastDailyResetDate: now,
  });

  console.log('Created user budget for Werner Weber.');
  await mongoose.disconnect();
  console.log('Done!');
};

seed().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
