import projectIncidentsSchema from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';

const ReactorProjectIncidentsForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ProjectIncidentsPanel@1.0.0',
  name: 'ProjectIncidentsPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectIncidentsSchema,
  uiSchema,
  uiSchemas: [],
  graphql,
  modules: [],
  description: `An incidents panel for a reactor project. This form displays incident information including active incidents, alerts, errors, and historical metrics.`,
  argsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        title: 'Project Name',
        description: 'The name of the Reactor project to load. This is required to load the project incident data.',
      },
    },
  },  
  uiFramework: 'material',
  uiSupport: ['material'],
  widgetMap: [    
  ],
  title: 'Reactor Project Incidents',
  registerAsComponent: true,
};

export default ReactorProjectIncidentsForm; 