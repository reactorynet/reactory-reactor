const uiSchema: Reactory.Schema.IFormUISchema = {
  "ui:field": "GridLayout",
  "ui:form": {
    toolbarStyle: {
      display: "none",
      height: 0,
    },
    showSubmit: false,
    showRefresh: false,
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
        border: "none",
        padding: 0,
        marginTop: 0,
        marginBottom: 0,
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
      },
    },
  },
  "ui:grid-layout": [
    {
      incidentActive: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      incidentCount: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      incidentTrend: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      mttr: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      mtta: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      lastIncidentDate: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      alerts: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      errors: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      projectMetrics: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
  ],
  incidentActive: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: "Active Incident",
      description: '${formData === true ? "🚨 Incident is currently active!" : "✅ No active incidents"}',
      avatar: "${formData === true ? '🚨' : '✅'}",
      headerOptions: {
        sx: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          marginTop: "16px",
          marginBottom: "16px",
        },
      },
      imageOptions: {
        sx: {
          width: 80,
          height: 80,
          borderRadius: "50%",
          border: "2px solid #000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "2rem",
          backgroundColor: "${formData === true ? '#ffebee' : '#e8f5e8'}",
        },
      },
    },
  },
  incidentCount: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: "Total Incidents",
      description: '${formData || 0} incidents recorded',
      avatar: "${formData > 0 ? '📊' : '📈'}",
      headerOptions: {
        sx: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          marginTop: "16px",
          marginBottom: "16px",
        },
      },
      imageOptions: {
        sx: {
          width: 80,
          height: 80,
          borderRadius: "50%",
          border: "2px solid #000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "2rem",
          backgroundColor: "#e3f2fd",
        },
      },
    },
  },
  incidentTrend: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: "Incident Trend",
      description: '${formData || "Unknown"}',
      avatar: "${formData === 'DECREASING' ? '📉' : formData === 'INCREASING' ? '📈' : formData === 'STABLE' ? '➡️' : '❓'}",
      headerOptions: {
        sx: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          marginTop: "16px",
          marginBottom: "16px",
        },
      },
      imageOptions: {
        sx: {
          width: 80,
          height: 80,
          borderRadius: "50%",
          border: "2px solid #000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "2rem",
          backgroundColor: "#f3e5f5",
        },
      },
    },
  },
  mttr: {
    "ui:widget": "LabelWidget",
    "ui:options": {
      showLabel: true,
      forceShrinkLabel: true,
      format: "${formData ? formData + ' hours' : 'No data available'}",
      emptyText: "No data available"
    }
  },
  mtta: {
    "ui:widget": "LabelWidget",
    "ui:options": {
      showLabel: true,
      forceShrinkLabel: true,
      format: "${formData ? formData + ' hours' : 'No data available'}",
      emptyText: "No data available"
    }
  },
  lastIncidentDate: {
    "ui:widget": "LabelWidget",
    "ui:options": {
      showLabel: true,
      forceShrinkLabel: true,
      format: "${formData ? reactory.utils.humanDate.relativeTime(reactory.utils.moment(formData)) : 'No incidents recorded'}",
      emptyText: "No incidents recorded"
    }
  },
  alerts: {
    "ui:widget": "ArrayFieldWidget",
    "ui:options": {
      title: "Active Alerts",
      description: "Current alerts and notifications for this project",
      sx: {
        marginTop: "16px",
        marginBottom: "16px",
      },
      itemWidget: "CardWidget",
      itemOptions: {
        title: '${formData?.alertType || "Unknown Alert"}',
        description: '${formData?.message || "No message"}',
        avatar: "${formData?.severity === 'CRITICAL' ? '🔴' : formData?.severity === 'HIGH' ? '🟠' : formData?.severity === 'MEDIUM' ? '🟡' : '🟢'}",
        headerOptions: {
          sx: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            marginTop: "8px",
            marginBottom: "8px",
          },
        },
        imageOptions: {
          sx: {
            width: 60,
            height: 60,
            borderRadius: "50%",
            border: "2px solid #000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.5rem",
          },
        },
        actions: [
          {
            icon: "visibility",
            onClick: "window.open('/reactor/alert/${item?.id || \"alert missing\"}', '_blank')",
          },
        ],
      },
    },
  },
  errors: {
    "ui:widget": "ArrayFieldWidget",
    "ui:options": {
      title: "Recent Errors",
      description: "Recent errors and incidents for this project",
      sx: {
        marginTop: "16px",
        marginBottom: "16px",
      },
      itemWidget: "CardWidget",
      itemOptions: {
        title: '${formData?.provider || "Unknown Provider"}',
        description: '${formData?.message || "No error message"}',
        avatar: "⚠️",
        headerOptions: {
          sx: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            marginTop: "8px",
            marginBottom: "8px",
          },
        },
        imageOptions: {
          sx: {
            width: 60,
            height: 60,
            borderRadius: "50%",
            border: "2px solid #ff9800",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.5rem",
            backgroundColor: "#fff3e0",
          },
        },
        actions: [
          {
            icon: "bug_report",
            onClick: "window.open('${formData?.link || \"#\"}', '_blank')",
          },
        ],
      },
    },
  },
  projectMetrics: {
    "ui:widget": "ArrayFieldWidget",
    "ui:options": {
      title: "Historical Metrics",
      description: "Historical incident and error metrics",
      sx: {
        marginTop: "16px",
        marginBottom: "16px",
      },
      itemWidget: "CardWidget",
      itemOptions: {
        title: '${reactory.utils.humanDate.format(reactory.utils.moment(formData?.date), "MMM DD, YYYY")}',
        description: '${formData?.incidents || 0} incidents, ${formData?.errors || 0} errors',
        avatar: "📊",
        headerOptions: {
          sx: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            marginTop: "8px",
            marginBottom: "8px",
          },
        },
        imageOptions: {
          sx: {
            width: 60,
            height: 60,
            borderRadius: "50%",
            border: "2px solid #2196f3",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.5rem",
            backgroundColor: "#e3f2fd",
          },
        },
      },
    },
  },
};

export default uiSchema; 