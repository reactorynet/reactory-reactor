import GetProjectMacroDefinition from '../GetProject.macro';

describe('GetProject Macro Definition & Execution', () => {
  const generateMockFiles = (count: number) => {
    const files = [];
    const types = ['typescript', 'javascript', 'json', 'markdown', 'yaml'];
    for (let i = 0; i < count; i++) {
      const type = types[i % types.length];
      const ext = type === 'typescript' ? 'ts' : type === 'javascript' ? 'js' : type;
      files.push({
        id: 1000 + i,
        path: `src/components/module_${Math.floor(i / 10)}/File_${i}.${ext}`,
        type
      });
    }
    return files;
  };

  const createMockServices = (projectData: any) => {
    const mockProjectService = {
      getProject: jest.fn().mockResolvedValue(projectData),
      getPrimaryDocumentation: jest.fn().mockResolvedValue({
        title: 'Project Readme',
        format: 'markdown',
        content: '# Readme Content'
      }),
      getProjectMetrics: jest.fn().mockResolvedValue([])
    };

    const mockContext = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      getService: jest.fn().mockImplementation((id: string) => {
        if (id === 'reactor.ReactorProjectService@1.0.0') return mockProjectService;
        return null;
      })
    };

    const mockState = {
      context: mockContext,
      vars: {},
      save: jest.fn().mockResolvedValue(true)
    } as any;

    return { mockProjectService, mockContext, mockState };
  };

  it('should define the getProject tool with child file parameters in schema', () => {
    expect(GetProjectMacroDefinition.name).toBe('GetProject');
    expect(GetProjectMacroDefinition.alias).toBe('getProject');
    expect(GetProjectMacroDefinition.tools).toHaveLength(1);

    const tool = GetProjectMacroDefinition.tools[0];
    expect(tool.function.name).toBe('getProject');
    expect(tool.function.parameters.properties).toHaveProperty('idOrPath');
    expect(tool.function.parameters.properties).toHaveProperty('includeFiles');
    expect(tool.function.parameters.properties).toHaveProperty('fileSearch');
    expect(tool.function.parameters.properties).toHaveProperty('page');
    expect(tool.function.parameters.properties).toHaveProperty('pageSize');
  });

  it('should return an error if idOrPath is missing', async () => {
    const mockState = { context: { debug: jest.fn(), error: jest.fn() }, vars: {} } as any;

    const result: any = await GetProjectMacroDefinition.component(
      { idOrPath: '' },
      mockState
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('idOrPath parameter is required');
  });

  it('should return an error if project is not found', async () => {
    const { mockState } = createMockServices(null);

    const result: any = await GetProjectMacroDefinition.component(
      { idOrPath: 'non-existent' },
      mockState
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Project not found');
  });

  it('should omit child files by default on large projects to prevent context bloat', async () => {
    const mockFiles = generateMockFiles(500);
    const mockProject = {
      id: 'p-1',
      name: 'large-project',
      nameSpace: 'reactory',
      version: '1.0.0',
      files: mockFiles
    };

    const { mockState } = createMockServices(mockProject);

    const result: any = await GetProjectMacroDefinition.component(
      { idOrPath: 'large-project' },
      mockState
    );

    expect(result.success).toBe(true);
    expect(result.data.project.files).toHaveLength(0);
    expect(result.data.fileSummary.totalFiles).toBe(500);
    expect(result.data.fileSummary.matchingFiles).toBe(500);
    expect(result.data.fileSummary.note).toContain('omitted to prevent context bloat');
    expect(result.data.fileSummary.breakdown.typescript).toBe(100);

    // Verify chatState does not retain massive array
    expect(mockState.vars.lastRetrievedProject.files).toHaveLength(0);
    expect(mockState.vars.lastProjectFileSummary.totalFiles).toBe(500);
  });

  it('should paginate child files when requested with includeFiles: true', async () => {
    const mockFiles = generateMockFiles(100);
    const mockProject = {
      id: 'p-1',
      name: 'large-project',
      nameSpace: 'reactory',
      version: '1.0.0',
      files: mockFiles
    };

    const { mockState } = createMockServices(mockProject);

    const result: any = await GetProjectMacroDefinition.component(
      {
        idOrPath: 'large-project',
        includeFiles: true,
        page: 2,
        pageSize: 15
      },
      mockState
    );

    expect(result.success).toBe(true);
    expect(result.data.project.files).toHaveLength(15);
    expect(result.data.project.files[0].path).toBe('src/components/module_1/File_15.ts');
    expect(result.data.fileSummary.page).toBe(2);
    expect(result.data.fileSummary.pageSize).toBe(15);
    expect(result.data.fileSummary.totalFiles).toBe(100);
    expect(result.data.fileSummary.totalPages).toBe(7);
    expect(result.data.fileSummary.hasNext).toBe(true);
  });

  it('should filter child files when fileSearch is provided', async () => {
    const mockFiles = [
      { id: 1, path: 'src/routes/userRouter.ts', type: 'typescript' },
      { id: 2, path: 'src/routes/authRouter.ts', type: 'typescript' },
      { id: 3, path: 'src/models/User.ts', type: 'typescript' },
      { id: 4, path: 'src/config/auth.json', type: 'json' },
      { id: 5, path: 'README.md', type: 'markdown' }
    ];
    const mockProject = {
      id: 'p-1',
      name: 'api-service',
      nameSpace: 'reactory',
      version: '1.0.0',
      files: mockFiles
    };

    const { mockState } = createMockServices(mockProject);

    const result: any = await GetProjectMacroDefinition.component(
      {
        idOrPath: 'api-service',
        fileSearch: 'auth'
      },
      mockState
    );

    expect(result.success).toBe(true);
    // Should match authRouter.ts and auth.json
    expect(result.data.project.files).toHaveLength(2);
    expect(result.data.fileSummary.totalFiles).toBe(5);
    expect(result.data.fileSummary.matchingFiles).toBe(2);
    expect(result.data.project.files.map((f: any) => f.path)).toEqual([
      'src/routes/authRouter.ts',
      'src/config/auth.json'
    ]);
  });

  it('should support regex search in fileSearch', async () => {
    const mockFiles = [
      { id: 1, path: 'src/index.ts', type: 'typescript' },
      { id: 2, path: 'src/App.tsx', type: 'typescript' },
      { id: 3, path: 'package.json', type: 'json' },
      { id: 4, path: 'docs/guide.md', type: 'markdown' }
    ];
    const mockProject = {
      id: 'p-1',
      name: 'frontend',
      nameSpace: 'reactory',
      version: '1.0.0',
      files: mockFiles
    };

    const { mockState } = createMockServices(mockProject);

    const result: any = await GetProjectMacroDefinition.component(
      {
        idOrPath: 'frontend',
        fileSearch: '\\.tsx?$'
      },
      mockState
    );

    expect(result.success).toBe(true);
    expect(result.data.project.files).toHaveLength(2);
    expect(result.data.fileSummary.matchingFiles).toBe(2);
    expect(result.data.project.files.map((f: any) => f.path)).toEqual([
      'src/index.ts',
      'src/App.tsx'
    ]);
  });

  it('should correctly format markdown with file summary and paged list', async () => {
    const mockFiles = [
      { id: 1, path: 'src/index.ts', type: 'typescript' },
      { id: 2, path: 'package.json', type: 'json' }
    ];
    const mockProject = {
      id: 'p-1',
      name: 'my-app',
      nameSpace: 'reactory',
      version: '1.0.0',
      files: mockFiles
    };

    const { mockState } = createMockServices(mockProject);

    const result: any = await GetProjectMacroDefinition.component(
      {
        idOrPath: 'my-app',
        format: 'markdown',
        includeFiles: true
      },
      mockState
    );

    expect(result.success).toBe(true);
    expect(typeof result.data).toBe('string');
    expect(result.data).toContain('# Project Details: my-app');
    expect(result.data).toContain('## Project Files');
    expect(result.data).toContain('- **Total Files**: 2');
    expect(result.data).toContain('`src/index.ts`');
  });

  it('should correctly format summary with fileSummary', async () => {
    const mockFiles = [
      { id: 1, path: 'src/index.ts', type: 'typescript' },
      { id: 2, path: 'package.json', type: 'json' }
    ];
    const mockProject = {
      id: 'p-1',
      name: 'my-app',
      nameSpace: 'reactory',
      version: '1.0.0',
      files: mockFiles
    };

    const { mockState } = createMockServices(mockProject);

    const result: any = await GetProjectMacroDefinition.component(
      {
        idOrPath: 'my-app',
        format: 'summary'
      },
      mockState
    );

    expect(result.success).toBe(true);
    expect(result.data.summary.projectName).toBe('my-app');
    expect(result.data.project.fileSummary.totalFiles).toBe(2);
    expect(result.data.files).toBeUndefined();
  });
});
