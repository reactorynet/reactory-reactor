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
