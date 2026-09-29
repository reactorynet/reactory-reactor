const schema: Reactory.Schema.ISchema = {
  type: "object",
  title: "AI Usage & Telemetry Dashboard",
  description: "Monitor and analyze AI token consumption, provider activity, and spending metrics",
  properties: {
    startDate: {
      type: "string",
      title: "Start Date",
      format: "date",
    },
    endDate: {
      type: "string",
      title: "End Date",
      format: "date",
    },
    provider: {
      type: "string",
      title: "Provider",
      enum: ["all", "google", "anthropic", "openai", "llamacpp", "ollama", "mistral", "openrouter"],
      default: "all",
    },
    model: {
      type: "string",
      title: "Model",
      description: "Filter by specific model name",
    },
    personaId: {
      type: "string",
      title: "Persona",
      description: "Filter by agent persona identifier",
    },
    userId: {
      type: "string",
      title: "User",
      description:
        "Scope the report to a single user. Accepts a user id or an email address. Bound by the /admin/ai/usage/:userId and /profile/usage routes. A caller without an admin role is always scoped to themselves, whatever this holds.",
    },
    userIds: {
      type: "array",
      title: "Users (selection)",
      description:
        "Scope the report to a selection of users. Add a user id or email and press Enter. The totals cover the whole selection in a single window rather than the sum of separate per-user windows, and every selected user appears in the breakdown below even when they used nothing.",
      items: { type: "string" },
      default: [],
    },
    use_case: {
      type: "string",
      title: "Use Case",
      enum: ["all", "standalone", "workflow", "support", "task"],
      default: "all",
    },
    totalTokens: {
      type: "number",
      title: "Total Tokens",
      readOnly: true,
    },
    totalPromptTokens: {
      type: "number",
      title: "Input (Prompt)",
      readOnly: true,
    },
    totalCompletionTokens: {
      type: "number",
      title: "Output (Completion)",
      readOnly: true,
    },
    totalCostUsd: {
      type: "number",
      title: "Est. Cost ($ USD)",
      readOnly: true,
    },
    totalRequests: {
      type: "number",
      title: "AI Turns",
      readOnly: true,
    },
    avgDurationMs: {
      type: "number",
      title: "Avg Latency (ms)",
      readOnly: true,
    },
    timeSeries: {
      type: "array",
      title: "Daily Token Consumption Trend",
      description: "Prompt, Completion, and Total tokens over time",
      readOnly: true,
      items: {
        type: "object",
        properties: {
          date: { type: "string", title: "Date" },
          promptTokens: { type: "number", title: "Prompt Tokens" },
          completionTokens: { type: "number", title: "Completion Tokens" },
          totalTokens: { type: "number", title: "Total Tokens" },
          costUsd: { type: "number", title: "Cost (USD)" },
          requests: { type: "number", title: "Requests" },
        },
      },
    },
    modelBreakdown: {
      type: "array",
      title: "Token Usage by Model",
      description: "Usage, cost and turn breakdown per model",
      readOnly: true,
      items: {
        type: "object",
        properties: {
          model: { type: "string", title: "Model" },
          provider: { type: "string", title: "Provider" },
          totalTokens: { type: "number", title: "Tokens" },
          costUsd: { type: "number", title: "Cost ($)" },
          requests: { type: "number", title: "Turns" },
        },
      },
    },
    providerBreakdown: {
      type: "array",
      title: "Usage by Provider",
      description: "Aggregate usage and spend per AI provider",
      readOnly: true,
      items: {
        type: "object",
        properties: {
          provider: { type: "string", title: "Provider" },
          totalTokens: { type: "number", title: "Tokens" },
          costUsd: { type: "number", title: "Cost ($)" },
          requests: { type: "number", title: "Turns" },
        },
      },
    },
    userBreakdown: {
      type: "array",
      title: "Token Usage by User",
      description:
        "Consumption per user for the selected window. This is what makes a per-user or per-selection view possible; previously the summary carried the rows but nothing rendered them.",
      readOnly: true,
      items: {
        type: "object",
        properties: {
          userId: { type: "string", title: "User ID" },
          firstName: { type: "string", title: "First Name" },
          lastName: { type: "string", title: "Last Name" },
          email: { type: "string", title: "Email" },
          totalTokens: { type: "number", title: "Tokens" },
          costUsd: { type: "number", title: "Cost ($)" },
          requests: { type: "number", title: "Turns" },
        },
      },
    },
    coverage: {
      type: "object",
      title: "Data Coverage",
      description:
        "How much of the requested window these figures actually cover. A total over 80% of turns is a different claim from a total over all of them.",
      readOnly: true,
      properties: {
        turns: { type: "number", title: "Turns" },
        attributedTurns: { type: "number", title: "Attributed" },
        pricedTurns: { type: "number", title: "Priced" },
        unpricedTurns: { type: "number", title: "Unpriced (excluded from cost)" },
        estimatedTurns: { type: "number", title: "Estimated-token Turns" },
        zeroUsageTurns: { type: "number", title: "Zero-usage Turns" },
        reroutedTurns: { type: "number", title: "Re-routed Turns" },
      },
    },
    records: {
      type: "array",
      title: "Recent AI Activity Ledger",
      description: "Chronological event logs of recent AI model interactions",
      readOnly: true,
      items: {
        type: "object",
        properties: {
          createdAt: { type: "string", title: "Timestamp" },
          personaId: { type: "string", title: "Persona" },
          provider: { type: "string", title: "Provider" },
          model: { type: "string", title: "Model" },
          promptTokens: { type: "number", title: "Input Tokens" },
          completionTokens: { type: "number", title: "Output Tokens" },
          totalTokens: { type: "number", title: "Total Tokens" },
          costUsd: { type: "number", title: "Cost ($)" },
          durationMs: { type: "number", title: "Latency (ms)" },
          status: { type: "string", title: "Status" },
        },
      },
    },
  },
};

export default schema;
