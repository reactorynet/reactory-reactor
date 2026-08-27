import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import ReactorAIUsageService from '../ReactorAIUsageService';
import ReactorAIUsageModel from '../../../models/ReactorAIUsage';
import ReactorUserBudgetModel from '../../../models/ReactorUserBudget';
import { ObjectId } from 'mongodb';

describe('ReactorAIUsageService', () => {
  let service: ReactorAIUsageService;
  let mockContext: any;

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

    it('blocks turn when budget is exceeded and hardStop is true', async () => {
      const mockBudget = {
        userId: mockContext.user._id,
        monthlyTokenLimit: 100000,
        currentMonthTokens: 105000,
        hardStop: true,
        status: 'EXCEEDED',
      };
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue(mockBudget as any);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe('EXCEEDED');
      expect(result.percentageUsed).toBe(100);
    });

    it('allows turn with WARNING status when hardStop is false', async () => {
      const mockBudget = {
        userId: mockContext.user._id,
        monthlyTokenLimit: 100000,
        currentMonthTokens: 85000,
        hardStop: false,
        status: 'WARNING',
      };
      jest.spyOn(ReactorUserBudgetModel, 'findOne').mockResolvedValue(mockBudget as any);

      const result = await service.checkUserBudget(mockContext.user._id);
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('WARNING');
      expect(result.percentageUsed).toBe(85);
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
