import { loadYamlWorkflow } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/YamlToWorkflow';
import path from 'path';

describe('CatalogProjectFolder Workflow & Indexing Improvement', () => {
  const workflowDir = path.join(__dirname, '..');

  it('should successfully load the CatalogProjectFolder.yaml workflow definition', () => {
    const workflow = loadYamlWorkflow('reactor', 'CatalogProjectFolder', 'CatalogProjectFolder.yaml', '1.0.0', workflowDir);

    expect(workflow).not.toBeNull();
    expect(workflow?.name).toBe('CatalogProjectFolder');
    expect(workflow?.nameSpace).toBe('reactor');
    expect(workflow?.version).toBe('1.0.0');
    expect(workflow?.workflowType).toBe('YAML');
  });

  it('should include required workflow steps: catalogProject and indexProjectContent', () => {
    const workflow = loadYamlWorkflow('reactor', 'CatalogProjectFolder', 'CatalogProjectFolder.yaml', '1.0.0', workflowDir);
    expect(workflow).not.toBeNull();

    const steps = workflow?.props?.steps || [];
    const stepIds = steps.map((s: any) => s.id);

    expect(stepIds).toContain('logStart');
    expect(stepIds).toContain('catalogProject');
    expect(stepIds).toContain('indexProjectContent');
    expect(stepIds).toContain('notifyAgentSession');
    expect(stepIds).toContain('logCompletion');
  });

  it('should configure catalogProject and indexProjectContent to call ReactorProjectService', () => {
    const workflow = loadYamlWorkflow('reactor', 'CatalogProjectFolder', 'CatalogProjectFolder.yaml', '1.0.0', workflowDir);
    const steps = workflow?.props?.steps || [];

    const catalogStep = steps.find((s: any) => s.id === 'catalogProject');
    expect(catalogStep).toBeDefined();
    expect(catalogStep.type).toBe('service_invoke');
    expect(catalogStep.config.service).toBe('reactor.ReactorProjectService@1.0.0');
    expect(catalogStep.config.method).toBe('catalogProject');

    const indexStep = steps.find((s: any) => s.id === 'indexProjectContent');
    expect(indexStep).toBeDefined();
    expect(indexStep.type).toBe('service_invoke');
    expect(indexStep.config.service).toBe('reactor.ReactorProjectService@1.0.0');
    expect(indexStep.config.method).toBe('indexProjectSearch');
  });
});
