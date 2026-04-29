import Reactory from '@reactorynet/reactory-core';
import schema from './schema';
import uiSchema from './uiSchema';
import modules from './modules';

const UsageDashboardForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.UsageDashboardForm@1.0.0',
  uiFramework: 'material',
  uiSupport: ['material'],
  title: 'AI Usage Dashboard',
  description: 'Read-only widget showing the current period spend versus configured budgets.',
  tags: ['reactor', 'usage', 'budget', 'dashboard'],
  nameSpace: 'reactor',
  name: 'UsageDashboardForm',
  version: '1.0.0',
  registerAsComponent: true,
  schema,
  uiSchema,
  modules,
  argsSchema: {
    type: 'object',
    properties: {
      userId: {
        type: 'string',
        title: 'User ID',
        description: 'The user whose usage to display. Defaults to the current user.',
      },
    },
  },
  widgetMap: [
    {
      componentFqn: 'reactor.UsageDashboardWidget@1.0.0',
      widget: 'UsageDashboardWidget',
    },
  ],
  roles: ['USER'],
};

export default UsageDashboardForm;
