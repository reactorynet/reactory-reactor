import projectSchemaBase from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';

const ReactorProjectDocumentationForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ProjectDocumentationPanel@1.0.0',
  name: 'ProjectDocumentationPanel',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectSchemaBase,
  uiSchema,
  uiSchemas: [],
  graphql,
  modules: [],
  description: `A documentation panel for a reactor project. This form displays project documentation including primary and additional documentation files.`,
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
  title: 'Reactor Project Documentation',
  registerAsComponent: true,
};

export default ReactorProjectDocumentationForm; 