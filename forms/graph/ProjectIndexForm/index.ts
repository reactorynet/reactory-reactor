import schema from './schema';
import GridUISchema from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const ProjectIndexForm: Reactory.Forms.IReactoryForm = { 
  id: `reactor.ProjectIndexForm@1.0.0`,
  schema,
  description: `This form is used to manage indexing of a project`,
  uiFramework: 'material',
  uiSupport: ['material'],
  uiSchema: GridUISchema,
  uiSchemas: [ ],
  graphql: graphql,
  uiResources: [],
  helpTopics: ['reactor-project-index-form-help'],
  title: "Reactor Project Indexing Form",
  registerAsComponent: true,
  widgetMap: [],
  nameSpace: "reactor",
  name: "ProjectIndexForm",  
  version: '1.0.0',
  modules
}

export default ProjectIndexForm;