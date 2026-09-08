/**
 * Search macro tests.
 *
 * The search macros use context.getService() for the search service
 * and context.debug/info/warn/error for logging — no separate logger mock needed.
 */
import SearchMacroRegistries from '../search/macro';
import { createMockState } from './support/mockState';

// Destructure the three macro definitions from the default array export
const [SearchContentDef, IndexContentDef, DeleteIndexDef] = SearchMacroRegistries;
const SearchContentMacro = SearchContentDef.component;
const IndexContentMacro = IndexContentDef.component;
const DeleteIndexMacro = DeleteIndexDef.component;

// ── Helpers ─────────────────────────────────────────────────────

function mockSearchService(overrides: Record<string, any> = {}) {
  return {
    search: jest.fn().mockResolvedValue({
      results: [
        { id: 'doc-1', _score: 0.95, title: 'Intro to Algebra', content: 'Algebra basics...', type: 'chapter', _formatted: { title: ['<em>Algebra</em>'] } },
        { id: 'doc-2', _score: 0.8, title: 'Advanced Math', content: 'Advanced topics...', type: 'chapter', _formatted: null },
      ],
      total: 2,
    }),
    index: jest.fn().mockResolvedValue({ id: 'task-123', success: true }),
    deleteIndex: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function stateWithSearch(
  serviceOverrides: Record<string, any> = {},
  stateExtras: Record<string, any> = {}
) {
  const svc = mockSearchService(serviceOverrides);
  return {
    state: createMockState({
      services: { 'core.ReactorySearchService@1.0.0': svc },
      // Most tests search via the persona's default indexes — the global
      // book-* fallback was removed (Providers Session 08).
      persona: { config: { defaultSearchIndexes: ['book-catalog', 'book-chapters', 'book-glossary'] } },
      ...stateExtras,
    }),
    service: svc,
  };
}

// ==================== SearchContentMacro ====================

describe('SearchContentMacro', () => {
  it('should fail when query is empty', async () => {
    const { state } = stateWithSearch();
    const result: any = await SearchContentMacro({ query: '' }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('query');
    expect(result.tool).toBe('searchContent');
  });

  it('should fail when search service is not available', async () => {
    const state = createMockState({ services: {} });
    const result: any = await SearchContentMacro({ query: 'algebra' }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ReactorySearchService');
  });

  it('should execute a search and return results', async () => {
    const { state, service } = stateWithSearch();
    const result: any = await SearchContentMacro({ query: 'algebra' }, state);

    expect(result.success).toBe(true);
    expect(result.tool).toBe('searchContent');
    expect(result.data).toBeDefined();
    expect(result.instructions).toContain('algebra');
    expect(service.search).toHaveBeenCalled();
  });

  it('returns guidance (not book defaults) when no index is given and the persona has none', async () => {
    const svc = mockSearchService();
    const state = createMockState({
      services: { 'core.ReactorySearchService@1.0.0': svc },
      persona: { config: {} },
    });
    const result: any = await SearchContentMacro({ query: 'algebra' }, state as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No search index specified');
    expect(result.instructions).toContain('listSearchIndexes');
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('uses the persona default indexes when none are passed', async () => {
    const { state, service } = stateWithSearch();
    await SearchContentMacro({ query: 'algebra' }, state as any);
    const searched = (service.search as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(searched.sort()).toEqual(['book-catalog', 'book-chapters', 'book-glossary']);
  });

  it('should search across specified indices', async () => {
    const { state, service } = stateWithSearch();
    await SearchContentMacro({ query: 'algebra', indices: ['books', 'glossary'] }, state);

    expect(service.search).toHaveBeenCalledTimes(2);
    expect(service.search).toHaveBeenCalledWith('books', 'algebra', undefined, 10, 0);
    expect(service.search).toHaveBeenCalledWith('glossary', 'algebra', undefined, 10, 0);
  });

  it('should search a single index when index param is provided', async () => {
    const { state, service } = stateWithSearch();
    await SearchContentMacro({ query: 'math', index: 'my-index' }, state);

    expect(service.search).toHaveBeenCalledTimes(1);
    expect(service.search).toHaveBeenCalledWith('my-index', 'math', undefined, 10, 0);
  });

  it('should respect limit and offset params', async () => {
    const { state, service } = stateWithSearch();
    await SearchContentMacro({ query: 'math', index: 'idx', limit: 5, offset: 10 }, state);

    expect(service.search).toHaveBeenCalledWith('idx', 'math', undefined, 5, 10);
  });

  it('should pass fields param to search', async () => {
    const { state, service } = stateWithSearch();
    await SearchContentMacro({ query: 'math', index: 'idx', fields: ['title', 'content'] }, state);

    expect(service.search).toHaveBeenCalledWith('idx', 'math', ['title', 'content'], 10, 0);
  });

  it('should store state variables for AI reference', async () => {
    const { state } = stateWithSearch();
    await SearchContentMacro({ query: 'algebra' }, state);

    expect(state.vars.lastSearchQuery).toBe('algebra');
    expect(state.vars.lastSearchResults).toBeDefined();
    expect(state.vars.searchMetadata).toBeDefined();
    expect(state.vars.searchSummary).toBeDefined();
  });

  it('should track search history', async () => {
    const { state } = stateWithSearch();
    await SearchContentMacro({ query: 'first' }, state);
    await SearchContentMacro({ query: 'second' }, state);

    const history = state.vars.searchHistory as any[];
    expect(history).toHaveLength(2);
    expect(history[0].query).toBe('first');
    expect(history[1].query).toBe('second');
  });

  it('should handle search errors gracefully per index', async () => {
    const svc = mockSearchService({
      search: jest.fn()
        .mockResolvedValueOnce({ results: [{ id: '1', _score: 1, title: 'ok' }], total: 1 })
        .mockRejectedValueOnce(new Error('Index not found')),
    });
    const state = createMockState({ services: { 'core.ReactorySearchService@1.0.0': svc } });
    const result: any = await SearchContentMacro({ query: 'test', indices: ['good', 'bad'] }, state);

    // Should still succeed with partial results from the good index
    expect(result.success).toBe(true);
  });

  it('should return markdown format when requested', async () => {
    const { state } = stateWithSearch();
    const result: any = await SearchContentMacro({ query: 'algebra', index: 'idx', format: 'markdown' }, state);

    expect(result.success).toBe(true);
    expect(typeof result.data).toBe('string');
    expect(result.data).toContain('# Search Results');
  });

  it('should return summary format when requested', async () => {
    const { state } = stateWithSearch();
    const result: any = await SearchContentMacro({ query: 'algebra', index: 'idx', format: 'summary' }, state);

    expect(result.success).toBe(true);
    expect(result.data.summary).toBeDefined();
    expect(result.data.results).toBeDefined();
  });
});

// ==================== IndexContentMacro ====================

describe('IndexContentMacro', () => {
  it('should fail when index name is empty', async () => {
    const { state } = stateWithSearch();
    const result: any = await IndexContentMacro({ index: '', documents: [{ id: '1' }] }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Index name');
  });

  it('should fail when documents array is empty', async () => {
    const { state } = stateWithSearch();
    const result: any = await IndexContentMacro({ index: 'my-index', documents: [] }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Documents');
  });

  it('should fail when documents is not an array', async () => {
    const { state } = stateWithSearch();
    const result: any = await IndexContentMacro({ index: 'my-index', documents: 'not-array' as any }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Documents');
  });

  it('should fail when documents are missing the ID field', async () => {
    const { state } = stateWithSearch();
    const result: any = await IndexContentMacro({
      index: 'my-index',
      documents: [{ title: 'No ID' }],
      idField: 'id',
    }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing required ID field');
  });

  it('should fail when search service is not available', async () => {
    const state = createMockState({ services: {} });
    const result: any = await IndexContentMacro({
      index: 'my-index',
      documents: [{ id: '1', title: 'Test' }],
    }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ReactorySearchService');
  });

  it('should index documents successfully', async () => {
    const { state, service } = stateWithSearch();
    const docs = [{ id: '1', title: 'Doc A' }, { id: '2', title: 'Doc B' }];
    const result: any = await IndexContentMacro({ index: 'my-index', documents: docs }, state);

    expect(result.success).toBe(true);
    expect(result.tool).toBe('indexContent');
    expect(service.index).toHaveBeenCalledWith('my-index', docs);
    expect(result.instructions).toContain('my-index');
  });

  it('should store indexing metadata in state.vars', async () => {
    const { state } = stateWithSearch();
    await IndexContentMacro({
      index: 'my-index',
      documents: [{ id: '1', title: 'Doc' }],
    }, state);

    expect(state.vars.lastIndexOperation).toBeDefined();
    expect(state.vars.indexedDocuments).toBeDefined();
    expect(state.vars.indexedDocuments.count).toBe(1);
    expect(state.vars.indexedDocuments.index).toBe('my-index');
  });

  it('should use custom idField for validation', async () => {
    const { state } = stateWithSearch();
    const result: any = await IndexContentMacro({
      index: 'my-index',
      documents: [{ docId: '1', title: 'Doc' }],
      idField: 'docId',
    }, state);

    expect(result.success).toBe(true);
  });
});

// ==================== DeleteIndexMacro ====================

describe('DeleteIndexMacro', () => {
  it('should fail when index name is empty', async () => {
    const { state } = stateWithSearch();
    const result: any = await DeleteIndexMacro({ index: '', confirm: true }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Index name');
  });

  it('should fail when confirmation is not provided', async () => {
    const { state } = stateWithSearch();
    const result: any = await DeleteIndexMacro({ index: 'my-index', confirm: false }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Confirmation required');
  });

  it('should fail when search service is not available', async () => {
    const state = createMockState({ services: {} });
    const result: any = await DeleteIndexMacro({ index: 'my-index', confirm: true }, state);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ReactorySearchService');
  });

  it('should delete index successfully', async () => {
    const { state, service } = stateWithSearch();
    const result: any = await DeleteIndexMacro({ index: 'my-index', confirm: true }, state);

    expect(result.success).toBe(true);
    expect(result.tool).toBe('deleteIndex');
    expect(service.deleteIndex).toHaveBeenCalledWith('my-index');
    expect(result.instructions).toContain('my-index');
  });

  it('should store deletion metadata in state.vars', async () => {
    const { state } = stateWithSearch();
    await DeleteIndexMacro({ index: 'my-index', confirm: true }, state);

    expect(state.vars.lastDeletedIndex).toBeDefined();
    expect(state.vars.lastDeletedIndex.index).toBe('my-index');
    expect(state.vars.lastDeletedIndex.success).toBe(true);
  });

  it('should return failure when service reports deletion failed', async () => {
    const { state } = stateWithSearch({ deleteIndex: jest.fn().mockResolvedValue(false) });
    const result: any = await DeleteIndexMacro({ index: 'my-index', confirm: true }, state);

    expect(result.success).toBe(false);
    expect(result.instructions).toContain('Failed');
  });
});

// ==================== Registry Definitions ====================

describe('Search Macro Registries', () => {
  it('should export exactly 5 macro definitions (search, index, delete, list, stats)', () => {
    expect(SearchMacroRegistries).toHaveLength(5);
  });

  it('SearchContent should have one tool named searchContent', () => {
    expect(SearchContentDef.tools).toHaveLength(1);
    expect(SearchContentDef.tools[0].function.name).toBe('searchContent');
    expect(SearchContentDef.tools[0].function.parameters.required).toEqual(['query']);
  });

  it('IndexContent should have one tool named indexContent', () => {
    expect(IndexContentDef.tools).toHaveLength(1);
    expect(IndexContentDef.tools[0].function.name).toBe('indexContent');
    expect(IndexContentDef.tools[0].function.parameters.required).toEqual(['index', 'documents']);
  });

  it('DeleteIndex should have one tool named deleteIndex', () => {
    expect(DeleteIndexDef.tools).toHaveLength(1);
    expect(DeleteIndexDef.tools[0].function.name).toBe('deleteIndex');
    expect(DeleteIndexDef.tools[0].function.parameters.required).toEqual(['index', 'confirm']);
  });
});


// ==================== ListSearchIndexesMacro / GetIndexStatsMacro ====================

const ListSearchIndexesDef = SearchMacroRegistries.find((d: any) => d.alias === 'listSearchIndexes');
const GetIndexStatsDef = SearchMacroRegistries.find((d: any) => d.alias === 'getIndexStats');

describe('ListSearchIndexesMacro', () => {
  const catalog = [
    { index: 'reactor_graph_test_app', kind: 'project', title: 'test.app@1.0.0', description: 'Indexed file contents', documentCount: 12, exists: true },
    { index: 'book-catalog', kind: 'module', title: 'BookTutor catalog', description: 'Books', exists: false },
  ];

  it('is registered with a safe auto-executable tool', () => {
    expect(ListSearchIndexesDef).toBeTruthy();
    expect(ListSearchIndexesDef!.tools![0].safeForAutoExecution).toBe(true);
    expect(ListSearchIndexesDef!.tools![0].function.name).toBe('listSearchIndexes');
  });

  it('returns the curated catalog from SystemGraphManager', async () => {
    const state = createMockState({
      services: {
        'reactor.SystemGraphManager@1.0.0': { getSearchIndexCatalog: jest.fn().mockResolvedValue(catalog) },
      },
    });
    const result: any = await (ListSearchIndexesDef!.component as any)({}, state);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.instructions).toContain('reactor_graph_test_app');
    expect(result.instructions).toContain('not yet built');
    expect((state.vars as any).searchIndexCatalog).toHaveLength(2);
  });

  it('fails gracefully when the graph manager is unavailable', async () => {
    const state = createMockState({ services: {} });
    const result: any = await (ListSearchIndexesDef!.component as any)({}, state);
    expect(result.success).toBe(false);
    expect(result.error).toContain('SystemGraphManager');
  });
});

describe('GetIndexStatsMacro', () => {
  it('returns stats for one index via the search service', async () => {
    const getIndexStats = jest.fn().mockResolvedValue({ name: 'idx', exists: true, documentCount: 7 });
    const state = createMockState({
      services: { 'core.ReactorySearchService@1.0.0': { getIndexStats } },
    });
    const result: any = await (GetIndexStatsDef!.component as any)({ index: 'idx' }, state);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: 'idx', exists: true, documentCount: 7 });
    expect(getIndexStats).toHaveBeenCalledWith('idx');
  });

  it('falls back to the catalog when no index is given', async () => {
    const state = createMockState({
      services: {
        'core.ReactorySearchService@1.0.0': {},
        'reactor.SystemGraphManager@1.0.0': {
          getSearchIndexCatalog: jest.fn().mockResolvedValue([{ index: 'a' }, { index: 'b' }]),
        },
      },
    });
    const result: any = await (GetIndexStatsDef!.component as any)({}, state);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });
});
