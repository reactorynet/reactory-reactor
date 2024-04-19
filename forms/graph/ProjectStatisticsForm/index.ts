import schema from './schema';
import GridUISchema from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const ProjectStatisticsForm: Reactory.Forms.IReactoryForm = { 
  id: `reactor.ProjectStatisticsForm@1.0.0`,
  schema,
  description: `A graph node editor form`,
  uiFramework: 'material',
  uiSupport: ['material'],
  uiSchema: GridUISchema,
  uiSchemas: [ ],
  graphql: graphql,
  uiResources: [],
  helpTopics: ['reactor-project-statistics-form-help'],
  title: "Reactor Node Statistics Form",
  registerAsComponent: true,
  widgetMap: [],
  nameSpace: "reactor",
  name: "ProjectStatisticsForm",  
  version: '1.0.0',
  modules
}

export default ProjectStatisticsForm;