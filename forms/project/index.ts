import projectSchemaBase from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const ReactorProjectsHomeForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ReactorProjectHome@1.0.0',
  name: 'ReactorProjectHome',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectSchemaBase,
  uiSchema,
  uiSchemas: [],  
  modules,
  description: `A form interface for view, managing and interacting with a Reactor project. Requires a project name to be passed in as a prop. The form will query the ReactorProjectByName GraphQL query to retrieve the project data.`,
  argsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        title: 'Project Name',
        description: 'The name of the Reactor project to load. This is required to load the project data.',
      },
    },
  },  
  uiFramework: 'material',
  uiSupport: ['material'],
  widgetMap: [
    {
      componentFqn: 'reactor.ProjectInfoPanel@1.0.0',
      widget: 'ProjectInfoPanel',      
    },
    {
      componentFqn: 'reactor.ProjectMetricsPanel@1.0.0',
      widget: 'ProjectMetricsPanel',      
    },
    {
      componentFqn: 'reactor.ProjectOverviewPanel@1.0.0',
      widget: 'ProjectOverviewPanel',      
    },
    {
      componentFqn: 'reactor.ProjectDocumentationPanel@1.0.0',
      widget: 'ProjectDocumentationPanel',      
    },
    {
      componentFqn: 'reactor.ProjectTasksPanel@1.0.0',
      widget: 'ProjectTasksPanel',      
    },
    {
      componentFqn: 'reactor.ProjectNotesPanel@1.0.0',
      widget: 'ProjectNotesPanel',      
    },
    {
      componentFqn: 'reactor.ProjectDeploymentsPanel@1.0.0',
      widget: 'ProjectDeploymentsPanel',      
    },
    {
      componentFqn: 'reactor.ProjectIncidentsPanel@1.0.0',
      widget: 'ProjectIncidentsPanel',      
    },
    {
      componentFqn: 'reactor.ProjectSecurityPanel@1.0.0',
      widget: 'ProjectSecurityPanel',
    },
    {
      componentFqn: 'reactor.ProjectTeamPanel@1.0.0',
      widget: 'ProjectTeamPanel',
    },
    {
      componentFqn: 'reactor.ProjectHistoryPanel@1.0.0',
      widget: 'ProjectHistoryPanel',
    },
    {
      componentFqn: 'reactor.ProjectNotesPanel@1.0.0',
      widget: 'ProjectNotesPanel',
    },    
  ],
  title: 'Reactor Project Home Page',
  registerAsComponent: true,
};

export default ReactorProjectsHomeForm;
