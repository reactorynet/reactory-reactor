'use strict';

/**
 * Load the host server's Jest configuration (`<server>/jest.config.ts`).
 *
 * Shared by `jest-worktree.config.js` (which derives the worktree config from it) and by
 * `run-worktree-tests.js` (which reads `detectOpenHandles` to decide whether the run needs
 * `--forceExit`). Keeping one loader means the two can never disagree about which config
 * the run actually used.
 *
 * The server config is a TypeScript module, so `ts-node` is registered in transpile-only mode:
 * a type error elsewhere in the server must not be able to stop the worktree recipe.
 */

const fs = require('fs');
const path = require('path');

/** Resolved configs, keyed by server root. */
const cache = new Map();

/**
 * @param {string} serverRoot the reactory-express-server checkout
 * @returns {Promise<object>} the resolved Jest configuration object
 */
async function loadServerJestConfig(serverRoot) {
  const resolvedRoot = path.resolve(serverRoot);
  if (cache.has(resolvedRoot)) return cache.get(resolvedRoot);

  const configPath = path.join(resolvedRoot, 'jest.config.ts');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `The host server at ${resolvedRoot} has no jest.config.ts; ` +
        'cannot derive a faithful worktree config.',
    );
  }

  try {
    require(require.resolve('ts-node', { paths: [resolvedRoot] })).register({
      transpileOnly: true,
      compilerOptions: { module: 'commonjs' },
    });
  } catch (error) {
    throw new Error(
      'Could not load ts-node from the host server, which is required to read its ' +
        `jest.config.ts: ${error && error.message ? error.message : error}`,
    );
  }

  const loaded = require(configPath);
  const exported = loaded && loaded.__esModule === true ? loaded.default : loaded;
  const config = typeof exported === 'function' ? await exported() : exported;

  if (!config || typeof config !== 'object') {
    throw new Error(`The host server Jest config (${configPath}) did not produce a configuration object.`);
  }

  cache.set(resolvedRoot, config);
  return config;
}

module.exports = { loadServerJestConfig };
