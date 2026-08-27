import { mergeGraphResolver } from '@reactory/server-core/utils';
import ReactorChat from './ReactorChat';
import ReactorPersona from './ReactorPersona';
import ReactorMacro from './ReactorMacro';
import ReactorTool from './ReactorTool';
import ReactorSystemGraph from './ReactorSystemGraph';
import ReactorGraphPerspective from './ReactorGraphPerspective';
import ReactorSystem from './Platform/ReactorSystem';
import ReactorProviders from './ReactorProviders';
import MCPRegistryResolvers from '../mcp/resolvers';
import ReactorProviderAuth from './ReactorProviderAuth';
import ReactorAIUsage from './ReactorAIUsage';

export default mergeGraphResolver([
  ReactorChat,
  ReactorSystemGraph,
  ReactorGraphPerspective,
  ReactorPersona,
  ReactorMacro,
  ReactorTool,
  ReactorSystem,
  MCPRegistryResolvers,
  ReactorProviders,
  ReactorProviderAuth,
  ReactorAIUsage,
]);
