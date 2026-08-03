/**
 * Unit tests for symlink handling in BaseProjectProcessor: classification,
 * lazy-tree symlink nodes (no expansion through the link), the batch walk
 * (no recursion through links, cycle-safe) and SYMLINK edge persistence.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import NodeJSProjectProcessor from '../../services/ReactorProjectProcessors/NodeJS/NodeJSProjectProcessor';
import { nodeId, pathLogicalKey, projectFqn } from '../../services/graph/GraphIdentity';
import { ReactorLinkType, ReactorNodeType } from '../../types/model.types';

/** Minimal in-memory Reactory context for driving processors without DI/Mongo. */
const makeContext = () => {
  const store = new Map<string, any>();
  return {
    getValue: async (k: string) => store.get(k),
    setValue: async (k: string, v: any) => {
      store.set(k, v);
    },
    warn: () => {},
    info: () => {},
    error: () => {},
    debug: () => {},
    getService: () => null,
    __store: store,
  } as any;
};

/**
 * Fixture layout:
 *   src/real.ts                    — regular file
 *   src/dirA/inside.ts             — regular file in a folder
 *   link-to-file.ts -> src/real.ts — in-repo file symlink
 *   link-to-dir     -> src/dirA    — in-repo directory symlink
 *   broken-link     -> ./missing   — broken symlink
 *   src/dirA/link-back -> <repo>   — directory symlink cycle (points at root)
 *   link-outside    -> <tmp dir>   — out-of-repo symlink
 */
const writeFixture = () => {
  // realpathSync: on macOS os.tmpdir() is /var/... which is a symlink to
  // /private/var/... — the walker canonicalizes paths, so repoPath must be
  // canonical too or every relativePath degrades to ../../..-style walks.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reactor-symlink-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reactor-outside-')));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'symlink-fixture', version: '1.0.0' })
  );
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'src', 'dirA'));
  fs.writeFileSync(path.join(dir, 'src', 'real.ts'), 'export const real = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'dirA', 'inside.ts'), 'export const inside = 2;\n');
  fs.writeFileSync(path.join(outside, 'outside.ts'), 'export const outside = 3;\n');

  fs.symlinkSync(path.join(dir, 'src', 'real.ts'), path.join(dir, 'link-to-file.ts'));
  fs.symlinkSync(path.join(dir, 'src', 'dirA'), path.join(dir, 'link-to-dir'));
  fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'broken-link'));
  fs.symlinkSync(dir, path.join(dir, 'src', 'dirA', 'link-back'));
  fs.symlinkSync(outside, path.join(dir, 'link-outside'));

  const project = {
    id: 'symlink-fixture-id',
    name: 'symlink-fixture',
    nameSpace: 'test',
    version: '1.0.0',
    repoPath: dir,
  };
  return { dir, outside, project };
};

describe('BaseProjectProcessor symlink handling', () => {
  let dir: string;
  let outside: string;
  let project: any;
  let ctx: any;
  let processor: NodeJSProjectProcessor;

  beforeAll(() => {
    ({ dir, outside, project } = writeFixture());
    ctx = makeContext();
    processor = new NodeJSProjectProcessor({}, ctx);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  describe('lazy tree (getChildrenForNode)', () => {
    let rootChildren: any[];

    beforeAll(async () => {
      const root = await processor.getProjectNode(project);
      rootChildren = await processor.getChildrenForNode(root, root.key, null, null);
    });

    it('classifies an in-repo file symlink with a resolved target node id', () => {
      const linkNode = rootChildren.find((c) => c.name === 'link-to-file.ts');
      expect(linkNode).toBeDefined();
      expect(linkNode.type).toBe(ReactorNodeType.FILE);
      expect(linkNode.data.kind).toBe('symlink');
      expect(linkNode.data.noExpand).toBe(true);
      expect(linkNode.data.symlink.broken).toBe(false);
      expect(linkNode.data.symlink.relativeTarget).toBe('src/real.ts');
      expect(linkNode.data.symlink.resolvedNodeId).toBe(
        nodeId(pathLogicalKey(projectFqn(project), 'src/real.ts'))
      );
    });

    it('types a directory symlink by its target kind (FOLDER) but never expands it', async () => {
      const dirLink = rootChildren.find((c) => c.name === 'link-to-dir');
      expect(dirLink).toBeDefined();
      expect(dirLink.type).toBe(ReactorNodeType.FOLDER);
      expect(dirLink.data.kind).toBe('symlink');
      expect(dirLink.data.symlink.relativeTarget).toBe('src/dirA');

      const children = await processor.getChildrenForNode(dirLink, dirLink.key, null, null);
      expect(children).toEqual([]);
    });

    it('marks broken symlinks as broken FILE nodes', () => {
      const broken = rootChildren.find((c) => c.name === 'broken-link');
      expect(broken).toBeDefined();
      expect(broken.type).toBe(ReactorNodeType.FILE);
      expect(broken.data.symlink.broken).toBe(true);
      expect(broken.data.symlink.resolvedNodeId).toBeUndefined();
    });

    it('records out-of-repo symlinks as metadata only (no relative target)', () => {
      const external = rootChildren.find((c) => c.name === 'link-outside');
      expect(external).toBeDefined();
      expect(external.data.kind).toBe('symlink');
      expect(external.data.symlink.relativeTarget).toBeUndefined();
      expect(external.data.symlink.target).toBe(fs.realpathSync(outside));
    });

    it('survives a symlink cycle in the lazy tree (link-back never expands)', async () => {
      const src = rootChildren.find((c) => c.name === 'src');
      const srcChildren = await processor.getChildrenForNode(src, src.key, null, null);
      const dirA = srcChildren.find((c) => c.name === 'dirA');
      const dirAChildren = await processor.getChildrenForNode(dirA, dirA.key, null, null);
      const linkBack = dirAChildren.find((c) => c.name === 'link-back');
      expect(linkBack).toBeDefined();
      expect(linkBack.data.noExpand).toBe(true);
      expect(await processor.getChildrenForNode(linkBack, linkBack.key, null, null)).toEqual([]);
    });
  });

  describe('batch pipeline (process)', () => {
    let persistedNodes: any[] = [];
    let persistedEdges: any[] = [];
    let indexedSearchables: any[] = [];

    beforeAll(async () => {
      persistedNodes = [];
      persistedEdges = [];
      jest
        .spyOn(processor as any, 'persistGraph')
        .mockImplementation(async (nodes: any[], edges: any[]) => {
          persistedNodes = nodes;
          persistedEdges = edges;
        });
      jest
        .spyOn(processor as any, 'indexSearchables')
        .mockImplementation(async (_project: any, searchables: any[]) => {
          indexedSearchables = searchables;
        });
      await processor.process(project);
    });

    afterAll(() => {
      jest.restoreAllMocks();
    });

    it('persists symlink nodes with symlink metadata', () => {
      const linkNode = persistedNodes.find((n) => n.name === 'link-to-file.ts');
      expect(linkNode).toBeDefined();
      expect(linkNode.data.kind).toBe('symlink');
      expect(linkNode.data.noExpand).toBe(true);
    });

    it('persists a SYMLINK edge to the in-repo target', () => {
      const fqn = projectFqn(project);
      const linkNodeId = nodeId(pathLogicalKey(fqn, 'link-to-file.ts'));
      const targetId = nodeId(pathLogicalKey(fqn, 'src/real.ts'));
      const edge = persistedEdges.find(
        (e) => e.source === linkNodeId && e.target === targetId
      );
      expect(edge).toBeDefined();
      expect(edge.types).toEqual([ReactorLinkType.SYMLINK]);
      expect(edge.title).toBe('src/real.ts');
    });

    it('does not recurse through symlinked directories (no duplicate file specs)', () => {
      // src/dirA/inside.ts must appear exactly once — at its real location,
      // never again via link-to-dir/inside.ts.
      const insideNodes = persistedNodes.filter((n) => n.name === 'inside.ts');
      expect(insideNodes).toHaveLength(1);
      expect(insideNodes[0].data.relativePath).toBe('src/dirA/inside.ts');
    });

    it('creates no edge for broken or out-of-repo symlinks', () => {
      const fqn = projectFqn(project);
      const brokenId = nodeId(pathLogicalKey(fqn, 'broken-link'));
      const outsideId = nodeId(pathLogicalKey(fqn, 'link-outside'));
      expect(persistedEdges.some((e) => e.source === brokenId)).toBe(false);
      expect(persistedEdges.some((e) => e.source === outsideId)).toBe(false);
      // The nodes themselves are still persisted (metadata only).
      expect(persistedNodes.some((n) => n.name === 'broken-link')).toBe(true);
      expect(persistedNodes.some((n) => n.name === 'link-outside')).toBe(true);
    });

    it('indexes symlink searchables', () => {
      expect(
        indexedSearchables.some((s) => String(s.name).startsWith('symlink_link-to-file.ts'))
      ).toBe(true);
    });

    it('terminates despite the link-back cycle', () => {
      // Reaching this point proves the walk completed; also assert the cycle
      // link was captured as a node rather than walked.
      const linkBack = persistedNodes.find((n) => n.name === 'link-back');
      expect(linkBack).toBeDefined();
      expect(linkBack.data.kind).toBe('symlink');
    });
  });
});
