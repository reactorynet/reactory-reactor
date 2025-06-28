import Reactory from "@reactory/reactory-core";

const uiSchema: Reactory.Schema.IFormUISchema = {
  "ui:form": {
    showSubmit: false,
    showHelp: false,
    showRefresh: false,
  },
  'ui:field': 'GridLayout',
  'ui:grid-layout': [
    { 
     overview: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 }, 
     metrics: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 } 
    },
    { 
     documentation: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 }, 
     team: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 } 
    }
  ],
  overview: {
    'ui:widget': 'core.ProjectOverviewCard@1.0.0',
    'ui:options': { showStatus: true, showTags: true, showRepo: true }
  },
  metrics: {
    'ui:widget': 'core.ProjectMetricsCard@1.0.0',
    'ui:options': { showDeployments: true, showDashboards: true, showEngineers: true, showBranches: true, showErrors: true, showNotes: true }
  },
  documentation: {
    'ui:widget': 'core.ProjectDocumentationCard@1.0.0',
    'ui:options': { showPrimary: true, showSecondary: true }
  },
  team: {
    'ui:widget': 'core.ProjectTeamCard@1.0.0',
    'ui:options': { showOwner: true, showTeams: true, showEngineers: true }
  }
};

export default uiSchema;
