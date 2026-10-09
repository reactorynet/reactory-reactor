import Reactory from '@reactorynet/reactory-core';
import schema from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const name = 'UsageDashboardForm';
const nameSpace = 'reactor';
const version = '1.0.0';

/**
 * AI Usage & Telemetry Dashboard.
 *
 * Rebuilt as a single custom widget (`reactor.UsageDashboardWidget@1.0.0`) on the
 * same pattern as the compute planner dashboard. The previous implementation
 * drove the whole page through the form engine — `ui:grid-layout` + ~27KB of
 * `uiSchema` wiring `LabelWidgetV2` / `LineChartWidget` / `MaterialTableWidget`
 * and a `graphql.queries.summary` bound to `formData.*` — and had drifted: the
 * KPI data depended on `graphql.query` being set, several schema/uiSchema/query
 * bindings were silently dropped, and the per-user drill-down rendered the
 * global view.
 *
 * The widget owns its own state, filters, pagination and GraphQL calls, which
 * removes that whole class of failure. Consequences to be aware of:
 *
 *   - The filter inputs (date range, provider, model, persona, use case, user
 *     and user-selection) live in the widget, not in `defaultFormValue`. There
 *     is deliberately no metric in form state — a KPI with no data reads zero,
 *     never a plausible fiction.
 *   - `componentProps` bound by the routes (`/admin/ai/usage/:userId` and
 *     `/profile/usage`) arrive on the form props; the widget reads the scope
 *     from `formContext.props.userId` and never forwards it as a query variable
 *     the schema does not declare.
 */
const UsageDashboardForm: Reactory.Forms.IReactoryForm = {
  id: `${nameSpace}.${name}@${version}`,
  uiFramework: 'material',
  uiSupport: ['material'],
  title: 'AI Usage & Telemetry Dashboard',
  description:
    'Monitor and analyze AI token consumption, provider activity, and spending metrics, derived from the conversation message log',
  icon: 'analytics',
  tags: ['reactor', 'ai', 'usage', 'telemetry', 'tokens', 'dashboard'],
  nameSpace,
  name,
  version,
  registerAsComponent: true,
  schema,
  uiSchema,
  graphql,
  modules,
  widgetMap: [
    {
      componentFqn: 'reactor.UsageDashboardWidget@1.0.0',
      widget: 'UsageDashboardWidget',
    },
  ],
  roles: ['USER', 'ADMIN', 'SUPERADMIN', 'DEVELOPER', 'SYSADMIN'],
};

export default UsageDashboardForm;
