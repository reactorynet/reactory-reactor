const schema: Reactory.Schema.ISchema = {
  type: "object",
  title: "AI Usage Budget Administration",
  description:
    "Configure AI token and cost budget limits per user, and see which users are unbudgeted",
  properties: {
    userId: {
      type: "string",
      title: "User",
      description:
        "The account this budget applies to. Accepts a user id or an email address. Saving again for the same user updates their existing budget.",
    },
    monthlyTokenLimit: {
      type: "number",
      title: "Monthly Token Limit",
      description: "Max tokens per calendar month (0 or empty = unlimited)",
    },
    dailyTokenLimit: {
      type: "number",
      title: "Daily Token Limit",
      description: "Max tokens per day (0 or empty = unlimited)",
    },
    monthlyCostLimitUsd: {
      type: "number",
      title: "Monthly Cost Limit (USD)",
      description: "Max spend per month in USD (0 or empty = unlimited)",
    },
    dailyCostLimitUsd: {
      type: "number",
      title: "Daily Cost Limit (USD)",
      description: "Max spend per day in USD (0 or empty = unlimited)",
    },
    alertThresholdPercent: {
      type: "number",
      title: "Warning Threshold (%)",
      description: "Percentage of budget consumed before triggering warning status",
      default: 80,
    },
    hardStop: {
      type: "boolean",
      title: "Hard Stop Enforcement",
      description: "If enabled, blocks chat turns once budget is exceeded",
      default: false,
    },
    notes: {
      type: "string",
      title: "Administrative Notes",
    },
    search: {
      type: "string",
      title: "Find User",
      description: "Filters the table below by first name, last name, email or username.",
    },
    onlyUnbudgeted: {
      type: "boolean",
      title: "Only users without a budget",
      description: "Narrow the table to users who have no budget configured.",
      default: false,
    },
    onlyBudgeted: {
      type: "boolean",
      title: "Only users with a budget",
      default: false,
    },
    /**
     * One row per user, budgeted or not.
     *
     * `hasBudget` is a first-class column rather than being inferred from the
     * presence of limits: an unbudgeted user and a user budgeted at zero are
     * different states, and the previous table — built from a list of budgets —
     * could not show the first group at all.
     */
    userBudgets: {
      type: "array",
      title: "All Users & Their AI Budgets",
      description:
        "Every user with their budget (if any) and measured month-to-date consumption.",
      readOnly: true,
      items: {
        type: "object",
        properties: {
          userId: { type: "string", title: "User ID" },
          hasBudget: { type: "boolean", title: "Has Budget" },
          user: {
            type: "object",
            title: "User",
            properties: {
              firstName: { type: "string", title: "First Name" },
              lastName: { type: "string", title: "Last Name" },
              email: { type: "string", title: "Email" },
            },
          },
          monthlyTokenLimit: { type: "number", title: "Month Token Limit" },
          dailyTokenLimit: { type: "number", title: "Day Token Limit" },
          monthlyCostLimitUsd: { type: "number", title: "Month Limit ($)" },
          dailyCostLimitUsd: { type: "number", title: "Day Limit ($)" },
          currentMonthTokens: { type: "number", title: "Month Tokens Used" },
          currentMonthCostUsd: { type: "number", title: "Month Spend ($)" },
          currentDayTokens: { type: "number", title: "Day Tokens Used" },
          currentDayCostUsd: { type: "number", title: "Day Spend ($)" },
          alertThresholdPercent: { type: "number", title: "Threshold %" },
          hardStop: { type: "boolean", title: "Hard Stop" },
          status: { type: "string", title: "Status" },
          notes: { type: "string", title: "Notes" },
          budget: {
            type: "object",
            title: "Budget",
            properties: {
              id: { type: "string", title: "Budget ID" },
              updatedAt: { type: "string", title: "Updated" },
            },
          },
        },
      },
    },
  },
};

export default schema;
