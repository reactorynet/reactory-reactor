const uiSchema: Reactory.Schema.IFormUISchema = {
  "ui:field": "GridLayout",
  "ui:form": {
    toolbarStyle: {
      display: "none",
      height: 0,
    },
    showSubmit: false,
    showRefresh: true,
    componentType: "div",
    style: {
      display: "flex",
      flexDirection: "column",
    },
  },
  "ui:grid-options": {
    container: "Paper",
    containerProps: {
      elevation: 0,
      square: true,
      variant: "outlined",
      sx: {
        padding: 2,
        marginTop: 1,
        marginBottom: 2,
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
      },
    },
  },
  "ui:grid-layout": [
    {
      startDate: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
      endDate: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
      provider: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
      model: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
      personaId: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
      use_case: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
    },
    {
      totalTokens: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
      totalPromptTokens: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
      totalCompletionTokens: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
      totalCostUsd: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
      totalRequests: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
      avgDurationMs: { xs: 12, sm: 6, md: 2, lg: 2, xl: 2 },
    },
    {
      timeSeries: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
    {
      modelBreakdown: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      providerBreakdown: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
    },
    {
      records: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
  ],
  startDate: {
    "ui:widget": "DateWidget",
    "ui:title": "Start Date",
    "ui:options": {
      placeholder: "YYYY-MM-DD",
    },
  },
  endDate: {
    "ui:widget": "DateWidget",
    "ui:title": "End Date",
    "ui:options": {
      placeholder: "YYYY-MM-DD",
    },
  },
  provider: {
    "ui:widget": "SelectWidget",
    "ui:title": "Provider",
    "ui:options": {
      selectOptions: [
        { value: "all", label: "All Providers" },
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic" },
        { value: "google", label: "Google Vertex/Gemini" },
        { value: "ollama", label: "Ollama" },
        { value: "mistral", label: "Mistral" },
        { value: "openrouter", label: "OpenRouter" },
      ],
    },
  },
  model: {
    "ui:widget": "InputWidget",
    "ui:title": "Model Filter",
    "ui:options": {
      placeholder: "e.g. gpt-4o, claude-3-5...",
    },
  },
  personaId: {
    "ui:widget": "InputWidget",
    "ui:title": "Persona Filter",
    "ui:options": {
      placeholder: "e.g. reactor, security...",
    },
  },
  use_case: {
    "ui:widget": "SelectWidget",
    "ui:title": "Use Case",
    "ui:options": {
      selectOptions: [
        { value: "all", label: "All Use Cases" },
        { value: "standalone", label: "Standalone Chat" },
        { value: "workflow", label: "Workflow Runner" },
        { value: "support", label: "Support Ticket" },
        { value: "task", label: "Scheduled Task" },
      ],
    },
  },
  totalTokens: {
    "ui:widget": "LabelWidget",
    "ui:title": "Total Tokens",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      forceShrinkLabel: true,
      icon: "token",
      format: "${formData != null ? Number(formData).toLocaleString() : '0'}",
    },
  },
  totalPromptTokens: {
    "ui:widget": "LabelWidget",
    "ui:title": "Input (Prompt)",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      forceShrinkLabel: true,
      icon: "input",
      format: "${formData != null ? Number(formData).toLocaleString() : '0'}",
    },
  },
  totalCompletionTokens: {
    "ui:widget": "LabelWidget",
    "ui:title": "Output (Completion)",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      forceShrinkLabel: true,
      icon: "output",
      format: "${formData != null ? Number(formData).toLocaleString() : '0'}",
    },
  },
  totalCostUsd: {
    "ui:widget": "LabelWidget",
    "ui:title": "Est. Cost ($ USD)",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      forceShrinkLabel: true,
      icon: "attach_money",
      format: "$${formData != null ? Number(formData).toFixed(4) : '0.00'}",
    },
  },
  totalRequests: {
    "ui:widget": "LabelWidget",
    "ui:title": "AI Turns",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      forceShrinkLabel: true,
      icon: "smart_toy",
      format: "${formData != null ? Number(formData).toLocaleString() : '0'}",
    },
  },
  avgDurationMs: {
    "ui:widget": "LabelWidget",
    "ui:title": "Avg Latency",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      forceShrinkLabel: true,
      icon: "speed",
      format: "${formData != null ? formData + ' ms' : '0 ms'}",
    },
  },
  timeSeries: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Daily Token Consumption (Prompt vs Output)",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      chartType: 'line',
      dataKey: 'date',
      series: [
        { key: 'promptTokens', label: 'Prompt Tokens', color: '#1976d2' },
        { key: 'completionTokens', label: 'Output Tokens', color: '#9c27b0' },
        { key: 'totalTokens', label: 'Total Tokens', color: '#f95e20' },
      ],
    },
  },
  modelBreakdown: {
    "ui:widget": "MaterialTableWidget",
    "ui:title": "Usage by Model",
    "ui:options": {
      showLabel: false,
      search: true,
      options: {
        search: true,
        pageSize: 5,
        pageSizeOptions: [5, 10, 20],
      },
      columns: [
        { title: "Model", field: "model" },
        { title: "Provider", field: "provider" },
        { title: "Tokens", field: "totalTokens" },
        { title: "Cost ($)", field: "costUsd" },
        { title: "Turns", field: "requests" },
      ],
    },
  },
  providerBreakdown: {
    "ui:widget": "MaterialTableWidget",
    "ui:title": "Usage by Provider",
    "ui:options": {
      showLabel: false,
      search: true,
      options: {
        search: true,
        pageSize: 5,
        pageSizeOptions: [5, 10, 20],
      },
      columns: [
        { title: "Provider", field: "provider" },
        { title: "Tokens", field: "totalTokens" },
        { title: "Cost ($)", field: "costUsd" },
        { title: "Turns", field: "requests" },
      ],
    },
  },
  records: {
    "ui:widget": "MaterialTableWidget",
    "ui:title": "Recent AI Activity Ledger",
    "ui:options": {
      showLabel: false,
      search: true,
      options: {
        search: true,
        pageSize: 10,
        pageSizeOptions: [10, 25, 50],
      },
      columns: [
        { title: "Timestamp", field: "createdAt" },
        { title: "Persona", field: "personaId" },
        { title: "Provider", field: "provider" },
        { title: "Model", field: "model" },
        { title: "Prompt", field: "promptTokens" },
        { title: "Output", field: "completionTokens" },
        { title: "Total", field: "totalTokens" },
        { title: "Cost ($)", field: "costUsd" },
        { title: "Latency (ms)", field: "durationMs" },
        { title: "Status", field: "status" },
      ],
    },
  },
};

export default uiSchema;
