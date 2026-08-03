import schema from './schema';
import GridUISchema from './uiSchema';
import graphql from './graphql';
import modules from './modules';

// The D3 "Graph View" uiSchema and its reactor.ReactorGraphExplorerWidget
// were removed — graph exploration now lives in the first-class three.js
// component core.GraphExplorer@1.0.0 on the /reactor/graph/:catalogId route.
const GraphExplorerForm: Reactory.Forms.IReactoryForm = {
  id: `reactor.ServiceGraph@1.0.0`,
  schema,
  description: `A graph explorer for systems and their dependencies`,
  uiFramework: 'material',
  uiSupport: ['material'],
  uiSchema: GridUISchema,
  uiSchemas: [{
    id: 'Default',
    key: 'default',
    description: 'Grid UI Schema',
    icon: 'table',
    title: 'Grid View',
    uiSchema: GridUISchema,
  }],
  graphql: graphql,
  uiResources: [],
  helpTopics: ['help-logging-a-support-ticket'],
  title: "Reactory Graph Explorer",
  registerAsComponent: true,
  nameSpace: "reactor",
  name: "ServiceGraph",
  version: '1.0.0',
  modules
}

export default GraphExplorerForm;