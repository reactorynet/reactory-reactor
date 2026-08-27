import Reactory from "@reactorynet/reactory-core";
import {
  query,
  mutation,
  resolver,
  property,
} from "@reactory/server-core/models/graphql/decorators/resolver";
import ReactorAIUsageService, {
  UsageSummaryFilter,
  SetUserBudgetInput,
} from "../../services/reactor/ReactorAIUsageService";

// @ts-ignore - resolver() is a marker decorator
@resolver
class ReactorAIUsageResolver {
  resolver: any;

  @query("ReactorAIUsageSummary")
  async ReactorAIUsageSummary(
    _: any,
    args: { filter?: UsageSummaryFilter },
    context: Reactory.Server.IReactoryContext
  ) {
    const user = context.user;
    if (!user) throw new Error("Authentication required");

    const isAdmin = context.hasRole("ADMIN") || context.hasRole("SUPERADMIN") || context.hasRole("DEVELOPER");
    const filter = { ...(args.filter || {}) };

    // Non-admin users are restricted to their own usage
    if (!isAdmin) {
      filter.userId = user._id.toString();
    }

    const usageService = context.getService<ReactorAIUsageService>(
      "reactor.ReactorAIUsageService@1.0.0"
    );
    return usageService.getUsageSummary(filter);
  }

  @query("ReactorAIUsageList")
  async ReactorAIUsageList(
    _: any,
    args: { filter?: UsageSummaryFilter; page?: number; pageSize?: number },
    context: Reactory.Server.IReactoryContext
  ) {
    const user = context.user;
    if (!user) throw new Error("Authentication required");

    const isAdmin = context.hasRole("ADMIN") || context.hasRole("SUPERADMIN") || context.hasRole("DEVELOPER");
    const filter = { ...(args.filter || {}) };

    // Non-admin users are restricted to their own usage
    if (!isAdmin) {
      filter.userId = user._id.toString();
    }

    const usageService = context.getService<ReactorAIUsageService>(
      "reactor.ReactorAIUsageService@1.0.0"
    );
    const result = await usageService.getUsageList(filter, args.page || 1, args.pageSize || 20);
    return {
      ...result,
      records: (result.records || []).map((r: any) => {
        const obj = r.toObject ? r.toObject() : { ...r };
        return {
          ...obj,
          id: r._id ? r._id.toString() : r.id,
          costUsd: (r.costUsdCents || 0) / 100,
          createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
          userId: r.userId && (r.userId._id || typeof r.userId === 'object') ? (r.userId._id ? r.userId._id.toString() : r.userId.toString()) : r.userId,
          user: r.userId && typeof r.userId === 'object' ? r.userId : null,
        };
      }),
    };
  }

  @property("ReactorAIUsageRecord", "costUsd")
  costUsd(record: any): number {
    if (record.costUsd !== undefined) return record.costUsd;
    return (record.costUsdCents || 0) / 100;
  }

  @property("ReactorAIUsageRecord", "id")
  id(record: any): string {
    return record._id ? record._id.toString() : record.id;
  }

  @property("ReactorUserBudget", "userId")
  budgetUserId(budget: any): string {
    if (budget.userId && budget.userId._id) return budget.userId._id.toString();
    if (budget.userId) return budget.userId.toString();
    return "";
  }

  @property("ReactorUserBudget", "user")
  budgetUser(budget: any): any {
    if (budget.userId && typeof budget.userId === 'object') return budget.userId;
    return null;
  }

  @property("ReactorUserBudget", "id")
  budgetId(budget: any): string {
    return budget._id ? budget._id.toString() : budget.id;
  }

  @query("ReactorMyAIUsage")
  async ReactorMyAIUsage(
    _: any,
    args: { filter?: UsageSummaryFilter },
    context: Reactory.Server.IReactoryContext
  ) {
    const user = context.user;
    if (!user) throw new Error("Authentication required");

    const filter = {
      ...(args.filter || {}),
      userId: user._id.toString(),
    };

    const usageService = context.getService<ReactorAIUsageService>(
      "reactor.ReactorAIUsageService@1.0.0"
    );
    return usageService.getUsageSummary(filter);
  }

  @query("ReactorUserUsageStatus")
  async ReactorUserUsageStatus(
    _: any,
    _args: any,
    context: Reactory.Server.IReactoryContext
  ) {
    const user = context.user;
    if (!user) throw new Error("Authentication required");

    const usageService = context.getService<ReactorAIUsageService>(
      "reactor.ReactorAIUsageService@1.0.0"
    );

    const [statusResult, budget] = await Promise.all([
      usageService.checkUserBudget(user._id),
      usageService.getUserBudget(user._id.toString()),
    ]);

    return {
      allowed: statusResult.allowed,
      status: statusResult.status,
      percentageUsed: statusResult.percentageUsed,
      reason: statusResult.reason,
      budget,
    };
  }

  @query("ReactorUserBudgets")
  async ReactorUserBudgets(
    _: any,
    _args: any,
    context: Reactory.Server.IReactoryContext
  ) {
    const isAdmin = context.hasRole("ADMIN") || context.hasRole("SUPERADMIN") || context.hasRole("DEVELOPER");
    if (!isAdmin) {
      throw new Error("Only administrators can view user budgets");
    }

    const usageService = context.getService<ReactorAIUsageService>(
      "reactor.ReactorAIUsageService@1.0.0"
    );
    const budgets = await usageService.listUserBudgets();
    return (budgets || []).map((b: any) => {
      const obj = b.toObject ? b.toObject() : { ...b };
      const userObj = b.userId && typeof b.userId === 'object' ? b.userId : null;
      return {
        ...obj,
        id: b._id ? b._id.toString() : b.id,
        userId: userObj ? (userObj._id ? userObj._id.toString() : userObj.id) : (b.userId ? b.userId.toString() : ""),
        user: userObj,
      };
    });
  }

  @query("ReactorUserBudget")
  async ReactorUserBudget(
    _: any,
    args: { userId: string },
    context: Reactory.Server.IReactoryContext
  ) {
    const user = context.user;
    if (!user) throw new Error("Authentication required");

    const isAdmin = context.hasRole("ADMIN") || context.hasRole("SUPERADMIN") || context.hasRole("DEVELOPER");
    if (!isAdmin && user._id.toString() !== args.userId) {
      throw new Error("Access denied to user budget");
    }

    const usageService = context.getService<ReactorAIUsageService>(
      "reactor.ReactorAIUsageService@1.0.0"
    );
    const b = await usageService.getUserBudget(args.userId);
    if (!b) return null;
    const userObj = b.userId && typeof b.userId === 'object' ? b.userId : null;
    return {
      ...(b.toObject ? b.toObject() : b),
      id: b._id ? b._id.toString() : b.id,
      userId: userObj ? (userObj._id ? userObj._id.toString() : userObj.id) : (b.userId ? b.userId.toString() : ""),
      user: userObj,
    };
  }

  @mutation("ReactorSetUserBudget")
  async ReactorSetUserBudget(
    _: any,
    args: { input: SetUserBudgetInput },
    context: Reactory.Server.IReactoryContext
  ) {
    const isAdmin = context.hasRole("ADMIN") || context.hasRole("SUPERADMIN") || context.hasRole("DEVELOPER");
    if (!isAdmin) {
      throw new Error("Only administrators can set user budgets");
    }

    const usageService = context.getService<ReactorAIUsageService>(
      "reactor.ReactorAIUsageService@1.0.0"
    );
    const b = await usageService.setUserBudget(args.input);
    const userObj = b.userId && typeof b.userId === 'object' ? b.userId : null;
    return {
      ...(b.toObject ? b.toObject() : b),
      id: b._id ? b._id.toString() : b.id,
      userId: userObj ? (userObj._id ? userObj._id.toString() : userObj.id) : (b.userId ? b.userId.toString() : ""),
      user: userObj,
    };
  }

  @mutation("ReactorDeleteUserBudget")
  async ReactorDeleteUserBudget(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ) {
    const isAdmin = context.hasRole("ADMIN") || context.hasRole("SUPERADMIN") || context.hasRole("DEVELOPER");
    if (!isAdmin) {
      throw new Error("Only administrators can delete user budgets");
    }

    const usageService = context.getService<ReactorAIUsageService>(
      "reactor.ReactorAIUsageService@1.0.0"
    );
    return usageService.deleteUserBudget(args.id);
  }
}

export default ReactorAIUsageResolver;
