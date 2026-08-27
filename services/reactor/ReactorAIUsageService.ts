import Reactory from "@reactorynet/reactory-core";
import { service } from "@reactory/server-core/application/decorators/service";
import { ObjectId } from "mongodb";
import ReactorAIUsageModel, { ReactorAIUsageDocument } from "../../models/ReactorAIUsage";
import ReactorUserBudgetModel, { ReactorUserBudgetDocument } from "../../models/ReactorUserBudget";
import { loadProviders, findModelById } from "../../ai/providers/provider-loader";

export interface RecordUsageInput {
  userId: string | ObjectId;
  organizationId?: string | ObjectId;
  businessUnitId?: string | ObjectId;
  chatSessionId?: string;
  parentSessionId?: string;
  personaId?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  use_case?: string;
  status?: 'success' | 'error';
  errorCode?: string;
  errorMessage?: string;
  toolCallsCount?: number;
  toolsUsed?: string[];
}

export interface UsageSummaryFilter {
  userId?: string;
  organizationId?: string;
  businessUnitId?: string;
  provider?: string;
  model?: string;
  personaId?: string;
  startDate?: string | Date;
  endDate?: string | Date;
  use_case?: string;
}

export interface SetUserBudgetInput {
  userId: string;
  monthlyTokenLimit?: number;
  dailyTokenLimit?: number;
  monthlyCostLimitUsd?: number;
  dailyCostLimitUsd?: number;
  alertThresholdPercent?: number;
  hardStop?: boolean;
  notes?: string;
}

@service({
  id: "reactor.ReactorAIUsageService@1.0.0",
  name: "Reactor AI Usage Service",
  nameSpace: "reactor",
  description: "Service for recording, aggregating and tracking AI token usage, costs, and budgets",
  serviceType: "ai",
})
export class ReactorAIUsageService {
  context: Reactory.Server.IReactoryContext;

  constructor(
    props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext
  ) {
    this.context = context;
  }

  /**
   * Calculates cost in USD cents for given model and token counts using providers.yaml pricing.
   */
  calculateCost(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number
  ): { costUsdCents: number; costCurrency: string } {
    try {
      const providers = loadProviders();
      const modelResult = findModelById(providers, model);

      if (modelResult && modelResult.model) {
        const inputRate = modelResult.model.inputCostPerTokenUsdCents || 0;
        const outputRate = modelResult.model.outputCostPerTokenUsdCents || 0;
        const costUsdCents = promptTokens * inputRate + completionTokens * outputRate;
        return {
          costUsdCents: Math.round(costUsdCents * 100000) / 100000,
          costCurrency: "USD",
        };
      }
    } catch (err: any) {
      this.context.log?.(`Failed to calculate cost for model ${model}: ${err.message}`, {}, "warning");
    }

    return { costUsdCents: 0, costCurrency: "USD" };
  }

  /**
   * Records an AI usage event into the ledger and updates user budget counters.
   */
  async recordUsage(input: RecordUsageInput): Promise<ReactorAIUsageDocument> {
    const {
      userId,
      organizationId,
      businessUnitId,
      chatSessionId,
      parentSessionId,
      personaId = "Reactor",
      provider,
      model,
      promptTokens = 0,
      completionTokens = 0,
      totalTokens = (promptTokens + completionTokens),
      durationMs,
      timeToFirstTokenMs,
      use_case = "standalone",
      status = "success",
      errorCode,
      errorMessage,
      toolCallsCount = 0,
      toolsUsed = [],
    } = input;

    const userObjectId = typeof userId === "string" ? new ObjectId(userId) : userId;
    const orgObjectId = organizationId ? (typeof organizationId === "string" ? new ObjectId(organizationId) : organizationId) : undefined;
    const buObjectId = businessUnitId ? (typeof businessUnitId === "string" ? new ObjectId(businessUnitId) : businessUnitId) : undefined;

    const { costUsdCents, costCurrency } = this.calculateCost(
      provider,
      model,
      promptTokens,
      completionTokens
    );

    // Persist usage record
    const usageRecord = new ReactorAIUsageModel({
      userId: userObjectId,
      organizationId: orgObjectId,
      businessUnitId: buObjectId,
      chatSessionId,
      parentSessionId,
      personaId,
      provider: provider.toLowerCase(),
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsdCents,
      costCurrency,
      durationMs,
      timeToFirstTokenMs,
      use_case,
      status,
      errorCode,
      errorMessage,
      toolCallsCount,
      toolsUsed,
    });

    await usageRecord.save();

    // Asynchronously update user budget counters
    this.updateUserBudgetCounters(userObjectId, totalTokens, costUsdCents / 100).catch((err) => {
      this.context.log?.(`Failed to update budget counters for user ${userId}: ${err.message}`, {}, "warning");
    });

    return usageRecord;
  }

  /**
   * Internal helper to update user budget counters with day/month rollover checks.
   */
  private async updateUserBudgetCounters(
    userId: ObjectId,
    tokens: number,
    costUsd: number
  ): Promise<void> {
    const now = new Date();
    const budget = await ReactorUserBudgetModel.findOne({ userId });
    if (!budget) return;

    // Check month rollover
    const lastReset = budget.lastResetDate || budget.createdAt;
    const isNewMonth =
      now.getFullYear() !== lastReset.getFullYear() ||
      now.getMonth() !== lastReset.getMonth();

    if (isNewMonth) {
      budget.currentMonthTokens = 0;
      budget.currentMonthCostUsd = 0;
      budget.lastResetDate = now;
    }

    // Check day rollover
    const lastDailyReset = budget.lastDailyResetDate || budget.createdAt;
    const isNewDay =
      now.getFullYear() !== lastDailyReset.getFullYear() ||
      now.getMonth() !== lastDailyReset.getMonth() ||
      now.getDate() !== lastDailyReset.getDate();

    if (isNewDay) {
      budget.currentDayTokens = 0;
      budget.currentDayCostUsd = 0;
      budget.lastDailyResetDate = now;
    }

    budget.currentMonthTokens += tokens;
    budget.currentMonthCostUsd += costUsd;
    budget.currentDayTokens += tokens;
    budget.currentDayCostUsd += costUsd;

    // Check thresholds
    const monthlyTokenExceeded = budget.monthlyTokenLimit && budget.currentMonthTokens >= budget.monthlyTokenLimit;
    const monthlyCostExceeded = budget.monthlyCostLimitUsd && budget.currentMonthCostUsd >= budget.monthlyCostLimitUsd;
    const dailyTokenExceeded = budget.dailyTokenLimit && budget.currentDayTokens >= budget.dailyTokenLimit;
    const dailyCostExceeded = budget.dailyCostLimitUsd && budget.currentDayCostUsd >= budget.dailyCostLimitUsd;

    if (monthlyTokenExceeded || monthlyCostExceeded || dailyTokenExceeded || dailyCostExceeded) {
      budget.status = "EXCEEDED";
    } else {
      const threshold = (budget.alertThresholdPercent || 80) / 100;
      const monthTokenWarn = budget.monthlyTokenLimit && budget.currentMonthTokens >= budget.monthlyTokenLimit * threshold;
      const monthCostWarn = budget.monthlyCostLimitUsd && budget.currentMonthCostUsd >= budget.monthlyCostLimitUsd * threshold;
      if (monthTokenWarn || monthCostWarn) {
        budget.status = "WARNING";
      } else {
        budget.status = "ACTIVE";
      }
    }

    await budget.save();
  }

  /**
   * Checks if user has exceeded budget limits before executing a turn.
   */
  async checkUserBudget(
    userId: string | ObjectId
  ): Promise<{ allowed: boolean; reason?: string; status: string; percentageUsed: number }> {
    const userObjectId = typeof userId === "string" ? new ObjectId(userId) : userId;
    const budget = await ReactorUserBudgetModel.findOne({ userId: userObjectId });

    if (!budget || budget.status === "DISABLED") {
      return { allowed: true, status: "ACTIVE", percentageUsed: 0 };
    }

    if (budget.status === "EXCEEDED" && budget.hardStop) {
      return {
        allowed: false,
        reason: "Monthly or daily AI budget limit has been reached.",
        status: budget.status,
        percentageUsed: 100,
      };
    }

    let maxPercent = 0;
    if (budget.monthlyTokenLimit && budget.monthlyTokenLimit > 0) {
      maxPercent = Math.max(maxPercent, (budget.currentMonthTokens / budget.monthlyTokenLimit) * 100);
    }
    if (budget.monthlyCostLimitUsd && budget.monthlyCostLimitUsd > 0) {
      maxPercent = Math.max(maxPercent, (budget.currentMonthCostUsd / budget.monthlyCostLimitUsd) * 100);
    }

    return {
      allowed: true,
      status: budget.status,
      percentageUsed: Math.min(Math.round(maxPercent), 100),
    };
  }

  /**
   * Retrieves aggregated AI usage statistics and breakdowns.
   */
  async getUsageSummary(filter: UsageSummaryFilter = {}): Promise<any> {
    const match: Record<string, any> = {};

    if (filter.userId) {
      match.userId = new ObjectId(filter.userId);
    }
    if (filter.organizationId) {
      match.organizationId = new ObjectId(filter.organizationId);
    }
    if (filter.businessUnitId) {
      match.businessUnitId = new ObjectId(filter.businessUnitId);
    }
    if (filter.provider) {
      match.provider = filter.provider.toLowerCase();
    }
    if (filter.model) {
      match.model = filter.model;
    }
    if (filter.personaId) {
      match.personaId = filter.personaId;
    }
    if (filter.use_case) {
      match.use_case = filter.use_case;
    }

    if (filter.startDate || filter.endDate) {
      match.createdAt = {};
      if (filter.startDate) match.createdAt.$gte = new Date(filter.startDate);
      if (filter.endDate) match.createdAt.$lte = new Date(filter.endDate);
    }

    // 1. Overall totals
    const totalsResult = await ReactorAIUsageModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalPromptTokens: { $sum: "$promptTokens" },
          totalCompletionTokens: { $sum: "$completionTokens" },
          totalTokens: { $sum: "$totalTokens" },
          totalCostUsdCents: { $sum: "$costUsdCents" },
          totalRequests: { $sum: 1 },
          avgDurationMs: { $avg: "$durationMs" },
          errorCount: {
            $sum: { $cond: [{ $eq: ["$status", "error"] }, 1, 0] },
          },
        },
      },
    ]);

    const totals = totalsResult[0] || {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCostUsdCents: 0,
      totalRequests: 0,
      avgDurationMs: 0,
      errorCount: 0,
    };

    // 2. Model breakdown
    const modelBreakdown = await ReactorAIUsageModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: { model: "$model", provider: "$provider" },
          totalTokens: { $sum: "$totalTokens" },
          promptTokens: { $sum: "$promptTokens" },
          completionTokens: { $sum: "$completionTokens" },
          costUsdCents: { $sum: "$costUsdCents" },
          requests: { $sum: 1 },
        },
      },
      { $sort: { totalTokens: -1 } },
      {
        $project: {
          _id: 0,
          model: "$_id.model",
          provider: "$_id.provider",
          totalTokens: 1,
          promptTokens: 1,
          completionTokens: 1,
          costUsdCents: 1,
          costUsd: { $divide: ["$costUsdCents", 100] },
          requests: 1,
        },
      },
    ]);

    // 3. Provider breakdown
    const providerBreakdown = await ReactorAIUsageModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$provider",
          totalTokens: { $sum: "$totalTokens" },
          costUsdCents: { $sum: "$costUsdCents" },
          requests: { $sum: 1 },
        },
      },
      { $sort: { totalTokens: -1 } },
      {
        $project: {
          _id: 0,
          provider: "$_id",
          totalTokens: 1,
          costUsdCents: 1,
          costUsd: { $divide: ["$costUsdCents", 100] },
          requests: 1,
        },
      },
    ]);

    // 4. Daily time-series
    const timeSeries = await ReactorAIUsageModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          promptTokens: { $sum: "$promptTokens" },
          completionTokens: { $sum: "$completionTokens" },
          totalTokens: { $sum: "$totalTokens" },
          costUsdCents: { $sum: "$costUsdCents" },
          requests: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          date: "$_id",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 1,
          costUsdCents: 1,
          costUsd: { $divide: ["$costUsdCents", 100] },
          requests: 1,
        },
      },
    ]);

    // 5. Top users breakdown (only when query is not scoped to single user)
    let userBreakdown: any[] = [];
    if (!filter.userId) {
      userBreakdown = await ReactorAIUsageModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$userId",
            totalTokens: { $sum: "$totalTokens" },
            costUsdCents: { $sum: "$costUsdCents" },
            requests: { $sum: 1 },
          },
        },
        { $sort: { totalTokens: -1 } },
        { $limit: 20 },
        {
          $lookup: {
            from: "reactory_users",
            localField: "_id",
            foreignField: "_id",
            as: "userDoc",
          },
        },
        {
          $project: {
            _id: 0,
            userId: { $toString: "$_id" },
            totalTokens: 1,
            costUsdCents: 1,
            costUsd: { $divide: ["$costUsdCents", 100] },
            requests: 1,
            firstName: { $arrayElemAt: ["$userDoc.firstName", 0] },
            lastName: { $arrayElemAt: ["$userDoc.lastName", 0] },
            email: { $arrayElemAt: ["$userDoc.email", 0] },
          },
        },
      ]);
    }

    return {
      totalPromptTokens: totals.totalPromptTokens,
      totalCompletionTokens: totals.totalCompletionTokens,
      totalTokens: totals.totalTokens,
      totalCostUsdCents: Math.round(totals.totalCostUsdCents * 1000) / 1000,
      totalCostUsd: Math.round((totals.totalCostUsdCents / 100) * 1000) / 1000,
      totalRequests: totals.totalRequests,
      avgDurationMs: Math.round(totals.avgDurationMs || 0),
      errorCount: totals.errorCount,
      timeSeries,
      modelBreakdown,
      providerBreakdown,
      userBreakdown,
    };
  }

  /**
   * Retrieves a paginated list of usage ledger records.
   */
  async getUsageList(
    filter: UsageSummaryFilter = {},
    page: number = 1,
    pageSize: number = 20
  ): Promise<{ records: ReactorAIUsageDocument[]; total: number; page: number; pageSize: number; hasNext: boolean }> {
    const query: Record<string, any> = {};

    if (filter.userId) {
      query.userId = new ObjectId(filter.userId);
    }
    if (filter.organizationId) {
      query.organizationId = new ObjectId(filter.organizationId);
    }
    if (filter.provider) {
      query.provider = filter.provider.toLowerCase();
    }
    if (filter.model) {
      query.model = filter.model;
    }
    if (filter.personaId) {
      query.personaId = filter.personaId;
    }
    if (filter.use_case) {
      query.use_case = filter.use_case;
    }
    if (filter.startDate || filter.endDate) {
      query.createdAt = {};
      if (filter.startDate) query.createdAt.$gte = new Date(filter.startDate);
      if (filter.endDate) query.createdAt.$lte = new Date(filter.endDate);
    }

    const skip = (page - 1) * pageSize;
    const [records, total] = await Promise.all([
      ReactorAIUsageModel.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .populate('userId', 'firstName lastName email avatar')
        .exec(),
      ReactorAIUsageModel.countDocuments(query),
    ]);

    return {
      records,
      total,
      page,
      pageSize,
      hasNext: skip + records.length < total,
    };
  }

  /**
   * Retrieves a single user's budget settings.
   */
  async getUserBudget(userId: string): Promise<ReactorUserBudgetDocument | null> {
    return ReactorUserBudgetModel.findOne({ userId: new ObjectId(userId) })
      .populate('userId', 'firstName lastName email avatar')
      .exec();
  }

  /**
   * Lists all user budgets with search/pagination.
   */
  async listUserBudgets(): Promise<ReactorUserBudgetDocument[]> {
    return ReactorUserBudgetModel.find()
      .populate('userId', 'firstName lastName email avatar')
      .sort({ updatedAt: -1 })
      .exec();
  }

  /**
   * Sets or updates a user's budget.
   */
  async setUserBudget(input: SetUserBudgetInput): Promise<ReactorUserBudgetDocument> {
    const {
      userId,
      monthlyTokenLimit,
      dailyTokenLimit,
      monthlyCostLimitUsd,
      dailyCostLimitUsd,
      alertThresholdPercent = 80,
      hardStop = false,
      notes,
    } = input;

    const userObjectId = new ObjectId(userId);

    let budget = await ReactorUserBudgetModel.findOne({ userId: userObjectId });
    if (!budget) {
      budget = new ReactorUserBudgetModel({
        userId: userObjectId,
        lastResetDate: new Date(),
        lastDailyResetDate: new Date(),
      });
    }

    if (monthlyTokenLimit !== undefined) budget.monthlyTokenLimit = monthlyTokenLimit;
    if (dailyTokenLimit !== undefined) budget.dailyTokenLimit = dailyTokenLimit;
    if (monthlyCostLimitUsd !== undefined) budget.monthlyCostLimitUsd = monthlyCostLimitUsd;
    if (dailyCostLimitUsd !== undefined) budget.dailyCostLimitUsd = dailyCostLimitUsd;
    if (alertThresholdPercent !== undefined) budget.alertThresholdPercent = alertThresholdPercent;
    if (hardStop !== undefined) budget.hardStop = hardStop;
    if (notes !== undefined) budget.notes = notes;

    await budget.save();
    return budget.populate('userId', 'firstName lastName email avatar');
  }

  /**
   * Deletes a user's budget limit.
   */
  async deleteUserBudget(id: string): Promise<boolean> {
    const result = await ReactorUserBudgetModel.findByIdAndDelete(id);
    return !!result;
  }

  toString?(includeVersion?: boolean): string {
    return `ReactorAIUsageService${includeVersion ? "@1.0.0" : ""}`;
  }

  description?: string = "Service for recording, aggregating and tracking AI token usage, costs, and budgets";
  tags?: string[] = ["ai", "telemetry", "tokens", "budget", "analytics"];
  nameSpace: string = "reactor";
  name: string = "Reactor AI Usage Service";
  version: string = "1.0.0";
}

export default ReactorAIUsageService;
