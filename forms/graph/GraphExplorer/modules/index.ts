import Reactory from '@reactorynet/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';
import path from 'path';

const { 
  NODE_ENV
} = process.env;
const fileType = NODE_ENV === 'development' ? 'tsx' : 'js';

const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.ReactorGraphExplorerWidget@1.0.0',
    src:  fileAsString(path.resolve(__dirname, `../../../widgets/reactor.ReactorGraphExplorerWidget.${fileType}`)),
    compiler: 'rollup',
    fileType: 'tsx'
  },
  {
    compilerOptions: {},
    id: 'reactor.GraphExplorerWorkflow@1.0.0',
    src:  fileAsString(path.resolve(__dirname, `../../../widgets/reactor.GraphExplorerWorkflow.${NODE_ENV === 'development' ? 'ts' : 'js'}`)),
    compiler: 'rollup',
    fileType: 'ts'
  },
];

export default modules;