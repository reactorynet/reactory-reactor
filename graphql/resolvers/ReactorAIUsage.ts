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
 * IMPORTANT — why this file has no `this.` in it.
 *
 * The graph registry harvests resolver classes by building an object from the
 * class prototype *without running the constructor* and then spreading the
 * decorator-built map into one shared root object:
 *
 *   const instance = Object.create(Resolver.prototype);
 *   rootResolver.Query = { ...rootResolver.Query, ...instance.resolver.Query };
 *
 * At execution time `this` is therefore the merged resolver map, not the
 * resolver instance, so any `this.helper()` throws "this.helper is not a
 * function" and the field resolves to null with an INTERNAL_SERVER_ERROR. Every
 * helper below is consequently a module-level function that receives `context`
 * explicitly. This was not theoretical: while these helpers were class methods,
 * `ReactorAIUsageSummary` failed with "this.scopeFilter is not a function" and
 * `ReactorUserBudgets` with "this.isAdmin is not a function", which is why the
 * dashboard showed no data and budgets could not be listed or saved.
 *
 * The GraphQL contract is preserved except where honesty requires a change:
 * `ReactorAIUsageRecord.costUsd` became nullable, because an unpriced model is
 * *unknown*, not free, and returning `0` for it was a silent money error.
 */

/** Roles that may see the whole tenant rather than only themselves. */
const ADMIN_ROLES = ['ADMIN', 'SUPERADMIN', 'DEVELOPER'];

/**
 * Whether the caller holds an administrative role.
 *
 * `hasRole` is the canonical check, but budgets are an enforcement path: if the
 * context ever lacks it we fall back to the user's own role list rather than
 * silently downgrading an admin (or, worse, letting the check throw and be
 * swallowed upstream).
 */
function isAdmin(context: Reactory.Server.IReactoryContext): boolean {
  if (!context) return false;
  if (typeof (context as any).hasRole === 'function') {
    return ADMIN_ROLES.some((role) => (context as any).hasRole(role) === true);
  }
  const roles: string[] = ((context.user as any)?.roles ?? []) as string[];
  return roles.some((role) => ADMIN_ROLES.includes(String(role).toUpperCase()));
}

function analytics(context: Reactory.Server.IReactoryContext): ReactorUsageAnalyticsService {
  return context.getService<ReactorUsageAnalyticsService>(
    'reactor.ReactorUsageAnalyticsService@1.0.0'
  );
}

function usageService(context: Reactory.Server.IReactoryContext): ReactorAIUsageService {
  return context.getService<ReactorAIUsageService>(
    'reactor.ReactorAIUsageService@1.0.0'
  );
}

/**
 * Apply row-level access control to a usage filter.
 *
 * A non-admin is pinned to their own `userId` regardless of what they asked for.
 * This is the one place that decision is made, so a new query cannot forget it —
 * the previous implementation repeated the check per resolver, which is exactly
 * how such a check gets missed.
 */
function scopeFilter(
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
  if (Array.isArray(scoped.userIds)) {
    const cleaned = scoped.userIds
      .map((id) => String(id ?? '').trim())
      .filter((id) => id.length > 0);
    if (cleaned.length === 0) delete scoped.userIds;
    else scoped.userIds = cleaned;
  }

  const user = context.user;
  if (user && !isAdmin(context)) {
    // A non-admin sees only themselves: an explicit single-user filter is
    // replaced, and a multi-user selection is dropped entirely.
    scoped.userId = user._id.toString();
    delete scoped.userIds;
  }

  return scoped;
}


/**
 * Resolve a user reference to a user id.
 *
 * Budgets are keyed by `ObjectId`, but an administrator typing into a picker (or
 * arriving from a link) may hold an email, a username, or the id itself. Passing
 * an email straight to `new ObjectId()` threw a BSONError that surfaced as an
 * opaque server error and made "create a budget" look broken. Unresolvable input
 * now returns null so callers can report something actionable.
 */
async function resolveUserId(value: string): Promise<string | null> {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^[a-f0-9]{24}$/i.test(raw) && mongoose.Types.ObjectId.isValid(raw)) return raw;

  try {
    const db = mongoose.connection?.db;
    if (!db) return null;
    const user = await db.collection('reactory_users').findOne(
      {
        $or: [{ email: raw }, { email: raw.toLowerCase() }, { username: raw }],
      },
      { projection: { _id: 1 } }
    );
    return user?._id ? String(user._id) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve any user references in a filter to user ids.
 *
 * The usage predicates compare against `m.user_id`, which holds an ObjectId
 * string, so an email typed into the dashboard filter matched no row and the
 * report came back empty — indistinguishable from a user who genuinely used
 * nothing. This translates what the caller supplied into the id the query needs.
 *
 * An entry that cannot be resolved is dropped rather than passed through: it
 * could never match a row, and carrying it forward would only make the SQL
 * predicate longer for the same result. For a single `userId` that dropped
 * reference would silently become "the whole tenant", so the caller is told
 * instead (see `ReactorAIUsageSummary`).
 */
async function resolveFilterUserRefs(filter: UsageAnalyticsFilter): Promise<UsageAnalyticsFilter> {
  const resolved: UsageAnalyticsFilter = { ...filter };

  if (Array.isArray(resolved.userIds) && resolved.userIds.length > 0) {
    const ids = await Promise.all(
      resolved.userIds.map((value) => resolveUserId(String(value ?? '')))
    );
    const cleaned = ids.filter((id): id is string => Boolean(id));
    if (cleaned.length > 0) resolved.userIds = Array.from(new Set(cleaned));
    else delete resolved.userIds;
  }

  if (resolved.userId) {
    const resolvedSingle = await resolveUserId(String(resolved.userId));
    if (resolvedSingle) {
      resolved.userId = resolvedSingle;
    } else {
      // Dropping this would widen the report to the whole tenant, which answers a
      // different question from the one that was asked — so fail loudly instead.
      throw new Error(
        `No user found for "${resolved.userId}". Provide a valid user id or email address.`
      );
    }
  }

  return resolved;
}

/**
 * Fill in user names for a breakdown.
 *
 * Enrichment is done here rather than in SQL because users live in Mongo and the
 * metrics live in Postgres. A single batched lookup keeps it to one query; a
 * failure leaves the ids intact rather than failing the report, since the metrics
 * are the point and a name is decoration.
 */
async function enrichUsers(
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
 * `to` is exclusive so a turn landing exactly at midnight belongs to one period
 * rather than both.
 */
function currentWindows(now = new Date()): {
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

const EMPTY_CONSUMPTION = { tokens: 0, costUsd: 0, turns: 0 };
/**
 * Project a stored budget plus measured consumption into the GraphQL shape.
 *
 * The stored `currentMonth*` / `currentDay*` counters are deliberately not
 * exposed: they are only ever advanced by the ledger write that never ran, so
 * they are structurally zero and showing them would misreport headroom.
 */
function toBudgetShape(
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

/** Measure a single user's month-to-date and day-to-date consumption. */
async function consumptionFor(
  context: Reactory.Server.IReactoryContext,
  userId: string
): Promise<{
  month: typeof EMPTY_CONSUMPTION;
  day: typeof EMPTY_CONSUMPTION;
}> {
  if (!userId) return { month: { ...EMPTY_CONSUMPTION }, day: { ...EMPTY_CONSUMPTION } };

  const { dayFrom, monthFrom, to } = currentWindows();
  const [month, day] = await Promise.all([
    analytics(context).getConsumptionForUser(userId, { from: monthFrom, to }),
    analytics(context).getConsumptionForUser(userId, { from: dayFrom, to }),
  ]);
  return { month, day };
}

// @ts-ignore - resolver() is a marker decorator
@resolver
class ReactorAIUsageResolver {
  resolver: any;

  @query('ReactorAIUsageSummary')
  async ReactorAIUsageSummary(
    _: any,
    args: { filter?: UsageSummaryFilter },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) throw new Error('Authentication required');
    const filter = await resolveFilterUserRefs(scopeFilter(args?.filter, context));

    // A multi-user selection is a report over several people, not one query per
    // person: the analytics service aggregates the selection in a single pass.
    // Every selected user is then guaranteed a row, including one with no turns in
    // the window — otherwise the report silently omits the person the admin was
    // looking for, which reads as "you asked for the wrong id" rather than "they
    // used nothing".
    const summary = await analytics(context).getUsageSummary(filter);

    if (filter.userIds && filter.userIds.length > 0) {
      const measured = summary.userBreakdown ?? [];
      const byId = new Map(measured.map((row: any) => [String(row.userId), row]));

      const merged = await enrichUsers(
        filter.userIds.map((userId) => byId.get(userId) ?? { userId })
      );

      summary.userBreakdown = merged.map((row: any) => ({
        userId: String(row.userId),
        firstName: row.firstName ?? null,
        lastName: row.lastName ?? null,
        email: row.email ?? null,
        totalTokens: Number(row.totalTokens ?? 0),
        costUsdCents: Number(row.costUsdCents ?? 0),
        costUsd: Number(row.costUsd ?? 0),
        requests: Number(row.requests ?? 0),
      }));
    } else if (summary.userBreakdown && summary.userBreakdown.length > 0) {
      // The SQL side cannot join `reactory_users`, so names are filled in here.
      summary.userBreakdown = (await enrichUsers(summary.userBreakdown)).map((row: any) => ({
        userId: String(row.userId),
        firstName: row.firstName ?? null,
        lastName: row.lastName ?? null,
        email: row.email ?? null,
        totalTokens: Number(row.totalTokens ?? 0),
        costUsdCents: Number(row.costUsdCents ?? 0),
        costUsd: Number(row.costUsd ?? 0),
        requests: Number(row.requests ?? 0),
      }));
    }

    return summary;
  }

  @query('ReactorMyAIUsage')
  async ReactorMyAIUsage(
    _: any,
    args: { filter?: UsageSummaryFilter },
    context: Reactory.Server.IReactoryContext
  ) {
    const user = context.user;
    if (!user) throw new Error('Authentication required');

    const filter = scopeFilter(args?.filter, context);
    // Unconditionally the caller's own usage, even for an admin. The id is already
    // known here, so there is nothing to resolve — and resolving the inbound
    // filter first would let a stale value in it fail the request.
    filter.userId = user._id.toString();
    delete filter.userIds;

    return analytics(context).getUsageSummary(filter);
  }

  @query('ReactorAIUsageList')
  async ReactorAIUsageList(
    _: any,
    args: { filter?: UsageSummaryFilter; page?: number; pageSize?: number },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) throw new Error('Authentication required');
    const filter = await resolveFilterUserRefs(scopeFilter(args?.filter, context));
    return analytics(context).getUsageList(filter, args?.page || 1, args?.pageSize || 20);
  }

  @query('ReactorUserUsageStatus')
  async ReactorUserUsageStatus(
    _: any,
    _args: any,
    context: Reactory.Server.IReactoryContext
  ) {
    const user = context.user;
    if (!user) throw new Error('Authentication required');

    const userId = user._id.toString();
    const [statusResult, budget] = await Promise.all([
      usageService(context).checkUserBudget(user._id),
      usageService(context).getUserBudget(userId),
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

    const { month, day } = await consumptionFor(context, userId);

    return {
      allowed: statusResult.allowed,
      status: statusResult.status,
      percentageUsed: statusResult.percentageUsed,
      reason: statusResult.reason,
      budget: toBudgetShape(budget, month, day),
    };
  }

  @query('ReactorUserBudgets')
  async ReactorUserBudgets(
    _: any,
    _args: any,
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) throw new Error('Authentication required');
    if (!isAdmin(context)) {
      throw new Error('Only administrators can view user budgets');
    }

    const budgets = await usageService(context).listUserBudgets();
    if (!budgets || budgets.length === 0) return [];

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
        const { month, day } = await consumptionFor(context, userId);
        return toBudgetShape(budget, month, day);
      })
    );
  }

  /**
   * Every user, with their budget if they have one.
   *
   * `ReactorUserBudgets` can only answer "which budgets exist", which is not the
   * question an administrator asks — they need to see who is unbudgeted too, and
   * the absence of a row was previously indistinguishable from a page that had
   * simply failed to load. This reports one row per user with `hasBudget` set.
   */
  @query('ReactorUserBudgetOverview')
  async ReactorUserBudgetOverview(
    _: any,
    args: { filter?: { search?: string; onlyUnbudgeted?: boolean; onlyBudgeted?: boolean; limit?: number } },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) throw new Error('Authentication required');
    if (!isAdmin(context)) {
      throw new Error('Only administrators can view user budgets');
    }

    const filter = args?.filter ?? {};
    const db = mongoose.connection?.db;
    if (!db) throw new Error('User directory unavailable');

    const search = String(filter.search ?? '').trim();
    const limit = Math.min(Math.max(Number(filter.limit) || 500, 1), 2000);

    const userQuery: Record<string, any> = {};
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      userQuery.$or = [
        { firstName: rx },
        { lastName: rx },
        { email: rx },
        { username: rx },
      ];
    }

    const users = await db
      .collection('reactory_users')
      .find(userQuery, {
        projection: { firstName: 1, lastName: 1, email: 1, username: 1, roles: 1 },
      })
      .sort({ firstName: 1, lastName: 1, email: 1 })
      .limit(limit)
      .toArray();

    if (users.length === 0) return [];

    const budgets = await usageService(context).listUserBudgets();
    const budgetByUserId = new Map<string, any>();
    (budgets ?? []).forEach((budget: any) => {
      const id = budget?.userId?._id
        ? String(budget.userId._id)
        : budget?.userId
          ? String(budget.userId)
          : '';
      if (id) budgetByUserId.set(id, budget);
    });

    const rows = users.map((user: any) => {
      const userId = String(user._id);
      const budget = budgetByUserId.get(userId);
      const populated = budget
        ? {
            ...(budget.toObject ? budget.toObject() : budget),
            user,
          }
        : null;

      return {
        userId,
        user: {
          id: userId,
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
          email: user.email ?? null,
        },
        hasBudget: Boolean(budget),
        budget: populated,
        monthlyTokenLimit: budget?.monthlyTokenLimit ?? null,
        dailyTokenLimit: budget?.dailyTokenLimit ?? null,
        monthlyCostLimitUsd: budget?.monthlyCostLimitUsd ?? null,
        dailyCostLimitUsd: budget?.dailyCostLimitUsd ?? null,
        alertThresholdPercent: budget?.alertThresholdPercent ?? null,
        hardStop: budget?.hardStop ?? false,
        notes: budget?.notes ?? null,
      };
    });

    const filtered = rows.filter((row) => {
      if (filter.onlyUnbudgeted && row.hasBudget) return false;
      if (filter.onlyBudgeted && !row.hasBudget) return false;
      return true;
    });

    // Consumption is only measured where a budget exists: an unbudgeted user has
    // no quota for the number to count against, and querying it per user across
    // the whole directory would turn an admin page load into hundreds of queries.
    return Promise.all(
      filtered.map(async (row) => {
        if (!row.hasBudget || !row.budget) {
          return {
            ...row,
            budget: null,
            currentMonthTokens: 0,
            currentMonthCostUsd: 0,
            currentDayTokens: 0,
            currentDayCostUsd: 0,
            status: 'NO_BUDGET',
          };
        }

        const { month, day } = await consumptionFor(context, row.userId);
        const shaped = toBudgetShape(row.budget, month, day);
        return { ...row, ...shaped, budget: shaped, hasBudget: true };
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

    const resolved = (await resolveUserId(args.userId)) ?? args.userId;
    if (!isAdmin(context) && user._id.toString() !== resolved) {
      throw new Error('Access denied to user budget');
    }

    const budget = await usageService(context).getUserBudget(resolved);
    if (!budget) return null;

    const { month, day } = await consumptionFor(context, resolved);
    return toBudgetShape(budget, month, day);
  }

  @mutation('ReactorSetUserBudget')
  async ReactorSetUserBudget(
    _: any,
    args: { input: SetUserBudgetInput },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) throw new Error('Authentication required');
    if (!isAdmin(context)) {
      throw new Error('Only administrators can set user budgets');
    }

    const resolved = await resolveUserId(args.input?.userId);
    if (!resolved) {
      throw new Error(
        `No user found for "${args.input?.userId}". Provide a valid user id or email address.`
      );
    }

    const budget = await usageService(context).setUserBudget({
      ...args.input,
      userId: resolved,
    });

    const { month, day } = await consumptionFor(context, resolved);
    return toBudgetShape(budget, month, day);
  }

  @mutation('ReactorDeleteUserBudget')
  async ReactorDeleteUserBudget(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) throw new Error('Authentication required');
    if (!isAdmin(context)) {
      throw new Error('Only administrators can delete user budgets');
    }

    // The overview lists every user, so this is reachable on a row with no budget.
    // That is a no-op (`false`), not an error — see the schema note.
    if (!args?.id) return false;

    return usageService(context).deleteUserBudget(args.id);
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
    const enriched = await enrichUsers([row]);
    return enriched[0]?.firstName ?? null;
  }
}

export default ReactorAIUsageResolver;
