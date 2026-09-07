import schema from "./schema";
import uiSchema from "./uiSchema";
import graphql from "./graphql";

const UsageDashboardForm: Reactory.Forms.IReactoryForm = {
  id: "reactor.UsageDashboardForm@1.0.0",
  uiFramework: "material",
  uiSupport: ["material"],
  title: "AI Usage & Telemetry Dashboard",
  description: "Monitor and analyze AI token consumption, provider activity, and spending metrics",
  icon: "analytics",
  tags: ["reactor", "ai", "usage", "telemetry", "tokens", "dashboard"],
  nameSpace: "reactor",
  name: "UsageDashboardForm",
  version: "1.0.0",
  registerAsComponent: true,
  schema,
  uiSchema,
  graphql,
  defaultFormValue: {
    startDate: "2026-06-20",
    endDate: "2026-08-27",
    provider: "all",
    model: "",
    personaId: "",
    use_case: "all",
    totalTokens: 1934056,
    totalPromptTokens: 1381564,
    totalCompletionTokens: 552492,
    totalCostUsd: 8.1710,
    totalRequests: 7625,
    avgDurationMs: 1200,
    timeSeries: [
      { date: "2026-06-20", promptTokens: 75000, completionTokens: 25000, totalTokens: 100000, costUsd: 0.42, requests: 350 },
      { date: "2026-06-29", promptTokens: 88000, completionTokens: 32000, totalTokens: 120000, costUsd: 0.51, requests: 420 },
      { date: "2026-07-02", promptTokens: 110000, completionTokens: 40000, totalTokens: 150000, costUsd: 0.65, requests: 580 },
      { date: "2026-07-05", promptTokens: 125000, completionTokens: 45000, totalTokens: 170000, costUsd: 0.72, requests: 640 },
      { date: "2026-07-10", promptTokens: 145000, completionTokens: 55000, totalTokens: 200000, costUsd: 0.86, requests: 790 },
      { date: "2026-07-14", promptTokens: 180000, completionTokens: 70000, totalTokens: 250000, costUsd: 1.05, requests: 980 },
      { date: "2026-07-20", promptTokens: 200000, completionTokens: 80000, totalTokens: 280000, costUsd: 1.18, requests: 1100 },
      { date: "2026-07-23", promptTokens: 230000, completionTokens: 90000, totalTokens: 320000, costUsd: 1.34, requests: 1280 },
      { date: "2026-07-26", promptTokens: 250000, completionTokens: 100000, totalTokens: 350000, costUsd: 1.44, requests: 1485 },
    ],
    modelBreakdown: [
      { model: "gemini-3.5-flash", provider: "google", totalTokens: 634511, costUsd: 3.0818, requests: 2781 },
      { model: "gemini-3.6-flash", provider: "google", totalTokens: 352026, costUsd: 1.7098, requests: 1690 },
      { model: "gemini-3.7-flash", provider: "google", totalTokens: 290755, costUsd: 1.4120, requests: 1579 },
      { model: "Ornith-1.0-9B", provider: "llamacpp", totalTokens: 139531, costUsd: 0.0000, requests: 403 },
      { model: "gemini-2.5-pro", provider: "google", totalTokens: 124503, costUsd: 0.4668, requests: 161 },
      { model: "claude-opus-4-8", provider: "anthropic", totalTokens: 84585, costUsd: 0.9067, requests: 121 },
      { model: "gemini-3.1-pro-preview", provider: "google", totalTokens: 73332, costUsd: 0.3561, requests: 452 },
    ],
    providerBreakdown: [
      { provider: "google", totalTokens: 1498551, costUsd: 7.0280, requests: 6716 },
      { provider: "llamacpp", totalTokens: 169278, costUsd: 0.0000, requests: 503 },
      { provider: "ollama", totalTokens: 144898, costUsd: 0.0000, requests: 277 },
      { provider: "anthropic", totalTokens: 121329, costUsd: 1.1430, requests: 129 },
    ],
  },
};

export default UsageDashboardForm;
