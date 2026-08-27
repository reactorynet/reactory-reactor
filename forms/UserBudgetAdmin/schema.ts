const schema: Reactory.Schema.ISchema = {
  type: "object",
  title: "AI Usage Budget Administration",
  description: "Configure and manage AI token and cost budget limits for users",
  properties: {
    userId: {
      type: "string",
      title: "User",
      description: "Select user account to apply budget to",
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
    budgets: {
      type: "array",
      title: "Configured User Budgets",
      readOnly: true,
      items: {
        type: "object",
        properties: {
          userId: { type: "string", title: "User ID" },
          user: {
            type: "object",
            title: "User",
            properties: {
              firstName: { type: "string", title: "First Name" },
              lastName: { type: "string", title: "Last Name" },
              email: { type: "string", title: "Email" },
            },
          },
          monthlyTokenLimit: { type: "number", title: "Monthly Token Limit" },
          dailyTokenLimit: { type: "number", title: "Daily Token Limit" },
          monthlyCostLimitUsd: { type: "number", title: "Monthly Limit ($)" },
          dailyCostLimitUsd: { type: "number", title: "Daily Limit ($)" },
          currentMonthTokens: { type: "number", title: "Month Tokens Used" },
          currentMonthCostUsd: { type: "number", title: "Month Spend ($)" },
          alertThresholdPercent: { type: "number", title: "Threshold %" },
          hardStop: { type: "boolean", title: "Hard Stop" },
          status: { type: "string", title: "Status" },
          updatedAt: { type: "string", title: "Last Updated" },
        },
      },
    },
  },
};

export default schema;
