'use strict';

/**
 * Jest module resolver for AI worktrees.
 *
 * Relative specifiers inside a module are written for the module's NATURAL mount depth
 * (`<server>/src/modules/<module>`). An AI worktree lives one level deeper
 * (`<server>/src/modules/reactory-worktrees/ai-<ref>`), so every relative specifier that
 * leaves the module root is short by exactly one `../`. `moduleNameMapper` cannot express
 * this: it matches request strings, not resolved locations, and the same `../../x` string
 * means different things from different file depths.
 *
 * This resolver keeps the default resolution for everything else and only re-anchors
 * requests that escape the module root from a relocated worktree. See
 * `worktree-module-resolution.js` for the path arithmetic and `docs/ai-worktree-testing.md`
 * for the supported recipe.
 *
 * @param {string} request the specifier as written in the importing file
 * @param {{ basedir: string, defaultResolver: (request: string, options: object) => string,
 *           rootDir?: string }} options provided by Jest
 * @returns {string} absolute path of the resolved module
 */

const {
  depthCorrectedRequest,
  resolveModuleLayoutCached,
} = require('./worktree-module-resolution');

module.exports = function worktreeResolver(request, options) {
  const layout = resolveModuleLayoutCached(options.basedir, { serverRoot: options.rootDir });
  const corrected = depthCorrectedRequest(request, options.basedir, layout);

  if (corrected) {
    try {
      return options.defaultResolver(corrected, options);
    } catch (correctedError) {
      // Fall through so the failure reported to the engineer is the specifier as written
      // in the source, not the synthetic one. A genuinely broken import still fails.
    }
  }

  return options.defaultResolver(request, options);
};
