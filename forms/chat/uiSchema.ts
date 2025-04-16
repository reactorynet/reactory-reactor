const baseUISchema: Reactory.Schema.IFormUISchema = {
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
    { id: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { members: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { name: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { description: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { aiModels: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { selectedModel: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { availableModels: { xs: 12, sm: 12, lg: 12, xl: 12 } },
    { messages : { xs: 12, sm: 12, lg: 12, xl: 12 } },
  ]
}

const idLabelOpts: Reactory.Schema.IUILabelWidgetOptions = { 
  icon: 'key',
  tooltip: 'Unique identifier for the chat session',
}

const selectModelOpts: Reactory.Schema.AnySchema = { }

const ChatBotUISchema = { 
  ...baseUISchema,
  id: {
    'ui:widget': 'LabelWidget',
    'ui:options': idLabelOpts
  },
  members: { 
    'ui:widget': 'ChipArrayWidget',
    'ui:options': {}
  },
  name: {
    'ui:widget': 'TextFieldWidget',
    'ui:options': {
      label: 'Chat Name',
      placeholder: 'Enter chat name'
    }
  },
  description: {
    'ui:widget': 'TextFieldWidget',
    'ui:options': {
      label: 'Chat Description',
      placeholder: 'Enter chat description'
    }
  },
  aiModels: {
    'ui:widget': 'ChipArrayWidget',
    'ui:options': {}
  },
  selectedModel: {
    'ui:widget': 'SelectWidget',
    'ui:options': {
      label: 'Select AI Model',
      placeholder: 'Select an AI model',
      options: {
        
      }
    }
  },
  messages: {
    'ui:widget': 'ChatbotWidget',
    'ui:options': {}
  }
}

export default ChatBotUISchema;
