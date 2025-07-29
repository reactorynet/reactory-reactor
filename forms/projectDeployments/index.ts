import projectDeploymentsSchema from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const ReactorProjectDeploymentsForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ProjectDeploymentsPanel@1.0.0',
  name: 'ProjectDeploymentsPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectDeploymentsSchema,
  uiSchema,
  uiSchemas: [],
  graphql,
  modules,
  description: `A deployments panel for a reactor project. This form displays deployment information including deployment history, environments, status, and deployment metrics.`,
  argsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        title: 'Project Name',
        description: 'The name of the Reactor project to load. This is required to load the project deployment data.',
      },
    },
  },  
  uiFramework: 'material',
  uiSupport: ['material'],
  widgetMap: [    
  ],
  title: 'Reactor Project Deployments',
  registerAsComponent: true,
};

export default ReactorProjectDeploymentsForm; 