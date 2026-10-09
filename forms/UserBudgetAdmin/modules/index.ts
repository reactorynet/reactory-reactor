import Reactory from '@reactorynet/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';
import path from 'path';

/**
 * The budget console is a single custom widget (same pattern as the usage
 * dashboard). It owns its filters, table, editor, bulk operations and GraphQL
 * calls, so the form contributes no engine-bound data bindings.
 *
 * `__dirname` is `<module>/forms/UserBudgetAdmin/modules`, so `../../widgets`
 * resolves to `<module>/forms/widgets`, where the reactor module keeps its
 * shared widgets.
 */
const modules: Reactory.Forms.IReactoryFormModule[] = [
  {
    compilerOptions: {},
    id: 'reactor.UserBudgetAdminWidget@1.0.0',
    src: fileAsString(path.resolve(__dirname, `../../widgets/reactor.UserBudgetAdminWidget.tsx`)),
    compiler: 'rollup',
    fileType: 'tsx',
  },
];

export default modules;
