const uiSchema: Reactory.Schema.IFormUISchema = {
  "ui:field": "GridLayout",
  "ui:form": {
    toolbarStyle: {
      display: "none",
      height: 0,
    },
    showSubmit: true,
    showRefresh: false,
    componentType: "div",
    submitButtonLabel: "Save User Budget",
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
      userId: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      monthlyTokenLimit: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
      dailyTokenLimit: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
    },
    {
      monthlyCostLimitUsd: { xs: 12, sm: 6, md: 3, lg: 3, xl: 3 },
      dailyCostLimitUsd: { xs: 12, sm: 6, md: 3, lg: 3, xl: 3 },
      alertThresholdPercent: { xs: 12, sm: 6, md: 3, lg: 3, xl: 3 },
      hardStop: { xs: 12, sm: 6, md: 3, lg: 3, xl: 3 },
    },
    {
      notes: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
    {
      budgets: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
  ],
  userId: {
    "ui:placeholder": "User ID / Email",
  },
  monthlyTokenLimit: {
    "ui:placeholder": "e.g. 5000000",
  },
  dailyTokenLimit: {
    "ui:placeholder": "e.g. 500000",
  },
  monthlyCostLimitUsd: {
    "ui:placeholder": "e.g. 50.00",
  },
  dailyCostLimitUsd: {
    "ui:placeholder": "e.g. 10.00",
  },
  alertThresholdPercent: {
    "ui:placeholder": "80",
  },
  hardStop: {
    "ui:widget": "CheckboxWidget",
  },
  notes: {
    "ui:widget": "TextareaWidget",
    "ui:options": {
      rows: 2,
    },
  },
  budgets: {
    "ui:widget": "MaterialTableWidget",
    "ui:title": "All User AI Budgets & Quotas",
    "ui:options": {
      showLabel: false,
      search: true,
      options: {
        search: true,
        pageSize: 10,
        pageSizeOptions: [10, 25, 50],
      },
      columns: [
        { title: "User Email", field: "user.email" },
        { title: "First Name", field: "user.firstName" },
        { title: "Last Name", field: "user.lastName" },
        { title: "Month Tokens Cap", field: "monthlyTokenLimit" },
        { title: "Month Tokens Used", field: "currentMonthTokens" },
        { title: "Month Budget ($)", field: "monthlyCostLimitUsd" },
        { title: "Month Spend ($)", field: "currentMonthCostUsd" },
        { title: "Threshold %", field: "alertThresholdPercent" },
        { title: "Hard Stop", field: "hardStop" },
        { title: "Status", field: "status" },
        { title: "Updated", field: "updatedAt" },
      ],
    },
  },
};

export default uiSchema;
