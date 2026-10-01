import Reactory from '@reactorynet/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';
import path from 'path';

/**
 * Client modules bundled with the AI Models grid form.
 *
 * The widget sources are inlined as strings and compiled by the client (rollup).
 * Each widget self-registers with the reactory component registry when loaded,
 * which is what makes the FQNs below resolvable at runtime.
 */
const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.AiModelWorkflow@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiModelWorkflow.ts')),
    compiler: 'rollup',
    fileType: 'ts',
  },
  {
    compilerOptions: {},
    id: 'reactor.AiModelOverview@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiModelOverview.tsx')),
    compiler: 'rollup',
    fileType: 'tsx',
  },
  {
    compilerOptions: {},
    id: 'reactor.AiModelLimitsPanel@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiModelLimitsPanel.tsx')),
    compiler: 'rollup',
    fileType: 'tsx',
  },
  {
    compilerOptions: {},
    id: 'reactor.AiModelDetailPanel@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiModelDetailPanel.tsx')),
    compiler: 'rollup',
    fileType: 'tsx',
  },
  {
    compilerOptions: {},
    id: 'reactor.AiModelsToolbar@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiModelsToolbar.tsx')),
    compiler: 'rollup',
    fileType: 'tsx',
  },
];

export default modules;
