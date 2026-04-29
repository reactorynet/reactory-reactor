import Reactory from '@reactorynet/reactory-core';

const uiSchema: Reactory.Schema.IFormUISchema = {
  'ui:form': {
    componentType: 'div',
    showSubmit: false,
    showRefresh: true,
    showHelp: false,
  },
  'ui:field': 'GridLayout',
  'ui:grid-layout': [
    {
      dashboard: { size: { xs: 12 } },
    },
  ],
  userId: {
    'ui:widget': 'HiddenWidget',
  },
  dashboard: {
    'ui:widget': 'UsageDashboardWidget',
    'ui:options': {
      showLabel: false,
    },
  },
};

export default uiSchema;
