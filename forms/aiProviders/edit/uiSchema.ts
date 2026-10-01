import Reactory from '@reactorynet/reactory-core';

/**
 * UI schema for the AI Provider editor.
 *
 * Layout: `ui:field: 'TabbedLayout'` groups the (flat) fields into tabs, and
 * `ui:grid-layout` lays each tab's fields out on the 12-column grid. The schema
 * — and therefore the formData shape and the GraphQL input mapping — is
 * unchanged; only the presentation is grouped.
 *
 * The nested `rateLimits` object (Limits tab) renders as a padded sub-section
 * via `ui:options.variant: 'section'`.
 */
const uiSchema: Reactory.Schema.IFormUISchema = {
  'ui:form': {
    componentType: 'div',
    showSubmit: true,
    showHelp: false,
    showRefresh: false,
    toolbarPosition: 'bottom',
    toolbarStyle: {
      display: 'flex',
      justifyContent: 'flex-end',
      paddingTop: '16px',
    },
    submitProps: {
      titleText: 'Save Provider',
    },
  },
  'ui:field': 'TabbedLayout',
  'ui:tab-layout': [
    {
      title: 'Identity',
      icon: 'badge',
      fields: ['id', 'name', 'providerType', 'description'],
    },
    {
      title: 'Connection',
      icon: 'cloud',
      fields: ['endpointUrl', 'apiVersion', 'authComponentFqn', 'defaultModel'],
    },
    {
      title: 'Access',
      icon: 'key',
      fields: ['capabilities', 'roles', 'credentialRequirements', 'isEnabled'],
    },
    {
      title: 'Limits',
      icon: 'speed',
      fields: ['rateLimits'],
    },
  ],
  'ui:grid-layout': [
    // Identity
    {
      id: { xs: 12, sm: 6, md: 4, lg: 4 },
      name: { xs: 12, sm: 6, md: 4, lg: 4 },
      providerType: { xs: 12, sm: 12, md: 4, lg: 4 },
    },
    { description: { xs: 12 } },
    // Connection
    {
      endpointUrl: { xs: 12, sm: 12, md: 8, lg: 8 },
      apiVersion: { xs: 12, sm: 12, md: 4, lg: 4 },
    },
    {
      authComponentFqn: { xs: 12, sm: 12, md: 6, lg: 6 },
      defaultModel: { xs: 12, sm: 12, md: 6, lg: 6 },
    },
    // Access
    {
      capabilities: { xs: 12, sm: 12, md: 6, lg: 6 },
      roles: { xs: 12, sm: 12, md: 6, lg: 6 },
    },
    {
      credentialRequirements: { xs: 12, sm: 12, md: 8, lg: 8 },
      isEnabled: { xs: 12, sm: 12, md: 4, lg: 4 },
    },
    // Limits (padded sub-section)
    { rateLimits: { xs: 12 } },
  ],
  id: {
    'ui:widget': 'text',
  },
  name: {
    'ui:placeholder': 'OpenAI',
  },
  description: {
    'ui:widget': 'textarea',
    'ui:options': {
      rows: 3,
    },
  },
  endpointUrl: {
    'ui:placeholder': 'https://api.openai.com/v1',
  },
  apiVersion: {
    'ui:placeholder': '2024-02-15-preview',
  },
  authComponentFqn: {
    'ui:placeholder': 'reactor.OpenAIAuthComponent@1.0.0',
  },
  defaultModel: {
    'ui:placeholder': 'gpt-4o',
  },
  capabilities: {
    'ui:widget': 'checkboxes',
  },
  roles: {
    'ui:widget': 'checkboxes',
  },
  credentialRequirements: {
    'ui:widget': 'checkboxes',
  },
  isEnabled: {
    'ui:widget': 'checkbox',
  },
  rateLimits: {
    'ui:options': {
      variant: 'section',
    },
    'ui:grid-layout': [
      {
        requestsPerMinute: { xs: 12, sm: 4, md: 4, lg: 4 },
        tokensPerMinute: { xs: 12, sm: 4, md: 4, lg: 4 },
        concurrentRequests: { xs: 12, sm: 4, md: 4, lg: 4 },
      },
    ],
  },
};

export default uiSchema;
