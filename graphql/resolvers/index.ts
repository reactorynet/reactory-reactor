import { mergeGraphResolver } from '@reactory/server-core/utils';
import ReactorChat from './ReactorChat';
import ReactorPersona from './ReactorPersona';
import ReactorMacro from './ReactorMacro';
import ReactorTool from './ReactorTool';
import ReactorSystemGraph from './ReactorSystemGraph';
import ReactorSystem from './Platform/ReactorSystem';

export default mergeGraphResolver([
  ReactorChat,
  ReactorSystemGraph,
  ReactorPersona,
  ReactorMacro,
  ReactorTool,
  ReactorSystem
]);