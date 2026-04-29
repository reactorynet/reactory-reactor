import { ObjectId } from 'mongodb';
import { getPeriodBounds } from '../ReactoryBudgetService';
import { BudgetExceededError } from '../errors/BudgetExceededError';

jest.mock('../../../models/ReactoryUserBudget', () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock('../../../models/ReactoryUsageEvent', () => ({
  __esModule: true,
  default: { aggregate: jest.fn() },
}));
jest.mock('../../../models/ReactoryUsageAlert', () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));

describe('getPeriodBounds', () => {
  const ts = (s: string) => new Date(s);

  it('returns UTC midnight bounds for a day in UTC', () => {
    const { start, end } = getPeriodBounds(ts('2026-04-29T15:30:00Z'), 'day', 'UTC');
    expect(start.toISOString()).toBe('2026-04-29T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-30T00:00:00.000Z');
  });

  it('returns local-midnight bounds for a day in Africa/Johannesburg (UTC+2)', () => {
    // 2026-04-29T15:30:00Z is 17:30 in JHB. JHB midnight = 22:00 UTC of prior day.
    const { start, end } = getPeriodBounds(ts('2026-04-29T15:30:00Z'), 'day', 'Africa/Johannesburg');
    expect(start.toISOString()).toBe('2026-04-28T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-29T22:00:00.000Z');
  });

  it('returns DST-aware bounds for a day in America/New_York during EDT', () => {
    // July 15 in NYC is EDT (UTC-4). Local midnight = 04:00 UTC.
    const { start, end } = getPeriodBounds(ts('2026-07-15T18:00:00Z'), 'day', 'America/New_York');
    expect(start.toISOString()).toBe('2026-07-15T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-07-16T04:00:00.000Z');
  });

  it('returns Monday-start week bounds in UTC', () => {
    // 2026-04-29 is a Wednesday. Monday of that week is 2026-04-27.
    const { start, end } = getPeriodBounds(ts('2026-04-29T15:30:00Z'), 'week', 'UTC', 'mon');
    expect(start.toISOString()).toBe('2026-04-27T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-04T00:00:00.000Z');
  });

  it('returns Sunday-start week bounds in UTC', () => {
    const { start, end } = getPeriodBounds(ts('2026-04-29T15:30:00Z'), 'week', 'UTC', 'sun');
    expect(start.toISOString()).toBe('2026-04-26T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-03T00:00:00.000Z');
  });

  it('returns month bounds in UTC', () => {
    const { start, end } = getPeriodBounds(ts('2026-04-29T15:30:00Z'), 'month', 'UTC');
    expect(start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('handles December → January month boundary', () => {
    const { start, end } = getPeriodBounds(ts('2026-12-15T08:00:00Z'), 'month', 'UTC');
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('ReactoryBudgetService', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ReactoryBudgetService = require('../ReactoryBudgetService').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BudgetModel = require('../../../models/ReactoryUserBudget').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const EventModel = require('../../../models/ReactoryUsageEvent').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AlertModel = require('../../../models/ReactoryUsageAlert').default;

  let service: any;
  const userId = new ObjectId();

  function makeBudgetDoc(overrides: any = {}) {
    return {
      _id: new ObjectId(),
      userId,
      active: true,
      timezone: 'UTC',
      weekStartsOn: 'mon',
      periods: {
        day: { limitUsdCents: 1000, softThresholdPct: 80, hardBlock: true },
        week: null,
        month: null,
      },
      ...overrides,
    };
  }

  function mockFindOne(doc: any | null) {
    (BudgetModel.findOne as jest.Mock).mockReturnValue({
      lean: () => ({ exec: jest.fn().mockResolvedValue(doc) }),
    });
  }

  function mockSpend(total: number) {
    (EventModel.aggregate as jest.Mock).mockResolvedValue(total > 0 ? [{ total }] : []);
  }

  beforeEach(() => {
    jest.resetAllMocks();
    // resetAllMocks clears implementations — restore the default no-op for AlertModel.create
    (AlertModel.create as jest.Mock).mockResolvedValue({});
    service = new ReactoryBudgetService(
      { dependencies: {}, $services: new Map() } as any,
      { user: { _id: 'admin' }, debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
    );
  });

  it('returns no-budget when no document exists', async () => {
    mockFindOne(null);
    const r = await service.checkBudget(userId);
    expect(r.status).toBe('no-budget');
    expect(EventModel.aggregate).not.toHaveBeenCalled();
  });

  it('returns no-budget when budget is inactive', async () => {
    mockFindOne(makeBudgetDoc({ active: false }));
    const r = await service.checkBudget(userId);
    expect(r.status).toBe('no-budget');
  });

  it('returns ok when under all limits', async () => {
    mockFindOne(makeBudgetDoc());
    mockSpend(500); // 50% of 1000
    const r = await service.checkBudget(userId);
    expect(r.status).toBe('ok');
    expect(r.periods).toHaveLength(1);
    expect(r.periods[0].pctUsed).toBe(50);
    expect(AlertModel.create).not.toHaveBeenCalled();
  });

  it('returns soft-warn when over soft threshold but under hard limit', async () => {
    mockFindOne(makeBudgetDoc());
    mockSpend(900); // 90% of 1000
    const r = await service.checkBudget(userId);
    expect(r.status).toBe('soft-warn');
    expect(AlertModel.create).toHaveBeenCalledTimes(1);
    expect((AlertModel.create as jest.Mock).mock.calls[0][0].alertType).toBe('soft-warn');
  });

  it('returns hard-block when at or over hard limit', async () => {
    mockFindOne(makeBudgetDoc());
    mockSpend(1100);
    const r = await service.checkBudget(userId);
    expect(r.status).toBe('hard-block');
    expect(AlertModel.create).toHaveBeenCalledTimes(1);
    expect((AlertModel.create as jest.Mock).mock.calls[0][0].alertType).toBe('hard-block');
  });

  it('does not block when hardBlock: false on a period', async () => {
    mockFindOne(
      makeBudgetDoc({
        periods: {
          day: { limitUsdCents: 1000, softThresholdPct: 80, hardBlock: false },
          week: null,
          month: null,
        },
      }),
    );
    mockSpend(1100);
    const r = await service.checkBudget(userId);
    // Over limit but hardBlock is false → soft-warn (since we're over the soft threshold)
    expect(r.status).toBe('soft-warn');
  });

  it('idempotently swallows duplicate alert insert errors', async () => {
    mockFindOne(makeBudgetDoc());
    mockSpend(1100);
    (AlertModel.create as jest.Mock).mockRejectedValue({ code: 11000 });
    // Should not throw
    const r = await service.checkBudget(userId);
    expect(r.status).toBe('hard-block');
  });

  it('rethrows non-duplicate alert errors', async () => {
    mockFindOne(makeBudgetDoc());
    mockSpend(1100);
    (AlertModel.create as jest.Mock).mockRejectedValue(new Error('connection lost'));
    await expect(service.checkBudget(userId)).rejects.toThrow('connection lost');
  });

  it('assertWithinBudget passes through ok status', async () => {
    mockFindOne(makeBudgetDoc());
    mockSpend(500);
    const r = await service.assertWithinBudget(userId);
    expect(r.status).toBe('ok');
  });

  it('assertWithinBudget throws BudgetExceededError on hard-block', async () => {
    mockFindOne(makeBudgetDoc());
    mockSpend(1100);
    await expect(service.assertWithinBudget(userId)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('assertWithinBudget passes through soft-warn without throwing', async () => {
    mockFindOne(makeBudgetDoc());
    mockSpend(900);
    const r = await service.assertWithinBudget(userId);
    expect(r.status).toBe('soft-warn');
  });

  it('passes scope to the spend aggregation', async () => {
    mockFindOne(makeBudgetDoc({ scope: { providerIds: ['openai'] } }));
    mockSpend(500);
    await service.checkBudget(userId);
    const matchStage = (EventModel.aggregate as jest.Mock).mock.calls[0][0][0].$match;
    expect(matchStage.providerId).toEqual({ $in: ['openai'] });
  });
});
