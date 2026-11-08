import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';

/**
 * Operational paths of `WorkflowProgrammeService` that the happy-path suites do
 * not reach: child construction, the control-plane refusal/race branches, the
 * recovery branches that only exist after a crash, and the notification failure
 * paths.
 *
 * These are not vanity coverage: each one is a branch an operator will meet
 * (a cancelled child that refuses to die, a lease lost to another tick, a
 * communicator that throws) and each one has to behave predictably when they do.
 */

const mockTaskSave = jest.fn(async function (this: any) {
  return this;
});

jest.mock('@reactory/server-modules/reactory-core/models/Task', () => {
  const Model: any = function (this: any, doc: any) {
    Object.assign(this, doc, { _id: new ObjectId() });
  };
  Model.prototype.save = mockTaskSave;
  return { __esModule: true, default: Model };
});

import WorkflowProgrammeService, {
  COMMUNICATOR_SERVICE_ID,
  DEFAULT_CHILD_WORKFLOW_ID,
  WORKFLOW_SERVICE_ID,
} from '../WorkflowProgrammeService';
import { InMemoryProgrammeStore } from './support/InMemoryProgrammeStore';

const ownerId = new ObjectId();
const minutes = (value: number) => value * 60_000;

let store: InMemoryProgrammeStore;
let service: WorkflowProgrammeService;
let communicator: { send: any };
let workflowService: any;

const buildContext = (user: any, overrides: Record<string, any> = {}): any => ({
  user,
  partner: { key: 'tenant-a' },
  log: jest.fn(),
  hasRole: (role: string) => (user?.roles || []).includes(role),
  getService: (id: string) => {
    if (id === COMMUNICATOR_SERVICE_ID) return communicator;
    if (id === WORKFLOW_SERVICE_ID) return workflowService;
    return null;
  },
  ...overrides,
});

const baseProgramme = (overrides: Record<string, any> = {}): any => ({
  programmeId: 'p1',
  name: 'Probe',
  state: 'active',
  ownerUserId: ownerId,
  ownerEmail: 'owner@example.com',
  childWorkflowId: DEFAULT_CHILD_WORKFLOW_ID,
  slaMinutes: 45,
  maxAttempts: 3,
  packages: [],
  ...overrides,
});

const pkg = (overrides: Record<string, any> = {}): any => ({
  id: 'pkg-1',
  title: 'Package one',
  dependsOn: [],
  state: 'ready',
  attempt: 0,
  stallCount: 0,
  ...overrides,
});

const tickOptions = (now = new Date()): any => ({
  now,
  staleMs: 120_000,
  leaseMs: 55_000,
  maxDispatchesPerTick: 4,
  maxVerificationsPerTick: 3,
  verificationIntervalMs: 5 * 60_000,
});

beforeEach(() => {
  store = new InMemoryProgrammeStore();
  communicator = { send: jest.fn(async () => ({ success: true })) };
  workflowService = {
    startWorkflow: jest.fn(async () => ({ id: 'child-1' })),
    cancelWorkflowInstance: jest.fn(async () => ({ success: true })),
    getWorkflowHistory: jest.fn(async () => ({ instances: [] })),
  };
  service = Object.create(WorkflowProgrammeService.prototype);
  service.context = buildContext({ _id: ownerId, email: 'owner@example.com', roles: ['USER'] }) as any;
  service.store = store;
  service.ownerContextBuilder = jest.fn(async () => undefined) as any;
  service.ghVerifier = jest.fn(async () => ({ kind: 'skipped' })) as any;
  mockTaskSave.mockReset();
  mockTaskSave.mockImplementation(async function (this: any) {
    return this;
  });
});

// ── child construction ──────────────────────────────────────────────────────

describe('startChild', () => {
  it('merges defaults, the package input and the reconciler fields, and honours a workflow override', async () => {
    const programme = baseProgramme({
      childInputDefaults: { agentId: 'ReactorAIPersona', taskType: 'feature' },
    }) as any;

    await service.startChild(
      programme,
      pkg({ id: 'pkg-9', input: { ticketReference: 'ACME-1' }, childWorkflowId: 'core.Special@1.0.0' }) as any,
      'dispatch-9',
    );

    const [workflowId, execution] = workflowService.startWorkflow.mock.calls[0] as any[];
    expect(workflowId).toBe('core.Special@1.0.0');
    expect(execution.input).toEqual({
      agentId: 'ReactorAIPersona',
      taskType: 'feature',
      ticketReference: 'ACME-1',
      dispatchId: 'dispatch-9',
      programmeId: 'p1',
      packageId: 'pkg-9',
    });
  });

  it('falls back to the programme default when the package names none', async () => {
    await service.startChild(baseProgramme() as any, pkg() as any, 'dispatch-1');
    expect((workflowService.startWorkflow.mock.calls[0] as any[])[0]).toBe(DEFAULT_CHILD_WORKFLOW_ID);
  });

  it('throws (so the tick records it) when the workflow service is unavailable', async () => {
    service.context = buildContext({ _id: ownerId, email: 'owner@example.com' }) as any;
    service.ownerContextBuilder = jest.fn(async () => ({ getService: (): null => null })) as any;

    await expect(service.startChild(baseProgramme() as any, pkg() as any, 'd-1')).rejects.toThrow(
      `${WORKFLOW_SERVICE_ID} is unavailable`,
    );
  });

  it('dispatches under the rebuilt OWNER context when one is available', async () => {
    const ownerWorkflowService = { startWorkflow: jest.fn(async () => ({ id: 'owner-child' })) };
    service.ownerContextBuilder = jest.fn(async () => ({
      getService: (id: string) => (id === WORKFLOW_SERVICE_ID ? ownerWorkflowService : null),
    })) as any;

    const result: any = await service.startChild(baseProgramme() as any, pkg() as any, 'd-1');

    expect(ownerWorkflowService.startWorkflow).toHaveBeenCalledTimes(1);
    // The tick's own service was NOT used: the child belongs to the owner.
    expect(workflowService.startWorkflow).not.toHaveBeenCalled();
    expect(result.id).toBe('owner-child');
  });
});

describe('owner context', () => {
  it('returns undefined when there is no owner email to rebuild from', async () => {
    const built = await WorkflowProgrammeService.prototype.ownerContextBuilder.call(service, {});
    expect(built).toBeUndefined();
  });

  it('falls back to the tick identity (and says so) when the rebuild throws', async () => {
    service.ownerContextBuilder = jest.fn(async () => {
      throw new Error('context factory unavailable');
    }) as any;

    await service.startChild(baseProgramme() as any, pkg() as any, 'd-1');

    // The dispatch still happened, under the tick's context.
    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);
    const logged = (service.context as any).log.mock.calls.map((call: any[]) => call[0]);
    expect(logged.join(' ')).toContain('could not rebuild the programme owner context');
  });
});

// ── reads ───────────────────────────────────────────────────────────────────

describe('listProgrammes and getPackageStatus', () => {
  it('lists only the caller’s programmes without an admin role', async () => {
    store.seed(baseProgramme({ programmeId: 'mine', packages: [pkg()] }));
    store.seed(baseProgramme({ programmeId: 'theirs', ownerUserId: new ObjectId(), packages: [pkg()] }));

    const result: any = await service.listProgrammes({});
    expect(result.programmes.map((entry: any) => entry.programmeId)).toEqual(['mine']);
  });

  it('lists every programme for an administrator', async () => {
    store.seed(baseProgramme({ programmeId: 'mine', packages: [pkg()] }));
    store.seed(baseProgramme({ programmeId: 'theirs', ownerUserId: new ObjectId(), packages: [pkg()] }));
    service.context = buildContext({ _id: new ObjectId(), email: 'admin@example.com', roles: ['ADMIN'] }) as any;

    const result: any = await service.listProgrammes({});
    expect(result.programmes).toHaveLength(2);
  });

  it('returns not_found for an unknown programme', async () => {
    const result: any = await service.getProgramme({ programmeId: 'nope' });
    expect(result.found).toBe(false);
    expect(result.code).toBe('not_found');
  });

  it('resolves a package by dispatch id, and says so when it cannot', async () => {
    store.seed(baseProgramme({ packages: [pkg({ state: 'running', dispatchId: 'dispatch-1', attempt: 1 })] }));

    const found: any = await service.getPackageStatus({ dispatchId: 'dispatch-1' });
    expect(found.found).toBe(true);
    expect(found.package.id).toBe('pkg-1');
    expect(found.programme.state).toBe('active');

    expect((await service.getPackageStatus({ dispatchId: '' })).found).toBe(false);
    expect((await service.getPackageStatus({ dispatchId: 'unknown' })).found).toBe(false);
  });
});

// ── control plane refusals and races ────────────────────────────────────────

describe('control plane', () => {
  it('refuses to pause/resume/abort from the wrong state', async () => {
    store.seed(baseProgramme({ state: 'paused', packages: [pkg()] }));
    expect(((await service.pause({ programmeId: 'p1' })) as any).code).toBe('invalid_state');
    expect(((await service.resume({ programmeId: 'nope' })) as any).code).toBe('not_found');

    store.seed(baseProgramme({ programmeId: 'p2', state: 'completed', packages: [pkg()] }));
    expect(((await service.resume({ programmeId: 'p2' })) as any).code).toBe('invalid_state');
    expect(((await service.abort({ programmeId: 'p2' })) as any).code).toBe('invalid_state');
  });

  it('reports a race instead of claiming a transition it did not win', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    jest.spyOn(store, 'transitionProgramme').mockResolvedValue(null);

    expect(((await service.pause({ programmeId: 'p1' })) as any).code).toBe('raced');
    expect(((await service.abort({ programmeId: 'p1' })) as any).code).toBe('raced');

    store.seed(baseProgramme({ programmeId: 'p2', state: 'paused', packages: [pkg()] }));
    expect(((await service.resume({ programmeId: 'p2' })) as any).code).toBe('raced');
  });

  it('refuses control from a caller with no identity at all', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    service.context = { ...(service.context as any), user: undefined } as any;
    expect(((await service.pause({ programmeId: 'p1' })) as any).code).toBe('no_identity');
  });

  it('reports a cancel that the engine refused, and one that threw', async () => {
    store.seed(
      baseProgramme({
        packages: [pkg({ state: 'running', childInstanceId: 'child-a', dispatchId: 'd-a', attempt: 1 })],
      }),
    );
    workflowService.cancelWorkflowInstance.mockResolvedValueOnce({ success: false, message: 'already complete' });

    const refused: any = await service.abort({ programmeId: 'p1' });
    expect(refused.cancelFailures).toBe(1);
    expect(store.snapshot('p1')!.packages[0].lastError).toContain('already complete');

    store.seed(
      baseProgramme({
        programmeId: 'p2',
        packages: [pkg({ state: 'running', childInstanceId: 'child-b', dispatchId: 'd-b', attempt: 1 })],
      }),
    );
    workflowService.cancelWorkflowInstance.mockRejectedValueOnce(new Error('engine down'));

    const threw: any = await service.abort({ programmeId: 'p2' });
    expect(threw.cancelFailures).toBe(1);
    expect(store.snapshot('p2')!.packages[0].lastError).toContain('engine down');
  });

  it('records the cancel failure when the engine client is missing', async () => {
    store.seed(
      baseProgramme({
        packages: [pkg({ state: 'running', childInstanceId: 'child-a', dispatchId: 'd-a', attempt: 1 })],
      }),
    );
    service.context = { ...(service.context as any), getService: (): null => null } as any;

    const result: any = await service.abort({ programmeId: 'p1' });
    expect(result.cancelFailures).toBe(1);
    expect(store.snapshot('p1')!.packages[0].lastError).toContain('unavailable');
  });
});

// ── recovery branches that only exist after a crash ─────────────────────────

describe('recoverDispatching', () => {
  it('adopts a package whose instance id landed but whose state did not', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ state: 'dispatching', dispatchId: 'd-1', childInstanceId: 'child-1', attempt: 1, dispatchedAt: new Date() }),
        ],
      }),
    );

    const result = await service.reconcile({ programmeId: 'p1' });

    expect(result.adopted).toBe(1);
    expect(workflowService.startWorkflow).not.toHaveBeenCalled();
    expect(store.snapshot('p1')!.packages[0].state).toBe('running');
  });

  it('re-arms a dispatching package that has no dispatch id at all', async () => {
    store.seed(
      baseProgramme({
        packages: [pkg({ state: 'dispatching', attempt: 1, dispatchedAt: new Date() })],
      }),
    );

    await service.reconcile({ programmeId: 'p1' });

    const stored = store.snapshot('p1')!.packages[0];
    expect(stored.dispatchId).toBeTruthy();
    expect(stored.state).toBe('running');
  });

  it('fails the package when the dispatch budget is spent and no child was ever found', async () => {
    const longAgo = new Date(Date.now() - minutes(10));
    store.seed(
      baseProgramme({
        maxAttempts: 1,
        packages: [
          pkg({ state: 'dispatching', dispatchId: 'd-gone', attempt: 1, dispatchedAt: longAgo }),
        ],
      }),
    );
    service.findChildByDispatchId = jest.fn(async () => undefined) as any;

    await service.reconcile({ programmeId: 'p1' });

    const stored = store.snapshot('p1')!.packages[0];
    expect(stored.state).toBe('failed');
    expect(stored.lastError).toContain('no child was found for dispatch d-gone after 1 dispatch attempt(s)');
  });

  it('skips a programme that is already terminal', async () => {
    store.seed(baseProgramme({ state: 'completed', packages: [pkg({ state: 'succeeded' })] }));

    const result = await service.reconcile({ programmeId: 'p1' });
    expect(result.ticks[0].outcome).toBe('skipped');
  });
});

// ── verification branches ───────────────────────────────────────────────────

describe('gh verification outcomes', () => {
  const verifying = (overrides: Record<string, any> = {}) =>
    baseProgramme({
      packages: [
        pkg({
          state: 'running',
          childInstanceId: 'child-1',
          dispatchId: 'd-1',
          attempt: 1,
          prUrl: 'https://github.com/reactorynet/reactory-reactor/pull/9',
          status: 'awaiting_merge',
          lastProgressAt: new Date(),
          ...overrides,
        }),
      ],
    });

  it('fails the package when the pull request was closed unmerged', async () => {
    store.seed(verifying());
    service.ghVerifier = jest.fn(async () => ({ kind: 'closed', prUrl: 'https://x/1' })) as any;

    await service.reconcile({ programmeId: 'p1' });

    const stored = store.snapshot('p1')!.packages[0];
    expect(stored.state).toBe('failed');
    expect(stored.lastError).toContain('closed without merging');
  });

  it('treats an open pull request as evidence of life and resets the SLA window', async () => {
    const old = new Date(Date.now() - minutes(90));
    store.seed(verifying({ lastProgressAt: old, dispatchedAt: old }));
    service.ghVerifier = jest.fn(async () => ({ kind: 'open', prUrl: 'https://x/1' })) as any;

    await service.reconcile({ programmeId: 'p1' });

    const stored = store.snapshot('p1')!.packages[0];
    expect(stored.state).toBe('running');
    // No stall escalation: a PR waiting on a human is not a silent child.
    expect(stored.stallCount).toBe(0);
    expect(communicator.send).not.toHaveBeenCalled();
  });
});

// ── notification failure paths ──────────────────────────────────────────────

describe('notification failure paths', () => {
  it('records a communicator that throws and still raises the task', async () => {
    communicator.send = jest.fn(async () => {
      throw new Error('smtp down');
    });
    store.seed(baseProgramme({ packages: [pkg({ state: 'succeeded', attempt: 1 })] }));

    await service.reconcile({ programmeId: 'p1' });

    const stored = store.snapshot('p1')!;
    expect(stored.state).toBe('completed');
    expect(stored.notificationChannel).toBe('task');
    expect(stored.notificationError).toBe('smtp down');
    expect(mockTaskSave).toHaveBeenCalledTimes(1);
  });

  it('survives a task surface that refuses to write', async () => {
    mockTaskSave.mockRejectedValueOnce(new Error('task store down'));
    store.seed(baseProgramme({ packages: [pkg({ state: 'succeeded', attempt: 1 })] }));

    await service.reconcile({ programmeId: 'p1' });

    expect(store.snapshot('p1')!.notificationChannel).toBe('communicator');
  });

  it('does not re-send the same terminal event', async () => {
    const programme = baseProgramme({
      notifiedEvent: 'completed',
      notifiedAt: new Date(),
      notificationChannel: 'communicator',
    }) as any;

    const outcome = await service.notifyProgramme(programme, 'completed');

    expect(outcome.channel).toBe('communicator');
    expect(communicator.send).not.toHaveBeenCalled();
  });

  it('does not re-send a package failure that is already recorded', async () => {
    const programme = baseProgramme() as any;
    const outcome = await service.notifyPackage(
      programme,
      pkg({ state: 'failed', failedNotifiedAt: new Date() }) as any,
      'failed',
    );

    expect(outcome.channel).toBe('none');
    expect(communicator.send).not.toHaveBeenCalled();
  });

  it('reports no channel at all when both surfaces fail', async () => {
    service.context = { getService: (): null => null } as any; // no communicator, no log
    mockTaskSave.mockRejectedValueOnce(new Error('no task store'));
    const programme = baseProgramme() as any;

    const outcome = await service.notifyProgramme(programme, 'failed');

    expect(outcome.channel).toBe('none');
  });

  it('notify() routes a package event to the package path', async () => {
    const seeded = store.seed(baseProgramme({ packages: [pkg({ state: 'failed', attempt: 1 })] }));
    await service.notify(seeded as any, 'failed', seeded.packages[0] as any);
    const payload = communicator.send.mock.calls[0][0] as any;
    expect(payload.metadata.packageId).toBe('pkg-1');
    expect(payload.content.subject).toContain('package pkg-1 failed');
  });
});

// ── create validation ───────────────────────────────────────────────────────

describe('createProgramme validation', () => {
  it('refuses a missing name, a bad id and an empty package list', async () => {
    expect(((await service.createProgramme({ name: '' } as any)) as any).code).toBe('invalid_name');
    expect(
      ((await service.createProgramme({ name: 'x', programmeId: 'a', packages: [{ id: 'p' }] } as any)) as any).code,
    ).toBe('invalid_programme_id');
    expect(((await service.createProgramme({ name: 'x', packages: [] } as any)) as any).code).toBe(
      'invalid_packages',
    );
  });

  it('refuses a duplicate programme id', async () => {
    store.seed(baseProgramme({ programmeId: 'programme-1', packages: [pkg()] }));
    const result: any = await service.createProgramme({
      name: 'Probe',
      programmeId: 'programme-1',
      packages: [{ id: 'p' }],
    });
    expect(result.code).toBe('duplicate');
  });

  it('derives a stable id when none is supplied and clamps the bounds', async () => {
    const result: any = await service.createProgramme({
      name: 'Reactor Hardening',
      slaMinutes: 1000000,
      maxAttempts: 0,
      packages: [{ id: 'p' }],
    });

    expect(result.created).toBe(true);
    expect(result.programme.programmeId).toMatch(/^reactor-hardening-[0-9a-f]{8}$/);
    expect(result.programme.slaMinutes).toBe(24 * 60);
    expect(result.programme.maxAttempts).toBe(1);
  });
});
