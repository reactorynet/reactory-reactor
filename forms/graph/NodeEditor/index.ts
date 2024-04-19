import schema from './schema';
import GridUISchema, { GraphExplorerSchema } from './uiSchema';
import graphql from './graphql';
import modules from './modules';

const GraphExplorerForm: Reactory.Forms.IReactoryForm = { 
  id: `reactor.GraphNodeEditor@1.0.0`,
  schema,
  description: `A graph node editor form`,
  uiFramework: 'material',
  uiSupport: ['material'],
  uiSchema: GridUISchema,
  uiSchemas: [,  ],
  graphql: graphql,
  uiResources: [],
  helpTopics: ['help-logging-a-support-ticket'],
  title: "Reactor Node Graph Editor",
  registerAsComponent: true,
  widgetMap: [],
  nameSpace: "reactor",
  name: "GraphNodeEditor",  
  version: '1.0.0',
  modules
}

export default GraphExplorerForm;