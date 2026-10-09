import Reactory from '@reactorynet/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';
import path from 'path';

/**
 * The usage dashboard is a single custom widget (mirroring the compute planner
 * dashboard). The widget owns its filters, GraphQL calls and layout, so this
 * form contributes no engine-bound data bindings.
 *
 * `__dirname` is `<module>/forms/UsageDashboard/modules`, so `../../widgets`
 * resolves to `<module>/forms/widgets`, where the reactor module keeps its
 * shared widgets (e.g. reactor.GraphNodeSelector.tsx).
 */
const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.UsageDashboardWidget@1.0.0',
    src: fileAsString(path.resolve(__dirname, `../../widgets/reactor.UsageDashboardWidget.tsx`)),
    compiler: 'rollup',
    fileType: 'tsx',
  },
];

export default modules;
