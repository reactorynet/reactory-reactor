import Reactory from '@reactorynet/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';
import path from 'path';

const { 
  NODE_ENV
} = process.env;
const fileType = NODE_ENV === 'development' ? 'tsx' : 'js';

// The reactor.ReactorGraphExplorerWidget (D3) module was removed — graph
// exploration now lives in the first-class client component
// core.GraphExplorer@1.0.0. The workflow module still backs the Grid view's
// toolbar/row actions.
const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.GraphExplorerWorkflow@1.0.0',
    src:  fileAsString(path.resolve(__dirname, `../../../widgets/reactor.GraphExplorerWorkflow.${NODE_ENV === 'development' ? 'ts' : 'js'}`)),
    compiler: 'rollup',
    fileType: 'ts'
  },
];

export default modules;