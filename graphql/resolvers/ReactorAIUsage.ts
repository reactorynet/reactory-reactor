import mongoose from 'mongoose';
import Reactory from '@reactorynet/reactory-core';
import {
  query,
  mutation,
  resolver,
  property,
} from '@reactory/server-core/models/graphql/decorators/resolver';
import ReactorAIUsageService, {
  UsageSummaryFilter,
  SetUserBudgetInput,
} from '../../services/reactor/ReactorAIUsageService';
import ReactorUsageAnalyticsService, {
  UsageAnalyticsFilter,
} from '../../services/reactor/ReactorUsageAnalyticsService';

/**
 * Usage reporting resolver.
 *
 * Reads are served by `ReactorUsageAnalyticsService`, which derives everything
 * from the Postgres message log. They previously came from a Mongo ledger
 * (`reactor_ai_usages`) that held **zero** documents, so every query returned
 * zeros and the dashboard silently rendered hardcoded fixtures instead.
 *
 * Budget *write* operations (limits, notes, hardStop) still live in
 * `ReactorAIUsageService`, because a budget is configuration rather than
 * telemetry. Its *consumption* counters are no longer trusted, though: they were
 * only ever advanced as a side effect of the ledger write that never happened, so
 * every budget reported zero used. Consumption is computed from messages at read
 * time instead.
 *
 * The GraphQL contract is preserved except where honesty requires a change:
 * `ReactorAIUsageRecord.costUsd` became nullable, because an unpriced model is
 * *unknown*, not free, and returning `0` for it was a silent money error.
 */
// @ts-ignore - resolver() is a marker decorator
@resolver
class ReactorAIUsageResolver {
  resolver: any;

  /** Admin-ish roles, which may see the whole tenant rather than only themselves. */
  private isAdmin(context: Reactory.Server.IReactoryContext): boolean {
    return (
      context.hasRole('ADMIN') ||
      context.hasRole('SUPERADMIN') ||
      context.hasRole('DEVELOPER')
    );
  }

  private analytics(context: Reactory.Server.IReactoryContext): ReactorUsageAnalyticsService {
    return context.getService<ReactorUsageAnalyticsService>(
      'reactor.ReactorUsageAnalyticsService@1.0.0'
    );
  }

  private usageService(context: Reactory.Server.IReactoryContext): ReactorAIUsageService {
    return context.getService<ReactorAIUsageService>(
      'reactor.ReactorAIUsageService@1.0.0'
    );
  }

  /**
   * Apply row-level access control to a usage filter.
   *
   * A non-admin is pinned to their own `userId` regardless of what they asked
   * for. This is the one place that decision is made, so a new query cannot
   * forget it — the previous implementation repeated the check per resolver,
   * which is exactly how such a check gets missed.
   */
  private scopeFilter(
    filter: UsageSummaryFilter | undefined,
    context: Reactory.Server.IReactoryContext
  ): UsageAnalyticsFilter {
    const scoped: UsageAnalyticsFilter = { ...(filter as UsageAnalyticsFilter) };

    // The dashboard sends `provider: 'all'` / `use_case: 'all'` from its selects.
    // Passing those through as literal predicates matches no row and silently
    // empties the report — the sentinel has to be dropped, not filtered on.
    if (scoped.provider && /^all$/i.test(String(scoped.provider).trim())) {
      delete scoped.provider;
    }
    if (scoped.useCase && /^all$/i.test(String(scoped.useCase).trim())) {
      delete scoped.useCase;
    }

    const user = context.user;
    if (user && !this.isAdmin(context)) {
      scoped.userId = user._id.toString();
    }

    return scoped;
  }

  @query('ReactorAIUsageSummary')
  async ReactorAIUsageSummary(
    _: any,
    args: { filter?: UsageSummaryFilter },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) throw new Error('Authentication required');
    const filter = this.scopeFilter(args?.filter, context);
    return this.analytics(context).getUsageSummary(filter);
  }

  @query('ReactorMyAIUsage')
  async ReactorMyAIUsage(
    _: any,
    args: { filter?: UsageSummaryFilter },
    context: Reactory.Server.IReactoryContext
  ) {
    const user = context.user;
    if (!user) throw new Error('Authentication required');

    const filter = this.scopeFilter(args?.filter, context);
    // Unconditionally the caller's own usage, even for an admin.
    filter.userId = user._id.toString();

    return this.analytics(context).getUsageSummary(filter);
  }

  @query('ReactorAIUsageList')
  async ReactorAIUsageList(
    _: any,
    args: { filter?: UsageSummaryFilter; page?: number; pageSize?: number },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) throw new Error('Authentication required');
    const filter = this.scopeFilter(args?.filter, context);
    return this.analytics(context).getUsageList(filter, args?.page || 1, args?.pageSize || 20);
  }

  /**
   * Fill in user names for a breakdown.
   *
   * Enrichment is done here rather than in SQL because users live in Mongo and
   * the metrics live in Postgres. A single batched lookup for the (at most 20)
   * ids keeps it to one query; a failure leaves the ids intact rather than
   * failing the report, since the metrics are the point and a name is decoration.
   */
  private async enrichUsers(
    rows: Array<Record<string, any>>
  ): Promise<Array<Record<string, any>>> {
    if (!rows || rows.length === 0) return [];

    const ids = rows
      .map((row) => String(row.userId ?? '').trim())
      .filter((id) => mongoose.Types.ObjectId.isValid(id));

    if (ids.length === 0) return rows;

    try {
      const db = mongoose.connection?.db;
      if (!db) return rows;

      const users = await db
        .collection('reactory_users')
        .find(
          { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } },
          { projection: { firstName: 1, lastName: 1, email: 1 } }
        )
        .toArray();

      const byId = new Map(
        users.map((user: any) => [
          String(user._id),
          {
            firstName: user.firstName ?? null,
            lastName: user.lastName ?? null,
            email: user.email ?? null,
          },
        ])
      );

      return rows.map((row) => ({
        ...row,
        ...(byId.get(String(row.userId)) ?? {}),
      }));
    } catch {
      return rows;
    }
  }

  /**
   * Current calendar month and day windows.
   *
   * `to` is exclusive so a turn landing exactly at midnight belongs to one
   * period rather than both.
   */
  private currentWindows(now = new Date()): {
    dayFrom: Date;
    monthFrom: Date;
    to: Date;
  } {
    const monthFrom = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
    );
    const dayFrom = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
    );
    const to = new Date(now.getTime() + 1);
    return { dayFrom, monthFrom, to };
  }

  @query('ReactorUserUsageStatus')
  async ReactorUserUsageStatus(
    _: any,
    _args: any,
    context: Reactory.Server.IReactoryContext
  ) {
    const user = context.user;
    if (!user) throw new Error('Authentication required');

    const analytics = this.analytics(context);
    const usageService = this.usageService(context);

    const [statusResult, budget] = await Promise.all([
      usageService.checkUserBudget(user._id),
      usageService.getUserBudget(user._id.toString()),
    ]);

    if (!budget) {
      return {
        allowed: statusResult.allowed,
        status: statusResult.status,
        percentageUsed: statusResult.percentageUsed,
        reason: statusResult.reason,
        budget: null,
      };
    }

    const { dayFrom, monthFrom, to } = this.currentWindows();
    const userId = user._id.toString();

    const [month, day] = await Promise.all([
      analytics.getConsumptionForUser(userId, { from: monthFrom, to }),
      analytics.getConsumptionForUser(userId, { from: dayFrom, to }),
    ]);

    return {
      allowed: statusResult.allowed,
      status: statusResult.status,
      percentageUsed: statusResult.percentageUsed,
      reason: statusResult.reason,
      budget: this.toBudgetShape(budget, month, day),
    };
  }

  /**
   * Project a stored budget plus measured consumption into the GraphQL shape.
   *
   * The stored `currentMonth*` / `currentDay*` counters are deliberately not
   * exposed: they are only ever advanced by the ledger write that never ran, so
   * they are structurally zero and showing them would misreport headroom.
   */
  private toBudgetShape(
    budget: any,
    month: { tokens: number; costUsd: number; turns: number },
    day: { tokens: number; costUsd: number; turns: number }
  ): Record<string, any> {
    const plain = budget?.toObject ? budget.toObject() : { ...budget };
    const userObj = budget?.userId && typeof budget.userId === 'object' ? budget.userId : null;

    return {
      ...plain,
      id: budget?._id ? budget._id.toString() : budget?.id,
      userId: userObj
        ? String(userObj._id ?? userObj.id ?? '').trim()
        : budget?.userId
          ? String(budget.userId).trim()
          : '',
      user: userObj,
      currentMonthTokens: Math.round(month.tokens),
      currentMonthCostUsd: month.costUsd,
      currentDayTokens: Math.round(day.tokens),
      currentDayCostUsd: day.costUsd,
    };
  }

  @query('ReactorUserBudgets')
  async ReactorUserBudgets(
    _: any,
    _args: any,
    context: Reactory.Server.IReactoryContext
  ) {
    if (!this.isAdmin(context)) {
      throw new Error('Only administrators can view user budgets');
    }

    const usageService = this.usageService(context);
    const analytics = this.analytics(context);
    const budgets = await usageService.listUserBudgets();
    if (!budgets || budgets.length === 0) return [];

    const { dayFrom, monthFrom, to } = this.currentWindows();

    // Consumption is measured per user. It is a real query per budget rather
    // than one round trip, which is acceptable for the handful of budgets an
    // admin screen lists and would not be for a per-turn path.
    return Promise.all(
      budgets.map(async (budget: any) => {
        const userId = budget?.userId?._id
          ? String(budget.userId._id)
          : budget?.userId
            ? String(budget.userId)
            : '';

        const [month, day] = userId
          ? await Promise.all([
              analytics.getConsumptionForUser(userId, { from: monthFrom, to }),
              analytics.getConsumptionForUser(userId, { from: dayFrom, to }),
            ])
          : [
              { tokens: 0, costUsd: 0, turns: 0 },
              { tokens: 0, costUsd: 0, turns: 0 },
            ];

        return this.toBudgetShape(budget, month, day);
      })
    );
  }

  @query('ReactorUserBudget')
  async ReactorUserBudget(
    _: any,
    args: { userId: string },
    context: Reactory.Server.IReactoryContext
  ) {
    const user = context.user;
    if (!user) throw new Error('Authentication required');

    if (!this.isAdmin(context) && user._id.toString() !== args.userId) {
      throw new Error('Access denied to user budget');
    }

    const budget = await this.usageService(context).getUserBudget(args.userId);
    if (!budget) return null;

    const { dayFrom, monthFrom, to } = this.currentWindows();
    const [month, day] = await Promise.all([
      this.analytics(context).getConsumptionForUser(args.userId, { from: monthFrom, to }),
      this.analytics(context).getConsumptionForUser(args.userId, { from: dayFrom, to }),
    ]);

    return this.toBudgetShape(budget, month, day);
  }

  @mutation('ReactorSetUserBudget')
  async ReactorSetUserBudget(
    _: any,
    args: { input: SetUserBudgetInput },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!this.isAdmin(context)) {
      throw new Error('Only administrators can set user budgets');
    }

    const budget = await this.usageService(context).setUserBudget(args.input);
    const { dayFrom, monthFrom, to } = this.currentWindows();
    const userId = budget?.userId?._id ? String(budget.userId._id) : args.input.userId;

    const [month, day] = await Promise.all([
      this.analytics(context).getConsumptionForUser(userId, { from: monthFrom, to }),
      this.analytics(context).getConsumptionForUser(userId, { from: dayFrom, to }),
    ]);

    return this.toBudgetShape(budget, month, day);
  }

  @mutation('ReactorDeleteUserBudget')
  async ReactorDeleteUserBudget(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!this.isAdmin(context)) {
      throw new Error('Only administrators can delete user budgets');
    }
    return this.usageService(context).deleteUserBudget(args.id);
  }

  /**
   * Resolve a breakdown's user names on demand.
   *
   * The SQL side has no access to `reactory_users`, so `userBreakdown` carries
   * ids only. Declaring this as a field resolver keeps the join out of the
   * aggregation while still letting the dashboard show a name.
   */
  @property('ReactorUserUsageBreakdown', 'firstName')
  async breakdownFirstName(row: any): Promise<string | null> {
    if (row?.firstName !== undefined) return row.firstName ?? null;
    const enriched = await this.enrichUsers([row]);
    return enriched[0]?.firstName ?? null;
  }
}

export default ReactorAIUsageResolver;
