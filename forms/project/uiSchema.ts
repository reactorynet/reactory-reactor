import Reactory from "@reactorynet/reactory-core";

const uiSchema: Reactory.Schema.IFormUISchema = {
  "ui:form": {
    showSubmit: false,
    showHelp: false,
    showRefresh: false,
  },
  "ui:field": "TabbedLayout",
  "ui:tab-layout": [
    {
      field: "overview",
      icon: "info",
      title: "Overview",
    },
    {
      field: "incidents",
      icon: "warning",
      title: "Incidents",
    },
    {
      field: "metrics",
      icon: "bar_chart",
      title: "Metrics",
    },
    {
      field: "deployments",
      icon: "cloud_upload",
      title: "Deployments",
    },
    {
      field: "documentation",
      icon: "description",
      title: "Documentation",
    },
    {
      field: "team",
      icon: "people",
      title: "Team",
    },
    {
      field: "security",
      icon: "security",
      title: "Security",
    },
    {
      field: "history",
      icon: "history",
      title: "History",
    },    
  ],
  "ui:options": {
    activeTab: "query",
    activeTabKey: "tab",
  },
  "ui:tab-options": {
    useRouter: true,
    path: "/reactor/service/${formContext.props.serviceId}?tab=${tab_id}",
  },
  overview: {
    "ui:widget": "ProjectOverviewPanel",     
    "ui:props-map": {
      'formContext.props.serviceId': 'serviceId',
      'formContext.props.mode': 'mode',
    },
    "ui:props-options": {
      // mergeStrategy: 'replace',
    },
  },
  metrics: {
    "ui:widget": "ProjectMetricsPanel",
    "ui:props-map": {
      'formContext.props.serviceId': 'serviceId',
      'formContext.props.mode': 'mode',
    },
    "ui:props-options": {
      // mergeStrategy: 'replace',
    },
  },
  incidents: {
    "ui:widget": "ProjectIncidentsPanel",
    "ui:props-map": {
      'formContext.props.serviceId': 'serviceId',
      'formContext.props.mode': 'mode',
    },
    "ui:props-options": {
      // mergeStrategy: 'replace',
    },
  },
  deployments: {
    "ui:widget": "ProjectDeploymentsPanel",
    "ui:props-map": {
      'formContext.props.serviceId': 'serviceId',
      'formContext.props.mode': 'mode',
    },
    "ui:props-options": {
      // mergeStrategy: 'replace',
    },
  },
  documentation: {
    "ui:widget": "ProjectDocumentationPanel",
    "ui:props-map": {
      'formContext.props.serviceId': 'serviceId',
      'formContext.props.mode': 'mode',
    },
    "ui:props-options": {
      // mergeStrategy: 'replace',
    },
  },
  team: {
    "ui:widget": "ProjectTeamPanel",
    "ui:props-map": {
      'formContext.props.serviceId': 'serviceId',
      'formContext.props.mode': 'mode',
    },    
    "ui:props-options": {
      // mergeStrategy: 'replace',
    },
  },
  history: {
    "ui:widget": "ProjectHistoryPanel",
    "ui:props-map": {
      'formContext.props.serviceId': 'serviceId',
      'formContext.props.mode': 'mode',
    },
    "ui:props-options": {
      // mergeStrategy: 'replace',
    },
  },
  security: {
    "ui:widget": "ProjectSecurityPanel",
    "ui:props-map": {
      'formContext.props.serviceId': 'serviceId',
      'formContext.props.mode': 'mode',
    },
    "ui:props-options": {
      // mergeStrategy: 'replace',
    },
  },
};

export default uiSchema;

/*
    activeIncidents: {
      "ui:widget": "MaterialListWidget",
      "ui:title": "Active Incidents",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        listItemProps: {
          primary: "${item}",
          secondary: "Active",
          action: {
            icon: "warning",
            color: "error"
          }
        }
      },
    },
    resolvedIncidents: {
      "ui:widget": "MaterialListWidget",
      "ui:title": "Resolved Incidents",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        listItemProps: {
          primary: "${item}",
          secondary: "Resolved",
          action: {
            icon: "check_circle",
            color: "success"
          }
        }
      },
    },
    incidentHistory: {
      "ui:widget": "MaterialListWidget",
      "ui:title": "Incident History",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        listItemProps: {
          primary: "${item}",
          secondary: "Historical",
          action: {
            icon: "history",
            color: "default"
          }
        }
      },
    },
  },
  history: {
    "ui:field": "GridLayout",
    "ui:grid-options": {
      container: 'Paper',
      containerProps: {
        elevation: 0,
        square: true,
        variant: 'outlined',
        sx: {
          padding: 2,
          marginTop: 2,
          marginBottom: 2,
          minHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
        },
      },
    },
    "ui:grid-layout": [
      {
        deployments: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
        alerts: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      },
    ],
    deployments: {
      "ui:widget": "MaterialListWidget",
      "ui:title": "Deployment History",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        listItemProps: {
          primary: "${item.environment?.name || 'Unknown Environment'}",
          secondary: "${item.status} - ${item.created}",
          action: {
            icon: "deployment",
            color: "${item.status === 'SUCCESS' ? 'success' : item.status === 'FAILED' ? 'error' : 'default'}"
          }
        }
      },
    },
    alerts: {
      "ui:widget": "MaterialListWidget",
      "ui:title": "Alert History",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        listItemProps: {
          primary: "${item.alertType}",
          secondary: "${item.status} - ${item.created}",
          action: {
            icon: "notifications",
            color: "${item.status === 'ACTIVE' ? 'error' : 'default'}"
          }
        }
      },
    },
  },
  security: {
    "ui:field": "GridLayout",
    "ui:grid-options": {
      container: 'Paper',
      containerProps: {
        elevation: 0,
        square: true,
        variant: 'outlined',
        sx: {
          padding: 2,
          marginTop: 2,
          marginBottom: 2,
          minHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
        },
      },
    },
    "ui:grid-layout": [
      {
        dataClassification: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
        vulnerabilityStatus: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
        lastSecurityReview: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
        encryptionAtRest: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
        encryptionInTransit: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
        dependenciesWithKnownVulnerabilities: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
        securityNotes: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        securityPoliciesUrl: { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 },
        vulnerabilityReportUrl: { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 },
      },
    ],
    dataClassification: {
      "ui:widget": "LabelWidget",
      "ui:title": "Data Classification",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "security",
      },
    },
    vulnerabilityStatus: {
      "ui:widget": "LabelWidget",
      "ui:title": "Vulnerability Status",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "bug_report",
      },
    },
    lastSecurityReview: {
      "ui:widget": "LabelWidget",
      "ui:title": "Last Security Review",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "calendar_today",
        format: '${formData ? reactory.utils.humanDate.relativeTime(formData) : "Never"}',
      },
    },
    encryptionAtRest: {
      "ui:widget": "LabelWidget",
      "ui:title": "Encryption At Rest",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "${formData ? 'lock' : 'lock_open'}",
        format: "${formData ? 'Enabled' : 'Disabled'}",
      },
    },
    encryptionInTransit: {
      "ui:widget": "LabelWidget",
      "ui:title": "Encryption In Transit",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "${formData ? 'lock' : 'lock_open'}",
        format: "${formData ? 'Enabled' : 'Disabled'}",
      },
    },
    dependenciesWithKnownVulnerabilities: {
      "ui:widget": "LabelWidget",
      "ui:title": "Known Vulnerabilities",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "warning",
        format: "${formData || 0} vulnerabilities found",
      },
    },
    securityNotes: {
      "ui:widget": "StaticContentWidget",
      "ui:title": "Security Notes",
      "ui:options": {
        showLabel: true,
        showUnit: false,
      },
    },
    securityPoliciesUrl: {
      "ui:widget": "LinkFieldWidget",
      "ui:title": "Security Policies",
      "ui:options": {
        format: '${formData || "#"}',
        title: '${formData ? "View Policies" : "No Policies URL"}',
        icon: "policy",
        openInNewWindow: true,
        sx: {
          textTransform: "none",
          textAlign: "left",
        },
      },
    },
    vulnerabilityReportUrl: {
      "ui:widget": "LinkFieldWidget",
      "ui:title": "Vulnerability Report",
      "ui:options": {
        format: '${formData || "#"}',
        title: '${formData ? "View Report" : "No Report URL"}',
        icon: "assessment",
        openInNewWindow: true,
        sx: {
          textTransform: "none",
          textAlign: "left",
        },
      },
    },
  },
*/
