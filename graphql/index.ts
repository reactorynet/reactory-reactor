import Reactory from '@reactory/reactory-core';
import Directives from './directives';
import Types from './schema';
import Resolvers from './resolvers';

const ReactorGraphql: Reactory.Graph.IGraphDefinitions = {
  Resolvers,
  Types,
  Directives
};

export default ReactorGraphql;