import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import ReactorAIUsageService from '../ReactorAIUsageService';
import ReactorAIUsageModel from '../../../models/ReactorAIUsage';
import ReactorUserBudgetModel from '../../../models/ReactorUserBudget';
import { ObjectId } from 'mongodb';

const ANALYTICS_SERVICE_ID = 'reactor.ReactorUsageAnalyticsService@1.0.0';

describe('ReactorAIUsageService', () => {
  let service: ReactorAIUsageService;
  let mockContext: any;

  /**
   * Stub the analytics service the budget gate now measures from.
   *
   * `checkUserBudget` deliberately no longer reads the stored
   * `currentMonthTokens` / `currentMonthCostUsd` counters. Those were only ever
   * advanced by `updateUserBudgetCounters`, which ran as a side effect of
   * `recordUsage` — a call that never persisted anything, because the ledger it
   * wrote to was empty. Every budget therefore read zero consumed, so `hardStop`
   * could never fire. Consumption is measured from the message log instead.
   */
  const withMeasuredConsumption = (tokens: number, costUsd: number = 0) => {
    mockContext.getService = jest.fn((id: string) =>
      id === ANALYTICS_SERVICE_ID
        ? {
            getConsumptionForUser: jest.fn(async () => ({ tokens, costUsd, turns: 1 })),
          }
        : undefined
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockContext = {
      user: { _id: new ObjectId(), organization: { _id: new ObjectId() } },
      log: jest.fn(),
      getService: jest.fn(),
    };
    service = new ReactorAIUsageService({} as any, mockContext);
  });

  describe('calculateCost', () => {
    it('calculates cost based on model input/output rates from providers.yaml', () => {
      // gpt-4o: inputCostPerTokenUsdCents = 0.0005, outputCostPerTokenUsdCents = 0.0015
      const cost = service.calculateCost('openai', 'gpt-4o', 1000, 500);
      expect(cost.costCurrency).toBe('USD');
      // 1000 * 0.0005 + 500 * 0.0015 = 0.5 + 0.75 = 1.25 cents
      expect(cost.costUsdCents).toBeCloseTo(1.25, 2);
    });

    it('handles zero or missing models gracefully', () => {
      const cost = service.calculateCost('unknown', 'non-existent-model', 100, 100);
      expect(cost.costUsdCents).toBe(0);
      expect(cost.costCurrency).toBe('USD');
    });
  });

  describe('checkUserBudget', () => {
    it('allows turns when user has no budget configured', async () => {
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue(null as any);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('ACTIVE');
    });

    it('allows turns when the budget is explicitly disabled', async () => {
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue({
        userId: mockContext.user._id,
        monthlyTokenLimit: 100,
        hardStop: true,
        status: 'DISABLED',
      } as any);

      // Even with consumption far past the limit: a disabled budget enforces nothing.
      withMeasuredConsumption(999_999);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(true);
    });

    it('blocks turn when measured usage exceeds the limit and hardStop is true', async () => {
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue({
        userId: mockContext.user._id,
        monthlyTokenLimit: 100000,
        hardStop: true,
      } as any);
      withMeasuredConsumption(105000);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe('EXCEEDED');
      expect(result.percentageUsed).toBe(100);
      // The refusal must say which limit was hit, so the user can act on it.
      expect(result.reason).toMatch(/monthly token/i);
    });

    it('reports WARNING without blocking when hardStop is false', async () => {
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue({
        userId: mockContext.user._id,
        monthlyTokenLimit: 100000,
        alertThresholdPercent: 80,
        hardStop: false,
      } as any);
      withMeasuredConsumption(85000);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('WARNING');
      expect(result.percentageUsed).toBe(85);
    });

    it('escalates to EXCEEDED, not blocked, when over limit without a hard stop', async () => {
      // Over the limit is a state; hardStop is what makes it an enforcement. An
      // admin who asked only to be told must still be able to work.
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue({
        userId: mockContext.user._id,
        monthlyTokenLimit: 100000,
        hardStop: false,
      } as any);
      withMeasuredConsumption(150000);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('EXCEEDED');
      expect(result.percentageUsed).toBe(100);
    });

    it('enforces a daily limit independently of the monthly one', async () => {
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue({
        userId: mockContext.user._id,
        dailyTokenLimit: 1000,
        hardStop: true,
      } as any);
      // Monthly headroom is irrelevant; the daily ceiling is what trips.
      withMeasuredConsumption(1500);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/daily token/i);
    });

    it('treats a zero or absent limit as unlimited rather than as a limit of zero', async () => {
      // A budget row with `monthlyTokenLimit: 0` means "no limit", not "block
      // everything". Reading it as a limit would deny every user on a default row.
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue({
        userId: mockContext.user._id,
        monthlyTokenLimit: 0,
        dailyTokenLimit: null,
        monthlyCostLimitUsd: 0,
        hardStop: true,
      } as any);
      withMeasuredConsumption(9_999_999);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('ACTIVE');
    });

    it('fails OPEN when consumption cannot be measured', async () => {
      // The deliberate trade: a reporting outage must not become a full AI outage.
      // The alternative — blocking everyone because telemetry hiccuped — is worse,
      // but the degradation is reported rather than hidden.
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue({
        userId: mockContext.user._id,
        monthlyTokenLimit: 1,
        hardStop: true,
      } as any);
      mockContext.getService = jest.fn(() => undefined);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(true);
      expect(result.reason).toMatch(/could not be measured/i);
    });

    it('fails OPEN when the analytics service throws', async () => {
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue({
        userId: mockContext.user._id,
        monthlyTokenLimit: 1,
        hardStop: true,
      } as any);
      mockContext.getService = jest.fn(() => ({
        getConsumptionForUser: jest.fn(async () => {
          throw new Error('postgres unavailable');
        }),
      }));

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(true);
    });

    it('allows the turn when the budget lookup itself fails', async () => {
      jest
        .spyOn(ReactorUserBudgetModel, 'findOne')
        .mockRejectedValue(new Error('mongo unavailable') as never);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('ACTIVE');
    });
  });

  describe('setUserBudget', () => {
    it('creates or updates user budget with correct values', async () => {
      const mockSavedBudget = {
        userId: mockContext.user._id,
        monthlyTokenLimit: 500000,
        save: jest.fn<any>().mockResolvedValue(true),
        populate: jest.fn<any>().mockResolvedValue({
          userId: mockContext.user._id,
          monthlyTokenLimit: 500000,
        }),
      };
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue(mockSavedBudget as any);

      const budget = await service.setUserBudget({
        userId: mockContext.user._id.toString(),
        monthlyTokenLimit: 500000,
        alertThresholdPercent: 80,
      });

      expect(budget).toBeDefined();
    });
  });
});
