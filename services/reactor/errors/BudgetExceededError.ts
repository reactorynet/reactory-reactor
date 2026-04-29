import ApiError from '../../../../../exceptions';
import { BudgetCheckResult } from '../../../types/usage.types';

/**
 * Thrown by the pre-flight budget gate when at least one period is over its hard limit.
 * Surfaces structured detail to the GraphQL layer so the client can render specifics
 * (which period, used vs. limit) rather than a generic error.
 */
export class BudgetExceededError extends ApiError {
  public code: string;
  public budget: BudgetCheckResult;

  constructor(userId: string, budget: BudgetCheckResult) {
    const breached = budget.periods.find(p => p.breachedHard);
    const message = breached
      ? `Budget exceeded for user ${userId}: ${breached.period} usage ${breached.usedUsdCents.toFixed(2)}¢ of ${breached.limitUsdCents.toFixed(2)}¢ limit`
      : `Budget exceeded for user ${userId}`;
    super(message, { userId, budget });
    this.code = 'REACTOR-BUDGET-EXCEEDED';
    this.budget = budget;
  }
}
