const uiSchema: Reactory.Schema.IFormUISchema = {
  "ui:field": "GridLayout",
  "ui:form": {
    toolbarStyle: {
      display: 'none',
      height: 0,
    },
    showSubmit: false,
    showRefresh: false,
    componentType: "div",
    style: {
      display: "flex",
      flexDirection: "column",    
    }
  },
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
      deploymentMetrics: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      environments: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
    },
    {
      recentDeployments: { xs: 12, sm: 12, md: 8, lg: 8, xl: 8 },
      deploymentConfig: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
    },
    {
      deploymentPipelines: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      deploymentAlerts: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
    },
  ],
  deploymentMetrics: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Deployment Metrics",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      chartType: 'line',
      dataKey: 'date',
      series: [
        { key: 'successfulDeployments', label: 'Successful', color: '#4caf50' },
        { key: 'failedDeployments', label: 'Failed', color: '#f44336' },
        { key: 'totalDeployments', label: 'Total', color: '#2196f3' }
      ]
    },
  },
  environments: {
    "ui:widget": "MaterialListWidget",
    "ui:title": "Environments",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      listItemProps: {
        primary: "${item.name}",
        secondary: "${item.currentVersion} - ${item.healthStatus}",
        action: {
          icon: "${item.healthStatus === 'HEALTHY' ? 'check_circle' : item.healthStatus === 'DEGRADED' ? 'warning' : 'error'}",
          color: "${item.healthStatus === 'HEALTHY' ? 'success' : item.healthStatus === 'DEGRADED' ? 'warning' : 'error'}"
        }
      }
    },
  },
  recentDeployments: {
    "ui:widget": "MaterialListWidget",
    "ui:title": "Recent Deployments",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      listItemProps: {
        primary: "${item.version} - ${item.environment}",
        secondary: "${item.deployedBy} - ${reactory.utils.humanDate.relativeTime(item.deployedAt)}",
        action: {
          icon: "${item.status === 'SUCCESS' ? 'check_circle' : item.status === 'FAILED' ? 'error' : item.status === 'IN_PROGRESS' ? 'hourglass_empty' : 'undo'}",
          color: "${item.status === 'SUCCESS' ? 'success' : item.status === 'FAILED' ? 'error' : item.status === 'IN_PROGRESS' ? 'warning' : 'default'}"
        }
      }
    },
  },
  deploymentConfig: {
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
        autoDeploy: { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 },
        rollbackEnabled: { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 },
        deploymentStrategy: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        deploymentTimeout: { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 },
        maxReplicas: { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 },
        minReplicas: { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 },
        healthCheckUrl: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      },
    ],
    autoDeploy: {
      "ui:widget": "LabelWidget",
      "ui:title": "Auto Deploy",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        forceShrinkLabel: true,
        icon: "${formData ? 'play_arrow' : 'pause'}",
        format: "${formData ? 'Enabled' : 'Disabled'}",
      },
    },
    rollbackEnabled: {
      "ui:widget": "LabelWidget",
      "ui:title": "Rollback Enabled",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "${formData ? 'undo' : 'block'}",
        format: "${formData ? 'Enabled' : 'Disabled'}",
      },
    },
    deploymentStrategy: {
      "ui:widget": "LabelWidget",
      "ui:title": "Deployment Strategy",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "deployment",
        format: "${formData || 'Not Set'}",
      },
    },
    deploymentTimeout: {
      "ui:widget": "LabelWidget",
      "ui:title": "Deployment Timeout",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "timer",
        format: "${formData || 0} minutes",
      },
    },
    maxReplicas: {
      "ui:widget": "LabelWidget",
      "ui:title": "Max Replicas",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "expand_less",
        format: "${formData || 0}",
      },
    },
    minReplicas: {
      "ui:widget": "LabelWidget",
      "ui:title": "Min Replicas",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        icon: "expand_more",
        format: "${formData || 0}",
      },
    },
    healthCheckUrl: {
      "ui:widget": "LinkFieldWidget",
      "ui:title": "Health Check URL",
      "ui:options": {
        format: '${formData || "#"}',
        title: '${formData ? "Check Health" : "No Health Check URL"}',
        icon: "health_and_safety",
        openInNewWindow: true,
        sx: {
          textTransform: "none",
          textAlign: "left",
        },
      },
    },
  },
  deploymentPipelines: {
    "ui:widget": "MaterialListWidget",
    "ui:title": "Deployment Pipelines",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      listItemProps: {
        primary: "${item.name}",
        secondary: "${item.successRate}% success rate - ${reactory.utils.humanDate.relativeTime(item.lastRun)}",
        action: {
          icon: "pipeline",
          color: "${item.successRate >= 90 ? 'success' : item.successRate >= 70 ? 'warning' : 'error'}"
        }
      }
    },
  },
  deploymentAlerts: {
    "ui:widget": "MaterialListWidget",
    "ui:title": "Deployment Alerts",
    "ui:options": {
      showLabel: true,
      showUnit: false,
      listItemProps: {
        primary: "${item.type}",
        secondary: "${item.message} - ${reactory.utils.humanDate.relativeTime(item.createdAt)}",
        action: {
          icon: "${item.severity === 'CRITICAL' ? 'error' : item.severity === 'HIGH' ? 'warning' : item.severity === 'MEDIUM' ? 'info' : 'help'}",
          color: "${item.severity === 'CRITICAL' ? 'error' : item.severity === 'HIGH' ? 'warning' : item.severity === 'MEDIUM' ? 'info' : 'default'}"
        }
      }
    },
  },
};

export default uiSchema; 