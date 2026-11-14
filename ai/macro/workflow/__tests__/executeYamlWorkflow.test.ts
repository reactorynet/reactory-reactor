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
 * D5 — listWorkflowInstances must describe itself honestly.
 *
 * Review round 2 (PR #54):
 * B1 — `saveWorkflowDefinition` registers the FQN in the runner itself, so the provenance lookup
 *      must be taken BEFORE the save or a first-ever `register: true` call reports 'registry'.
 * B2 — a dispatch that could not be confirmed must not report 'failed' (retry would duplicate a run).
 * B3 — a catalog write cannot replace a loaded definition; the receipt must say so.
 * B4 — the lifecycle registry is never populated for engine runs; the copy must not imply waiting.
 * N4 — an unconfirmed catalog write must not be reported as "not written".
 * N5 — PARTIAL must be visible on the receipt.
 * N6 — both dispatch branches use the same { input } envelope.
 * N7 — the schema advertises the string form of `inputs` that the macro accepts.
 * N8 — only `.id` is read from IWorkflowInstance.
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

/** Same identity, different executable steps — used to model a changed file or a stale entry. */
const APPROVAL_WORKFLOW_YAML_CHANGED = APPROVAL_WORKFLOW_YAML.replace(
  'awaitHumanApproval',
  'awaitHumanApprovalV2'
);

const tempDirs: string[] = [];

/** `fs.rmSync` is missing from this repo's @types/node, so reach it through a cast. */
const rmrf = (dir: string): void => {
  try {
    (fs as any).rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
};

const writeWorkflowFile = (contents: string, name = 'workflow.yaml'): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-yaml-workflow-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, 'utf8');
  tempDirs.push(dir);
  return filePath;
};

afterAll(() => {
  for (const dir of tempDirs) rmrf(dir);
});

/** A workflow entry as `WorkflowRunner.registerWorkflow` stores it. */
interface RegisteredWorkflow {
  nameSpace: string;
  name: string;
  version: string;
  workflowType: 'YAML';
  location: string;
  props: any;
}

/** Mirror of `compareWorkflowVersions` (WorkflowRunner.ts:110). */
const compareWorkflowVersions = (a: string, b: string): number => {
  const parse = (value: string): number[] =>
    String(value || '0').trim().split('.').map((segment) => parseInt(segment, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * Mirror of `selectWorkflowByName` (WorkflowRunner.ts:94) including the no-version branch, which
 * reduces to the HIGHEST semver — not the last appended entry. The earlier version of this fake
 * claimed fidelity it did not have.
 */
const selectWorkflowByName = (
  workflows: RegisteredWorkflow[],
  nameSpace: string,
  name: string,
  version?: string
): RegisteredWorkflow | undefined => {
  const matches = workflows.filter((w) => w.nameSpace === nameSpace && w.name === name);
  if (matches.length === 0) return undefined;
  if (version) return matches.find((w) => w.version === version);
  return matches.reduce((latest, candidate) =>
    compareWorkflowVersions(candidate.version, latest.version) > 0 ? candidate : latest
  );
};

/** Mirror of `WorkflowRunner.startWorkflow`'s lookup: FIRST match wins, by id or by bare name. */
const findForStart = (workflows: RegisteredWorkflow[], id: string): RegisteredWorkflow | undefined =>
  workflows.find((w) => `${w.nameSpace}.${w.name}@${w.version}` === id || w.name === id);

const catalogKey = (nameSpace: string, name: string, version: string) =>
  `${nameSpace}.${name}@${version}`;

interface HarnessOptions {
  /** Pre-existing registrations the runner already holds (the catalog-workflow case). */
  registered?: RegisteredWorkflow[];
  /** Pre-existing on-disk catalog entries, keyed `nameSpace.name@version`. */
  catalog?: Record<string, any>;
  startWorkflowResult?: (workflowId: string, input: any) => any;
  startWorkflowError?: Error;
  /** Thrown by validateWorkflowDefinition — models a pre-dispatch failure. */
  validationError?: Error;
  validation?: any;
  /** Returned by saveWorkflowDefinition. `undefined` models an unconfirming implementation. */
  saveResult?: any;
  serviceStartWorkflow?: boolean;
  /** When false, the runner has no getWorkflowByName (older runner). */
  runnerLookup?: boolean;
}

/**
 * A fake `core.ReactoryWorkflowService@1.0.0` that is faithful where it matters here:
 * - the runner's registry is an append-only array resolved by first match;
 * - `saveWorkflowDefinition` writes the catalog map AND registers the FQN in the runner with
 *   `props: {}` — exactly what `ReactoryWorkflowService.saveWorkflowDefinition` does after
 *   `writeFileSync`, and the behaviour that B1 depends on;
 * - `startWorkflow` returns an IWorkflowInstance whose `id` is the engine instance id and whose
 *   `status` is the hardcoded fallback constant the real service returns;
 * - `getWorkflowHistoryById` resolves that id to a persisted record (status 0 / Pending).
 */
const createHarness = (options: HarnessOptions = {}) => {
  const registry: RegisteredWorkflow[] = [...(options.registered ?? [])];
  const catalog = new Map<string, any>(Object.entries(options.catalog ?? {}));
  const instances = new Map<string, { workflowId: string; version?: string; input: any; usedLocation?: string }>();
  let counter = 0;

  const runner: any = {
    isInitialized: jest.fn().mockReturnValue(true),
    state: { workflows: registry },
    // The real method APPENDS; it never replaces by id.
    registerWorkflow: jest.fn((workflow: RegisteredWorkflow) => {
      registry.push(workflow);
    }),
    resetCircuitBreaker: jest.fn(),
    startWorkflow: jest.fn(async (workflowId: string, version: string, data: any) => {
      const id = `runner-instance-${++counter}`;
      const used = findForStart(registry, workflowId);
      instances.set(id, { workflowId, version, input: data, usedLocation: used?.location });
      return id;
    }),
  };

  if (options.runnerLookup !== false) {
    runner.getWorkflowByName = jest.fn(
      (nameSpace: string, name: string, version?: string) =>
        selectWorkflowByName(registry, nameSpace, name, version)
    );
  }

  const service: any = {
    workflowRunner: runner,
    onStartup: jest.fn().mockResolvedValue(undefined),
    validateWorkflowDefinition: jest.fn(async () => {
      if (options.validationError) throw options.validationError;
      return options.validation ?? { isValid: true };
    }),
    saveWorkflowDefinition: jest.fn(async (definition: any) => {
      const result = 'saveResult' in options
        ? options.saveResult
        : { loadStatus: 'SUCCESS', errors: [] };
      if (result && (result.loadStatus === 'SUCCESS' || result.loadStatus === 'PARTIAL')) {
        const { nameSpace, name, version } = definition;
        const targetFile = `/reactory-data/workflows/catalog/${nameSpace}/${name}/${version}/${name}.yaml`;
        catalog.set(catalogKey(nameSpace, name, version), definition);
        // Mirrors ReactoryWorkflowService.saveWorkflowDefinition: register the FQN (with empty
        // props, so the definition is lazily parsed from `location`) if it is not already known.
        if (!selectWorkflowByName(registry, nameSpace, name, version)) {
          registry.push({
            nameSpace,
            name,
            version,
            workflowType: 'YAML',
            location: targetFile,
            props: {},
          });
        }
      }
      return result;
    }),
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
      if (!id) return id;
      const version = String(workflowId).split('@').pop();
      const used = findForStart(registry, workflowId);
      instances.set(id, { workflowId, version, input, usedLocation: used?.location });
      return {
        id,
        workflowId,
        version,
        // Exactly what the real service returns for an engine-started instance: its hardcoded
        // fallback status, not an observation.
        status: 'running',
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

  return {
    service,
    runner,
    registry,
    catalog,
    instances,
    context,
    state: { context, vars: {} } as any,
  };
};

describe('executeYamlWorkflow registry contract', () => {
  const tool = ExecuteYamlWorkflowRegistry.tools[0];
  const properties = () => (tool.function.parameters as any).properties;

  it('does not advertise a timeout parameter (D2)', () => {
    expect(properties()).not.toHaveProperty('timeout');
    expect(ExecuteYamlWorkflowRegistry.description).not.toMatch(/timeout/i);
    expect(tool.function.description).not.toMatch(/maximum execution time/i);
  });

  it('exposes register as an opt-in boolean and still requires filePath', () => {
    expect(properties().register).toMatchObject({ type: 'boolean' });
    expect((tool.function.parameters as any).required).toEqual(['filePath']);
  });

  it('advertises the string form of inputs that the macro accepts (N7)', () => {
    expect(properties().inputs.oneOf).toEqual([
      expect.objectContaining({ type: 'object' }),
      expect.objectContaining({ type: 'string' }),
    ]);
  });

  it('documents the three statuses and the provenance fields', () => {
    const both = `${ExecuteYamlWorkflowRegistry.description}\n${tool.function.description}`;
    expect(both).toMatch(/dispatched_unconfirmed/);
    expect(both).toMatch(/do not retry/i);
    expect(both).toMatch(/getRecentExecutions/);
    expect(both).toMatch(/definitionSource/);
    expect(both).toMatch(/definitionStale/);
    expect(both).toMatch(/bump .?version/i);
    expect(both).toMatch(/restart the server/i);
    // The remedy that cannot work must be gone.
    expect(ExecuteYamlWorkflowRegistry.description).not.toMatch(/re-save it with saveWorkflowYaml/);
    expect(tool.function.description).not.toMatch(/saveWorkflowYaml/);
  });
});

describe('executeYamlWorkflow dispatch result (D1/D3/B1)', () => {
  it('returns the engine instance id and an explicit status, with no phantom or observed-status field', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness();

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(true);
    expect(result.status).toBe('dispatched');
    expect(result.fqn).toBe('core.HumanApprovalProbe@1.0.0');
    expect(result.instanceId).toBe('instance-1');
    expect(result.registered).toBe(false);
    expect(result.definitionSource).toBe('file');
    expect(result.definitionStale).toBe(false);

    for (const [key, value] of Object.entries(result)) {
      expect({ key, value }).not.toEqual({ key, value: undefined });
    }
    expect(result).not.toHaveProperty('outputs');
    expect(result).not.toHaveProperty('state');
    // B1 (round 1): the service's status is a constant, so no run-status field may be emitted.
    expect(result).not.toHaveProperty('instanceStatus');
    expect(result).not.toHaveProperty('statusLabel');
    // N5: loadStatus belongs to a catalog write only.
    expect(result).not.toHaveProperty('loadStatus');

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

  it('parses string inputs before dispatching (N7)', async () => {
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

    // The receipt and the record answer different questions and must not be compared as if they
    // answered the same one. The receipt says what the CALL did; the record says what the RUN is
    // doing. The receipt carries no run status, so it cannot disagree with 'Pending'.
    expect(history.items[0].statusLabel).toBe('Pending');
    expect(history.items[0].status).toBe(0);
    expect(dispatched.status).toBe('dispatched');
    expect(dispatched).not.toHaveProperty('instanceStatus');
  });

  it('uses the same { input } envelope in the runner fallback (N6)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness({ serviceStartWorkflow: false });

    const result: any = await executeYamlWorkflow(
      { filePath, inputs: { input: { nested: true } } },
      state,
      context
    );

    expect(result.success).toBe(true);
    expect(result.instanceId).toBe('runner-instance-1');
    expect(result.definitionSource).toBe('file');
    // Both branches must unwrap to the same depth when a workflow input is itself named `input`.
    expect(service.workflowRunner.startWorkflow).toHaveBeenCalledWith(
      'core.HumanApprovalProbe@1.0.0',
      '1.0.0',
      { input: { input: { nested: true } } },
      context
    );
  });

  it('reports dispatched_unconfirmed — not failed — when no instance id comes back (B2)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { state, context } = createHarness({ startWorkflowResult: () => undefined });

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('dispatched_unconfirmed');
    expect(result.fqn).toBe('core.HumanApprovalProbe@1.0.0');
    expect(result.error).toMatch(/no instance id/);
    expect(result.error).toMatch(/do NOT retry/i);
    expect(result.error).toMatch(/getRecentExecutions/);
  });

  it('reports dispatched_unconfirmed — not failed — when the dispatch throws (B2)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { state, context } = createHarness({ startWorkflowError: new Error('engine offline') });

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('dispatched_unconfirmed');
    // The old shape dropped fqn, leaving the caller with no handle at all.
    expect(result.fqn).toBe('core.HumanApprovalProbe@1.0.0');
    expect(result.error).toMatch(/engine offline/);
    expect(result.error).toMatch(/may be live/i);
    expect(result.error).toMatch(/getRecentExecutions/);
    expect(result.stack).toBeTruthy();
  });

  it('reports failed — and carries fqn — when the failure is before the dispatch attempt', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness({
      validationError: new Error('validation service unavailable'),
    });

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.fqn).toBe('core.HumanApprovalProbe@1.0.0');
    expect(result.error).toBe('validation service unavailable');
    expect(service.startWorkflow).not.toHaveBeenCalled();
  });
});

describe('executeYamlWorkflow catalog integrity (D4/N4/N5)', () => {
  it('performs no catalog write on a default run and leaves the registered entry untouched', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const liveDefinition = { nameSpace: 'core', name: 'HumanApprovalProbe', version: '1.0.0', steps: [{ id: 'live', type: 'shell' }] };
    const { service, catalog, state, context } = createHarness({
      catalog: { 'core.HumanApprovalProbe@1.0.0': liveDefinition },
    });
    const before = JSON.stringify([...catalog.entries()]);

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.registered).toBe(false);
    // The write path was not invoked at all (the exact assertion the ticket asks for)…
    expect(service.saveWorkflowDefinition).not.toHaveBeenCalled();
    // …and the registered definition is still byte-identical.
    expect(JSON.stringify([...catalog.entries()])).toBe(before);
    expect(catalog.get('core.HumanApprovalProbe@1.0.0')).toBe(liveDefinition);
  });

  it('writes the catalog only when register: true is passed explicitly', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, catalog, state, context } = createHarness();

    const result: any = await executeYamlWorkflow({ filePath, register: true }, state, context);

    expect(result.success).toBe(true);
    expect(result.registered).toBe(true);
    expect(result.loadStatus).toBe('SUCCESS');
    expect(service.saveWorkflowDefinition).toHaveBeenCalledTimes(1);
    const written = service.saveWorkflowDefinition.mock.calls[0][0];
    expect(written).toMatchObject({
      nameSpace: 'core',
      name: 'HumanApprovalProbe',
      version: '1.0.0',
    });
    expect(catalog.get('core.HumanApprovalProbe@1.0.0')).toBe(written);
  });

  it('reports definitionSource "file" for a first-ever register: true call (B1)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, runner, registry, state, context } = createHarness();

    const result: any = await executeYamlWorkflow({ filePath, register: true }, state, context);

    // The save registers the FQN in the runner, so a post-save lookup would always be truthy.
    // The snapshot taken before the save is what makes this honest.
    expect(result.definitionSource).toBe('file');
    expect(result.definitionStale).toBe(false);
    expect(result).not.toHaveProperty('warning');
    // The macro did not append on top of the service's own registration.
    expect(runner.registerWorkflow).not.toHaveBeenCalled();
    expect(registry).toHaveLength(1);
    expect(service.saveWorkflowDefinition).toHaveBeenCalledTimes(1);
  });

  it('reports definitionStale when register: true cannot change what runs (B3)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const staleEntry: RegisteredWorkflow = {
      nameSpace: 'core',
      name: 'HumanApprovalProbe',
      version: '1.0.0',
      workflowType: 'YAML',
      location: '/reactory-data/workflows/catalog/core/HumanApprovalProbe/1.0.0/HumanApprovalProbe.yaml',
      props: { nameSpace: 'core', name: 'HumanApprovalProbe', version: '1.0.0', steps: [{ id: 'loaded', type: 'shell' }] },
    };
    const { catalog, state, context } = createHarness({ registered: [staleEntry] });

    const result: any = await executeYamlWorkflow({ filePath, register: true }, state, context);

    // The catalog write happened…
    expect(result.registered).toBe(true);
    expect(result.loadStatus).toBe('SUCCESS');
    expect(catalog.has('core.HumanApprovalProbe@1.0.0')).toBe(true);
    // …but it did not change the executed definition, and the receipt says so instead of
    // presenting `registered: true` as a success signal.
    expect(result.definitionSource).toBe('registry');
    expect(result.definitionStale).toBe(true);
    expect(result.warning).toMatch(/catalog was updated/i);
    expect(result.warning).toMatch(/bump .?version/i);
  });

  it('surfaces PARTIAL on the receipt rather than silently accepting it (N5)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { state, context } = createHarness({
      saveResult: { loadStatus: 'PARTIAL', errors: [{ stage: 'VALIDATION', message: 'step lacks a timeout', code: 'STEP_WARNING' }] },
    });

    const result: any = await executeYamlWorkflow({ filePath, register: true }, state, context);

    expect(result.success).toBe(true);
    expect(result.registered).toBe(true);
    expect(result.loadStatus).toBe('PARTIAL');
  });

  it('does not dispatch when an explicitly requested catalog write fails (N4)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, catalog, state, context } = createHarness({
      saveResult: {
        loadStatus: 'PARSE_ERROR',
        errors: [{ stage: 'VALIDATION', message: 'step awaitHumanApproval is invalid', code: 'INVALID_STEP' }],
      },
    });

    const result: any = await executeYamlWorkflow({ filePath, register: true }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.loadStatus).toBe('PARSE_ERROR');
    expect(result.error).toMatch(/PARSE_ERROR/);
    // Error CODES must survive: a bare message loses the machine-readable reason.
    expect(result.error).toMatch(/step awaitHumanApproval is invalid \(INVALID_STEP\)/);
    // N4: do not assert a fact the macro has not observed — the service writes before it reads back.
    expect(result.error).toMatch(/could not be confirmed/i);
    expect(result.error).not.toMatch(/catalog was not written/i);
    expect(service.startWorkflow).not.toHaveBeenCalled();
    expect(catalog.size).toBe(0);
  });

  it('treats a missing save result as a registration failure (N4)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness({ saveResult: undefined });

    const result: any = await executeYamlWorkflow({ filePath, register: true }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.registered).toBeUndefined();
    expect(result.error).toMatch(/no loadStatus returned by saveWorkflowDefinition/);
    expect(service.startWorkflow).not.toHaveBeenCalled();
  });

  it('treats a result without a loadStatus as a registration failure (N4)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, state, context } = createHarness({ saveResult: { errors: [] } });

    const result: any = await executeYamlWorkflow({ filePath, register: true }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no loadStatus returned by saveWorkflowDefinition/);
    expect(service.startWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an invalid definition before dispatch', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { service, catalog, state, context } = createHarness({
      validation: { isValid: false, errors: [{ message: 'step __end__ is unreachable', code: 'UNREACHABLE' }] },
    });

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/failed validation/);
    expect(result.error).toMatch(/step __end__ is unreachable \(UNREACHABLE\)/);
    expect(service.saveWorkflowDefinition).not.toHaveBeenCalled();
    expect(service.startWorkflow).not.toHaveBeenCalled();
    expect(catalog.size).toBe(0);
  });
});

describe('executeYamlWorkflow definition provenance (B1/C5)', () => {
  it('registers the file and reports definitionSource "file" for an unregistered FQN', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { runner, registry, instances, state, context } = createHarness();

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.definitionSource).toBe('file');
    expect(result).not.toHaveProperty('warning');
    expect(runner.registerWorkflow).toHaveBeenCalledTimes(1);
    expect(registry).toHaveLength(1);
    expect(registry[0].location).toBe(filePath);
    expect(instances.get(result.instanceId)?.usedLocation).toBe(filePath);
  });

  it('stays "file" and silent when the same unchanged file is run again (C5)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { runner, registry, state, context } = createHarness();

    const first: any = await executeYamlWorkflow({ filePath }, state, context);
    const second: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(first.definitionSource).toBe('file');
    expect(second.definitionSource).toBe('file');
    // The old behaviour warned on every later call, which turned the warning into noise exactly
    // on the run where the file really had changed.
    expect(second).not.toHaveProperty('warning');
    expect(second.definitionStale).toBe(false);
    // No dead append on the repeat call.
    expect(runner.registerWorkflow).toHaveBeenCalledTimes(1);
    expect(registry).toHaveLength(1);
  });

  it('reports "registry" and warns when the file changed but the process holds the old steps (C5)', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { state, context } = createHarness();

    await executeYamlWorkflow({ filePath }, state, context);
    fs.writeFileSync(filePath, APPROVAL_WORKFLOW_YAML_CHANGED, 'utf8');
    const changed: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(changed.definitionSource).toBe('registry');
    expect(changed.warning).toMatch(/steps differ from/);
    expect(changed.warning).toMatch(/not the steps in this file/);
    // Not stale: `registered` is false, so no catalog write is being oversold.
    expect(changed.definitionStale).toBe(false);
  });

  it('reports "registry", does not append, and runs the registered definition for a differing entry', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const alreadyRegistered: RegisteredWorkflow = {
      nameSpace: 'core',
      name: 'HumanApprovalProbe',
      version: '1.0.0',
      workflowType: 'YAML',
      location: '/catalog/core/HumanApprovalProbe/1.0.0/HumanApprovalProbe.yaml',
      props: { nameSpace: 'core', name: 'HumanApprovalProbe', version: '1.0.0', steps: [{ id: 'catalog', type: 'shell' }] },
    };
    const { runner, registry, instances, state, context } = createHarness({
      registered: [alreadyRegistered],
    });

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(true);
    expect(result.status).toBe('dispatched');
    expect(result.definitionSource).toBe('registry');
    expect(result.warning).toMatch(/steps differ from/);
    expect(result.warning).toMatch(/bump .?version/i);
    expect(result.warning).toMatch(/restart the server/i);

    expect(runner.registerWorkflow).not.toHaveBeenCalled();
    expect(registry).toHaveLength(1);
    // The truth the warning states: a changed file is NOT what the run executes.
    expect(instances.get(result.instanceId)?.usedLocation).toBe(alreadyRegistered.location);
  });

  it('does not grow the registry across repeated calls for the same FQN', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { registry, state, context } = createHarness();

    await Promise.all([
      executeYamlWorkflow({ filePath }, state, context),
      executeYamlWorkflow({ filePath }, state, context),
      executeYamlWorkflow({ filePath }, state, context),
    ]);

    // Concurrent first calls can each see an empty registry (no lock in the runner); what must
    // not happen is unbounded growth per call afterwards.
    const afterFirstBurst = registry.length;
    await executeYamlWorkflow({ filePath }, state, context);
    expect(registry.length).toBe(afterFirstBurst);
    expect(afterFirstBurst).toBeLessThanOrEqual(3);
  });

  it('falls back to "file" when the runner has no getWorkflowByName', async () => {
    const filePath = writeWorkflowFile(APPROVAL_WORKFLOW_YAML);
    const { runner, state, context } = createHarness({ runnerLookup: false });

    const result: any = await executeYamlWorkflow({ filePath }, state, context);

    expect(result.success).toBe(true);
    expect(result.definitionSource).toBe('file');
    expect(result.definitionStale).toBe(false);
    expect(runner.registerWorkflow).toHaveBeenCalledTimes(1);
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

describe('listWorkflowInstances registry honesty (B4)', () => {
  it('states that the registry is not populated for engine runs', () => {
    const copy = `${ListWorkflowInstancesRegistry.description}\n${ListWorkflowInstancesRegistry.tools[0].function.description}`;
    expect(copy).toMatch(/not populated/i);
    expect(copy).toMatch(/do not poll|does NOT mean|does not mean/i);
    expect(copy).toMatch(/getRecentExecutions/);
    expect(copy).toMatch(/getWorkflowHistory/);
    // The timing hint that invited polling must be gone.
    expect(copy).not.toMatch(/may not appear here yet/);
    expect(copy).not.toMatch(/live runs: pending, running, paused/);
  });

  it('no longer describes the id filter as an instance id', () => {
    const idProperty = (ListWorkflowInstancesRegistry.tools[0].function.parameters as any).properties.id;
    expect(idProperty.description).toMatch(/not an instance id/i);
    expect(idProperty.description).toMatch(/getWorkflowHistory/);
  });

  it('reports engineRunsTracked: false and a hint when nothing is registered', async () => {
    const { service, state, context } = createHarness();
    service.getWorkflowInstances.mockResolvedValue({
      instances: [],
      pagination: { page: 1, pages: 0, limit: 20, total: 0 },
    });

    const result: any = await listWorkflowInstances({ name: 'HumanApprovalProbe' }, state, context);

    expect(result.success).toBe(true);
    expect(result.instances).toEqual([]);
    expect(result.engineRunsTracked).toBe(false);
    expect(result.note).toMatch(/not populated/i);
    expect(result.note).toMatch(/getRecentExecutions/);
  });

  it('does not add the hint when a page is past the end of a non-empty result', async () => {
    const { service, state, context } = createHarness();
    service.getWorkflowInstances.mockResolvedValue({
      instances: [],
      pagination: { page: 2, pages: 1, limit: 20, total: 1 },
    });

    const result: any = await listWorkflowInstances({ page: 2 }, state, context);

    expect(result.success).toBe(true);
    // "Nothing is tracked here" would be wrong: there IS an entry, this page is just past it.
    expect(result).not.toHaveProperty('note');
    expect(result.pagination.total).toBe(1);
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
