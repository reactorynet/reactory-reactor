

const uiSchema: Reactory.Schema.IFormUISchema = { 
  'ui:form': {
    showSubmit: true,
    submitProps: {
      title: 'Start Indexing',
      variant: "button",
      tooltip: "Click to start indexing"
    },
    submitIcon: "refresh",
    showRefresh: false,
    showHelp: true,
    allowSupportRequest: false,
    toolbarPosition: 'top',
    toolbarStyle: {
      display: 'flex',
      justifyContent: 'flex-end'
    },
    showSchemaSelectorInToolbar: false,
    schemaSelector: {
      variant: 'icon-button',
    }
  },
  'ui:title': null,
  'ui:field': 'GridLayout',
  'ui:grid-layout': [ 
    { id: { xs: 12, xl: 12 }},
    { name: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { description: { xs: 12, sm: 12, lg: 12, xl: 12 } },
  ],
  id: {
    'ui:options': {
      readonly: true
    }
  },
  name: {
  },
  description: {
    'ui:widget': 'StaticContent',
    'ui:options': { 
      showLabel: false,
      slug: 'catalog-indexing-description'
    }
  },
}

export default uiSchema;