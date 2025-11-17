import projectHistorySchema from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const ReactorProjectHistoryForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ProjectHistoryPanel@1.0.0',
  name: 'ProjectHistoryPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectHistorySchema,
  uiSchema,
  uiSchemas: [],
  graphql,
  modules,
  description: `A history panel for a reactor project. This form displays an audit history of changes made to the project including incidents, deployments, tasks, notes, documentation, security, team changes, and metrics updates.`,
  argsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        title: 'Project Name',
        description: 'The name of the Reactor project to load. This is required to load the project history data.',
      },
    },
  },  
  uiFramework: 'material',
  uiSupport: ['material'],
  widgetMap: [    
  ],
  title: 'Reactor Project History',
  registerAsComponent: true,
};

export default ReactorProjectHistoryForm;
