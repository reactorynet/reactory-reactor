import Reactory from '@reactory/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';

const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.ReactorGraphExplorerWidget@1.0.0',
    src: fileAsString(require.resolve('../../../widgets/reactor.ReactorGraphExplorerWidget.tsx')),
    compiler: 'rollup',
    fileType: 'tsx'
  },
  {
    compilerOptions: {},
    id: 'reactor.GraphExplorerWorkflow@1.0.0',
    src: fileAsString(require.resolve('../../../widgets/reactor.GraphExplorerWorkflow.ts')),
    compiler: 'rollup',
    fileType: 'ts'
  },
  // {
  //   compilerOptions: {},
  //   id: 'reactor.GraphNodeSelector@1.0.0',
  //   src: fileAsString(require.resolve('../../../widgets/reactor.GraphNodeSelector.tsx')),
  //   compiler: 'rollup',
  //   fileType: 'tsx'
  // }, 
  // {
  //   compilerOptions: {},
  //   id: 'core.SupportTicketInfoPanel@1.0.0',
  //   src: fileAsString(require.resolve('../../widgets/core.SupportTicketInfoPanel.tsx')),
  //   compiler: 'rollup',
  //   fileType: 'tsx'
  // },
  // {
  //   compilerOptions: {},
  //   id: 'core.SupportTicketWorkflow@1.0.0',
  //   src: fileAsString(require.resolve('../../Widgets/core.SupportTicketWorkflow.ts')),
  //   compiler: 'rollup',
  //   fileType: 'ts'
  // }
];

export default modules;