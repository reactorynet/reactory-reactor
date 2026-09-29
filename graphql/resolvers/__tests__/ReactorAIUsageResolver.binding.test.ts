import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';
import ReactorAIUsageResolver from '../ReactorAIUsage';

/**
 * The graph registry harvests resolver classes by creating an object from the
 * class prototype without ever running the constructor, then spreading the
 * decorator-built map into one shared root object:
 *
 *   const instance = Object.create(Resolver.prototype);
 *   rootResolver.Query = { ...rootResolver.Query, ...instance.resolver.Query };
 *
 * Two consequences these tests pin down:
 *
 *  1. At execution time `this` is the merged resolver map, not the resolver
 *     instance, so any `this.helper()` call throws "this.helper is not a
 *     function" and the field resolves to null with an INTERNAL_SERVER_ERROR.
 *     That is not hypothetical: this resolver shipped with `this.scopeFilter`,
 *     `this.isAdmin`, `this.analytics` and friends, and as a result every usage
 *     query returned null and no budget could be listed, created or deleted.
 *  2. The constructor never runs, so instance state is never available either.
 *
 * Every function below is therefore invoked fully detached from the class — the
 * same way the server invokes it — which is the only way these tests can fail if
 * a `this.` reference creeps back in.
 */
describe('ReactorAIUsageResolver prototype binding', () => {
  /** Mirrors MergeGraphResolvers exactly. */
  const harvest = () => {
    const instance: any = Object.create((ReactorAIUsageResolver as any).prototype);
    const map = instance.resolver;
    return {
      Query: { ...map.Query },
      Mutation: { ...map.Mutation },
      ReactorUserUsageBreakdown: { ...(map.ReactorUserUsageBreakdown ?? {}) },
    };
  };

  const emptySummary = () => ({
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCostUsdCents: 0,
    totalCostUsd: 0,
    totalRequests: 0,
    avgDurationMs: null,
    errorCount: 0,
    errorRate: 0,
    errorBreakdown: [],
    timeSeries: [],
    modelBreakdown: [],
    providerBreakdown: [],
    userBreakdown: [] as any[],
    coverage: { turns: 0 },
  });

  let analytics: any;
  let usage: any;
  let context: any;
  const userId = new ObjectId();

  const makeContext = (admin: boolean) => {
    analytics = {
      getUsageSummary: jest.fn(async () => emptySummary()),
      getUsageList: jest.fn(async () => ({
        records: [],
        total: 0,
        page: 1,
        pageSize: 20,
        hasNext: false,
      })),
      getConsumptionForUser: jest.fn(async () => ({ tokens: 1000, costUsd: 2.5, turns: 3 })),
    };

    usage = {
      checkUserBudget: jest.fn(async () => ({
        allowed: true,
        status: 'ACTIVE',
        percentageUsed: 0,
      })),
      getUserBudget: jest.fn(async () => null),
      listUserBudgets: jest.fn(async () => []),
      setUserBudget: jest.fn(async (input: any) => ({
        _id: 'budget-1',
        userId: input.userId,
        monthlyTokenLimit: input.monthlyTokenLimit,
        toObject: () => ({ _id: 'budget-1', userId: input.userId }),
      })),
      deleteUserBudget: jest.fn(async () => true),
    };

    context = {
      user: { _id: admin ? new ObjectId() : userId, roles: admin ? ['ADMIN'] : ['USER'] },
      hasRole: jest.fn((role: string) =>
        admin ? ['ADMIN', 'SUPERADMIN', 'DEVELOPER'].includes(role) : false
      ),
      getService: jest.fn((id: string) =>
        String(id).includes('Analytics') ? analytics : usage
      ),
      log: jest.fn(),
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    makeContext(true);
  });

  it('exposes every declared query and mutation on the harvested map', () => {
    const map = harvest();
    expect(Object.keys(map.Query)).toEqual(
      expect.arrayContaining([
        'ReactorAIUsageSummary',
        'ReactorAIUsageList',
        'ReactorMyAIUsage',
        'ReactorUserUsageStatus',
        'ReactorUserBudgets',
        'ReactorUserBudgetOverview',
        'ReactorUserBudget',
      ])
    );
    expect(Object.keys(map.Mutation)).toEqual(
      expect.arrayContaining(['ReactorSetUserBudget', 'ReactorDeleteUserBudget'])
    );
  });

  describe('queries invoked detached from the class', () => {
    it('resolves a usage summary without touching `this`', async () => {
      const map = harvest();
      const summary = await map.Query.ReactorAIUsageSummary(null, { filter: {} }, context, {});
      expect(summary).toBeTruthy();
      expect(analytics.getUsageSummary).toHaveBeenCalled();
    });

    it('drops the `all` select sentinels instead of filtering on them', async () => {
      // `provider: 'all'` is a UI sentinel. Passing it through as a literal
      // predicate matched no row and silently emptied the whole report.
      const map = harvest();
      await map.Query.ReactorAIUsageSummary(
        null,
        { filter: { provider: 'all', use_case: 'all', model: 'gpt-4o' } },
        context,
        {}
      );
      const passed = analytics.getUsageSummary.mock.calls[0][0];
      expect(passed.provider).toBeUndefined();
      expect(passed.useCase).toBeUndefined();
      expect(passed.model).toBe('gpt-4o');
    });

    it('pins a non-admin caller to their own user id', async () => {
      makeContext(false);
      const map = harvest();
      await map.Query.ReactorAIUsageSummary(
        null,
        { filter: { userId: new ObjectId().toString() } },
        context,
        {}
      );
      const passed = analytics.getUsageSummary.mock.calls[0][0];
      expect(passed.userId).toBe(userId.toString());
    });

    it('drops a multi-user selection for a non-admin caller', async () => {
      makeContext(false);
      const map = harvest();
      await map.Query.ReactorAIUsageSummary(
        null,
        { filter: { userIds: [new ObjectId().toString(), new ObjectId().toString()] } },
        context,
        {}
      );
      const passed = analytics.getUsageSummary.mock.calls[0][0];
      expect(passed.userIds).toBeUndefined();
      expect(passed.userId).toBe(userId.toString());
    });

    it('gives every selected user a row, including one with no usage', async () => {
      const withUsage = new ObjectId().toString();
      const withoutUsage = new ObjectId().toString();
      const map = harvest();
      analytics.getUsageSummary.mockResolvedValue({
        ...emptySummary(),
        userBreakdown: [
          {
            userId: withUsage,
            totalTokens: 42,
            costUsdCents: 7,
            costUsd: 0.07,
            requests: 1,
          },
        ],
      });

      const summary = await map.Query.ReactorAIUsageSummary(
        null,
        { filter: { userIds: [withUsage, withoutUsage] } },
        context,
        {}
      );

      expect(summary.userBreakdown).toHaveLength(2);
      const zero = summary.userBreakdown.find((row: any) => row.userId === withoutUsage);
      expect(zero).toBeDefined();
      expect(zero.totalTokens).toBe(0);
      const measured = summary.userBreakdown.find((row: any) => row.userId === withUsage);
      expect(measured.totalTokens).toBe(42);
    });

    it('lists budgets for an admin', async () => {
      const map = harvest();
      await expect(map.Query.ReactorUserBudgets(null, {}, context, {})).resolves.toEqual([]);
      expect(usage.listUserBudgets).toHaveBeenCalled();
    });

    it('refuses the budget list to a non-admin', async () => {
      makeContext(false);
      const map = harvest();
      await expect(map.Query.ReactorUserBudgets(null, {}, context, {})).rejects.toThrow(
        /administrators/i
      );
    });

    it('resolves the current user quota status without a budget', async () => {
      const map = harvest();
      const status = await map.Query.ReactorUserUsageStatus(null, {}, context, {});
      expect(status.allowed).toBe(true);
      expect(status.budget).toBeNull();
    });

    it('reports measured month and day consumption against a stored budget', async () => {
      const map = harvest();
      const localUser = { _id: userId };
      const localContext = { ...context, user: localUser };
      usage.getUserBudget.mockResolvedValue({
        _id: 'budget-9',
        userId,
        monthlyTokenLimit: 5000,
        toObject: () => ({ _id: 'budget-9', userId }),
      });

      const status = await map.Query.ReactorUserUsageStatus(null, {}, localContext, {});
      expect(status.budget.currentMonthTokens).toBe(1000);
      expect(status.budget.currentMonthCostUsd).toBe(2.5);
      expect(analytics.getConsumptionForUser).toHaveBeenCalledTimes(2);
    });

    it('resolves a single budget when addressed by user id', async () => {
      const map = harvest();
      usage.getUserBudget.mockResolvedValue({
        _id: 'budget-3',
        userId,
        toObject: () => ({ _id: 'budget-3', userId }),
      });

      const budget = await map.Query.ReactorUserBudget(null, { userId: userId.toString() }, context, {});
      expect(budget).toBeTruthy();
      expect(usage.getUserBudget).toHaveBeenCalledWith(userId.toString());
    });

    it('denies one user reading another user\'s budget', async () => {
      makeContext(false);
      const map = harvest();
      await expect(
        map.Query.ReactorUserBudget(null, { userId: new ObjectId().toString() }, context, {})
      ).rejects.toThrow(/Access denied/i);
    });

    it('refuses the per-user overview to a non-admin', async () => {
      makeContext(false);
      const map = harvest();
      await expect(map.Query.ReactorUserBudgetOverview(null, {}, context, {})).rejects.toThrow(
        /administrators/i
      );
    });

    it('resolves a breakdown first name without touching `this`', async () => {
      const map = harvest();
      // No Mongo connection in this process, so enrichment degrades to null rather
      // than throwing — the metrics are the point and a name is decoration.
      await expect(
        map.ReactorUserUsageBreakdown.firstName({ userId: userId.toString() }, {}, context, {})
      ).resolves.toBeNull();
    });
  });

  describe('mutations invoked detached from the class', () => {
    it('creates a budget for a valid user id', async () => {
      const map = harvest();
      const result = await map.Mutation.ReactorSetUserBudget(
        null,
        { input: { userId: userId.toString(), monthlyTokenLimit: 5000 } },
        context,
        {}
      );
      expect(result).toBeTruthy();
      expect(usage.setUserBudget).toHaveBeenCalledWith(
        expect.objectContaining({ userId: userId.toString(), monthlyTokenLimit: 5000 })
      );
    });

    it('reports an actionable error for an unresolvable user instead of a BSONError', async () => {
      // A non-ObjectId used to reach `new ObjectId()` and surface as an opaque
      // "Cast to ObjectId failed" — which is why "create a budget" looked broken.
      const map = harvest();
      await expect(
        map.Mutation.ReactorSetUserBudget(
          null,
          { input: { userId: 'nobody@example.com', monthlyTokenLimit: 5000 } },
          context,
          {}
        )
      ).rejects.toThrow(/No user found/i);
      expect(usage.setUserBudget).not.toHaveBeenCalled();
    });

    it('refuses budget writes to a non-admin', async () => {
      makeContext(false);
      const map = harvest();
      await expect(
        map.Mutation.ReactorSetUserBudget(
          null,
          { input: { userId: userId.toString(), monthlyTokenLimit: 5000 } },
          context,
          {}
        )
      ).rejects.toThrow(/administrators/i);
      await expect(map.Mutation.ReactorDeleteUserBudget(null, { id: 'x' }, context, {})).rejects.toThrow(
        /administrators/i
      );
    });

    it('deletes a budget by id', async () => {
      const map = harvest();
      await expect(
        map.Mutation.ReactorDeleteUserBudget(null, { id: 'budget-1' }, context, {})
      ).resolves.toBe(true);
      expect(usage.deleteUserBudget).toHaveBeenCalledWith('budget-1');
    });
  });
});
