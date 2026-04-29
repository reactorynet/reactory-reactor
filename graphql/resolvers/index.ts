import { mergeGraphResolver } from '@reactory/server-core/utils';
import ReactorChat from './ReactorChat';
import ReactorPersona from './ReactorPersona';
import ReactorMacro from './ReactorMacro';
import ReactorTool from './ReactorTool';
import ReactorSystemGraph from './ReactorSystemGraph';
import ReactorSystem from './Platform/ReactorSystem';
import ReactorProviders from './ReactorProviders';
import MCPRegistryResolvers from '../mcp/resolvers';

import ReactorProviderAuth from './ReactorProviderAuth';
import ReactorBudget from './ReactorBudget';

export default mergeGraphResolver([
  ReactorChat,
  ReactorSystemGraph,
  ReactorPersona,
  ReactorMacro,
  ReactorTool,
  ReactorSystem,
  MCPRegistryResolvers,

  ReactorProviders,
  ReactorProviderAuth,
  ReactorBudget,
]);