import projectSchemaBase from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';
//import modules from './modules';

const ReactorProjectsInfoPanel: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ProjectInfoPanel@1.0.0',
  name: 'ProjectInfoPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectSchemaBase,
  uiSchema,
  uiSchemas: [],
  graphql,
  modules: [],
  description: `An info panel for for a reactor project. This form displays basic statistics.`,
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

export default ReactorProjectsInfoPanel;
