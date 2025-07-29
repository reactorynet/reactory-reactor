import ReactorProjectSchemaResolver from './schema';
import {
  ProjectListUiSchema,
  ProjectGridUISchema
} from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const ServiceCatalogForm: Reactory.Forms.IReactoryForm = { 
  id: `reactor.ServiceCatalog@1.0.0`,
  name: 'ServiceCatalog',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: ReactorProjectSchemaResolver,
  description: `The service catalogue provides a comprehensive list of all projects and services that are available to the user`,
  uiFramework: 'material',
  uiSupport: ['material'],
  uiSchema: ProjectGridUISchema,
  uiSchemas: [{
    id: 'Default',
    key: 'default',
    description: 'Grid UI Schema',
    icon: 'table',
    title: 'Grid View',
    uiSchema: ProjectGridUISchema,
  },
  {
    id: 'List',
    key: 'list',
    description: 'List UI Schema',
    icon: 'list',
    title: 'List View',
    uiSchema: ProjectListUiSchema,
  }],
  graphql: graphql,
  uiResources: [],
  helpTopics: ['reactor-service-catalogue'],
  title: "Reactory Service Catalog",
  registerAsComponent: true,
  widgetMap: [    
  ],
  modules
}

export default ServiceCatalogForm;