import DeletePerspectiveMacroDefinition from '../DeletePerspective.macro';

describe('DeletePerspective Macro Definition', () => {
  it('should define the deletePerspective tool with proper schema', () => {
    expect(DeletePerspectiveMacroDefinition.name).toBe('DeletePerspective');
    expect(DeletePerspectiveMacroDefinition.alias).toBe('deletePerspective');
    expect(DeletePerspectiveMacroDefinition.tools).toHaveLength(1);

    const tool = DeletePerspectiveMacroDefinition.tools[0];
    expect(tool.function.name).toBe('deletePerspective');
    expect(tool.function.parameters.properties).toHaveProperty('id');
    expect(tool.function.parameters.properties).toHaveProperty('name');
    expect(tool.function.parameters.properties).toHaveProperty('projectId');
    expect(tool.function.parameters.properties).toHaveProperty('confirm');
  });

  it('should return error if no params are passed to macro execution', async () => {
    const mockContext = {
      debug: jest.fn(),
      error: jest.fn(),
    };
    const mockState = { context: mockContext, vars: {} } as any;

    const result: any = await DeletePerspectiveMacroDefinition.component({}, mockState);

    expect(result.success).toBe(false);
    expect(result.error).toContain('At least one parameter');
  });
});
