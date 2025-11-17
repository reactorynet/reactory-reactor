import projectSecuritySchema from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';

const ReactorProjectSecurityForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ProjectSecurityPanel@1.0.0',
  name: 'ProjectSecurityPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectSecuritySchema,
  uiSchema,
  uiSchemas: [],
  graphql,
  modules: [],
  description: `A security panel for a reactor project. This form displays security information including risk levels, compliance standards, vulnerability status, and security contacts.`,
  argsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        title: 'Project Name',
        description: 'The name of the Reactor project to load. This is required to load the project security data.',
      },
    },
  },  
  uiFramework: 'material',
  uiSupport: ['material'],
  widgetMap: [    
  ],
  title: 'Reactor Project Security',
  registerAsComponent: true,
};

export default ReactorProjectSecurityForm; 