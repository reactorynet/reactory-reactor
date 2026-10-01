import Reactory from '@reactorynet/reactory-core';

/**
 * UI schema for the AI Model editor.
 *
 * Layout: `ui:field: 'TabbedLayout'` groups the (flat) fields into tabs, and
 * `ui:grid-layout` lays each tab's fields out on the 12-column grid. The schema
 * — and therefore the formData shape and the GraphQL input mapping — is
 * unchanged; only the presentation is grouped.
 *
 * The nested `sampling` and `thinking` objects (Advanced tab) render as padded
 * sub-sections via `ui:options.variant: 'section'`.
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
      titleText: 'Save Model',
    },
  },
  'ui:field': 'TabbedLayout',
  'ui:tab-layout': [
    {
      title: 'Identity',
      icon: 'badge',
      fields: ['providerId', 'modelKey', 'name', 'version'],
    },
    {
      title: 'Limits',
      icon: 'speed',
      fields: [
        'contextLength',
        'maxOutputTokens',
        'supportsStreaming',
        'isEnabled',
        'sortOrder',
        'rpm',
        'itpm',
        'otpm',
        'maxParallelRequests',
      ],
    },
    {
      title: 'Capabilities',
      icon: 'extension',
      fields: ['capabilities', 'supportedTools', 'supportedMediaTypes'],
    },
    {
      title: 'Cost',
      icon: 'payments',
      fields: ['inputCostPerTokenUsdCents', 'outputCostPerTokenUsdCents', 'costPerToken'],
    },
    {
      title: 'Advanced',
      icon: 'tune',
      fields: ['sampling', 'thinking'],
    },
  ],
  'ui:grid-layout': [
    // Identity
    {
      providerId: { xs: 12, sm: 6, md: 4, lg: 4 },
      modelKey: { xs: 12, sm: 6, md: 4, lg: 4 },
      name: { xs: 12, sm: 12, md: 4, lg: 4 },
    },
    { version: { xs: 12, sm: 6, md: 4, lg: 4 } },
    // Limits
    {
      contextLength: { xs: 12, sm: 4, md: 4, lg: 4 },
      maxOutputTokens: { xs: 12, sm: 4, md: 4, lg: 4 },
      maxParallelRequests: { xs: 12, sm: 4, md: 4, lg: 4 },
    },
    {
      supportsStreaming: { xs: 12, sm: 4, md: 4, lg: 4 },
      isEnabled: { xs: 12, sm: 4, md: 4, lg: 4 },
      sortOrder: { xs: 12, sm: 4, md: 4, lg: 4 },
    },
    {
      rpm: { xs: 12, sm: 6, md: 3, lg: 3 },
      itpm: { xs: 12, sm: 6, md: 3, lg: 3 },
      otpm: { xs: 12, sm: 6, md: 3, lg: 3 },
    },
    // Capabilities
    { capabilities: { xs: 12 } },
    {
      supportedTools: { xs: 12, sm: 12, md: 6, lg: 6 },
      supportedMediaTypes: { xs: 12, sm: 12, md: 6, lg: 6 },
    },
    // Cost
    {
      inputCostPerTokenUsdCents: { xs: 12, sm: 4, md: 4, lg: 4 },
      outputCostPerTokenUsdCents: { xs: 12, sm: 4, md: 4, lg: 4 },
      costPerToken: { xs: 12, sm: 4, md: 4, lg: 4 },
    },
    // Advanced (padded sub-sections)
    { sampling: { xs: 12 } },
    { thinking: { xs: 12 } },
  ],
  providerId: {
    'ui:placeholder': 'openai',
  },
  modelKey: {
    'ui:placeholder': 'gpt-4o',
  },
  name: {
    'ui:placeholder': 'GPT-4o',
  },
  version: {
    'ui:placeholder': '2024-11',
  },
  capabilities: {
    'ui:widget': 'checkboxes',
  },
  supportedTools: {
    'ui:widget': 'checkboxes',
  },
  supportedMediaTypes: {
    'ui:widget': 'checkboxes',
  },
  supportsStreaming: {
    'ui:widget': 'checkbox',
  },
  isEnabled: {
    'ui:widget': 'checkbox',
  },
  sampling: {
    'ui:options': {
      variant: 'section',
    },
    'ui:grid-layout': [
      {
        temperature: { xs: 12, sm: 4, md: 4, lg: 4 },
        topP: { xs: 12, sm: 4, md: 4, lg: 4 },
        topK: { xs: 12, sm: 4, md: 4, lg: 4 },
      },
    ],
  },
  thinking: {
    'ui:options': {
      variant: 'section',
    },
    'ui:grid-layout': [
      {
        mode: { xs: 12, sm: 4, md: 4, lg: 4 },
        effort: { xs: 12, sm: 4, md: 4, lg: 4 },
        display: { xs: 12, sm: 4, md: 4, lg: 4 },
      },
    ],
  },
};

export default uiSchema;
