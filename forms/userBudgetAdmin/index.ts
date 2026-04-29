import Reactory from '@reactorynet/reactory-core';
import schema from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';

const UserBudgetAdminForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.UserBudgetAdminForm@1.0.0',
  uiFramework: 'material',
  uiSupport: ['material'],
  title: 'AI Usage Budget Administration',
  description: 'Configure per-user AI usage budgets, soft/hard thresholds, scope, and pricing overrides. ADMIN role required.',
  tags: ['reactor', 'budget', 'admin', 'usage'],
  nameSpace: 'reactor',
  name: 'UserBudgetAdminForm',
  version: '1.0.0',
  registerAsComponent: true,
  schema,
  uiSchema,
  graphql,
  roles: ['ADMIN', 'DEVELOPER', 'SUPERADMIN'],
};

export default UserBudgetAdminForm;
