import Reactory from '@reactorynet/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';
import path from 'path';

const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.UsageDashboardWidget@1.0.0',
    src: fileAsString(path.resolve(__dirname, './widgets/UsageDashboardWidget.tsx')),
    compiler: 'rollup',
    fileType: 'tsx',
  },
];

export default modules;
