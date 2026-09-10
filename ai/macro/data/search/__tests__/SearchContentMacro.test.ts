import MacroDefinitions from '../macro';

const [SearchContentMacroDefinition] = MacroDefinitions;

function makeState(searchImpl: (index: string, query: string, fields: any, limit: number, offset: number) => Promise<any>) {
  const mockContext = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    getService: jest.fn().mockReturnValue({
      search: jest.fn(searchImpl),
    }),
  };
  return { context: mockContext, vars: {} } as any;
}

describe('SearchContent Macro Definition', () => {
  it('should define the searchContent tool with a bounded limit and includeFullContent opt-in', () => {
    expect(SearchContentMacroDefinition.name).toBe('SearchContent');
    expect(SearchContentMacroDefinition.alias).toBe('searchContent');

    const tool = SearchContentMacroDefinition.tools[0];
    expect(tool.function.name).toBe('searchContent');
    expect(tool.function.parameters.properties.limit.maximum).toBeLessThanOrEqual(100);
    expect(tool.function.parameters.properties).toHaveProperty('includeFullContent');
    expect(tool.function.parameters.properties.includeFullContent.default).toBe(false);
  });

  it('returns an error when query is empty', async () => {
    const state = makeState(async () => ({ results: [], total: 0 }));
    const result: any = await (SearchContentMacroDefinition.component as any)({ query: '' }, state);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Search query is required');
  });

  it('truncates long source document fields by default (json format)', async () => {
    const longContent = 'A'.repeat(5000);
    const state = makeState(async () => ({
      results: [{ id: 'doc-1', title: 'Doc 1', content: longContent, _score: 1 }],
      total: 1,
    }));

    const result: any = await (SearchContentMacroDefinition.component as any)(
      { query: 'test', indices: ['book-chapters'], format: 'json' },
      state
    );

    expect(result.success).toBe(true);
    const [first] = result.data.results;
    expect(first.source.content.length).toBeLessThan(longContent.length);
    expect(first.source.content.endsWith('...')).toBe(true);
    expect(first.source.contentFullLength).toBe(5000);
  });

  it('returns full content when includeFullContent is explicitly true', async () => {
    const longContent = 'B'.repeat(5000);
    const state = makeState(async () => ({
      results: [{ id: 'doc-1', title: 'Doc 1', content: longContent, _score: 1 }],
      total: 1,
    }));

    const result: any = await (SearchContentMacroDefinition.component as any)(
      { query: 'test', indices: ['book-chapters'], format: 'json', includeFullContent: true },
      state
    );

    expect(result.success).toBe(true);
    const [first] = result.data.results;
    expect(first.source.content).toBe(longContent);
    expect(first.source.contentFullLength).toBeUndefined();
  });

  it('requires an index/indices or persona default before searching', async () => {
    const state = makeState(async () => ({ results: [], total: 0 }));
    const result: any = await (SearchContentMacroDefinition.component as any)({ query: 'test' }, state);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No search index specified');
  });

  describe('follow-up A: richer detailed/markdown formats wired from ./utils', () => {
    const buildResults = () => [
      { id: 'doc-1', title: 'Doc 1', content: 'A'.repeat(50), type: 'chapter', subject: 'mining', _score: 0.9 },
      { id: 'doc-2', title: 'Doc 2', content: 'B'.repeat(50), type: 'glossary', subject: 'economics', _score: 0.3 },
    ];

    it('"detailed" format includes the original fields plus the richer analysis, without colliding on contentTypes', async () => {
      const state = makeState(async () => ({ results: buildResults(), total: 2 }));
      const result: any = await (SearchContentMacroDefinition.component as any)(
        { query: 'test', indices: ['book-chapters'], format: 'detailed' },
        state
      );

      expect(result.success).toBe(true);
      const { analysis } = result.data;
      // Original back-compat fields preserved
      expect(Array.isArray(analysis.contentTypes)).toBe(true);
      expect(analysis.contentTypes.sort()).toEqual(['chapter', 'glossary']);
      expect(typeof analysis.averageScore).toBe('number');
      expect(Array.isArray(analysis.indicesUsed)).toBe(true);
      expect(typeof analysis.hasHighlights).toBe('boolean');
      // New richer fields from analyzeSearchResults, under non-colliding keys
      expect(analysis.scoreDistribution).toEqual({ high: 1, medium: 0, low: 1 });
      expect(analysis.contentTypeCounts).toEqual({ chapter: 1, glossary: 1 });
      expect(analysis.subjects).toEqual({ mining: 1, economics: 1 });
      expect(analysis.difficultyLevels).toBeDefined();
    });

    it('"markdown" format renders the richer createSearchSummaryMarkdown report', async () => {
      const state = makeState(async () => ({ results: buildResults(), total: 2 }));
      const result: any = await (SearchContentMacroDefinition.component as any)(
        { query: 'mining basics', indices: ['book-chapters'], format: 'markdown' },
        state
      );

      expect(result.success).toBe(true);
      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('Search Results Summary');
      expect(result.data).toContain('Score Distribution');
      expect(result.data).toContain('Content Analysis');
      expect(result.data).toContain('Difficulty Levels');
    });

    it('"detailed" analysis does not divide by zero on an empty result set', async () => {
      const state = makeState(async () => ({ results: [], total: 0 }));
      const result: any = await (SearchContentMacroDefinition.component as any)(
        { query: 'nothing matches', indices: ['book-chapters'], format: 'detailed' },
        state
      );
      expect(result.success).toBe(true);
      expect(result.data.analysis.averageScore).toBe(0);
    });
  });
});
