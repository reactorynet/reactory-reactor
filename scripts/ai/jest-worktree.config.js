'use strict';

/**
 * Supported Jest configuration for running a server module's suites from an AI worktree.
 *
 * Normally used through `node scripts/ai/run-worktree-tests.js <paths>`; that wrapper sets
 * REACTORY_MODULE_ROOT / REACTORY_SERVER_ROOT and adds the run-mode flags this config cannot
 * express (notably the exit-code contract documented in docs/ai-worktree-testing.md).
 *
 * WHAT THIS FILE DOES
 * -------------------
 * 1. Locates the module content root. `REACTORY_MODULE_ROOT` wins (the wrapper sets it to the
 *    worktree being tested), otherwise the root is two levels above this file. The env override
 *    is what lets ONE copy of the harness serve any module.
 * 2. Locates the host `reactory-express-server` checkout. `REACTORY_SERVER_ROOT` wins, otherwise
 *    it walks up to the package named `@reactory/server-core`.
 * 3. Loads the SERVER'S OWN jest config (`<server>/jest.config.ts`) so the transformer, setup
 *    files, ignore patterns and alias mappings are exactly the ones the module runs with at its
 *    natural mount - no per-run copy of the harness that can drift.
 * 4. Overrides only what must change: `rootDir` stays at the server (so `<rootDir>` tokens,
 *    `node_modules` and `setupFilesAfterEnv` resolve), `roots` is narrowed to this worktree, and
 *    the module's own `@reactory/server-modules/<module>/...` alias is re-pointed at the worktree
 *    instead of the primary checkout.
 * 5. Installs the depth-aware resolver (`worktree-jest-resolver.js`), which re-anchors the relative
 *    specifiers that escape the module root. Without it every suite that transitively imports
 *    e.g. `services/reactor/ReactorConversationService.ts` dies at load with `Cannot find module
 *    '../../../database/tenant/ClientKeyColumn'` and reports `Tests: 0 total`.
 * 6. Strips Babel's `module-resolver` plugin for worktree runs only (see withoutAliasRewriting).
 *
 * This also works from a natural checkout (`src/modules/<module>`), where the resolver applies an
 * offset of zero and the config behaves like the server config with narrower roots.
 */

const fs = require('fs');
const path = require('path');

const { loadServerJestConfig } = require('./load-server-jest-config');
const {
  escapeRegExp,
  findModuleMountId,
  findServerRoot,
} = require('./worktree-module-resolution');

/** The module content root: the worktree root, or the module checkout at its natural mount. */
const MODULE_ROOT = (() => {
  const configured = process.env.REACTORY_MODULE_ROOT;
  const candidate = configured && configured.trim()
    ? path.resolve(configured.trim())
    : path.resolve(__dirname, '..', '..');

  if (!fs.existsSync(path.join(candidate, 'package.json'))) {
    throw new Error(
      `Module root resolves to "${candidate}", which is not a module root (no package.json). ` +
        'REACTORY_MODULE_ROOT must name the git worktree or module checkout.',
    );
  }
  return candidate;
})();

/** The host server checkout this module is mounted in. */
const SERVER_ROOT = (() => {
  const configured = process.env.REACTORY_SERVER_ROOT;
  if (configured && configured.trim()) {
    const resolved = path.resolve(configured.trim());
    if (!fs.existsSync(path.join(resolved, 'jest.config.ts'))) {
      throw new Error(
        `REACTORY_SERVER_ROOT points at "${resolved}", which has no jest.config.ts. ` +
          'Point it at the reactory-express-server checkout.',
      );
    }
    return resolved;
  }

  const discovered = findServerRoot(MODULE_ROOT);
  if (!discovered) {
    throw new Error(
      `Could not find the host server checkout for ${MODULE_ROOT}.\n` +
        'This module must sit inside a reactory-express-server tree ' +
        '(<server>/src/modules/<module>) for its relative imports to resolve, or ' +
        'REACTORY_SERVER_ROOT must name that tree.',
    );
  }
  return discovered;
})();

/**
 * Remove Babel's `module-resolver` alias rewriting from the server's transform pipeline.
 *
 * The server config keeps aliases in two places: `moduleNameMapper` (Jest) and a Babel
 * `module-resolver` plugin (transform time). In the primary checkout they agree. In a worktree
 * they do not: Babel rewrites `@reactory/server-modules/<module>/...` against its own
 * `root: './src'`, i.e. to the PRIMARY checkout, before Jest's (worktree-aware) `moduleNameMapper`
 * ever sees the specifier. The visible symptom is a module loaded twice from two different paths -
 * `OverwriteModelError: Cannot overwrite 'ReactorConversation' model once compiled` - not a
 * resolution error.
 *
 * Dropping the plugin leaves Jest's `moduleNameMapper` (which we point at this worktree) as the
 * single source of truth for aliases. Babel's `root: './src'` behaviour that the module relies on
 * for root-relative imports (`schema/reflection`) is preserved by Jest's `modulePaths`, which the
 * server config already sets to `<rootDir>/src`.
 *
 * @param {Record<string, unknown>} transform the server config's transform map
 * @returns {Record<string, unknown>} a copy with the alias plugin removed
 */
function withoutAliasRewriting(transform) {
  if (!transform || typeof transform !== 'object') return transform;

  const clone = JSON.parse(JSON.stringify(transform));

  for (const pattern of Object.keys(clone)) {
    const value = clone[pattern];
    const options = Array.isArray(value) ? value[1] : null;
    if (!options || !options.babelConfig || !Array.isArray(options.babelConfig.plugins)) continue;

    const keptPlugins = options.babelConfig.plugins.filter((plugin) => {
      const name = Array.isArray(plugin) ? plugin[0] : plugin;
      return name !== 'module-resolver';
    });

    if (keptPlugins.length !== options.babelConfig.plugins.length) {
      options.babelConfig.plugins = keptPlugins;
      // The server root also ships a `babel.config.js` with the same `module-resolver` alias
      // table. Babel loads it by default, so the inline table alone is not enough: turn off both
      // config discovery mechanisms and keep only the inline options above.
      options.babelConfig.babelrc = false;
      options.babelConfig.configFile = false;
      clone[pattern] = [value[0], options];
    }
  }

  return clone;
}

module.exports = async () => {
  // The loader is shared with the CLI so the two cannot disagree about which config the run
  // actually used (the CLI reads detectOpenHandles from it to decide on --forceExit).
  const base = await loadServerJestConfig(SERVER_ROOT);
  const modulePackage = JSON.parse(fs.readFileSync(path.join(MODULE_ROOT, 'package.json'), 'utf8'));
  const mountId = findModuleMountId(SERVER_ROOT, modulePackage.name) || path.basename(MODULE_ROOT);
  const ownAliasPrefix = `^@reactory/server-modules/${escapeRegExp(mountId)}/(.*)$`;

  const moduleNameMapper = {};
  // MUST come first: Jest applies mappings in declaration order, and the generic
  // `@reactory/server-modules/(.*)` entry from the server config would otherwise send this
  // module's own alias imports to the PRIMARY checkout instead of the worktree.
  moduleNameMapper[ownAliasPrefix] = path.join(MODULE_ROOT, '$1');
  Object.assign(moduleNameMapper, base.moduleNameMapper || {});

  return {
    ...base,

    // Keep the server root so `<rootDir>` tokens, node_modules and setup files resolve.
    rootDir: SERVER_ROOT,
    displayName: `${modulePackage.name}@worktree`,

    // Only this worktree's files may be collected.
    roots: [MODULE_ROOT],

    modulePaths: [path.join(SERVER_ROOT, 'src')],

    // Keep the server's transformer (ts-jest + Babel presets) but let Jest's mapper own alias
    // resolution. See withoutAliasRewriting() for the two-copies failure.
    transform: withoutAliasRewriting(base.transform),

    moduleNameMapper,

    // Re-anchors relative specifiers written for the natural mount depth.
    resolver: require.resolve('./worktree-jest-resolver.js'),

    collectCoverage: false,
  };
};

module.exports.withoutAliasRewriting = withoutAliasRewriting;
