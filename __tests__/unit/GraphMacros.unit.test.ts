/**
 * Unit tests for the graph AI macros — mocked SystemGraphManager, verifying
 * the macro contract: { success, tool, params, instructions } on both success
 * and failure, missing-parameter handling, and safe-for-auto-execution flags.
 */

import fs from 'fs';
import path from 'path';
import GraphMacros from '../../ai/macro/graph';
import SearchGraphMacroDefinition from '../../ai/macro/graph/SearchGraph.macro';
import GetGraphNodeMacroDefinition from '../../ai/macro/graph/GetGraphNode.macro';
import GetNodeChildrenMacroDefinition from '../../ai/macro/graph/GetNodeChildren.macro';
import ExploreGraphMacroDefinition from '../../ai/macro/graph/ExploreGraph.macro';
import GetNodeLinksMacroDefinition from '../../ai/macro/graph/GetNodeLinks.macro';
import CreateNodeEdgeMacroDefinition from '../../ai/macro/graph/CreateNodeEdge.macro';

const NODES = [
  { id: 1, name: 'root', type: 'SYSTEM', key: '1', data: {} },
  { id: 2, name: 'file.ts', type: 'FILE', key: '1|2', parentId: 1, data: { relativePath: 'src/file.ts', kind: 'file' } },
];

function makeService(overrides: any = {}) {
  return {
    getNode: jest.fn(async (id: number) => NODES.find((n) => n.id === id)),
    getNodes: jest.fn(async (ids: number[]) => ids.map((id) => NODES.find((n) => n.id === id) ?? { id, name: `#${id}`, type: 'PROCESS' })),
    getChildren: jest.fn(async () => [NODES[1]]),
    getNodeLinks: jest.fn(async () => [{ id: 12, source: 1, target: 2, types: ['DEPENDENCY'] }]),
    getSubgraph: jest.fn(async (rootId: number) => ({
      rootId,
      nodes: NODES,
      links: [{ id: 12, source: 1, target: 2, types: ['CONTAINS'] }],
      truncated: false,
      stats: { nodeCount: 2, linkCount: 1, depthReached: 1 },
    })),
    searchNodes: jest.fn(async () => [NODES[1]]),
    createLink: jest.fn(async (source: any, type: string, target: any) => ({
      id: 12,
      source: source.id,
      target: target.id,
      type,
      types: [type],
    })),
    updateLink: jest.fn(async (link: any) => link),
    ...overrides,
  };
}

function makeChatState(service: any) {
  return {
    context: {
      getService: (id: string) => (id === 'reactor.SystemGraphManager@1.0.0' ? service : null),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
    },
    vars: {},
    save: jest.fn(async () => undefined),
  } as any;
}

describe('Graph macros', () => {
  describe('registration', () => {
    it('exposes six macros, spread into the MacroRegistry', () => {
      expect(GraphMacros).toHaveLength(6);
      // Importing ../../ai/macro here would pull the entire macro dependency
      // tree (OpenAI SDK, playwright, ...) through ts-jest and exhaust the
      // heap — assert the registration site textually instead.
      const registrySource = fs.readFileSync(
        path.join(__dirname, '../../ai/macro/index.ts'),
        'utf8'
      );
      expect(registrySource).toContain("import GraphMacros from './graph'");
      expect(registrySource).toContain('...GraphMacros,');
    });

    it('read tools are auto-safe; the write tool (createNodeEdge) is not', () => {
      for (const macro of GraphMacros) {
        expect(macro.runat).toBe('server');
        const isWrite = macro.alias === 'createNodeEdge';
        for (const tool of macro.tools ?? []) {
          expect(tool.safeForAutoExecution).toBe(!isWrite);
          expect(tool.function.parameters.required?.length).toBeGreaterThan(0);
        }
      }
    });

    it('aliases match the persona allowlist names', () => {
      const aliases = GraphMacros.map((m) => m.alias).sort();
      expect(aliases).toEqual(
        ['createNodeEdge', 'exploreGraph', 'getGraphNode', 'graphChildren', 'graphLinks', 'searchGraph'].sort()
      );
    });
  });

  describe.each([
    ['searchGraph', SearchGraphMacroDefinition, {}],
    ['getGraphNode', GetGraphNodeMacroDefinition, {}],
    ['graphChildren', GetNodeChildrenMacroDefinition, {}],
    ['exploreGraph', ExploreGraphMacroDefinition, {}],
    ['graphLinks', GetNodeLinksMacroDefinition, {}],
    ['createNodeEdge', CreateNodeEdgeMacroDefinition, {}],
  ])('%s common contract', (alias, definition) => {
    it('returns a failure shape (not a throw) for missing required params', async () => {
      const macro = definition.component as any;
      const result = await macro({}, makeChatState(makeService()));
      expect(result.success).toBe(false);
      expect(result.tool).toBe(alias);
      expect(result.instructions).toContain('Recovery Options');
    });

    it('returns a service-unavailable failure when the graph service is missing', async () => {
      const macro = definition.component as any;
      const params =
        alias === 'searchGraph'
          ? { term: 'x' }
          : alias === 'exploreGraph'
          ? { rootId: 1 }
          : alias === 'createNodeEdge'
          ? { from: 1, to: 2 }
          : { id: 1 };
      const chatState = makeChatState(null);
      const result = await macro(params, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  describe('happy paths', () => {
    it('searchGraph returns trimmed nodes and follow-up guidance', async () => {
      const macro = SearchGraphMacroDefinition.component as any;
      const result = await macro({ term: 'file' }, makeChatState(makeService()));
      expect(result.success).toBe(true);
      expect(result.data.nodes[0]).toMatchObject({ id: 2, name: 'file.ts', path: 'src/file.ts' });
      expect(result.instructions).toContain('getGraphNode');
    });

    it('getGraphNode returns the node plus a per-type link summary', async () => {
      const macro = GetGraphNodeMacroDefinition.component as any;
      const result = await macro({ id: 1 }, makeChatState(makeService()));
      expect(result.success).toBe(true);
      expect(result.data.node.id).toBe(1);
      expect(result.data.linkSummary.outgoing).toEqual({ DEPENDENCY: 1 });
    });

    it('graphChildren pages and trims children', async () => {
      const macro = GetNodeChildrenMacroDefinition.component as any;
      const result = await macro({ id: 1, pageSize: 10 }, makeChatState(makeService()));
      expect(result.success).toBe(true);
      expect(result.data.parent.id).toBe(1);
      expect(result.data.nodes).toHaveLength(1);
      expect(result.data.hasNext).toBe(false);
    });

    it('exploreGraph renders an adjacency list and never materializes', async () => {
      const service = makeService();
      const macro = ExploreGraphMacroDefinition.component as any;
      const result = await macro({ rootId: 1, depth: 99, limit: 9999 }, makeChatState(service));
      expect(result.success).toBe(true);
      expect(result.instructions).toContain('-CONTAINS->');
      // Caps applied and lazy materialization disabled for token safety.
      expect(service.getSubgraph).toHaveBeenCalledWith(1, expect.objectContaining({
        depth: 3,
        limit: 200,
        materialize: false,
      }));
    });

    it('graphLinks resolves endpoint names for the edge list', async () => {
      const macro = GetNodeLinksMacroDefinition.component as any;
      const result = await macro({ id: 1 }, makeChatState(makeService()));
      expect(result.success).toBe(true);
      expect(result.data.links).toHaveLength(1);
      expect(result.instructions).toContain('root');
      expect(result.instructions).toContain('file.ts');
    });

    it('createNodeEdge creates then updates the link with the full type set', async () => {
      const service = makeService();
      const macro = CreateNodeEdgeMacroDefinition.component as any;
      const result = await macro(
        { from: 1, to: 2, types: ['dependency', 'CALL'], title: 'uses api' },
        makeChatState(service)
      );
      expect(result.success).toBe(true);
      expect(service.createLink).toHaveBeenCalledWith(
        { id: 1 },
        'DEPENDENCY',
        { id: 2 }
      );
      expect(service.updateLink).toHaveBeenCalledWith(
        expect.objectContaining({ types: ['DEPENDENCY', 'CALL'], title: 'uses api' })
      );
      expect(result.data.link).toMatchObject({ source: 1, target: 2 });
      expect(result.instructions).toContain('Edge Created');
    });

    it('createNodeEdge rejects self-edges and unknown types without touching the service', async () => {
      const service = makeService();
      const macro = CreateNodeEdgeMacroDefinition.component as any;

      const selfEdge = await macro({ from: 1, to: 1 }, makeChatState(service));
      expect(selfEdge.success).toBe(false);
      expect(selfEdge.error).toContain('self-edges');

      const badType = await macro({ from: 1, to: 2, types: ['SYMLINK'] }, makeChatState(service));
      expect(badType.success).toBe(false);
      expect(badType.error).toContain('SYMLINK');

      expect(service.createLink).not.toHaveBeenCalled();
    });
  });
});
