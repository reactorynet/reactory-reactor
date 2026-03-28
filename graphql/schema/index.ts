import { loadGraphQLTypeDefinitions } from '@reactory/server-core/graph/graphql-loader';

const ReactorTypeDefinitions = loadGraphQLTypeDefinitions(
  [
    'ReactorPersona',
    'ReactorChat',
    'ReactorProviders',
    'ReactorCapabilities',
    'ReactorMessageProcessing',
    // Instead of a single file, load all files in the new ReactorSystemGraph directory
    'ReactorSystemGraph/types',
    'ReactorSystemGraph/project',
    'ReactorSystemGraph/platform',
    'ReactorSystemGraph/ui',
    'ReactorSystemGraph/links',
    'ReactorSystemGraph/inputs',
    'ReactorSystemGraph/mutations',
    '../mcp/mcp',

    'ReactorSystemGraph/queries',
  ],
  __dirname,
  'REACTOR'
);

export default ReactorTypeDefinitions;