import SearchProjectMacroDefinition from '../SearchProject.macro';

describe('SearchProject Macro Definition & Execution', () => {
  it('should define the searchProject tool with proper schema', () => {
    expect(SearchProjectMacroDefinition.name).toBe('SearchProject');
    expect(SearchProjectMacroDefinition.alias).toBe('searchProject');
    expect(SearchProjectMacroDefinition.tools).toHaveLength(1);

    const tool = SearchProjectMacroDefinition.tools[0];
    expect(tool.function.name).toBe('searchProject');
    expect(tool.function.parameters.properties).toHaveProperty('projectName');
    expect(tool.function.parameters.properties).toHaveProperty('query');
  });

  it('should return an error if search query is missing', async () => {
    const mockState = { context: { debug: jest.fn(), error: jest.fn() }, vars: {} } as any;

    const result: any = await SearchProjectMacroDefinition.component(
      { projectName: 'reactory-express-server', query: '' },
      mockState
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('query is required');
  });

  it('should return an error if project identifier is missing', async () => {
    const mockState = { context: { debug: jest.fn(), error: jest.fn() }, vars: {} } as any;

    const result: any = await SearchProjectMacroDefinition.component(
      { query: 'test' },
      mockState
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Project identifier');
  });

  it('should search project index via ReactorySearchService when parameters are valid', async () => {
    const mockSearchService = {
      search: jest.fn().mockResolvedValue({
        total: 1,
        results: [
          {
            id: 'doc-1',
            name: 'server.ts',
            path: 'src/express/server.ts',
            type: 'file',
            source: 'import express from "express";',
            _score: 0.95
          }
        ]
      })
    };

    const mockProjectService = {
      getProject: jest.fn().mockResolvedValue({
        id: 'p1',
        name: 'reactory-express-server',
        nameSpace: 'reactory'
      })
    };

    const mockContext = {
      debug: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      getService: jest.fn().mockImplementation((id: string) => {
        if (id === 'reactor.ReactorProjectService@1.0.0') return mockProjectService;
        if (id === 'core.ReactorySearchService@1.0.0') return mockSearchService;
        return null;
      })
    };

    const mockState = { context: mockContext, vars: {} } as any;

    const result: any = await SearchProjectMacroDefinition.component(
      {
        projectName: 'reactory-express-server',
        nameSpace: 'reactory',
        query: 'express'
      },
      mockState
    );

    expect(result.success).toBe(true);
    expect(mockSearchService.search).toHaveBeenCalledWith(
      'reactor_graph_reactory_reactory-express-server',
      'express',
      undefined,
      10,
      0
    );
    expect(mockState.vars.lastProjectSearchResults).toBeDefined();
    expect(mockState.vars.lastProjectSearchResults.totalHits).toBe(1);
  });
});
