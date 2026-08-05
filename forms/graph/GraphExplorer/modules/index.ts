import fs from 'fs';
import path from 'path';
import Reactory from '@reactorynet/reactory-core';
import { fileAsString } from '@reactory/server-core/utils/io';
import logger from '@reactory/server-core/logging';

const WIDGETS_DIR = path.resolve(__dirname, '../../../widgets');

/**
 * Reads a form module's source, trying each source extension in turn.
 *
 * This used to pick the extension from NODE_ENV — `.ts` under `development` and
 * `.js` otherwise — so under any other environment (`test`, and `production`
 * before a build has emitted the artifact) it read a path that does not exist
 * and threw ENOENT. Form modules are read at *import* time, so that took down
 * every test suite pulling in the module registry, not just the ones using this
 * form.
 *
 * Returns null when nothing is found: an unreadable form module should degrade
 * to "that widget is unavailable", never to a failed process start.
 */
const widgetSource = (baseName: string): string | null => {
  for (const extension of ['ts', 'tsx', 'js', 'jsx']) {
    const candidate = path.join(WIDGETS_DIR, `${baseName}.${extension}`);
    if (!fs.existsSync(candidate)) continue;
    try {
      return fileAsString(candidate);
    } catch (error) {
      logger.warn(`Could not read form module widget ${candidate}: ${(error as Error).message}`);
      return null;
    }
  }
  logger.warn(
    `Form module widget "${baseName}" not found in ${WIDGETS_DIR}; the widget will be unavailable`
  );
  return null;
};

// The reactor.ReactorGraphExplorerWidget (D3) module was removed — graph
// exploration now lives in the first-class client component
// core.GraphExplorer@1.0.0. The workflow module still backs the Grid view's
// toolbar/row actions.
const declared: { id: string; baseName: string }[] = [
  { id: 'reactor.GraphExplorerWorkflow@1.0.0', baseName: 'reactor.GraphExplorerWorkflow' },
];

const modules: Reactory.Forms.IReactoryFormModule[] = declared
  .map(({ id, baseName }) => {
    const src = widgetSource(baseName);
    if (src === null) return null;
    return {
      compilerOptions: {},
      id,
      src,
      compiler: 'rollup',
      fileType: 'ts',
    } as Reactory.Forms.IReactoryFormModule;
  })
  .filter((module): module is Reactory.Forms.IReactoryFormModule => module !== null);

export default modules;
