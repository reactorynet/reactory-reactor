import schema from './schema';
import uiSchema from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const ReactorProjectsHomeForm: Reactory.Forms.IReactoryForm = {
  id: 'reactor.ReactorProjectsHome@1.0.0',
  name: 'ReactorProjectsHome',
  nameSpace: 'reactor',
  version: '1.0.0',
  schema,
  uiSchema,
  graphql,
  modules,
  description: 'A home page for browsing Reactory projects.',
  uiFramework: 'material',
  uiSupport: ['material'],
  widgetMap: [
    {
      componentFqn: 'reactor.ReactorProjectsHomeWidget@1.0.0',
      widget: 'ReactorProjectsHomeWidget',
    },
  ],
  title: 'Reactory Projects Home',
  registerAsComponent: true,
};

export default ReactorProjectsHomeForm;
