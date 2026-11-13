import fs from 'fs';
import os from 'os';
import path from 'path';

import { executeYamlWorkflow, ExecuteYamlWorkflowRegistry } from '../executeYaml.macro';
import { listWorkflowInstances, ListWorkflowInstancesRegistry } from '../listWorkflowInstances.macro';
import { getWorkflowHistory } from '../getWorkflowHistory.macro';

/**
 * Regression suite for REACTORY-302016408/20261113/2498408002.
 *
 * D1 — the engine instance id must be returned (it is the only handle for an async run).
 * D2 — `timeout` was a documented no-op and is removed.
 * D3 — `success: true` must always carry an explicit lifecycle status (and no phantom slots).
 * D4 — the on-disk catalog must not be written unless the caller asks for it.
 * D5 — listWorkflowInstances must describe itself honestly and point at the history surface.
 */

const APPROVAL_WORKFLOW_YAML = `nameSpace: core
name: HumanApprovalProbe
version: 1.0.0
description: Probe workflow with a human approval step
inputs:
  ticketReference: ''
steps:
  - id: __start__
    type: start
  - id: awaitHumanApproval
    type: wait_event
    config:
      eventName: ticket.approved
  - id: __end__
    type: end
`;

const tempDirs: string[] = [];

const writeWorkflowFile = (contents: string, name = 'workflow.yaml'): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-yaml-workflow-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, 'utf8');
  tempDirs.push(dir);
  return filePath;
};

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, entry));
      }
      fs.rmdirSync(dir);
    } catch {
      // best effort
    }
  }
});

interface HarnessOptions {
  startWorkflowResult?: (workflowId: string, input: any) => any;
  startWorkflowError?: Error;
  validation?: any;
  saveResult?: any;
  serviceStartWorkflow?: boolean;
}

/**
 * Build a fake `core.ReactoryWorkflowService@1.0.0` that behaves like the real one where it
 * matters here: `startWorkflow` returns an IWorkflowInstance (id + status), the runner's
 * `startWorkflow` returns the bare instance id string, and `getWorkflowHistoryById` resolves a
 * dispatched instance.
 */
const createHarness = (options: HarnessOptions = {}) => {
  const instances = new Map<string, any>();
  let counter = 0;

  const runner = {
    isInitialized: jest.fn().mockReturnValue(true),
    registerWorkflow: jest.fn(),
    resetCircuitBreaker: jest.fn(),
    startWorkflow: jest.fn(async (workflowId: string, version: string, data: any) => {
      const id = `runner-instance-${++counter}`;
      instances.set(id, { workflowId, version, input: data });
      return id;
    }),
  };

  const service: any = {
    workflowRunner: runner,
    onStartup: jest.fn().mockResolvedValue(undefined),
    validateWorkflowDefinition: jest.fn().mockResolvedValue(options.validation ?? { isValid: true }),
    saveWorkflowDefinition: jest.fn().mockResolvedValue(options.saveResult ?? { loadStatus: 'SUCCESS', errors: [] }),
    getWorkflowInstances: jest.fn(),
    getWorkflowHistoryById: jest.fn(async (instanceId: string) => {
      const stored = instances.get(instanceId);
      if (!stored) return undefined;
      return {
        id: instanceId,
        workflowDefinitionId: stored.workflowId,
        version: stored.version,
        status: 0,
        statusLabel: 'Pending',
        stepCount: 3,
        completedStepCount: 1,
        failedStepCount: 0,
        data: stored.input,
      };
    }),
  };

  if (options.serviceStartWorkflow !== false) {
    service.startWorkflow = jest.fn(async (workflowId: string, input: any) => {
      if (options.startWorkflowError) throw options.startWorkflowError;
      const id = options.startWorkflowResult
        ? options.startWorkflowResult(workflowId, input)
        : `instance-${++counter}`;
      if (id && typeof id === 'object') {
        instances.set(id.id, { workflowId, version: id.version, input });
        return id;
      }
      instances.set(id, { workflowId, input });
      return {
        id,
        workflowId,
        version: String(workflowId).split('@').pop(),
        // Deliberately upper-case: the macro must normalise to the engine vocabulary.
        status: 'RUNNING',
        priority: 2,
        startedAt: new Date(),
        updatedAt: new Date(),
        dependencies: [],
        dependents: [],
        cleanupTasks: [],
        resourceUsage: { memory: 0, cpu: 0, disk: 0 },
      };
    });
  }

  const context: any = {
    log: jest.fn(),
    getService: jest.fn((id: string) =>
      id === 'core.ReactoryWorkflowService@1.0.0' ? service : null
    ),
  };

  return { service, runner, context, state: { context, vars: {} } as any, instances };
};

describe('executeYamlWorkflow registry contract (D2)', () => {
  const tool = ExecuteYamlWorkflowRegistry.tools[0];
  const properties = () => (tool.function.parameters as any).properties;

  it('does not advertise a timeout parameter', () => {
    expect(properties()).not.toHaveProperty('timeout');
    expect(ExecuteYamlWorkflowRegistry.description).not.toMatch(/timeout/i);
    expect(tool.function.description).not.toMatch(/maximum execution time/i);
  });

  it('exposes register as an opt-in boolean and still requires filePath', () => {
    expect(properties().register).toMatchObject({ type: 'boolean' });
    expect((tool.function.parameters as any).required).toEqual(['filePath']);
  });

  it('advertises the dispatch-only result shape', () => {
    expect(tool.function.description).toMatch(/dispatched/);
    expect(tool.function.description).toMatch(/instanceId/);
    expect(tool.function.description).toMatch(/getWorkflowHistory/);
    expect(ExecuteYamlWorkflowRegistry.description).toMatch(/register: true/);
  });
});

describe('executeYamlWorkflow dispatch result (D1/D3)', () => {
  it('returns the engine instance id, an explicit status and no phantom output fields', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness();

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(true);
    expect(result.status).toBe('dispatched');
    expect(result.fqn).toBe('core.HumanApprovalProbe@1.0.0');
    expect(result.instanceId).toBe('instance-1');
    expect(result.instanceStatus).toBe('running');
    expect(result.registered).toBe(false);

    // No output field may be undefined — that is how the old shape lied about completion.
    for (const [key, value] of Object.entries(result)) {
      expect({ key, value }).not.toEqual({ key, value: undefined });
    }
    expect(result).not.toHaveProperty('outputs');
    expect(result).not.toHaveProperty('state');

    expect(service.startWorkflow).toHaveBeenCalledWith('core.HumanApprovalProbe@1.0.0', {
      input: {},
    });
  });

  it('dispatches through the service entry point so the payload is unwrapped correctly', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness();

    await executeYamlWorkflow({ filePath, inputs: { ticketReference: 'REACTORY-1' } }, state, context);

    expect(service.startWorkflow).toHaveBeenCalledWith('core.HumanApprovalProbe@1.0.0', {
      input: { ticketReference: 'REACTORY-1' },
    });
    expect(service.workflowRunner.startWorkflow).not.toHaveBeenCalled();
  });

  it('parses string inputs before dispatching', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness();

    await executeYamlWorkflow({ filePath, inputs: '{"ticketReference":"REACTORY-2"}' }, state, context);

    expect(service.startWorkflow).toHaveBeenCalledWith('core.HumanApprovalProbe@1.0.0', {
      input: { ticketReference: 'REACTORY-2' },
    });
  });

  it('returns an id that resolves through getWorkflowHistory for a human-approval run', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { state, context } = createHarness();

    const dispatched: any = await executeYamlWorkflow(
      { filePath, inputs: { ticketReference: 'REACTORY-302016408/20261113/2498408002' } },
      state,
      context
    );
    expect(dispatched.instanceId).toBeTruthy();

    const history: any = await getWorkflowHistory(
      { instanceId: dispatched.instanceId },
      state,
      context
    );

    expect(history.success).toBe(true);
    expect(history.items).toHaveLength(1);
    expect(history.items[0].id).toBe(dispatched.instanceId);
    expect(history.items[0].workflowDefinitionId).toBe(dispatched.fqn);
    expect(history.items[0].statusLabel).toBe('Pending');
  });

  it('falls back to the runner instance id when the service has no instance-returning entry point', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness({ serviceStartWorkflow: false });

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(true);
    expect(result.status).toBe('dispatched');
    expect(result.instanceId).toBe('runner-instance-1');
    expect(service.workflowRunner.startWorkflow).toHaveBeenCalled();
    // Absent, not `undefined`.
    expect(Object.prototype.hasOwnProperty.call(result, 'instanceStatus')).toBe(false);
  });

  it('reports failure rather than a false success when no instance id comes back', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { state, context } = createHarness({ startWorkflowResult: () => undefined });

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/did not return an instance id/);
  });

  it('reports failure with a status when dispatch throws', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { state, context } = createHarness({ startWorkflowError: new Error('engine offline') });

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('engine offline');
    expect(result.stack).toBeTruthy();
  });
});

describe('executeYamlWorkflow catalog integrity (D4)', () => {
  it('does not write the catalog on a default run', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness();

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.registered).toBe(false);
    // The registered definition is untouched: no write path was invoked at all.
    expect(service.saveWorkflowDefinition).not.toHaveBeenCalled();
    // In-memory registration is still required so the run uses the file's definition.
    expect(service.workflowRunner.registerWorkflow).toHaveBeenCalledTimes(1);
  });

  it('writes the catalog only when register: true is passed explicitly', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness();

    const result: any = await executeYamlWorkflow({ filePath, register: true }, state, context);

    expect(result.success).toBe(true);
    expect(result.registered).toBe(true);
    expect(service.saveWorkflowDefinition).toHaveBeenCalledTimes(1);
    expect(service.saveWorkflowDefinition.mock.calls[0][0]).toMatchObject({
      nameSpace: 'core',
      name: 'HumanApprovalProbe',
      version: '1.0.0',
    });
  });

  it('does not dispatch when an explicitly requested catalog write fails', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness({
      saveResult: {
        loadStatus: 'PARSE_ERROR',
        errors: [{ stage: 'VALIDATION', message: 'step awaitHumanApproval is invalid' }],
      },
    });

    const result: any = await executeYamlWorkflow({ filePath, register: true }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/PARSE_ERROR/);
    expect(result.error).toMatch(/step awaitHumanApproval is invalid/);
    expect(service.startWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an invalid definition before dispatch', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness({
      validation: { isValid: false, errors: [{ message: 'step __end__ is unreachable' }] },
    });

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/failed validation/);
    expect(result.error).toMatch(/step __end__ is unreachable/);
    expect(service.saveWorkflowDefinition).not.toHaveBeenCalled();
    expect(service.startWorkflow).not.toHaveBeenCalled();
  });
});

describe('executeYamlWorkflow input rejection', () => {
  it('rejects a missing filePath', async () => {
    const { state, context } = createHarness();
    const result: any = await executeYamlWorkflow({ filePath: '' } as any, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('filePath is required');
  });

  it('rejects a missing file', async () => {
    const { state, context } = createHarness();
    const result: any = await executeYamlWorkflow(
      { filePath: path.join(os.tmpdir(), 'definitely-not-here-2498408002.yaml') },
      state,
      context
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/File not found/);
  });

  it('rejects unparseable YAML', async () => {
    const filePath = writeWorkflowFile('nameSpace: [unclosed\n  - bad: : :');
    const { state, context } = createHarness();
    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Failed to parse YAML/);
  });

  it('rejects a definition without nameSpace, name and version', async () => {
    const filePath = writeWorkflowFile('name: OnlyAName\nsteps: []\n');
    const { state, context } = createHarness();
    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/nameSpace, name, and version/);
  });
});

describe('listWorkflowInstances registry honesty (D5)', () => {
  it('describes itself as the in-memory registry and points at the history surface', () => {
    expect(ListWorkflowInstancesRegistry.description).toMatch(/in-memory/i);
    expect(ListWorkflowInstancesRegistry.description).toMatch(/getRecentExecutions/);
    expect(ListWorkflowInstancesRegistry.description).toMatch(/getWorkflowHistory/);

    const tool = ListWorkflowInstancesRegistry.tools[0];
    expect(tool.function.description).toMatch(/in-memory/i);
    expect(tool.function.description).toMatch(/getRecentExecutions/);
    expect(tool.function.description).toMatch(/getWorkflowHistory/);
  });

  it('no longer describes the id filter as an instance id', () => {
    const tool = ListWorkflowInstancesRegistry.tools[0];
    const idProperty = (tool.function.parameters as any).properties.id;
    expect(idProperty.description).toMatch(/not an instance id/i);
    expect(idProperty.description).toMatch(/getWorkflowHistory/);
  });

  it('carries a hint when the in-memory registry has nothing to show', async () => {
    const { service, state, context } = createHarness();
    service.getWorkflowInstances.mockResolvedValue({
      instances: [],
      pagination: { page: 1, pages: 0, limit: 20, total: 0 },
    });

    const result: any = await listWorkflowInstances({ name: 'HumanApprovalProbe' }, state, context);

    expect(result.success).toBe(true);
    expect(result.instances).toEqual([]);
    expect(result.note).toMatch(/getRecentExecutions/);
    expect(result.note).toMatch(/getWorkflowHistory/);
  });

  it('does not add the hint when instances are present', async () => {
    const { service, state, context } = createHarness();
    service.getWorkflowInstances.mockResolvedValue({
      instances: [{ id: 'instance-1', workflowId: 'core.HumanApprovalProbe@1.0.0', status: 'pending' }],
      pagination: { page: 1, pages: 1, limit: 20, total: 1 },
    });

    const result: any = await listWorkflowInstances({}, state, context);

    expect(result.success).toBe(true);
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0].id).toBe('instance-1');
    expect(result).not.toHaveProperty('note');
  });

  it('maps every filter and the pagination into the service call', async () => {
    const { service, state, context } = createHarness();
    service.getWorkflowInstances.mockResolvedValue({
      instances: [],
      pagination: { page: 2, pages: 3, limit: 5, total: 12 },
    });

    const result: any = await listWorkflowInstances(
      {
        id: 'core.HumanApprovalProbe@1.0.0',
        nameSpace: 'core',
        name: 'HumanApprovalProbe',
        version: '1.0.0',
        status: 'pending',
        createdBy: 'user-1',
        startTimeFrom: '2026-11-01T00:00:00.000Z',
        startTimeTo: '2026-11-30T00:00:00.000Z',
        page: 2,
        limit: 5,
      },
      state,
      context
    );

    expect(service.getWorkflowInstances).toHaveBeenCalledWith(
      {
        id: 'core.HumanApprovalProbe@1.0.0',
        nameSpace: 'core',
        name: 'HumanApprovalProbe',
        version: '1.0.0',
        status: 'pending',
        createdBy: 'user-1',
        startTimeFrom: new Date('2026-11-01T00:00:00.000Z'),
        startTimeTo: new Date('2026-11-30T00:00:00.000Z'),
      },
      { page: 2, limit: 5 }
    );
    expect(result.pagination).toEqual({ page: 2, pages: 3, limit: 5, total: 12 });
  });

  it('returns an error when no execution context is available', async () => {
    const result: any = await listWorkflowInstances({}, {} as any);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No execution context/);
  });

  it('returns an error when the workflow service is not registered', async () => {
    const state: any = { context: { log: jest.fn(), getService: jest.fn(() => null) }, vars: {} };

    const result: any = await listWorkflowInstances({}, state);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/core.ReactoryWorkflowService@1.0.0 is not available/);
  });

  it('returns an error when the service query throws', async () => {
    const { service, state, context } = createHarness();
    service.getWorkflowInstances.mockRejectedValue(new Error('registry offline'));

    const result: any = await listWorkflowInstances({}, state, context);

    expect(result.success).toBe(false);
    expect(result.error).toBe('registry offline');
    expect(context.log).toHaveBeenCalled();
  });
});
