import Reactory from '@reactorynet/reactory-core';

/**
 * Mounts the custom widget full-width, with no form chrome. The widget renders
 * its own header, filter bar, refresh control and empty states, so the engine
 * toolbar and title are suppressed here.
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
    // Explicitly null hides the object title. MaterialObjectTemplate only
    // suppresses the title when `ui:title` is literally null/empty; otherwise it
    // renders the schema's `title` above the widget — and the widget draws its
    // own header, so the engine title is redundant.
    'ui:title': null,
    'ui:widget': 'reactor.UsageDashboardWidget@1.0.0',
    'ui:options': {},
  },
};

export default uiSchema;
