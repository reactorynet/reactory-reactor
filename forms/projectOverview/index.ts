import projectSchemaBase from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';

const ReactorProjectOverviewForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ProjectOverviewPanel@1.0.0',
  name: 'ProjectOverviewPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectSchemaBase,
  uiSchema,
  uiSchemas: [],
  graphql,
  modules: [],
  description: `An overview panel for a reactor project. This form displays basic project information including status, owner, and key details.`,
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
  backButton: true,
  title: 'Reactor Project Overview',
  registerAsComponent: true,
};

export default ReactorProjectOverviewForm; 