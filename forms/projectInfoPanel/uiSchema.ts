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
      incidents: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      openPullRequests: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      errors: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      deployments: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      activeTasks: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      closedTasks: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      openedTasks: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      totalBranches: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      totalTeams: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      totalEngineers: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      owner: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      ownerTeam: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
    },
  ],
  incidents: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Incidents",
    "ui:options": {
      showLabel: true,
      showUnit: false,      
    },
  },
  openPullRequests: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Open Pull Requests",
    "ui:options": {
      showLabel: true,
      showUnit: false,
    },
  },
  activeDeployments: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Active Deployments",
    "ui:options": {
      showLabel: true,
      showUnit: false,
    },
  },
  activeTasks: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Active Tasks",
    "ui:options": { 
      showLabel: true,
      showUnit: false,
    },
  },
  closedPullRequests: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Closed Pull Requests",
    "ui:options": {
      showLabel: true,
      showUnit: false,
    }, 
   },
  closedTasks: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Closed Tasks",
    "ui:options": {
      showLabel: true,
      showUnit: false,
    },
  },
  openedTasks: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Opened Tasks",
    "ui:options": {
      showLabel: true,
      showUnit: false,
    },
  },
  totalBranches: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Total Branches",
    "ui:options": {
      showLabel: true,
      showUnit: false,
    },
  },
  totalTeams: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Total Teams",
    "ui:options": {
      showLabel: true,
      showUnit: false,
    },
  },
  totalEngineers: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Total Engineers",
    "ui:options": {
      showLabel: true,
      showUnit: false,
    },
  },
  owner: {
    "ui:widget": "LinkFieldWidget",    
    "ui:options": {
      format: "/people/${formData?.id?.toLowerCase()}?tab=team&action=setOwner",
      title: "${formData?.firstName || 'Not'} ${formData?.lastName || 'Set'}",
      icon: "navigate_next",
      forceShrinkLabel: true,
      sx: {
        textTransform: "none",
        textAlign: "left",
      },
    },
  },
  ownerTeam: {
    "ui:widget": "LinkFieldWidget",   
    "ui:options": {
      format: "/team/${formData?.name?.toLowerCase()}",
      title: "${formData?.name || 'Not Set'}",
      icon: "navigate_next",
      forceShrinkLabel: true,
      sx: {
        textTransform: "none",
        textAlign: "left",
      },
    },
  },
  deployments: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Deployments",
    "ui:options": {
      showLabel: true,
      showUnit: false,
    },
  },
  errors: {
    "ui:widget": "LineChartWidget",
    "ui:title": "Errors",
    "ui:options": {
      showLabel: true,
      showUnit: false,
    },
  },
};

export default uiSchema;
