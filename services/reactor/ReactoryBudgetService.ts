import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import { ObjectId } from 'mongodb';
import ReactoryUserBudgetModel from '../../models/ReactoryUserBudget';
import ReactoryUsageEventModel from '../../models/ReactoryUsageEvent';
import ReactoryUsageAlertModel from '../../models/ReactoryUsageAlert';
import {
  BudgetCheckResult,
  BudgetPeriod,
  ReactoryUserBudgetDocument,
  ReactoryUserBudgetPeriodConfig,
} from '../../types/usage.types';
import { BudgetExceededError } from './errors/BudgetExceededError';

export interface PeriodBounds {
  start: Date;
  end: Date;
}

/**
 * Get the user's local Y/M/D as a string YYYY-MM-DD in the given IANA timezone.
 */
function localDateString(d: Date, timezone: string): string {
  // en-CA locale yields ISO-style YYYY-MM-DD via Intl
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

/**
 * Compute the timezone offset in minutes for a given UTC instant, in a given IANA zone.
 * Positive = ahead of UTC. Used to convert local-clock boundaries to UTC instants.
 */
function timezoneOffsetMinutes(utcDate: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(utcDate);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const y = get('year');
  const m = get('month');
  const d = get('day');
  // Intl can return 24 for hour at midnight in some implementations; normalize.
  const hRaw = get('hour');
  const h = hRaw === 24 ? 0 : hRaw;
  const mn = get('minute');
  const s = get('second');
  const asUtc = Date.UTC(y, m - 1, d, h, mn, s);
  return (asUtc - utcDate.getTime()) / 60000;
}

/**
 * Convert a "wall-clock" date in a given timezone to the equivalent UTC instant.
 */
function utcFromLocal(year: number, month: number, day: number, timezone: string): Date {
  const naiveUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offset = timezoneOffsetMinutes(naiveUtc, timezone);
  // If TZ is ahead of UTC by 120m, midnight local = (UTC midnight) - 120m
  return new Date(naiveUtc.getTime() - offset * 60000);
}

/**
 * Returns the [start, end) period bounds for a given period at `now`.
 * Day:   midnight TZ to midnight TZ +1d
 * Week:  midnight TZ on weekStart to +7d
 * Month: midnight TZ on first of month to first of next month
 */
export function getPeriodBounds(
  now: Date,
  period: BudgetPeriod,
  timezone: string,
  weekStartsOn: 'mon' | 'sun' = 'mon',
): PeriodBounds {
  const ymd = localDateString(now, timezone);
  const [y, m, d] = ymd.split('-').map(Number);

  if (period === 'day') {
    return {
      start: utcFromLocal(y, m, d, timezone),
      end: utcFromLocal(y, m, d + 1, timezone),
    };
  }

  if (period === 'month') {
    return {
      start: utcFromLocal(y, m, 1, timezone),
      end: utcFromLocal(y, m + 1, 1, timezone),
    };
  }

  // Week: figure out the day of the week of (y,m,d) in the given timezone
  // Use Intl with weekday option
  const weekdayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  const wd = weekdayFmt.format(now); // Mon, Tue, ...
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dow = weekdayMap[wd] ?? 1;
  const startDow = weekStartsOn === 'mon' ? 1 : 0;
  // Days back to the start of the week
  let back = dow - startDow;
  if (back < 0) back += 7;

  return {
    start: utcFromLocal(y, m, d - back, timezone),
    end: utcFromLocal(y, m, d - back + 7, timezone),
  };
}

@service({
  id: 'reactor.ReactoryBudgetService@1.0.0',
  name: 'Reactory Budget Service',
  nameSpace: 'reactor',
  version: '1.0.0',
  description: 'Per-user usage budgets with pre-flight gating and alert publishing',
  serviceType: 'data',
  lifeCycle: 'singleton',
})
class ReactoryBudgetService implements Reactory.Service.IReactoryService {
  context: Reactory.Server.IReactoryContext;

  constructor(props: Reactory.Service.IReactoryServiceProps, context: Reactory.Server.IReactoryContext) {
    this.context = context;
  }

  description?: string = 'Per-user usage budgets with pre-flight gating and alert publishing';
  tags?: string[] = ['ai', 'usage', 'budget'];
  nameSpace: string = 'reactor';
  name: string = 'ReactoryBudgetService';
  version: string = '1.0.0';

  toString?(includeVersion?: boolean): string {
    return `ReactoryBudgetService${includeVersion ? '@1.0.0' : ''}`;
  }

  /**
   * Returns the user's budget configuration, or null when no document exists
   * (i.e. user has not opted into budgeting — pre-flight always passes).
   */
  async getEffectiveBudget(userId: ObjectId | string): Promise<ReactoryUserBudgetDocument | null> {
    const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
    return await ReactoryUserBudgetModel.findOne({ userId: id }).lean<ReactoryUserBudgetDocument>().exec();
  }

  /**
   * Evaluate whether a user is within their budget. Returns 'no-budget' when no doc exists.
   * `triggeringContext` is optional metadata used for alert publishing.
   */
  async checkBudget(
    userId: ObjectId | string,
    triggeringContext: { conversationId?: ObjectId | string; eventId?: ObjectId | string } = {},
    now: Date = new Date(),
  ): Promise<BudgetCheckResult> {
    const budget = await this.getEffectiveBudget(userId);
    if (!budget || !budget.active) {
      return { status: 'no-budget', periods: [] };
    }

    const periods: BudgetPeriod[] = ['day', 'week', 'month'];
    const periodResults: BudgetCheckResult['periods'] = [];

    let anyHardBreach = false;
    let anySoftBreach = false;

    for (const period of periods) {
      const cfg: ReactoryUserBudgetPeriodConfig | null =
        (budget.periods as any)[period] || null;
      if (!cfg) continue;

      const bounds = getPeriodBounds(now, period, budget.timezone, budget.weekStartsOn);
      const used = await this.sumPeriodSpend(
        budget.userId,
        bounds,
        budget.scope || {},
      );

      const pctUsed = cfg.limitUsdCents > 0 ? (used / cfg.limitUsdCents) * 100 : 0;
      const breachedHard = cfg.hardBlock && used >= cfg.limitUsdCents;
      const breachedSoft = !breachedHard && pctUsed >= cfg.softThresholdPct;

      if (breachedHard) anyHardBreach = true;
      if (breachedSoft) anySoftBreach = true;

      periodResults.push({
        period,
        usedUsdCents: used,
        limitUsdCents: cfg.limitUsdCents,
        pctUsed,
        softThresholdPct: cfg.softThresholdPct,
        breachedHard,
        breachedSoft,
      });
    }

    const status: BudgetCheckResult['status'] = anyHardBreach
      ? 'hard-block'
      : anySoftBreach
        ? 'soft-warn'
        : 'ok';

    // Publish alerts on first crossing per period (idempotent via unique index).
    if (anyHardBreach || anySoftBreach) {
      for (const p of periodResults) {
        if (p.breachedHard || p.breachedSoft) {
          const bounds = getPeriodBounds(now, p.period, budget.timezone, budget.weekStartsOn);
          await this.publishAlert({
            userId: budget.userId,
            alertType: p.breachedHard ? 'hard-block' : 'soft-warn',
            period: p.period,
            periodStart: bounds.start,
            periodEnd: bounds.end,
            usedUsdCents: p.usedUsdCents,
            limitUsdCents: p.limitUsdCents,
            pctUsed: p.pctUsed,
            conversationId: triggeringContext.conversationId,
            triggeringEventId: triggeringContext.eventId,
          });
        }
      }
    }

    return { status, periods: periodResults };
  }

  /**
   * Throw BudgetExceededError when the user is over a hard limit.
   * Returns the BudgetCheckResult so callers can read soft-warn state without re-querying.
   */
  async assertWithinBudget(
    userId: ObjectId | string,
    triggeringContext: { conversationId?: ObjectId | string; eventId?: ObjectId | string } = {},
  ): Promise<BudgetCheckResult> {
    const result = await this.checkBudget(userId, triggeringContext);
    if (result.status === 'hard-block') {
      throw new BudgetExceededError(userId.toString(), result);
    }
    return result;
  }

  /**
   * Insert a `reactor_usage_alerts` row. Idempotent per (userId, period, periodStart, alertType)
   * via the unique index on the model — the consumer-pattern future feature reads unconsumed alerts.
   */
  async publishAlert(input: {
    userId: ObjectId;
    alertType: 'soft-warn' | 'hard-block';
    period: BudgetPeriod;
    periodStart: Date;
    periodEnd: Date;
    usedUsdCents: number;
    limitUsdCents: number;
    pctUsed: number;
    conversationId?: ObjectId | string;
    triggeringEventId?: ObjectId | string;
  }): Promise<void> {
    try {
      await ReactoryUsageAlertModel.create({
        userId: input.userId,
        alertType: input.alertType,
        period: input.period,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        usedUsdCents: input.usedUsdCents,
        limitUsdCents: input.limitUsdCents,
        pctUsed: input.pctUsed,
        conversationId: input.conversationId
          ? (typeof input.conversationId === 'string' ? new ObjectId(input.conversationId) : input.conversationId)
          : null,
        triggeringEventId: input.triggeringEventId
          ? (typeof input.triggeringEventId === 'string' ? new ObjectId(input.triggeringEventId) : input.triggeringEventId)
          : null,
        triggeredAt: new Date(),
        consumed: false,
      });
    } catch (err: any) {
      if (err && err.code === 11000) {
        // Duplicate per period crossing — silently swallow
        return;
      }
      throw err;
    }
  }

  /**
   * Sum total cost over a [start, end) window for a user. Optionally scoped.
   */
  private async sumPeriodSpend(
    userId: ObjectId,
    bounds: PeriodBounds,
    scope: { providerIds?: string[]; modelIds?: string[] },
  ): Promise<number> {
    const match: Record<string, unknown> = {
      userId,
      occurredAt: { $gte: bounds.start, $lt: bounds.end },
    };
    if (scope.providerIds && scope.providerIds.length > 0) {
      match.providerId = { $in: scope.providerIds };
    }
    if (scope.modelIds && scope.modelIds.length > 0) {
      match.modelId = { $in: scope.modelIds };
    }
    const [row] = await ReactoryUsageEventModel.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$costs.totalUsdCents' } } },
    ]);
    return row?.total || 0;
  }
}

export default ReactoryBudgetService;
