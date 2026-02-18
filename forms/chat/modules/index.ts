import Reactory from '@reactorynet/reactory-core';
import path from 'path';
import { fileAsString } from '@reactory/server-core/utils/io';

const {
  NODE_ENV
} = process.env;

const fileType = NODE_ENV === 'development' ? 'tsx' : 'js';


const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.ChatBotWidget@1.0.0',
    src:  fileAsString(path.resolve(__dirname, `../../widgets/reactor.ChatBotWidget.${fileType}`)),
    compiler: 'rollup',
    fileType: 'tsx'
  }, 
];

export default modules;