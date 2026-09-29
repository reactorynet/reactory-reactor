const uiSchema: Reactory.Schema.IFormUISchema = {
  "ui:field": "GridLayout",
  "ui:form": {
    toolbarStyle: {
      display: "none",
      height: 0,
    },
    showSubmit: true,
    showRefresh: true,
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
      search: { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 },
      onlyUnbudgeted: { xs: 12, sm: 3, md: 3, lg: 3, xl: 3 },
      onlyBudgeted: { xs: 12, sm: 3, md: 3, lg: 3, xl: 3 },
    },
    {
      userBudgets: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
  ],
  userId: {
    "ui:placeholder": "User ID or email",
    "ui:help": "Saving for a user who already has a budget updates it.",
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
  search: {
    "ui:options": {
      placeholder: "Search by name, email or username",
    },
  },
  onlyUnbudgeted: {
    "ui:widget": "CheckboxWidget",
  },
  onlyBudgeted: {
    "ui:widget": "CheckboxWidget",
  },

  /**
   * Every user, budgeted or not.
   *
   * The previous table listed only existing budgets, so an administrator could
   * not see who was missing one — and a user absent from a list looks exactly
   * like a page that failed to load. `hasBudget` therefore renders as its own
   * column, and the row action is what makes removal possible at all: there was
   * no delete affordance anywhere in this form before.
   */
  userBudgets: {
    "ui:widget": "MaterialTableWidget",
    "ui:title": "All Users & Their AI Budgets",
    "ui:options": {
      showLabel: false,
      search: true,
      options: {
        search: true,
        showTitle: true,
        pageSize: 10,
        pageSizeOptions: [10, 25, 50],
        headerSx: {
          backgroundColor: "rgba(255, 255, 255, 0.03)",
        },
        rowSx: {
          "&:hover": {
            backgroundColor: "rgba(255, 255, 255, 0.04)",
          },
        },
      },
      actions: [
        {
          key: "delete",
          title: "Remove Budget",
          tooltip:
            "Remove this user's budget. Their AI access is unaffected; only the quota and hard stop are deleted.",
          icon: "delete",
          mutation: "delete",
        },
      ],
      columns: [
        {
          title: "User",
          field: "user.email",
          format:
            "${cellData || ((formData && (formData.user?.firstName || formData.user?.lastName)) ? `${formData.user?.firstName || ''} ${formData.user?.lastName || ''}`.trim() : formData?.userId || '-')}",
          sx: { minWidth: 220 },
        },
        {
          title: "Has Budget",
          field: "hasBudget",
          format: "${cellData === true ? 'Yes' : 'No'}",
          sx: { fontWeight: 600 },
        },
        {
          title: "Status",
          field: "status",
          format: "${cellData || '-'}",
          sx: { fontFamily: "monospace", fontSize: "0.8rem" },
        },
        {
          title: "Month Tokens Cap",
          field: "monthlyTokenLimit",
          format: "${cellData != null ? Number(cellData).toLocaleString() : 'Unlimited'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace" },
        },
        {
          title: "Month Tokens Used",
          field: "currentMonthTokens",
          format: "${cellData != null ? Number(cellData).toLocaleString() : '0'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace" },
        },
        {
          title: "Month Budget ($)",
          field: "monthlyCostLimitUsd",
          format: "${cellData != null ? '$' + Number(cellData).toFixed(2) : 'Unlimited'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace" },
        },
        {
          title: "Month Spend ($)",
          field: "currentMonthCostUsd",
          format: "${cellData != null ? '$' + Number(cellData).toFixed(4) : '0.0000'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace", color: "#fbbf24" },
        },
        {
          title: "Threshold %",
          field: "alertThresholdPercent",
          format: "${cellData != null ? cellData + '%' : '-'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
        },
        {
          title: "Hard Stop",
          field: "hardStop",
          format: "${cellData === true ? 'Yes' : 'No'}",
        },
        {
          title: "Budget ID",
          field: "budget.id",
          format: "${cellData || '-'}",
          sx: { fontFamily: "monospace", fontSize: "0.75rem", opacity: 0.7 },
        },
      ],
    },
  },
};

export default uiSchema;
