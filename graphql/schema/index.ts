import { loadGraphQLTypeDefinitions } from '@reactory/server-core/graph/graphql-loader';

const ReactorTypeDefinitions = loadGraphQLTypeDefinitions(
  [
    'ReactorChat',
    'ReactorProviders',
    'ReactorCapabilities',
    'ReactorMessageProcessing',
    'ReactorSystemGraph'
  ],
  __dirname,
  'REACTOR'
);

export default ReactorTypeDefinitions;