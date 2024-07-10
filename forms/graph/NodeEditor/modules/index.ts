import Reactory from '@reactory/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';

const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.ReactorGraphExplorerWidget@1.0.0',
    src: fileAsString(require.resolve('../../../widgets/reactor.reactor.GraphNodeSelector')),
    compiler: 'rollup',
    fileType: 'tsx'
  }, 
];

export default modules;