import Reactory from '@reactory/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';
import path from 'path';
import { file } from 'pdfkit';

const { 
  NODE_ENV
} = process.env;

const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.ReactorProjectCard@1.0.0',
    src:  fileAsString(path.resolve(__dirname, `./widgets/ReactorProjectCard.tsx`)),
    compiler: 'rollup',
    fileType: 'tsx'
  },
  {
    compilerOptions: {},
    id: 'core.ContentWidget@1.0.0',
    src:  fileAsString(path.resolve(`${process.env.REACTORY_SERVER}/${NODE_ENV!=='production' ? 'src': 'app'}/modules/reactory-core/forms/Widgets/core.ContentWidget.tsx`)),
    compiler: 'rollup',
    fileType: 'tsx'
  },
];

export default modules;