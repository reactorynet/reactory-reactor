/**
 * Unit tests for the AI-worktree Jest harness (scripts/ai/*.js).
 *
 * These assert the path arithmetic that makes a worktree one level deeper than the module's
 * natural mount still able to run its suites. They build throwaway trees on disk so they
 * exercise the real filesystem walking rather than mocks.
 *
 * See docs/ai-worktree-testing.md for the defect this guards against.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  depthCorrectedRequest,
  escapes,
  findModuleMountId,
  findServerRoot,
  resolveModuleLayout,
} = require('../worktree-module-resolution');

interface Fixture {
  root: string;
  serverRoot: string;
  naturalMount: string;
  worktreeRoot: string;
  cleanup: () => void;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFileWithDirs(filePath: string, content = ''): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Server tree:
 *   <root>/package.json                                  @reactory/server-core
 *   <root>/jest.config.ts
 *   <root>/src/database/tenant/ClientKeyColumn.ts
 *   <root>/src/modules/reactory-reactor/...               natural mount (depth 1)
 *   <root>/src/modules/reactory-worktrees/ai-abc/...      AI worktree (depth 2)
 */
function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reactor-worktree-harness-'));

  writeJson(path.join(root, 'package.json'), { name: '@reactory/server-core', version: '0.0.0' });
  writeFileWithDirs(path.join(root, 'jest.config.ts'), 'export default {};\n');
  writeFileWithDirs(path.join(root, 'src', 'database', 'tenant', 'ClientKeyColumn.ts'), 'export const ClientKeyColumn = 1;\n');

  const naturalMount = path.join(root, 'src', 'modules', 'reactory-reactor');
  writeJson(path.join(naturalMount, 'package.json'), { name: '@reactory/reactor' });
  writeFileWithDirs(path.join(naturalMount, 'models', 'ReactorConversationMessage.ts'), 'export const m = 1;\n');
  writeFileWithDirs(path.join(naturalMount, 'services', 'reactor', 'ReactorConversationService.ts'), 'export const s = 1;\n');

  const worktreeRoot = path.join(root, 'src', 'modules', 'reactory-worktrees', 'ai-abc');
  writeJson(path.join(worktreeRoot, 'package.json'), { name: '@reactory/reactor' });
  writeFileWithDirs(path.join(worktreeRoot, 'models', 'ReactorConversationMessage.ts'), 'export const m = 1;\n');
  writeFileWithDirs(path.join(worktreeRoot, 'services', 'reactor', 'ReactorConversationService.ts'), 'export const s = 1;\n');

  return {
    root,
    serverRoot: root,
    naturalMount,
    worktreeRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe('worktree module resolution', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe('resolveModuleLayout', () => {
    it('reports a natural mount (src/modules/<module>) as depth 1 with no offset', () => {
      const layout = resolveModuleLayout(path.join(fixture.naturalMount, 'models'), {
        serverRoot: fixture.serverRoot,
      });

      expect(layout.isModuleMount).toBe(true);
      expect(layout.moduleRoot).toBe(fixture.naturalMount);
      expect(layout.depth).toBe(1);
      expect(layout.offset).toBe(0);
      expect(layout.reason).toBe('natural-mount');
    });

    it('reports an AI worktree as depth 2 with an offset of 1', () => {
      const layout = resolveModuleLayout(path.join(fixture.worktreeRoot, 'models'), {
        serverRoot: fixture.serverRoot,
      });

      expect(layout.isModuleMount).toBe(true);
      expect(layout.moduleRoot).toBe(fixture.worktreeRoot);
      expect(layout.depth).toBe(2);
      expect(layout.offset).toBe(1);
      expect(layout.reason).toBe('relocated-worktree');
    });

    it('does not treat a directory outside src/modules as a module mount', () => {
      const layout = resolveModuleLayout(path.join(fixture.serverRoot, 'src'), {
        serverRoot: fixture.serverRoot,
      });

      expect(layout.isModuleMount).toBe(false);
      expect(layout.offset).toBe(0);
    });

    it('discovers the server root by walking up to @reactory/server-core', () => {
      expect(findServerRoot(path.join(fixture.worktreeRoot, 'services', 'reactor'))).toBe(fixture.serverRoot);
    });

    it('discovers the mount id of the module from its package name', () => {
      expect(findModuleMountId(fixture.serverRoot, '@reactory/reactor')).toBe('reactory-reactor');
      expect(findModuleMountId(fixture.serverRoot, '@reactory/unknown')).toBeNull();
    });
  });

  describe('depthCorrectedRequest', () => {
    it('re-anchors a relative specifier that escapes the module root from a worktree', () => {
      const basedir = path.join(fixture.worktreeRoot, 'models');
      const layout = resolveModuleLayout(basedir, { serverRoot: fixture.serverRoot });

      expect(depthCorrectedRequest('../../../database/tenant/ClientKeyColumn', basedir, layout))
        .toBe('../../../../database/tenant/ClientKeyColumn');
    });

    it('leaves the same specifier untouched at the natural mount (the code is already correct there)', () => {
      const basedir = path.join(fixture.naturalMount, 'models');
      const layout = resolveModuleLayout(basedir, { serverRoot: fixture.serverRoot });

      expect(depthCorrectedRequest('../../../database/tenant/ClientKeyColumn', basedir, layout)).toBeNull();
    });

    it('leaves relative specifiers that stay inside the module root untouched', () => {
      const basedir = path.join(fixture.worktreeRoot, 'services', 'reactor');
      const layout = resolveModuleLayout(basedir, { serverRoot: fixture.serverRoot });

      expect(depthCorrectedRequest('../../models/ReactorConversationMessage', basedir, layout)).toBeNull();
      expect(depthCorrectedRequest('../ReactorConversationMessage', basedir, layout)).toBeNull();
    });

    it('never rewrites bare package specifiers (moduleNameMapper owns those)', () => {
      const basedir = path.join(fixture.worktreeRoot, 'models');
      const layout = resolveModuleLayout(basedir, { serverRoot: fixture.serverRoot });

      expect(depthCorrectedRequest('typeorm', basedir, layout)).toBeNull();
      expect(depthCorrectedRequest('@reactory/server-core/database/tenant/ClientKeyColumn', basedir, layout)).toBeNull();
    });

    it('does not rewrite requests made from inside node_modules', () => {
      const basedir = path.join(fixture.worktreeRoot, 'node_modules', 'some-dep');
      const layout = resolveModuleLayout(basedir, { serverRoot: fixture.serverRoot });

      expect(depthCorrectedRequest('../../../database/tenant/ClientKeyColumn', basedir, layout)).toBeNull();
    });

    it('adds one level per level of relocation, not a fixed one', () => {
      const deeper = path.join(fixture.serverRoot, 'src', 'modules', 'reactory-worktrees', 'batch', 'ai-abc');
      writeJson(path.join(deeper, 'package.json'), { name: '@reactory/reactor' });

      const basedir = path.join(deeper, 'models');
      const layout = resolveModuleLayout(basedir, { serverRoot: fixture.serverRoot });

      expect(layout.offset).toBe(2);
      expect(depthCorrectedRequest('../../../database/tenant/ClientKeyColumn', basedir, layout))
        .toBe('../../../../../database/tenant/ClientKeyColumn');
    });
  });

  describe('escapes', () => {
    it('detects strictly-outside paths only', () => {
      const root = path.join(fixture.root, 'module');

      expect(escapes(root, path.join(root, 'models'))).toBe(false);
      expect(escapes(root, root)).toBe(false);
      expect(escapes(root, path.join(root, '..', 'other'))).toBe(true);
    });
  });
});
