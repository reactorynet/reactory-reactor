

const uiSchema: Reactory.Schema.IFormUISchema = { 
  'ui:form': {
    showSubmit: false,
    showRefresh: false,
    showHelp: true,
    allowSupportRequest: false,
    toolbarPosition: 'top',
    toolbarStyle: {
      display: 'flex',
      justifyContent: 'flex-end'
    },
    showSchemaSelectorInToolbar: true,
    schemaSelector: {
      variant: 'icon-button',
    }
  },
  'ui:title': null,
  'ui:field': 'GridLayout',
  'ui:grid-layout': [ 
    { name: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { nameSpace: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { version: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { description: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { type: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { metrics: { xs: 12, sm: 12, lg: 12, xl: 12 } },
  ]
}

export default uiSchema;