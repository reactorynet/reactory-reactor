import { mergeGraphResolver } from '@reactory/server-core/utils';
import ReactorChat from './ReactorChat';
import ReactorSystemGraph from './ReactorSystemGraph';

export default mergeGraphResolver([
  ReactorChat,
  ReactorSystemGraph,
]);