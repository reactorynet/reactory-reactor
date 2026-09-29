import schema from "./schema";
import uiSchema from "./uiSchema";
import graphql from "./graphql";
import type { Reactory } from "@reactorynet/reactory-core";

/**
 * Default window for the dashboard: the trailing 30 days.
 *
 * Computed at module load rather than hardcoded. The previous default named a
 * fixed two-month window that had already passed, and — more damaging — the same
 * object carried a full set of fabricated metrics (1,934,056 tokens, $8.1710,
 * 7,625 requests, invented per-model rows). Because the backing ledger was empty,
 * every query returned zeros and the form silently rendered those fixtures
 * instead: the dashboard reported numbers that had never happened.
 *
 * `defaultFormValue` now carries **only** the filter inputs. No metric may live
 * here. A KPI with no data should read zero or empty, never a plausible fiction —
 * a wrong number that looks right is worse than a blank, because nobody
 * investigates a blank.
 */
const defaultEndDate = new Date();
const defaultStartDate = new Date(
  defaultEndDate.getTime() - 30 * 24 * 60 * 60 * 1000
);

const toIsoDate = (value: Date): string => value.toISOString().slice(0, 10);

const UsageDashboardForm: Reactory.Forms.IReactoryForm = {
  id: "reactor.UsageDashboardForm@1.0.0",
  uiFramework: "material",
  uiSupport: ["material"],
  title: "AI Usage & Telemetry Dashboard",
  description:
    "Monitor and analyze AI token consumption, provider activity, and spending metrics, derived from the conversation message log",
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
    startDate: toIsoDate(defaultStartDate),
    endDate: toIsoDate(defaultEndDate),
    provider: "all",
    model: "",
    personaId: "",
    use_case: "all",
    // Bound by the /admin/ai/usage/:userId and /profile/usage routes. Previously
    // undeclared, so the per-user drill-down silently rendered the global view.
    // Accepts a user id or an email; the resolver translates the latter.
    userId: "",
    // A selection of users, scoped and aggregated together. Empty means "all
    // users", which is the overall report.
    userIds: [],
  },
};

export default UsageDashboardForm;
