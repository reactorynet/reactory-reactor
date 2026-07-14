import Reactory from '@reactorynet/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';
import path from 'path';
import { file } from 'pdfkit';

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
    // __dirname-relative (not NODE_ENV-based): this file's own directory
    // structure is preserved 1:1 between src/ and the compiled app/ output,
    // so this resolves correctly either way without depending on NODE_ENV
    // (which elsewhere in the codebase means something different — "am I
    // really in a production deployment" — not "are files compiled").
    src:  fileAsString(path.resolve(__dirname, '../../../reactory-core/forms/Widgets/core.ContentWidget.tsx')),
    compiler: 'rollup',
    fileType: 'tsx'
  },
];

export default modules;