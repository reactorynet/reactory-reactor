import projectTeamSchema from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';

const ReactorProjectTeamForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ProjectTeamPanel@1.0.0',
  name: 'ProjectTeamPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectTeamSchema,
  uiSchema,
  uiSchemas: [],
  graphql,
  modules: [],
  description: `A team panel for a reactor project. This form displays team information including project owner, teams, engineers, and organizational structure.`,
  argsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        title: 'Project Name',
        description: 'The name of the Reactor project to load. This is required to load the project team data.',
      },
    },
  },  
  uiFramework: 'material',
  uiSupport: ['material'],
  widgetMap: [    
  ],
  title: 'Reactor Project Team',
  registerAsComponent: true,
};

export default ReactorProjectTeamForm; 