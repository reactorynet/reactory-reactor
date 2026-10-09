import Reactory from '@reactorynet/reactory-core';

/**
 * Mounts the custom widget full-width, with no form chrome. The widget renders
 * its own header, filters, table, editor and action dialogs.
 */
const uiSchema: Reactory.Schema.IFormUISchema = {
  'ui:form': {
    componentType: 'div',
    showSubmit: false,
    showRefresh: false,
    toolbarPosition: 'none',
  },
  'ui:title': null,
  'ui:field': 'GridLayout',
  'ui:grid-layout': [
    {
      dashboard: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
  ],
  dashboard: {
    // Explicitly null hides the object title; see schema.ts.
    'ui:title': null,
    'ui:widget': 'reactor.UserBudgetAdminWidget@1.0.0',
    'ui:options': {},
  },
};

export default uiSchema;
