import Reactory from '@reactorynet/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';
import path from 'path';

/**
 * Client modules bundled with the AI Providers grid form.
 *
 * The widget sources are inlined as strings and compiled by the client (rollup).
 * Each widget self-registers with the reactory component registry when loaded,
 * which is what makes the FQNs below resolvable at runtime.
 */
const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.AiProviderWorkflow@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiProviderWorkflow.ts')),
    compiler: 'rollup',
    fileType: 'ts',
  },
  {
    compilerOptions: {},
    id: 'reactor.AiProviderOverview@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiProviderOverview.tsx')),
    compiler: 'rollup',
    fileType: 'tsx',
  },
  {
    compilerOptions: {},
    id: 'reactor.AiProviderModelsPanel@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiProviderModelsPanel.tsx')),
    compiler: 'rollup',
    fileType: 'tsx',
  },
  {
    compilerOptions: {},
    id: 'reactor.AiProviderStatusPanel@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiProviderStatusPanel.tsx')),
    compiler: 'rollup',
    fileType: 'tsx',
  },
  {
    compilerOptions: {},
    id: 'reactor.AiProviderDetailPanel@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiProviderDetailPanel.tsx')),
    compiler: 'rollup',
    fileType: 'tsx',
  },
  {
    compilerOptions: {},
    id: 'reactor.AiProvidersToolbar@1.0.0',
    src: fileAsString(path.resolve(__dirname, '../widgets/reactor.AiProvidersToolbar.tsx')),
    compiler: 'rollup',
    fileType: 'tsx',
  },
];

export default modules;
