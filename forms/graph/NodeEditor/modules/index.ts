import Reactory from '@reactorynet/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';

const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.GraphNodeSelector@1.0.0',
    src: fileAsString(require.resolve('../../../widgets/reactor.GraphNodeSelector.tsx')),
    compiler: 'rollup',
    fileType: 'tsx'
  }, 
];

export default modules;