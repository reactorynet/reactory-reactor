import TSqlProjectProcessor from './TSqlProjectProcessor';

describe('TSqlProjectProcessor', () => {
  it('should instantiate without error', () => {
    const processor = new TSqlProjectProcessor({}, {} as any);
    expect(processor).toBeDefined();
  });

  // Add more tests for supportsProject, getProjectType, etc. as needed
});
