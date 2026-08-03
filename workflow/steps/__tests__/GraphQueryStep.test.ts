/**
 * Unit tests for GraphQueryStep — mocked SystemGraphManager (no Mongo), covers
 * the validateConfig matrix, per-operation execution, template resolution and
 * the trimmed/serializable output contract.
 */

import { GraphQueryStep } from '../GraphQueryStep';
import { workflowSteps } from '../index';

const GRAPH_SERVICE_ID = 'reactor.SystemGraphManager@1.0.0';

const NODES = [
  { id: 1, name: 'root', type: 'SYSTEM', key: '1', data: { relativePath: '', kind: 'folder' } },
  { id: 2, name: 'file.ts', type: 'FILE', key: '1|2', parentId: 1, data: { relativePath: 'src/file.ts', kind: 'file' } },
  { id: 3, name: 'other.ts', type: 'FILE', key: '1|3', parentId: 1, data: { relativePath: 'src/other.ts', kind: 'file' } },
];

function makeService(overrides: any = {}) {
  return {
    getNode: jest.fn(async (id: number) => NODES.find((n) => n.id === id) ?? { id, name: `#${id}`, type: 'PROCESS' }),
    getNodes: jest.fn(async (ids: number[]) => ids.map((id) => NODES.find((n) => n.id === id) ?? { id, name: `#${id}`, type: 'PROCESS' })),
    getChildren: jest.fn(async () => [NODES[1], NODES[2]]),
    getNodeLinks: jest.fn(async () => [
      { id: 12, source: 1, target: 2, types: ['DEPENDENCY'], title: 'dep' },
    ]),
    getSubgraph: jest.fn(async (rootId: number) => ({
      rootId,
      nodes: NODES,
      links: [{ id: 12, source: 1, target: 2, types: ['CONTAINS'] }],
      truncated: false,
      stats: { nodeCount: 3, linkCount: 1, depthReached: 1 },
    })),
    searchNodes: jest.fn(async () => [NODES[1], NODES[2]]),
    findPath: jest.fn(async () => ({
      found: true,
      nodeIds: [1, 2],
      links: [{ id: 12, source: 1, target: 2, types: ['DEPENDENCY'] }],
    })),
    ...overrides,
  };
}

function makeContext(service: any, extra: any = {}) {
  return {
    inputs: {},
    workflowInputs: {},
    variables: {},
    env: {},
    stepResults: {},
    workflow: { id: 't', instanceId: 't', nameSpace: 'test', name: 'graph', version: '1.0.0' },
    logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    reactoryContext: {
      getService: (id: string) => (id === GRAPH_SERVICE_ID ? service : null),
    },
    ...extra,
  } as any;
}

describe('GraphQueryStep', () => {
  describe('registration', () => {
    it('is provided by the module step index with a designer definition', () => {
      const provider: any = workflowSteps.find((p) => p.stepType === 'graph_query');
      expect(provider).toBeDefined();
      expect(provider.constructor).toBe(GraphQueryStep);
      expect(provider.definition?.id).toBe('graph_query');
    });
  });

  describe('validateConfig', () => {
    const step = new GraphQueryStep('gq', { operation: 'search', term: 'x' });

    it('rejects a missing or unknown operation', () => {
      expect(step.validateConfig({}).valid).toBe(false);
      expect(step.validateConfig({ operation: 'explode' }).valid).toBe(false);
    });

    it.each([
      ['node', { operation: 'node' }, 'id'],
      ['children', { operation: 'children' }, 'id'],
      ['links', { operation: 'links' }, 'id'],
      ['search', { operation: 'search' }, 'term'],
      ['subgraph', { operation: 'subgraph' }, 'rootId'],
      ['path', { operation: 'path', sourceId: 1 }, 'targetId'],
    ])('requires the per-operation field for %s', (_op, config, field) => {
      const result = step.validateConfig(config as any);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain(field);
    });

    it('requires a non-empty ids array for nodes', () => {
      expect(step.validateConfig({ operation: 'nodes' }).valid).toBe(false);
      expect(step.validateConfig({ operation: 'nodes', ids: [] }).valid).toBe(false);
      expect(step.validateConfig({ operation: 'nodes', ids: [1] }).valid).toBe(true);
    });

    it('validates numeric bounds and enums', () => {
      expect(step.validateConfig({ operation: 'search', term: 'x', depth: 0 }).valid).toBe(false);
      expect(step.validateConfig({ operation: 'search', term: 'x', limit: -5 }).valid).toBe(false);
      expect(step.validateConfig({ operation: 'search', term: 'x', direction: 'sideways' }).valid).toBe(false);
      expect(step.validateConfig({ operation: 'search', term: 'x', types: 'DEPENDENCY' }).valid).toBe(false);
    });

    it('accepts a fully-specified subgraph config', () => {
      const result = step.validateConfig({
        operation: 'subgraph',
        rootId: 1,
        depth: 2,
        direction: 'both',
        types: ['DEPENDENCY'],
        nodeTypes: ['FILE'],
        limit: 100,
      });
      expect(result).toEqual({ valid: true, errors: [] });
    });
  });

  describe('executeStep', () => {
    it('fails cleanly without a reactory context', async () => {
      const step = new GraphQueryStep('gq', { operation: 'search', term: 'x' });
      const context = makeContext(makeService());
      context.reactoryContext = undefined;
      const result = await step.execute(context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No Reactory context');
    });

    it('fails cleanly when the graph service is unavailable', async () => {
      const step = new GraphQueryStep('gq', { operation: 'search', term: 'x' });
      const context = makeContext(null);
      const result = await step.execute(context);
      expect(result.success).toBe(false);
      expect(result.error).toContain(GRAPH_SERVICE_ID);
    });

    it('search returns trimmed nodes plus nodeIds/firstNodeId conveniences', async () => {
      const service = makeService();
      const step = new GraphQueryStep('gq', { operation: 'search', term: 'file' });
      const result = await step.execute(makeContext(service));

      expect(result.success).toBe(true);
      expect(result.outputs.nodeIds).toEqual([2, 3]);
      expect(result.outputs.firstNodeId).toBe(2);
      expect(result.outputs.nodes[0]).toEqual({
        id: 2,
        name: 'file.ts',
        type: 'FILE',
        key: '1|2',
        parentId: 1,
        path: 'src/file.ts',
        kind: 'file',
      });
    });

    it('resolves ${...} templates in ids and terms from workflow state', async () => {
      const service = makeService();
      const step = new GraphQueryStep('gq', {
        operation: 'subgraph',
        rootId: '${steps.findNodes.outputs.firstNodeId}',
      });
      const context = makeContext(service, {
        stepResults: {
          findNodes: { success: true, outputs: { firstNodeId: 1 } },
        },
      });
      const result = await step.execute(context);
      expect(result.success).toBe(true);
      expect(service.getSubgraph).toHaveBeenCalledWith(1, expect.objectContaining({ materialize: false }));
    });

    it('treats an unresolved optional template as missing input', async () => {
      const service = makeService();
      const step = new GraphQueryStep('gq', {
        operation: 'node',
        id: '${input.notSupplied}',
      });
      const result = await step.execute(makeContext(service));
      expect(result.success).toBe(false);
      expect(result.error).toContain("requires 'id'");
    });

    it('children applies the file filter but keeps folders', async () => {
      const service = makeService({
        getChildren: jest.fn(async () => [
          { id: 10, name: 'src', type: 'FOLDER', data: { kind: 'folder' } },
          { id: 11, name: 'a.ts', type: 'FILE', data: { kind: 'file' } },
          { id: 12, name: 'b.md', type: 'FILE', data: { kind: 'file' } },
        ]),
      });
      const step = new GraphQueryStep('gq', { operation: 'children', id: 1, filter: '\\.ts$' });
      const result = await step.execute(makeContext(service));
      expect(result.success).toBe(true);
      expect(result.outputs.nodes.map((n: any) => n.name)).toEqual(['src', 'a.ts']);
    });

    it('path returns found + ordered nodes and links', async () => {
      const step = new GraphQueryStep('gq', { operation: 'path', sourceId: 1, targetId: 2 });
      const result = await step.execute(makeContext(makeService()));
      expect(result.success).toBe(true);
      expect(result.outputs.found).toBe(true);
      expect(result.outputs.nodes.map((n: any) => n.id)).toEqual([1, 2]);
      expect(result.outputs.links).toHaveLength(1);
    });

    it('outputs are plain JSON-serializable data (durable persistence contract)', async () => {
      // Simulate a mongoose-ish document with methods and circular internals —
      // the step must strip everything down to plain trimmed shapes.
      const doc = {
        id: 9,
        name: 'doc.ts',
        type: 'FILE',
        key: '1|9',
        parentId: 1,
        data: { relativePath: 'src/doc.ts', kind: 'file', ast: {} as any },
        toObject() {
          return this;
        },
        $__: {},
      };
      doc.data.ast.self = doc; // circular
      const service = makeService({ getSubgraph: jest.fn(async () => ({
        rootId: 9,
        nodes: [doc],
        links: [{ id: 1, source: 9, target: 9, types: ['DEPENDENCY'], data: { raw: doc } }],
        truncated: true,
        stats: { nodeCount: 1, linkCount: 1, depthReached: 1 },
      })) });

      const step = new GraphQueryStep('gq', { operation: 'subgraph', rootId: 9 });
      const result = await step.execute(makeContext(service));

      expect(result.success).toBe(true);
      expect(result.outputs.truncated).toBe(true);
      // Must not throw — no circular refs, no functions, no mongoose internals.
      const serialized = JSON.stringify(result.outputs);
      expect(serialized).not.toContain('$__');
      expect(result.outputs.nodes[0]).not.toHaveProperty('data');
      expect(result.outputs.links[0]).not.toHaveProperty('data');
    });

    it('surfaces service failures as step errors', async () => {
      const service = makeService({
        searchNodes: jest.fn(async () => {
          throw new Error('index unavailable');
        }),
      });
      const step = new GraphQueryStep('gq', { operation: 'search', term: 'x' });
      const result = await step.execute(makeContext(service));
      expect(result.success).toBe(false);
      expect(result.error).toContain('index unavailable');
    });
  });
});
