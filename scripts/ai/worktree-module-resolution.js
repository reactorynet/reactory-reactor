'use strict';

/**
 * Path arithmetic for running a server module's suites from an AI worktree.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Reactory server module is mounted at `reactory-express-server/src/modules/<module>`,
 * i.e. exactly ONE directory level below `src/modules`. Module code reaches into the
 * host server with relative specifiers that assume that depth:
 *
 *   // reactory-reactor/models/ReactorConversationMessage.ts
 *   import { ClientKeyColumn } from '../../../database/tenant/ClientKeyColumn';
 *   //                               models/ -> reactory-reactor/ -> modules/ -> src/
 *
 * `ProcessAITicket` creates its git worktree one level DEEPER, at
 * `src/modules/reactory-worktrees/ai-<ref>`, so the same specifier now lands in
 * `src/modules/database` and every suite that transitively imports the module fails
 * at load with `Cannot find module ...` and `Tests: 0 total`.
 *
 * The module cannot be relocated to a natural path (it would collide with the primary
 * checkout and duplicate the `workspaces: ["src/modules/*"]` package), and relative
 * specifiers cannot be remapped with `moduleNameMapper` (which matches request strings,
 * not resolved paths). The supported fix is therefore a Jest `resolver` that knows the
 * module mount depth and re-anchors relative specifiers that escape the module root.
 *
 * The helpers here are deliberately free of Jest dependencies so they can be unit tested.
 */

const fs = require('fs');
const path = require('path');

/** The package name of the host server (reactory-express-server/package.json). */
const SERVER_PACKAGE_NAME = '@reactory/server-core';

/** package.json contents, keyed by directory. Never invalidated: these are build trees. */
const packageCache = new Map();

/** Resolved layout, keyed by `serverRoot\0basedir`. */
const layoutCache = new Map();

/**
 * Read and cache `<dir>/package.json`. Returns null when absent or unparseable.
 * @param {string} dir
 * @returns {object|null}
 */
function readPackage(dir) {
  if (packageCache.has(dir)) return packageCache.get(dir);

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (error) {
    pkg = null;
  }
  packageCache.set(dir, pkg);
  return pkg;
}

/**
 * Walk up from `startDir` and return the first directory for which `predicate` is true.
 * @param {string} startDir
 * @param {(dir: string) => boolean} predicate
 * @returns {string|null}
 */
function findAncestor(startDir, predicate) {
  let dir = path.resolve(startDir);

  for (;;) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Locate the host server root by walking up to the package named `@reactory/server-core`.
 * @param {string} startDir
 * @returns {string|null}
 */
function findServerRoot(startDir) {
  return findAncestor(startDir, (dir) => {
    const pkg = readPackage(dir);
    return Boolean(pkg && pkg.name === SERVER_PACKAGE_NAME);
  });
}

/**
 * Locate the module content root: the nearest ancestor carrying a package.json. That is the
 * git worktree root when the runner is pointed at a worktree, and the module checkout itself
 * when the module sits at its natural path.
 * @param {string} startDir
 * @returns {string|null}
 */
function findModuleRoot(startDir) {
  return findAncestor(startDir, (dir) => {
    const pkg = readPackage(dir);
    return Boolean(pkg && typeof pkg.name === 'string' && pkg.name.length > 0);
  });
}

/**
 * @param {string} parent
 * @param {string} child
 * @returns {boolean} true when `child` is strictly outside `parent`.
 */
function escapes(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * Describe how this module is mounted below the host server.
 *
 * `depth`  - number of path segments between `<server>/src/modules` and the module root.
 *            A natural mount (`src/modules/reactory-reactor`) is 1.
 * `offset` - how many directory levels the module root is deeper than a natural mount.
 *            Zero at a natural mount, one for `src/modules/reactory-worktrees/ai-<ref>`.
 *            Every relative specifier that escapes the module root is off by exactly this
 *            many `../` segments, because the code was written for the natural depth.
 *
 * @param {string} startDir any directory inside the module (usually a file's dirname)
 * @param {{ serverRoot?: string }} [options]
 * @returns {{ serverRoot: string|null, modulesRoot: string|null, moduleRoot: string|null,
 *             depth: number, offset: number, isModuleMount: boolean, reason: string }}
 */
function resolveModuleLayout(startDir, options = {}) {
  const serverRoot = options.serverRoot
    ? path.resolve(options.serverRoot)
    : findServerRoot(startDir);

  if (!serverRoot) {
    return {
      serverRoot: null,
      modulesRoot: null,
      moduleRoot: null,
      depth: 0,
      offset: 0,
      isModuleMount: false,
      reason: 'server-root-not-found',
    };
  }

  const modulesRoot = path.join(serverRoot, 'src', 'modules');
  const moduleRoot = findModuleRoot(startDir);

  if (!moduleRoot) {
    return {
      serverRoot,
      modulesRoot,
      moduleRoot: null,
      depth: 0,
      offset: 0,
      isModuleMount: false,
      reason: 'module-root-not-found',
    };
  }

  const rel = path.relative(modulesRoot, moduleRoot);
  const outsideModules =
    rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  const depth = outsideModules ? 0 : rel.split(path.sep).filter(Boolean).length;

  if (depth === 0) {
    return {
      serverRoot,
      modulesRoot,
      moduleRoot,
      depth: 0,
      offset: 0,
      isModuleMount: false,
      reason: 'not-inside-src-modules',
    };
  }

  return {
    serverRoot,
    modulesRoot,
    moduleRoot,
    depth,
    offset: Math.max(0, depth - 1),
    isModuleMount: true,
    reason: depth > 1 ? 'relocated-worktree' : 'natural-mount',
  };
}

/**
 * Cached {@link resolveModuleLayout} for hot resolver paths.
 * @param {string} startDir
 * @param {{ serverRoot?: string }} [options]
 * @returns {ReturnType<typeof resolveModuleLayout>}
 */
function resolveModuleLayoutCached(startDir, options = {}) {
  const key = `${options.serverRoot || ''}\u0000${startDir}`;
  if (!layoutCache.has(key)) layoutCache.set(key, resolveModuleLayout(startDir, options));
  return layoutCache.get(key);
}

/**
 * @param {string} request a module specifier as written in the source
 * @returns {boolean} true for `./x`, `../x`, `.` or `..`
 */
function isRelativeRequest(request) {
  return (
    request === '.' ||
    request === '..' ||
    request.startsWith('./') ||
    request.startsWith('../')
  );
}

/**
 * Compute the re-anchored specifier for a relative request that escapes the module root.
 *
 * Returns null when no correction applies, which is the common case:
 *  - the module sits at its natural depth (offset 0),
 *  - the request is a bare package specifier (mapped by `moduleNameMapper` instead),
 *  - the request resolves inside the module root (already correct at any depth),
 *  - the request comes from inside node_modules.
 *
 * @param {string} request
 * @param {string} basedir directory of the importing file
 * @param {ReturnType<typeof resolveModuleLayout>} layout
 * @returns {string|null}
 */
function depthCorrectedRequest(request, basedir, layout) {
  if (!layout || !layout.isModuleMount || layout.offset <= 0) return null;
  if (!layout.moduleRoot) return null;
  if (!isRelativeRequest(request)) return null;
  if (basedir.split(path.sep).includes('node_modules')) return null;

  const naiveTarget = path.resolve(basedir, request);
  if (!escapes(layout.moduleRoot, naiveTarget)) return null;

  // One `../` per level of relocation, prepended to the specifier chain. Specifiers are
  // POSIX-style even on Windows, so join them with posix semantics.
  const prefix = new Array(layout.offset).fill('..').join('/');
  return `${prefix}/${request}`;
}

/**
 * Find the directory name a module is mounted under in the host server, by matching the
 * module's package.json `name` against the candidates in `<server>/src/modules/*`.
 *
 * @param {string} serverRoot
 * @param {string} packageName
 * @returns {string|null}
 */
function findModuleMountId(serverRoot, packageName) {
  const modulesRoot = path.join(serverRoot, 'src', 'modules');
  let entries = [];

  try {
    entries = fs.readdirSync(modulesRoot, { withFileTypes: true });
  } catch (error) {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const pkg = readPackage(path.join(modulesRoot, entry.name));
    if (pkg && pkg.name === packageName) return entry.name;
  }

  return null;
}

/**
 * Escape a string for literal use inside a RegExp.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  SERVER_PACKAGE_NAME,
  depthCorrectedRequest,
  escapeRegExp,
  escapes,
  findModuleMountId,
  findModuleRoot,
  findServerRoot,
  isRelativeRequest,
  readPackage,
  resolveModuleLayout,
  resolveModuleLayoutCached,
};
