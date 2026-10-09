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
  /** Report over a selection of users; see UsageAnalyticsFilter.userIds. */
  userIds?: string[];
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

/**
 * A budget patch applied to one or many users.
 *
 * Only the fields present are written, so an omitted limit is left unchanged —
 * the distinction that lets one bulk patch be applied across a selection without
 * wiping limits the operator did not touch.
 */
export interface SetUserBudgetPatch {
  monthlyTokenLimit?: number;
  dailyTokenLimit?: number;
  monthlyCostLimitUsd?: number;
  dailyCostLimitUsd?: number;
  alertThresholdPercent?: number;
  hardStop?: boolean;
  notes?: string;
}

/** Outcome of a bulk budget operation, with per-user errors rather than a throw. */
export interface BulkBudgetResult {
  requested: number;
  applied: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
  errors: Array<{ userId: string; message: string }>;
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
   *
   * Consumption is **measured from the message log**, not read from the stored
   * counters. Those counters were only ever advanced by `updateUserBudgetCounters`,
   * which ran as a side effect of `recordUsage` — a call that never persisted
   * anything (the ledger it wrote to was empty). Every budget therefore reported
   * zero consumed, so `hardStop` could never trigger and every user read as
   * `ACTIVE` regardless of real spend.
   *
   * FAIL-OPEN on a telemetry fault. If Postgres is unreachable the gate allows the
   * turn and says so in the reason. The alternative — blocking every user because
   * a counter store hiccuped — converts a reporting outage into a full AI outage,
   * which is the worse failure. A `hardStop` is an admin guardrail against
   * overspend, not a safety interlock; degrading it to a no-op is the recoverable
   * direction, and the log makes the degradation visible.
   */
  async checkUserBudget(
    userId: string | ObjectId
  ): Promise<{ allowed: boolean; reason?: string; status: string; percentageUsed: number }> {
    const userObjectId = typeof userId === "string" ? new ObjectId(userId) : userId;
    const userIdString = userObjectId.toString();

    let budget: ReactorUserBudgetDocument | null = null;
    try {
      budget = await ReactorUserBudgetModel.findOne({ userId: userObjectId });
    } catch (err: any) {
      this.context.log?.(
        `Budget lookup failed for user ${userIdString}: ${err.message}`,
        {},
        "warning"
      );
      return { allowed: true, status: "ACTIVE", percentageUsed: 0 };
    }

    // No budget, or an explicitly disabled one: nothing to enforce.
    if (!budget || budget.status === "DISABLED") {
      return { allowed: true, status: "ACTIVE", percentageUsed: 0 };
    }

    const consumption = await this.measureConsumption(userIdString);

    if (!consumption.measured) {
      return {
        allowed: true,
        status: "ACTIVE",
        percentageUsed: 0,
        reason:
          "Usage could not be measured, so budget enforcement is degraded to allow this turn.",
      };
    }

    const { monthTokens, monthCostUsd, dayTokens, dayCostUsd } = consumption;

    // Which limits were actually declared. A limit of 0 or null means unlimited,
    // and treating it as a limit of zero would block every user with a default row.
    const limitChecks: Array<{ label: string; used: number; limit: number }> = [];
    if (budget.monthlyTokenLimit && budget.monthlyTokenLimit > 0) {
      limitChecks.push({ label: "monthly token", used: monthTokens, limit: budget.monthlyTokenLimit });
    }
    if (budget.monthlyCostLimitUsd && budget.monthlyCostLimitUsd > 0) {
      limitChecks.push({ label: "monthly cost", used: monthCostUsd, limit: budget.monthlyCostLimitUsd });
    }
    if (budget.dailyTokenLimit && budget.dailyTokenLimit > 0) {
      limitChecks.push({ label: "daily token", used: dayTokens, limit: budget.dailyTokenLimit });
    }
    if (budget.dailyCostLimitUsd && budget.dailyCostLimitUsd > 0) {
      limitChecks.push({ label: "daily cost", used: dayCostUsd, limit: budget.dailyCostLimitUsd });
    }

    // No limits declared at all: nothing enforceable, and definitely not exceeded.
    if (limitChecks.length === 0) {
      return { allowed: true, status: "ACTIVE", percentageUsed: 0 };
    }

    const exceeded = limitChecks.find((c) => c.used >= c.limit);
    const maxPercent = Math.min(
      Math.round(
        Math.max(...limitChecks.map((c) => (c.used / c.limit) * 100))
      ),
      100
    );

    const threshold = (budget.alertThresholdPercent ?? 80) / 100;
    const warning = limitChecks.some((c) => c.used >= c.limit * threshold);

    if (exceeded && budget.hardStop) {
      return {
        allowed: false,
        reason:
          `AI usage budget reached: ${exceeded.used.toLocaleString()} of ` +
          `${exceeded.limit.toLocaleString()} ${exceeded.label} limit used. ` +
          `Ask an administrator to raise the limit.`,
        status: "EXCEEDED",
        percentageUsed: 100,
      };
    }

    // Exceeded without a hard stop is a warning, not a block: the admin asked to be
    // told, not to be stopped.
    const status = exceeded ? "EXCEEDED" : warning ? "WARNING" : "ACTIVE";

    return { allowed: true, status, percentageUsed: maxPercent };
  }

  /**
   * Measure a user's real consumption for the current month and day.
   *
   * `measured` distinguishes "genuinely zero" from "could not read", because
   * collapsing those two is how a budget gate silently stops working: a zero
   * caused by a missing data source reads exactly like a user who has spent
   * nothing.
   *
   * Boundaries are computed in UTC and the end is exclusive, so a turn landing
   * exactly at midnight counts in one period, not both.
   */
  private async measureConsumption(userId: string): Promise<{
    measured: boolean;
    monthTokens: number;
    monthCostUsd: number;
    dayTokens: number;
    dayCostUsd: number;
  }> {
    const empty = {
      measured: false,
      monthTokens: 0,
      monthCostUsd: 0,
      dayTokens: 0,
      dayCostUsd: 0,
    };

    try {
      const analytics = this.context.getService<any>(
        "reactor.ReactorUsageAnalyticsService@1.0.0"
      );
      if (!analytics || typeof analytics.getConsumptionForUser !== "function") {
        return empty;
      }

      const now = new Date();
      const monthFrom = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
      );
      const dayFrom = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
      );
      const to = new Date(now.getTime() + 1);

      const [month, day] = await Promise.all([
        analytics.getConsumptionForUser(userId, { from: monthFrom, to }),
        analytics.getConsumptionForUser(userId, { from: dayFrom, to }),
      ]);

      return {
        measured: true,
        monthTokens: Number(month?.tokens ?? 0),
        monthCostUsd: Number(month?.costUsd ?? 0),
        dayTokens: Number(day?.tokens ?? 0),
        dayCostUsd: Number(day?.costUsd ?? 0),
      };
    } catch (err: any) {
      this.context.log?.(
        `Usage measurement failed for user ${userId}: ${err.message}`,
        {},
        "warning"
      );
      return empty;
    }
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
    // A non-ObjectId here (an email, or a truncated id) used to reach `new
    // ObjectId()` and throw a BSONError, which surfaced as an opaque server error
    // on the budget screen. "No budget" is the honest answer for anything that is
    // not an id.
    if (!ObjectId.isValid(userId)) return null;

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

    if (!ObjectId.isValid(userId)) {
      throw new Error(`Invalid user id "${userId}" for budget assignment`);
    }

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
    // Nothing to delete is a `false`, not an exception: the budget table lists
    // every user, so "remove" is reachable on a row that has no budget, and an
    // id that is absent or not an ObjectId reached `findByIdAndDelete` and threw
    // a CastError instead of reporting the no-op it is.
    if (!id || !ObjectId.isValid(id)) return false;

    const result = await ReactorUserBudgetModel.findByIdAndDelete(id);
    return !!result;
  }

  /**
   * Set or update budgets for many users in one round trip.
   *
   * Implemented with a single `bulkWrite` rather than N `setUserBudget` calls:
   * the console applies one patch to a whole selection, and doing that as one
   * statement keeps it fast and makes the created/updated split reportable.
   *
   * Failures are reported per user (`errors`) and never abort the batch — a
   * single bad entry must not discard the work done for the rest.
   */
  async setUserBudgetsBulk(
    userIds: string[],
    patch: SetUserBudgetPatch
  ): Promise<BulkBudgetResult> {
    const requestedIds = Array.from(
      new Set((userIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean))
    );

    const result: BulkBudgetResult = {
      requested: requestedIds.length,
      applied: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    const validIds: ObjectId[] = [];
    for (const id of requestedIds) {
      if (ObjectId.isValid(id)) validIds.push(new ObjectId(id));
      else {
        result.failed += 1;
        result.errors.push({ userId: id, message: 'Not a valid user id' });
      }
    }
    if (validIds.length === 0) return result;

    // Only the supplied fields are written. `undefined` means "not supplied"; a
    // deliberate `null` (e.g. clearing notes) is kept, matching setUserBudget.
    const set: Record<string, unknown> = {};
    if (patch.monthlyTokenLimit !== undefined) set.monthlyTokenLimit = patch.monthlyTokenLimit;
    if (patch.dailyTokenLimit !== undefined) set.dailyTokenLimit = patch.dailyTokenLimit;
    if (patch.monthlyCostLimitUsd !== undefined) set.monthlyCostLimitUsd = patch.monthlyCostLimitUsd;
    if (patch.dailyCostLimitUsd !== undefined) set.dailyCostLimitUsd = patch.dailyCostLimitUsd;
    if (patch.alertThresholdPercent !== undefined) set.alertThresholdPercent = patch.alertThresholdPercent;
    if (patch.hardStop !== undefined) set.hardStop = patch.hardStop;
    if (patch.notes !== undefined) set.notes = patch.notes;

    // `bulkWrite` bypasses Mongoose schema defaults, so the insert defaults must
    // be stated explicitly or an upsert would create a budget missing its
    // counters/status. Fields already in `$set` are removed here — MongoDB rejects
    // the same path appearing in both `$set` and `$setOnInsert`.
    const insertDefaults: Record<string, unknown> = {
      currentMonthTokens: 0,
      currentMonthCostUsd: 0,
      currentDayTokens: 0,
      currentDayCostUsd: 0,
      alertThresholdPercent: 80,
      hardStop: false,
      status: 'ACTIVE',
      organizationId: null,
      lastResetDate: new Date(),
      lastDailyResetDate: new Date(),
    };
    for (const key of Object.keys(set)) delete insertDefaults[key];

    // Which of these already have a budget — the created/updated split. One query
    // for the whole batch rather than one per user.
    const existing = await ReactorUserBudgetModel.find({ userId: { $in: validIds } })
      .select('userId')
      .lean()
      .exec();
    const existingSet = new Set(existing.map((b: any) => String(b.userId)));

    const operations = validIds.map((userId) => ({
      updateOne: {
        filter: { userId },
        update: { $set: set, $setOnInsert: insertDefaults },
        upsert: true,
      },
    }));

    const creditApplied = (userId: ObjectId) => {
      result.applied += 1;
      if (existingSet.has(String(userId))) result.updated += 1;
      else result.created += 1;
    };

    try {
      await ReactorUserBudgetModel.bulkWrite(operations as any, { ordered: false });
      validIds.forEach(creditApplied);
    } catch (error: any) {
      // A partially-applied batch. `ordered: false` means the writes that could
      // succeed did; report the failures instead of throwing the batch away.
      const rawErrors =
        error?.writeErrors ?? error?.result?.getWriteErrors?.() ?? [];
      const failedIndexes = new Set<number>();
      for (const writeError of rawErrors) {
        const index =
          typeof writeError?.index === 'number'
            ? writeError.index
            : writeError?.err?.index;
        if (typeof index === 'number' && index >= 0) failedIndexes.add(index);
      }

      validIds.forEach((userId, index) => {
        if (failedIndexes.has(index)) {
          result.failed += 1;
          result.errors.push({ userId: String(userId), message: 'Write failed' });
        } else {
          creditApplied(userId);
        }
      });
    }

    return result;
  }

  /**
   * Remove the budgets of many users in one round trip.
   *
   * Keyed on user ids because the console selects users, not budgets, and a
   * selected user may have no budget — that is `skipped`, not a failure.
   */
  async deleteUserBudgetsBulk(userIds: string[]): Promise<BulkBudgetResult> {
    const requestedIds = Array.from(
      new Set((userIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean))
    );

    const result: BulkBudgetResult = {
      requested: requestedIds.length,
      applied: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    const validIds: ObjectId[] = [];
    for (const id of requestedIds) {
      if (ObjectId.isValid(id)) validIds.push(new ObjectId(id));
      else {
        result.failed += 1;
        result.errors.push({ userId: id, message: 'Not a valid user id' });
      }
    }
    if (validIds.length === 0) return result;

    const deleteResult = await ReactorUserBudgetModel.deleteMany({
      userId: { $in: validIds },
    });

    result.deleted = deleteResult.deletedCount ?? 0;
    result.applied = result.deleted;
    // Users that had no budget are skipped, not failed: "remove" is reachable on
    // a row with nothing to remove, which is a no-op.
    result.skipped = validIds.length - result.deleted;

    return result;
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
