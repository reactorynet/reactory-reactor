/**
 * Unit tests for the SystemGraphManager traversal façade — getNodes,
 * getNodeLinks, getSubgraph, searchNodes and findPath — over mocked Mongo
 * models (no database).
 */

import { ReactorLinkType } from '../../types/model.types';

// In-memory graph the model mocks serve from. Populated per test.
const graph: { nodes: any[]; links: any[] } = { nodes: [], links: [] };

const makeQuery = (result: () => any[]) => {
  let limitValue: number | undefined;
  const q: any = {
    limit: jest.fn((n: number) => {
      limitValue = n;
      return q;
    }),
    skip: jest.fn(() => q),
    sort: jest.fn(() => q),
    lean: jest.fn(async () => {
      const rows = result();
      return limitValue !== undefined ? rows.slice(0, limitValue) : rows;
    }),
  };
  return q;
};

const matchNodeQuery = (query: any): any[] => {
  if (query?.id?.$in) return graph.nodes.filter((n) => query.id.$in.includes(n.id));
  if (query?.parentId?.$in) return graph.nodes.filter((n) => query.parentId.$in.includes(n.parentId));
  if (query?.$or) {
    // Regex search over name/description.
    return graph.nodes.filter((n) =>
      query.$or.some((clause: any) =>
        Object.entries(clause).some(([field, rx]) => rx instanceof RegExp && rx.test(n[field] ?? ''))
      )
    );
  }
  return [];
};

const matchLinkQuery = (query: any): any[] => {
  let rows = graph.links;
  if (query?.$or) {
    rows = rows.filter((l) =>
      query.$or.some((clause: any) => {
        if (clause.source?.$in) return clause.source.$in.includes(l.source);
        if (clause.target?.$in) return clause.target.$in.includes(l.target);
        return false;
      })
    );
  }
  if (query?.types?.$in) {
    rows = rows.filter((l) => (l.types || []).some((t: string) => query.types.$in.includes(t)));
  }
  if (query?.projectId) rows = rows.filter((l) => l.projectId === query.projectId);
  return rows;
};

const lastUpdateCall: { filter?: any; update?: any; options?: any } = {};

jest.mock('@reactory/server-modules/reactory-reactor/models/ReactorGraphNode', () => ({
  DefaultReactorNodeCategories: [],
  ReactorNodeModel: {
    find: jest.fn((query: any) => makeQuery(() => matchNodeQuery(query))),
    findOne: jest.fn((query: any) => makeQuery(() => matchNodeQuery({ id: { $in: [query?.id] } }))),
  },
}));

jest.mock('@reactory/server-modules/reactory-reactor/models/ReactorNodeLink', () => ({
  ReactorNodeLinkModel: {
    find: jest.fn((query: any) => makeQuery(() => matchLinkQuery(query))),
    findOne: jest.fn((query: any) => {
      const link = graph.links.find((l) => l.id === query?.id);
      return {
        lean: jest.fn(async () => link || null),
      };
    }),
    updateOne: jest.fn(async (filter: any, update: any, options: any) => {
      lastUpdateCall.filter = filter;
      lastUpdateCall.update = update;
      lastUpdateCall.options = options;
      const existingIndex = graph.links.findIndex((l) => l.id === filter?.id);
      const doc = {
        id: filter?.id,
        ...(update?.$set || {}),
        ...(update?.$setOnInsert || {}),
      };
      if (existingIndex >= 0) {
        graph.links[existingIndex] = { ...graph.links[existingIndex], ...(update?.$set || {}) };
      } else if (options?.upsert) {
        graph.links.push(doc);
      }
      return { acknowledged: true };
    }),
  },
}));

import SystemGraphManager from '../../services/SystemGraphManager';

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
    utils: { hash: (s: string) => s.length },
    __store: store,
  } as any;
};

const node = (id: number, name: string, extra: any = {}) => ({
  id,
  name,
  type: 'FILE',
  key: `${id}`,
  ...extra,
});

const link = (source: number, target: number, types: string[] = ['DEPENDENCY']) => ({
  id: Number(`${source}${target}`),
  source,
  target,
  types,
});

describe('SystemGraphManager traversal façade', () => {
  let manager: any;
  let ctx: any;

  beforeEach(() => {
    graph.nodes = [];
    graph.links = [];
    ctx = makeContext();
    manager = new (SystemGraphManager as any)({}, ctx);
  });

  describe('getNodes', () => {
    it('resolves persisted nodes, cache misses and placeholders, preserving order', async () => {
      graph.nodes = [node(1, 'one')];
      await ctx.setValue('REACTOR_NODE_2', node(2, 'two-cached'));

      const nodes = await manager.getNodes([1, 2, 3]);

      expect(nodes.map((n: any) => n.id)).toEqual([1, 2, 3]);
      expect(nodes[0].name).toBe('one');
      expect(nodes[1].name).toBe('two-cached');
      expect(nodes[2].description).toBe('Unresolved node');
    });

    it('dedupes ids and returns [] for empty input', async () => {
      graph.nodes = [node(1, 'one')];
      expect(await manager.getNodes([])).toEqual([]);
      const nodes = await manager.getNodes([1, 1, 1]);
      expect(nodes).toHaveLength(1);
    });
  });

  describe('getNodeLinks', () => {
    beforeEach(() => {
      graph.links = [link(1, 2), link(3, 1, ['CALL']), link(4, 5)];
    });

    it('direction "out" only matches edges where the node is the source', async () => {
      const links = await manager.getNodeLinks([1], { direction: 'out' });
      expect(links.map((l: any) => l.target)).toEqual([2]);
    });

    it('direction "in" only matches edges where the node is the target', async () => {
      const links = await manager.getNodeLinks([1], { direction: 'in' });
      expect(links.map((l: any) => l.source)).toEqual([3]);
    });

    it('direction "both" matches either endpoint and filters by type', async () => {
      const both = await manager.getNodeLinks([1], { direction: 'both' });
      expect(both).toHaveLength(2);
      const calls = await manager.getNodeLinks([1], { direction: 'both', types: ['CALL'] });
      expect(calls).toHaveLength(1);
      expect(calls[0].source).toBe(3);
    });
  });

  describe('getSubgraph', () => {
    beforeEach(() => {
      graph.nodes = [
        node(1, 'root'),
        node(2, 'dep', { parentId: undefined }),
        node(3, 'transitive'),
        node(5, 'child', { parentId: 1 }),
      ];
      graph.links = [link(1, 2), link(2, 3, ['CALL'])];
    });

    it('walks BFS to the requested depth', async () => {
      const depth1 = await manager.getSubgraph(1, { depth: 1, includeContainment: false });
      expect(depth1.nodes.map((n: any) => n.id).sort()).toEqual([1, 2]);

      const depth2 = await manager.getSubgraph(1, { depth: 2, includeContainment: false });
      expect(depth2.nodes.map((n: any) => n.id).sort()).toEqual([1, 2, 3]);
      expect(depth2.links).toHaveLength(2);
      expect(depth2.truncated).toBe(false);
    });

    it('synthesizes CONTAINS edges from parentId without persisting them', async () => {
      const subgraph = await manager.getSubgraph(1, { depth: 1 });
      const contains = subgraph.links.filter((l: any) => l.types.includes(ReactorLinkType.CONTAINS));
      expect(contains).toHaveLength(1);
      expect(contains[0].source).toBe(1);
      expect(contains[0].target).toBe(5);
      // The synthesized edge never entered the persisted store.
      expect(graph.links.some((l) => (l.types || []).includes('CONTAINS'))).toBe(false);
    });

    it('truncates at the node limit', async () => {
      const subgraph = await manager.getSubgraph(1, { depth: 2, limit: 2, includeContainment: false });
      expect(subgraph.nodes.length).toBeLessThanOrEqual(2);
      expect(subgraph.truncated).toBe(true);
    });

    it('drops links whose endpoints were filtered out', async () => {
      const subgraph = await manager.getSubgraph(1, {
        depth: 2,
        includeContainment: false,
        nodeTypes: ['FOLDER'], // nothing matches — only the root remains
      });
      expect(subgraph.nodes.map((n: any) => n.id)).toEqual([1]);
      expect(subgraph.links).toHaveLength(0);
    });
  });

  describe('searchNodes', () => {
    it('regex-matches name/description over the persisted graph', async () => {
      graph.nodes = [
        node(1, 'UserService'),
        node(2, 'OrderService'),
        node(3, 'readme', { description: 'the user manual' }),
      ];
      const results = await manager.searchNodes('user');
      expect(results.map((n: any) => n.id).sort()).toEqual([1, 3]);
    });

    it('escapes regex metacharacters and returns [] for empty terms', async () => {
      graph.nodes = [node(1, 'file(1).ts')];
      expect(await manager.searchNodes('')).toEqual([]);
      const results = await manager.searchNodes('file(1)');
      expect(results).toHaveLength(1);
    });
  });

  describe('findPath', () => {
    beforeEach(() => {
      graph.links = [link(1, 2), link(2, 3, ['CALL']), link(4, 3)];
    });

    it('finds a path and reconstructs nodes + edges in order', async () => {
      const path = await manager.findPath(1, 3);
      expect(path.found).toBe(true);
      expect(path.nodeIds[0]).toBe(1);
      expect(path.nodeIds[path.nodeIds.length - 1]).toBe(3);
      expect(path.links).toHaveLength(path.nodeIds.length - 1);
    });

    it('returns not-found when no path exists within maxDepth', async () => {
      const path = await manager.findPath(1, 99, { maxDepth: 3 });
      expect(path.found).toBe(false);
      expect(path.nodeIds).toEqual([]);
    });

    it('handles source === target trivially', async () => {
      const path = await manager.findPath(7, 7);
      expect(path).toEqual({ found: true, nodeIds: [7], links: [] });
    });
  });

  describe('getProject', () => {
    it('throws 400 ApiError if pathSpec is not provided', async () => {
      await expect(manager.getProject('')).rejects.toThrow('A path or id is required');
      await expect(manager.getProject(null as any)).rejects.toThrow('A path or id is required');
    });

    it('throws 404 ApiError if projectService.getProject returns null', async () => {
      const mockProjectService = {
        getProject: jest.fn().mockResolvedValue(null),
      };
      manager.setProjectService(mockProjectService);

      await expect(manager.getProject('non-existent')).rejects.toThrow('Project non-existent not found');
      expect(mockProjectService.getProject).toHaveBeenCalledWith('non-existent');
    });

    it('returns the project when found by projectService', async () => {
      const mockProject = { id: 'p1', name: 'TestProject', nameSpace: 'test', version: '1.0.0' };
      const mockProjectService = {
        getProject: jest.fn().mockResolvedValue(mockProject),
      };
      manager.setProjectService(mockProjectService);

      const result = await manager.getProject('test-project-spec');
      expect(result).toEqual(mockProject);
      expect(mockProjectService.getProject).toHaveBeenCalledWith('test-project-spec');
    });
  });

  describe('createLink', () => {
    it('stamps runId: "manual" in $setOnInsert', async () => {
      const sourceNode = node(10, 'Source');
      const targetNode = node(20, 'Target');

      const created = await manager.createLink(sourceNode, 'DEPENDENCY', targetNode);
      expect(lastUpdateCall.update?.$setOnInsert).toBeDefined();
      expect(lastUpdateCall.update.$setOnInsert.runId).toBe('manual');
      expect(created.source).toBe(10);
      expect(created.target).toBe(20);
    });
  });

  describe('getSubgraph O(1) child index & lazy materialization', () => {
    it('skips getChildren when frontier node already has persisted child in childCountByParent', async () => {
      const getChildrenSpy = jest.spyOn(manager, 'getChildren').mockResolvedValue([]);

      // Parent 1 has persisted child 5 with parentId 1
      graph.nodes = [
        node(1, 'folder', { type: 'FOLDER', providerId: 'test.Provider@1.0.0' }),
        node(5, 'file', { parentId: 1, type: 'FILE' }),
      ];

      const res = await manager.getSubgraph(1, { depth: 2, materialize: true });
      expect(getChildrenSpy).not.toHaveBeenCalled();
      expect(res.nodes.map((n: any) => n.id).sort()).toEqual([1, 5]);
    });

    it('materializes children via getChildren when frontier node has no persisted child', async () => {
      const childNode = node(100, 'lazychild', { parentId: 1, type: 'FILE' });
      const getChildrenSpy = jest.spyOn(manager, 'getChildren').mockResolvedValue([childNode]);

      graph.nodes = [
        node(1, 'emptyfolder', { type: 'FOLDER', providerId: 'test.Provider@1.0.0' }),
      ];

      const res = await manager.getSubgraph(1, { depth: 2, materialize: true });
      expect(getChildrenSpy).toHaveBeenCalled();
      expect(res.nodes.map((n: any) => n.id).sort()).toEqual([1, 100]);
    });
});
