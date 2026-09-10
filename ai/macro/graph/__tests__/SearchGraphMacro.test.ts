import SearchGraphMacroDefinition from '../SearchGraph.macro';

function makeState(
  searchNodesResult: any[],
  opts: { getNodeLinksResult?: any[]; getNodeLinksImpl?: (...args: any[]) => Promise<any[]> } = {}
) {
  const mockContext = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    getService: jest.fn().mockReturnValue({
      searchNodes: jest.fn().mockResolvedValue(searchNodesResult),
      getNodeLinks: opts.getNodeLinksImpl
        ? jest.fn(opts.getNodeLinksImpl)
        : jest.fn().mockResolvedValue(opts.getNodeLinksResult ?? []),
    }),
  };
  return { context: mockContext, vars: {} } as any;
}

describe('SearchGraph Macro Definition', () => {
  it('should define the searchGraph tool with proper schema', () => {
    expect(SearchGraphMacroDefinition.name).toBe('SearchGraph');
    expect(SearchGraphMacroDefinition.alias).toBe('searchGraph');
    expect(SearchGraphMacroDefinition.tools).toHaveLength(1);

    const tool = SearchGraphMacroDefinition.tools[0];
    expect(tool.function.name).toBe('searchGraph');
    expect(tool.function.parameters.properties).toHaveProperty('term');
    expect(tool.function.parameters.properties).toHaveProperty('limit');
  });

  it('returns an error when term is missing', async () => {
    const state = makeState([]);
    const result: any = await (SearchGraphMacroDefinition.component as any)({}, state);
    expect(result.success).toBe(false);
    expect(result.error).toContain('term parameter is required');
  });

  it('returns trimmed nodes untouched when payload is small', async () => {
    const nodes = [
      { id: 1, name: 'index.ts', type: 'FILE', key: 'k1', parentId: null, data: { relativePath: 'src/index.ts' } },
      { id: 2, name: 'utils.ts', type: 'FILE', key: 'k2', parentId: null, data: { relativePath: 'src/utils.ts' } },
    ];
    const state = makeState(nodes);
    const result: any = await (SearchGraphMacroDefinition.component as any)({ term: 'index' }, state);

    expect(result.success).toBe(true);
    expect(result.data.nodes).toHaveLength(2);
    expect(result.data.truncated).toBeUndefined();
    expect(result.data.nodes[0].path).toBe('src/index.ts');
  });

  it('defensively caps an oversized node payload instead of relying solely on the outer guard', async () => {
    // Build nodes with an unusually long path field to blow past the macro's
    // own NODE_PAYLOAD_BUDGET independent of the shared ToolResultProcessor.
    const longPath = 'src/'.repeat(200) + 'file.ts';
    const nodes = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      name: `file_${i}.ts`,
      type: 'FILE',
      key: `k${i}`,
      parentId: null,
      data: { relativePath: longPath, kind: 'source', language: 'typescript' },
    }));
    const state = makeState(nodes);
    const result: any = await (SearchGraphMacroDefinition.component as any)({ term: 'file', limit: 50 }, state);

    expect(result.success).toBe(true);
    expect(result.data.truncated).toBe(true);
    expect(result.data.totalMatched).toBe(50);
    // Either fields were slimmed (path dropped) or the node count itself was clipped.
    const stillHasPath = result.data.nodes.some((n: any) => n.path);
    if (stillHasPath) {
      expect(result.data.nodes.length).toBeLessThan(50);
    } else {
      expect(result.data.nodes.every((n: any) => n.path === undefined)).toBe(true);
    }
    expect(result.instructions).toContain('### Note:');
  });

  it('returns a service-unavailable error when the graph service is missing', async () => {
    const mockContext = {
      debug: jest.fn(),
      error: jest.fn(),
      getService: jest.fn().mockReturnValue(null),
    };
    const state = { context: mockContext, vars: {} } as any;
    const result: any = await (SearchGraphMacroDefinition.component as any)({ term: 'x' }, state);
    expect(result.success).toBe(false);
    expect(result.error).toContain('SystemGraphManager');
  });

  describe('format: "markdown" (richer option)', () => {
    it('renders true adjacency between matched nodes, filtering out edges that reach outside the result set', async () => {
      const nodes = [
        { id: 1, name: 'a.ts', type: 'FILE', key: 'k1', parentId: null, data: { relativePath: 'src/a.ts' } },
        { id: 2, name: 'b.ts', type: 'FILE', key: 'k2', parentId: null, data: { relativePath: 'src/b.ts' } },
        { id: 3, name: 'c.ts', type: 'FILE', key: 'k3', parentId: null, data: { relativePath: 'src/c.ts' } },
      ];
      // 1 -> 2 is internal (both endpoints in the result set); 2 -> 999 reaches
      // a hub node outside the result set and must be filtered out.
      const rawLinks = [
        { id: 100, source: 1, target: 2, types: ['DEPENDENCY'], title: 'a imports b' },
        { id: 101, source: 2, target: 999, types: ['DEPENDENCY'], title: 'b imports hub' },
      ];
      const state = makeState(nodes, { getNodeLinksResult: rawLinks });

      const result: any = await (SearchGraphMacroDefinition.component as any)(
        { term: 'ts', format: 'markdown' },
        state
      );

      expect(result.success).toBe(true);
      expect(typeof result.data).toBe('string');
      // Internal edge rendered with resolved node names
      expect(result.data).toContain('a.ts');
      expect(result.data).toContain('b.ts');
      expect(result.data).toContain('DEPENDENCY');
      // The edge reaching node 999 (outside the result set) must be excluded
      expect(result.data).not.toContain('999');
      // c.ts has no internal edges — should appear in the "Unlinked nodes" section
      expect(result.data).toContain('Unlinked nodes');
      expect(result.data).toContain('c.ts');
      expect(result.instructions).toContain('edge(s) among them');
    });

    it('falls back to a node-only markdown rendering when the link lookup fails', async () => {
      const nodes = [{ id: 1, name: 'a.ts', type: 'FILE', key: 'k1', parentId: null, data: { relativePath: 'src/a.ts' } }];
      const state = makeState(nodes, {
        getNodeLinksImpl: async () => {
          throw new Error('graph link lookup boom');
        },
      });

      const result: any = await (SearchGraphMacroDefinition.component as any)(
        { term: 'a', format: 'markdown' },
        state
      );

      expect(result.success).toBe(true);
      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('a.ts');
      expect(state.context.warn).toHaveBeenCalled();
    });

    it('defaults to the json shape when format is omitted', async () => {
      const nodes = [{ id: 1, name: 'a.ts', type: 'FILE', key: 'k1', parentId: null, data: {} }];
      const state = makeState(nodes);
      const result: any = await (SearchGraphMacroDefinition.component as any)({ term: 'a' }, state);
      expect(result.success).toBe(true);
      expect(typeof result.data).toBe('object');
      expect(Array.isArray(result.data.nodes)).toBe(true);
    });
  });
});
