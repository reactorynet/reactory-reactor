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
      gap: "20px",
    },
  },
  "ui:grid-options": {
    container: "div",
    spacing: 2.5,
    containerStyles: {
      padding: "16px 24px",
      minHeight: "100%",
      boxSizing: "border-box",
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
      totalTokens: {
        xs: 12,
        sm: 6,
        md: 4,
        lg: 2,
        xl: 2,
        sx: { display: "flex", flexDirection: "column" },
      },
      totalPromptTokens: {
        xs: 12,
        sm: 6,
        md: 4,
        lg: 2,
        xl: 2,
        sx: { display: "flex", flexDirection: "column" },
      },
      totalCompletionTokens: {
        xs: 12,
        sm: 6,
        md: 4,
        lg: 2,
        xl: 2,
        sx: { display: "flex", flexDirection: "column" },
      },
      totalCostUsd: {
        xs: 12,
        sm: 6,
        md: 4,
        lg: 2,
        xl: 2,
        sx: { display: "flex", flexDirection: "column" },
      },
      totalRequests: {
        xs: 12,
        sm: 6,
        md: 4,
        lg: 2,
        xl: 2,
        sx: { display: "flex", flexDirection: "column" },
      },
      avgDurationMs: {
        xs: 12,
        sm: 6,
        md: 4,
        lg: 2,
        xl: 2,
        sx: { display: "flex", flexDirection: "column" },
      },
    },
    {
      timeSeries: {
        xs: 12,
        sm: 12,
        md: 12,
        lg: 12,
        xl: 12,
        sx: {
          mt: 0.5,
          mb: 0.5,
          "& .MuiBox-root": {
            borderRadius: "14px",
            border: "1px solid",
            borderColor: "divider",
            boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
            overflow: "hidden",
            transition: "border-color 0.2s ease-in-out",
            "&:hover": {
              borderColor: "primary.main",
            },
          },
        },
      },
    },
    {
      modelBreakdown: {
        xs: 12,
        sm: 12,
        md: 6,
        lg: 6,
        xl: 6,
        sx: {
          "& .MuiPaper-root": {
            borderRadius: "14px",
            border: "1px solid",
            borderColor: "divider",
            boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
            overflow: "hidden",
          },
        },
      },
      providerBreakdown: {
        xs: 12,
        sm: 12,
        md: 6,
        lg: 6,
        xl: 6,
        sx: {
          "& .MuiPaper-root": {
            borderRadius: "14px",
            border: "1px solid",
            borderColor: "divider",
            boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
            overflow: "hidden",
          },
        },
      },
    },
    {
      records: {
        xs: 12,
        sm: 12,
        md: 12,
        lg: 12,
        xl: 12,
        sx: {
          mt: 1,
          "& .MuiPaper-root": {
            borderRadius: "14px",
            border: "1px solid",
            borderColor: "divider",
            boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
            overflow: "hidden",
          },
        },
      },
    },
  ],

  // Filter Bar Controls
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
        { value: "google", label: "Google Vertex / Gemini" },
        { value: "anthropic", label: "Anthropic" },
        { value: "openai", label: "OpenAI" },
        { value: "llamacpp", label: "LlamaCPP" },
        { value: "ollama", label: "Ollama" },
        { value: "mistral", label: "Mistral" },
        { value: "openrouter", label: "OpenRouter" },
      ],
    },
  },
  model: {
    "ui:title": "Model Filter",
    "ui:options": {
      placeholder: "e.g. gemini-3.5-flash, claude-3-5...",
    },
  },
  personaId: {
    "ui:title": "Persona Filter",
    "ui:options": {
      placeholder: "e.g. reactor, formidable...",
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

  // KPI Stat Cards
  totalTokens: {
    "ui:widget": "LabelWidgetV2",
    "ui:options": {
      showLabel: false,
      renderHtml: true,
      containerSx: {
        p: 2.2,
        borderRadius: "14px",
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        boxShadow: "0 2px 10px rgba(0,0,0,0.15)",
        minHeight: "108px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "stretch",
        width: "100%",
        boxSizing: "border-box",
        transition: "all 0.2s ease-in-out",
        "&:hover": {
          borderColor: "#38bdf8",
          transform: "translateY(-2px)",
          boxShadow: "0 8px 24px rgba(56, 189, 248, 0.2)",
        },
      },
      format: `<div style="display: flex; flex-direction: column; width: 100%; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; opacity: 0.7;">Total Tokens</span>
          <span style="display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; background: rgba(56, 189, 248, 0.14); color: #38bdf8;">
            <i class="material-icons" style="font-size: 18px;">token</i>
          </span>
        </div>
        <div style="font-size: 1.65rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; color: #fff;">
          \${formData != null ? Number(formData).toLocaleString() : '0'}
        </div>
        <div style="font-size: 0.72rem; opacity: 0.55; display: flex; align-items: center; gap: 4px;">
          <span style="color: #38bdf8; font-size: 0.85rem;">●</span> Lifetime tokens
        </div>
      </div>`,
    },
  },

  totalPromptTokens: {
    "ui:widget": "LabelWidgetV2",
    "ui:options": {
      showLabel: false,
      renderHtml: true,
      containerSx: {
        p: 2.2,
        borderRadius: "14px",
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        boxShadow: "0 2px 10px rgba(0,0,0,0.15)",
        minHeight: "108px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "stretch",
        width: "100%",
        boxSizing: "border-box",
        transition: "all 0.2s ease-in-out",
        "&:hover": {
          borderColor: "#818cf8",
          transform: "translateY(-2px)",
          boxShadow: "0 8px 24px rgba(129, 140, 248, 0.2)",
        },
      },
      format: `<div style="display: flex; flex-direction: column; width: 100%; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; opacity: 0.7;">Input (Prompt)</span>
          <span style="display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; background: rgba(129, 140, 248, 0.14); color: #818cf8;">
            <i class="material-icons" style="font-size: 18px;">input</i>
          </span>
        </div>
        <div style="font-size: 1.65rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; color: #fff;">
          \${formData != null ? Number(formData).toLocaleString() : '0'}
        </div>
        <div style="font-size: 0.72rem; opacity: 0.55; display: flex; align-items: center; gap: 4px;">
          <span style="color: #818cf8; font-size: 0.85rem;">●</span> Context & prompts
        </div>
      </div>`,
    },
  },

  totalCompletionTokens: {
    "ui:widget": "LabelWidgetV2",
    "ui:options": {
      showLabel: false,
      renderHtml: true,
      containerSx: {
        p: 2.2,
        borderRadius: "14px",
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        boxShadow: "0 2px 10px rgba(0,0,0,0.15)",
        minHeight: "108px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "stretch",
        width: "100%",
        boxSizing: "border-box",
        transition: "all 0.2s ease-in-out",
        "&:hover": {
          borderColor: "#34d399",
          transform: "translateY(-2px)",
          boxShadow: "0 8px 24px rgba(52, 211, 153, 0.2)",
        },
      },
      format: `<div style="display: flex; flex-direction: column; width: 100%; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; opacity: 0.7;">Output (Completion)</span>
          <span style="display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; background: rgba(52, 211, 153, 0.14); color: #34d399;">
            <i class="material-icons" style="font-size: 18px;">output</i>
          </span>
        </div>
        <div style="font-size: 1.65rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; color: #fff;">
          \${formData != null ? Number(formData).toLocaleString() : '0'}
        </div>
        <div style="font-size: 0.72rem; opacity: 0.55; display: flex; align-items: center; gap: 4px;">
          <span style="color: #34d399; font-size: 0.85rem;">●</span> Generated content
        </div>
      </div>`,
    },
  },

  totalCostUsd: {
    "ui:widget": "LabelWidgetV2",
    "ui:options": {
      showLabel: false,
      renderHtml: true,
      containerSx: {
        p: 2.2,
        borderRadius: "14px",
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        boxShadow: "0 2px 10px rgba(0,0,0,0.15)",
        minHeight: "108px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "stretch",
        width: "100%",
        boxSizing: "border-box",
        transition: "all 0.2s ease-in-out",
        "&:hover": {
          borderColor: "#fbbf24",
          transform: "translateY(-2px)",
          boxShadow: "0 8px 24px rgba(251, 191, 36, 0.2)",
        },
      },
      format: `<div style="display: flex; flex-direction: column; width: 100%; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; opacity: 0.7;">Est. Cost ($ USD)</span>
          <span style="display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; background: rgba(251, 191, 36, 0.14); color: #fbbf24;">
            <i class="material-icons" style="font-size: 18px;">attach_money</i>
          </span>
        </div>
        <div style="font-size: 1.65rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; color: #fbbf24;">
          $\${formData != null ? Number(formData).toFixed(4) : '0.0000'}
        </div>
        <div style="font-size: 0.72rem; opacity: 0.55; display: flex; align-items: center; gap: 4px;">
          <span style="color: #fbbf24; font-size: 0.85rem;">●</span> Estimated spend
        </div>
      </div>`,
    },
  },

  totalRequests: {
    "ui:widget": "LabelWidgetV2",
    "ui:options": {
      showLabel: false,
      renderHtml: true,
      containerSx: {
        p: 2.2,
        borderRadius: "14px",
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        boxShadow: "0 2px 10px rgba(0,0,0,0.15)",
        minHeight: "108px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "stretch",
        width: "100%",
        boxSizing: "border-box",
        transition: "all 0.2s ease-in-out",
        "&:hover": {
          borderColor: "#c084fc",
          transform: "translateY(-2px)",
          boxShadow: "0 8px 24px rgba(192, 132, 252, 0.2)",
        },
      },
      format: `<div style="display: flex; flex-direction: column; width: 100%; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; opacity: 0.7;">AI Turns</span>
          <span style="display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; background: rgba(192, 132, 252, 0.14); color: #c084fc;">
            <i class="material-icons" style="font-size: 18px;">smart_toy</i>
          </span>
        </div>
        <div style="font-size: 1.65rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; color: #fff;">
          \${formData != null ? Number(formData).toLocaleString() : '0'}
        </div>
        <div style="font-size: 0.72rem; opacity: 0.55; display: flex; align-items: center; gap: 4px;">
          <span style="color: #c084fc; font-size: 0.85rem;">●</span> Executed turns
        </div>
      </div>`,
    },
  },

  avgDurationMs: {
    "ui:widget": "LabelWidgetV2",
    "ui:options": {
      showLabel: false,
      renderHtml: true,
      containerSx: {
        p: 2.2,
        borderRadius: "14px",
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        boxShadow: "0 2px 10px rgba(0,0,0,0.15)",
        minHeight: "108px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "stretch",
        width: "100%",
        boxSizing: "border-box",
        transition: "all 0.2s ease-in-out",
        "&:hover": {
          borderColor: "#f87171",
          transform: "translateY(-2px)",
          boxShadow: "0 8px 24px rgba(248, 113, 113, 0.2)",
        },
      },
      format: `<div style="display: flex; flex-direction: column; width: 100%; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; opacity: 0.7;">Avg Latency</span>
          <span style="display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; background: rgba(248, 113, 113, 0.14); color: #f87171;">
            <i class="material-icons" style="font-size: 18px;">speed</i>
          </span>
        </div>
        <div style="font-size: 1.65rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; color: #fff;">
          \${formData != null ? Math.round(Number(formData)) : '0'} ms
        </div>
        <div style="font-size: 0.72rem; opacity: 0.55; display: flex; align-items: center; gap: 4px;">
          <span style="color: #f87171; font-size: 0.85rem;">●</span> Turn duration
        </div>
      </div>`,
    },
  },

  // Daily Trend Chart
  timeSeries: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Daily Token Consumption Trend",
    "ui:options": {
      showLabel: false,
      showUnit: false,
      xKey: "date",
      yKey: "totalTokens",
      bounds: {
        height: 340,
      },
      xAxis: {
        dataKey: "date",
        stroke: "#94a3b8",
        tick: { fill: "#94a3b8", fontSize: 11 },
      },
      yAxis: {
        stroke: "#94a3b8",
        tick: { fill: "#94a3b8", fontSize: 11 },
      },
      series: [
        {
          dataKey: "totalTokens",
          name: "Total Tokens",
          stroke: "#38bdf8",
          type: "monotone",
          strokeWidth: 3,
          dot: { r: 3, fill: "#38bdf8", strokeWidth: 0 },
          activeDot: { r: 6 },
        },
        {
          dataKey: "promptTokens",
          name: "Prompt Tokens",
          stroke: "#818cf8",
          type: "monotone",
          strokeWidth: 2,
          dot: { r: 2.5, fill: "#818cf8", strokeWidth: 0 },
          activeDot: { r: 5 },
        },
        {
          dataKey: "completionTokens",
          name: "Output Tokens",
          stroke: "#34d399",
          type: "monotone",
          strokeWidth: 2,
          dot: { r: 2.5, fill: "#34d399", strokeWidth: 0 },
          activeDot: { r: 5 },
        },
      ],
    },
  },

  // Model Breakdown Table
  modelBreakdown: {
    "ui:widget": "MaterialTableWidget",
    "ui:title": "Token Usage by Model",
    "ui:options": {
      showLabel: false,
      search: true,
      options: {
        search: true,
        showTitle: true,
        pageSize: 5,
        pageSizeOptions: [5, 10, 20],
        headerSx: {
          backgroundColor: "rgba(255, 255, 255, 0.03)",
        },
        rowSx: {
          "&:hover": {
            backgroundColor: "rgba(255, 255, 255, 0.04)",
          },
        },
      },
      columns: [
        {
          title: "Model",
          field: "model",
          format: "${cellData || '-'}",
          sx: { fontWeight: 600 },
        },
        {
          title: "Provider",
          field: "provider",
          format: "${cellData ? cellData.toUpperCase() : '-'}",
          sx: { textTransform: "capitalize", opacity: 0.85 },
        },
        {
          title: "Tokens",
          field: "totalTokens",
          format: "${cellData != null ? Number(cellData).toLocaleString() : '0'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace" },
        },
        {
          title: "Cost ($)",
          field: "costUsd",
          format: "$${cellData != null ? Number(cellData).toFixed(4) : '0.0000'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace", color: "#fbbf24" },
        },
        {
          title: "Turns",
          field: "requests",
          format: "${cellData != null ? Number(cellData).toLocaleString() : '0'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace" },
        },
      ],
    },
  },

  // Provider Breakdown Table
  providerBreakdown: {
    "ui:widget": "MaterialTableWidget",
    "ui:title": "Usage by Provider",
    "ui:options": {
      showLabel: false,
      search: true,
      options: {
        search: true,
        showTitle: true,
        pageSize: 5,
        pageSizeOptions: [5, 10, 20],
        headerSx: {
          backgroundColor: "rgba(255, 255, 255, 0.03)",
        },
        rowSx: {
          "&:hover": {
            backgroundColor: "rgba(255, 255, 255, 0.04)",
          },
        },
      },
      columns: [
        {
          title: "Provider",
          field: "provider",
          format: "${cellData ? cellData.toUpperCase() : '-'}",
          sx: { fontWeight: 600, textTransform: "capitalize" },
        },
        {
          title: "Tokens",
          field: "totalTokens",
          format: "${cellData != null ? Number(cellData).toLocaleString() : '0'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace" },
        },
        {
          title: "Cost ($)",
          field: "costUsd",
          format: "$${cellData != null ? Number(cellData).toFixed(4) : '0.0000'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace", color: "#fbbf24" },
        },
        {
          title: "Turns",
          field: "requests",
          format: "${cellData != null ? Number(cellData).toLocaleString() : '0'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace" },
        },
      ],
    },
  },

  // Detailed Activity Records Ledger
  records: {
    "ui:widget": "MaterialTableWidget",
    "ui:title": "Recent AI Activity Ledger",
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
      columns: [
        {
          title: "Timestamp",
          field: "createdAt",
          format: "${cellData ? new Date(cellData).toLocaleString() : '-'}",
          sx: { whiteSpace: "nowrap" },
        },
        {
          title: "Persona",
          field: "personaId",
          format: "${cellData || '-'}",
          sx: { fontWeight: 500 },
        },
        {
          title: "Provider",
          field: "provider",
          format: "${cellData ? cellData.toUpperCase() : '-'}",
          sx: { textTransform: "capitalize" },
        },
        {
          title: "Model",
          field: "model",
          format: "${cellData || '-'}",
        },
        {
          title: "Prompt",
          field: "promptTokens",
          format: "${cellData != null ? Number(cellData).toLocaleString() : '0'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace" },
        },
        {
          title: "Output",
          field: "completionTokens",
          format: "${cellData != null ? Number(cellData).toLocaleString() : '0'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace" },
        },
        {
          title: "Total",
          field: "totalTokens",
          format: "${cellData != null ? Number(cellData).toLocaleString() : '0'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace", fontWeight: 600 },
        },
        {
          title: "Cost ($)",
          field: "costUsd",
          format: "$${cellData != null ? Number(cellData).toFixed(4) : '0.0000'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "monospace", color: "#fbbf24" },
        },
        {
          title: "Latency",
          field: "durationMs",
          format: "${cellData != null ? cellData + ' ms' : '-'}",
          headerProps: { align: "right" },
          sx: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
        },
        {
          title: "Status",
          field: "status",
          format: "${cellData ? cellData.toUpperCase() : 'OK'}",
          sx: { fontWeight: 600 },
        },
      ],
    },
  },
};

export default uiSchema;
