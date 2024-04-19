import schema from './schema';
import GridUISchema, { GraphExplorerSchema } from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const GraphExplorerForm: Reactory.Forms.IReactoryForm = { 
  id: `reactor.GraphExplorerForm@1.0.0`,
  schema,
  description: `A D3 graph explorer for systems and their dependencies`,
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
  },
  {
    id: 'Graph',
    key: 'graph',
    description: 'Graph UI Schema',
    icon: 'link',
    title: 'Graph View',
    uiSchema: GraphExplorerSchema,
  }
],
  graphql: graphql,
  uiResources: [],
  helpTopics: ['help-logging-a-support-ticket'],
  title: "Reactory Graph Explorer",
  registerAsComponent: true,
  widgetMap: [
    { componentFqn: 'reactor.ReactorGraphExplorerWidget@1.0.0', widget: 'GraphExplorerWidget' }
  ],
  nameSpace: "reactor",
  name: "GraphExplorerForm",  
  version: '1.0.0',
  modules
}

export default GraphExplorerForm;