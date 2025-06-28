import projectSchemaBase from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const ReactorProjectsHomeForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ReactorProjectHome@1.0.0',
  name: 'ReactorProjectHome',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema: projectSchemaBase,
  uiSchema,
  graphql,
  modules,
  description: 'A form interface for view, managing and interacting with a Reactor project.',
  uiFramework: 'material',
  uiSupport: ['material'],
  widgetMap: [    
  ],
  title: 'Reactor Project Home Page',
  registerAsComponent: true,
};

export default ReactorProjectsHomeForm;
