import projectSchemaBase from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';
//import modules from './modules';

const ReactorProjectsMetricsPanel: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ProjectMetricsPanel@1.0.0',
  name: 'ProjectMetricsPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectSchemaBase,
  uiSchema,
  uiSchemas: [],
  graphql,
  modules: [],
  description: `A metrics panel for for a reactor project. This form displays basic statistics.`,
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
  ],
  title: 'Reactor Project Home Page',
  registerAsComponent: true,
};

export default ReactorProjectsMetricsPanel;
