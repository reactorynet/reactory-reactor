import Reactory from '@reactorynet/reactory-core';
import schema from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const name = 'UserBudgetAdminForm';
const nameSpace = 'reactor';
const version = '1.0.0';

/**
 * AI Usage Budgets.
 *
 * Rebuilt as a single custom widget (`reactor.UserBudgetAdminWidget@1.0.0`), the
 * same way as the usage dashboard. The previous implementation drove a CRUD
 * console — a filtered table of every user plus a budget editor — through the
 * form engine, which forced the table's filters and selection and the editor's
 * form state into one form model, made "save" a page-level submit, and made
 * delete depend on row-selection plumbing.
 *
 * The widget owns all of that. It also serves the self-service, read-only view
 * (`/profile/budget`) when mounted with `scope: 'self'`, reading
 * `ReactorUserUsageStatus` rather than the admin-gated overview query.
 */
const UserBudgetAdminForm: Reactory.Forms.IReactoryForm = {
  id: `${nameSpace}.${name}@${version}`,
  uiFramework: 'material',
  uiSupport: ['material'],
  title: 'AI Usage Budgets',
  description:
    'Configure AI token and cost limits per user, see who is unbudgeted, and act on them in bulk',
  tags: ['reactor', 'ai', 'budget', 'limits', 'admin'],
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
      componentFqn: 'reactor.UserBudgetAdminWidget@1.0.0',
      widget: 'UserBudgetAdminWidget',
    },
  ],
  roles: ['USER', 'ADMIN', 'SUPERADMIN', 'DEVELOPER', 'SYSADMIN'],
};

export default UserBudgetAdminForm;
