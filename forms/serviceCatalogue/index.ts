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
  description: `A form for managing the Reactory Service Catalog`,
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
  helpTopics: [''],
  title: "Reactory Service Catalog",
  registerAsComponent: true,
  widgetMap: [    
  ],
  modules
}

export default ServiceCatalogForm;