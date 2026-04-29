import { ObjectId } from 'mongodb';
import {
  query,
  mutation,
  resolver,
} from '@reactory/server-core/models/graphql/decorators/resolver';
import ReactoryUserBudgetModel from '../../models/ReactoryUserBudget';
import ReactoryBudgetService, {
  getPeriodBounds,
} from '../../services/reactor/ReactoryBudgetService';
import ReactoryUsageService from '../../services/reactor/ReactoryUsageService';
import { BudgetPeriod } from '../../types/usage.types';

function requireAdmin(context: Reactory.Server.IReactoryContext, op: string) {
  const user: any = context.user;
  const roles: string[] = user?.memberships?.flatMap((m: any) => m?.roles || []) || user?.roles || [];
  if (!roles.includes('ADMIN') && !roles.includes('DEVELOPER') && !roles.includes('SUPERADMIN')) {
    throw new Error(`Forbidden: ${op} requires ADMIN role`);
  }
}

function shapeBudgetForGraphQL(doc: any) {
  if (!doc) return null;
  return {
    id: doc._id,
    userId: doc.userId,
    active: doc.active,
    timezone: doc.timezone,
    weekStartsOn: doc.weekStartsOn,
    day: doc.periods?.day || null,
    week: doc.periods?.week || null,
    month: doc.periods?.month || null,
    scope: doc.scope || null,
    pricingOverrides: doc.pricingOverrides || [],
    created: doc.created,
    updated: doc.updated,
  };
}

// @ts-ignore - resolver() is a marker decorator; same pattern used elsewhere in this module
@resolver
class ReactorBudgetResolver {
  resolver: any;

  @query('ReactorUserBudget')
  async ReactorUserBudget(
    _: any,
    args: { userId: string | ObjectId },
    context: Reactory.Server.IReactoryContext,
  ) {
    requireAdmin(context, 'ReactorUserBudget');
    const userId = typeof args.userId === 'string' ? new ObjectId(args.userId) : args.userId;
    const doc = await ReactoryUserBudgetModel.findOne({ userId }).lean().exec();
    return shapeBudgetForGraphQL(doc);
  }

  @query('ReactorBudgetCheck')
  async ReactorBudgetCheck(
    _: any,
    args: { userId: string | ObjectId },
    context: Reactory.Server.IReactoryContext,
  ) {
    requireAdmin(context, 'ReactorBudgetCheck');
    const budgetService = context.getService<ReactoryBudgetService>(
      'reactor.ReactoryBudgetService@1.0.0',
    );
    return await budgetService.checkBudget(args.userId);
  }

  @query('ReactorUserUsage')
  async ReactorUserUsage(
    _: any,
    args: { userId: string | ObjectId; period: BudgetPeriod },
    context: Reactory.Server.IReactoryContext,
  ) {
    requireAdmin(context, 'ReactorUserUsage');
    const usageService = context.getService<ReactoryUsageService>(
      'reactor.ReactoryUsageService@1.0.0',
    );
    // Resolve the user's timezone from their budget (if any) so periods align
    const userId = typeof args.userId === 'string' ? new ObjectId(args.userId) : args.userId;
    const budget = await ReactoryUserBudgetModel.findOne({ userId }).lean<any>().exec();
    const tz = budget?.timezone || 'UTC';
    const wso = budget?.weekStartsOn || 'mon';
    const bounds = getPeriodBounds(new Date(), args.period, tz, wso);
    const result = await usageService.getUsageForPeriod(userId, bounds);
    return { ...result, start: bounds.start, end: bounds.end };
  }

  @mutation('ReactorSetUserBudget')
  async ReactorSetUserBudget(
    _: any,
    args: { input: any },
    context: Reactory.Server.IReactoryContext,
  ) {
    requireAdmin(context, 'ReactorSetUserBudget');
    const { input } = args;
    const userId = typeof input.userId === 'string' ? new ObjectId(input.userId) : input.userId;
    const update = {
      active: input.active,
      timezone: input.timezone || 'UTC',
      weekStartsOn: input.weekStartsOn || 'mon',
      periods: {
        day: input.day || null,
        week: input.week || null,
        month: input.month || null,
      },
      scope: input.scope || undefined,
      pricingOverrides: input.pricingOverrides || undefined,
      updated: new Date(),
    };
    const doc = await ReactoryUserBudgetModel.findOneAndUpdate(
      { userId },
      { $set: update, $setOnInsert: { userId, created: new Date() } },
      { upsert: true, new: true },
    ).lean().exec();
    return shapeBudgetForGraphQL(doc);
  }

  @mutation('ReactorClearUserBudget')
  async ReactorClearUserBudget(
    _: any,
    args: { userId: string | ObjectId },
    context: Reactory.Server.IReactoryContext,
  ) {
    requireAdmin(context, 'ReactorClearUserBudget');
    const userId = typeof args.userId === 'string' ? new ObjectId(args.userId) : args.userId;
    const result = await ReactoryUserBudgetModel.deleteOne({ userId }).exec();
    return result.deletedCount > 0;
  }
}

export default ReactorBudgetResolver;
