import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';

/**
 * reactor.WorkflowProgrammeService@1.0.0
 *
 * These tests pin the properties the reconciler exists for — the ones that were
 * missing from the agent-as-orchestrator pattern:
 *
 *  1. A tick dispatched twice concurrently starts exactly ONE child. The guard is
 *     the conditional package transition, not a lock, so the test calls the claim
 *     path twice against the same snapshot.
 *  2. A crash between "start the child" and "adopt the instance id" is recovered by
 *     looking the child up by the dispatch id threaded into its input. No duplicate.
 *  3. Pause stops new dispatch and leaves running children untouched; resume
 *     continues from actual state.
 *  4. Abort cancels non-terminal children and marks the rest.
 *  5. Completion and failure notify through the communicator module.
 *  6. `gh` is consulted only for a claim that cannot be trusted — never per tick.
 */

// Hoisted fixtures must be `mock`-prefixed: the Jest hoist plugin moves the
// `jest.mock` call above the import list, and only `mock*` bindings are hoisted
// with it.
const mockTaskSave = jest.fn(async function (this: any) {
  return this;
});
const mockTaskDocuments: any[] = [];

jest.mock('@reactory/server-modules/reactory-core/models/Task', () => {
  const Model: any = function (this: any, doc: any) {
    mockTaskDocuments.push(doc);
    Object.assign(this, doc, { _id: new ObjectId() });
  };
  Model.prototype.save = mockTaskSave;
  return { __esModule: true, default: Model };
});

import WorkflowProgrammeService, {
  COMMUNICATOR_SERVICE_ID,
  DEFAULT_CHILD_WORKFLOW_ID,
  WORKFLOW_SERVICE_ID,
  dependencyVerdict,
  initialPackageState,
  mintDispatchId,
  normaliseChildStatus,
  sanitiseOptionalString,
  summariseProgrammeOutcome,
  validateProgrammePackages,
} from '../WorkflowProgrammeService';
import { InMemoryProgrammeStore } from './support/InMemoryProgrammeStore';

const ownerId = new ObjectId();
const otherId = new ObjectId();
const PROGRAMME_ID = 'reactor-hardening';

const minutes = (value: number) => value * 60_000;

/** A tick options object with the production defaults, pinned to a fixed clock. */
const tickOptions = (now = new Date()): any => ({
  now,
  staleMs: 120_000,
  leaseMs: 55_000,
  maxDispatchesPerTick: 4,
  maxVerificationsPerTick: 3,
  verificationIntervalMs: 5 * 60_000,
});

const buildContext = (user: any): any => ({
  user,
  partner: { key: 'tenant-a' },
  log: jest.fn(),
  hasRole: (role: string) => (user?.roles || []).includes(role),
  getService: (id: string) => {
    if (id === COMMUNICATOR_SERVICE_ID) return communicator;
    if (id === WORKFLOW_SERVICE_ID) return workflowService;
    return null;
  },
});

let store: InMemoryProgrammeStore;
let service: WorkflowProgrammeService;
let communicator: { send: any };
let workflowService: any;

beforeEach(() => {
  store = new InMemoryProgrammeStore();
  communicator = { send: jest.fn(async () => ({ success: true })) };
  workflowService = {
    startWorkflow: jest.fn(async () => ({ id: 'child-1' })),
    cancelWorkflowInstance: jest.fn(async () => ({ success: true })),
    getWorkflowHistory: jest.fn(async () => ({ instances: [] })),
  };

  // `Object.create(prototype)` mirrors the AgentContinuation suite: the decorator's
  // constructor is not needed, and every collaborator is explicit.
  service = Object.create(WorkflowProgrammeService.prototype);
  service.context = buildContext({ _id: ownerId, email: 'owner@example.com', roles: ['USER'] }) as any;
  service.store = store;
  // Rebuild is exercised separately; default to "no owner context" so dispatch uses
  // the tick's own context (which owns the fake workflow service).
  service.ownerContextBuilder = jest.fn(async () => undefined);
  service.ghVerifier = jest.fn(async () => ({ kind: 'skipped' })) as any;

  mockTaskSave.mockClear();
  mockTaskDocuments.length = 0;
});

const baseProgramme = (overrides: Record<string, any> = {}): any => ({
  programmeId: PROGRAMME_ID,
  name: 'Reactor hardening',
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
  ...overrides,
});

// ── creation and graph validation ────────────────────────────────────────────

describe('createProgramme', () => {
  it('marks dependency-free packages ready and their dependents pending', async () => {
    const result: any = await service.createProgramme({
      name: 'Reactor hardening',
      packages: [{ id: 'schema' }, { id: 'api', dependsOn: ['schema'] }],
    });

    expect(result.created).toBe(true);
    const byId = new Map(result.programme.packages.map((entry: any) => [entry.id, entry]));
    expect((byId.get('schema') as any).state).toBe('ready');
    expect((byId.get('api') as any).state).toBe('pending');
    expect(result.programme.childWorkflowId).toBe(DEFAULT_CHILD_WORKFLOW_ID);
  });

  it('refuses an unknown dependency, a duplicate id and a cycle', async () => {
    const unknown: any = await service.createProgramme({
      name: 'Bad graph',
      packages: [{ id: 'a', dependsOn: ['nope'] }],
    });
    expect(unknown.created).toBe(false);
    expect(unknown.code).toBe('invalid_packages');
    expect(unknown.errors.join(' ')).toContain('unknown package "nope"');

    const duplicate: any = await service.createProgramme({
      name: 'Duplicate',
      packages: [{ id: 'a' }, { id: 'a' }],
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.errors.join(' ')).toContain('duplicate package id "a"');

    const cycle: any = await service.createProgramme({
      name: 'Cycle',
      packages: [
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
      ],
    });
    expect(cycle.created).toBe(false);
    expect(cycle.errors.join(' ')).toContain('dependency cycle');
  });

  it('refuses the system account as an owner', async () => {
    const previous = process.env.SYSTEM_USER_EMAIL;
    process.env.SYSTEM_USER_EMAIL = 'system@reactory.net';
    try {
      service.context = buildContext({ _id: ownerId, email: 'system@reactory.net', roles: ['ADMIN'] }) as any;
      const result: any = await service.createProgramme({ name: 'System owned', packages: [{ id: 'a' }] });
      expect(result.created).toBe(false);
      expect(result.code).toBe('system_caller');
    } finally {
      if (previous === undefined) delete process.env.SYSTEM_USER_EMAIL;
      else process.env.SYSTEM_USER_EMAIL = previous;
    }
  });
});

// ── AC: a tick dispatched twice concurrently starts exactly one child ────────

describe('dispatch idempotency (predicate, not lock)', () => {
  it('two concurrent claim calls start exactly one child', async () => {
    const snapshot = store.seed(baseProgramme({ packages: [pkg()] }));

    const [first, second] = await Promise.all([
      service.dispatchReadyPackages(snapshot, tickOptions()),
      // The SAME snapshot: this is the worst case, where neither caller has seen the
      // other's write. The conditional transition still admits only one.
      service.dispatchReadyPackages(snapshot, tickOptions()),
    ]);

    expect(first + second).toBe(1);
    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);

    const stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.packages[0].state).toBe('running');
    expect(stored.packages[0].childInstanceId).toBe('child-1');
    expect(stored.packages[0].attempt).toBe(1);
    // The losing claim is recorded as a failed predicate, not as an error.
    expect(store.rejectedTransitions.length).toBe(1);
  });

  it('two concurrent reconcile passes start exactly one child', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));

    const [first, second] = await Promise.all([
      service.reconcile({ programmeId: PROGRAMME_ID }),
      service.reconcile({ programmeId: PROGRAMME_ID }),
    ]);

    expect(first.dispatched + second.dispatched).toBe(1);
    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);
    expect(store.snapshot(PROGRAMME_ID)!.packages[0].state).toBe('running');
  });

  it('threads the dispatch id INTO the child input', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    await service.reconcile({ programmeId: PROGRAMME_ID });

    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);
    const [workflowId, execution] = workflowService.startWorkflow.mock.calls[0] as any[];
    expect(workflowId).toBe(DEFAULT_CHILD_WORKFLOW_ID);
    expect(execution.input.programmeId).toBe(PROGRAMME_ID);
    expect(execution.input.packageId).toBe('pkg-1');
    expect(String(execution.input.dispatchId)).toContain(`${PROGRAMME_ID}:pkg-1:`);
  });
});

// ── AC: crash between dispatch and adopt is recovered by dispatchId ──────────

describe('crash recovery by dispatch id', () => {
  it('adopts the child that already exists and never starts a second one', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({
            state: 'dispatching',
            dispatchId: 'dispatch-orphan',
            dispatchedAt: new Date(Date.now() - minutes(10)),
            attempt: 1,
          }),
        ],
      }),
    );
    service.findChildByDispatchId = jest.fn(async () => ({ id: 'child-existing' })) as any;

    const result = await service.reconcile({ programmeId: PROGRAMME_ID });

    expect(service.findChildByDispatchId).toHaveBeenCalledWith(
      'dispatch-orphan',
      expect.anything(),
      expect.objectContaining({ id: 'pkg-1' }),
    );
    expect(result.adopted).toBe(1);
    expect(workflowService.startWorkflow).not.toHaveBeenCalled();
    const stored = store.snapshot(PROGRAMME_ID)!.packages[0];
    expect(stored.state).toBe('running');
    expect(stored.childInstanceId).toBe('child-existing');
    expect(stored.dispatchId).toBe('dispatch-orphan');
  });

  it('re-arms a stale dispatch with no child, and the retry is the only start', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({
            state: 'dispatching',
            dispatchId: 'dispatch-lost',
            dispatchedAt: new Date(Date.now() - minutes(10)),
            attempt: 1,
          }),
        ],
      }),
    );
    service.findChildByDispatchId = jest.fn(async () => undefined) as any;

    await service.reconcile({ programmeId: PROGRAMME_ID });

    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);
    const stored = store.snapshot(PROGRAMME_ID)!.packages[0];
    expect(stored.state).toBe('running');
    expect(stored.dispatchId).not.toBe('dispatch-lost');
    expect(stored.attempt).toBe(2);
  });

  it('waits out the stale window rather than risking a duplicate child', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({
            state: 'dispatching',
            dispatchId: 'dispatch-in-flight',
            dispatchedAt: new Date(),
            attempt: 1,
          }),
        ],
      }),
    );
    service.findChildByDispatchId = jest.fn(async () => undefined) as any;

    await service.reconcile({ programmeId: PROGRAMME_ID });

    expect(workflowService.startWorkflow).not.toHaveBeenCalled();
    expect(store.snapshot(PROGRAMME_ID)!.packages[0].state).toBe('dispatching');
  });

  it('leaves a failed start in dispatching so the next tick can find any child it made', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    workflowService.startWorkflow.mockRejectedValueOnce(new Error('transport timeout'));

    await service.reconcile({ programmeId: PROGRAMME_ID });

    let stored = store.snapshot(PROGRAMME_ID)!.packages[0];
    expect(stored.state).toBe('dispatching');
    expect(stored.lastError).toContain('transport timeout');

    // The next tick finds the child that the "failed" call actually created.
    service.findChildByDispatchId = jest.fn(async () => ({ id: 'child-created-despite-error' })) as any;
    await service.reconcile({ programmeId: PROGRAMME_ID });

    stored = store.snapshot(PROGRAMME_ID)!.packages[0];
    expect(stored.state).toBe('running');
    expect(stored.childInstanceId).toBe('child-created-despite-error');
    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);
  });
});

// ── AC: pause stops new dispatch and leaves running children untouched ───────

describe('pause and resume', () => {
  it('pauses new dispatch without touching a running child, then resumes from actual state', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'running', state: 'running', childInstanceId: 'child-live', dispatchId: 'd-live', attempt: 1 }),
          pkg({ id: 'waiting', state: 'ready' }),
        ],
      }),
    );

    const paused: any = await service.pause({ programmeId: PROGRAMME_ID, reason: 'human review' });
    expect(paused.paused).toBe(true);
    expect(paused.runningPackages).toBe(1);

    let stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.state).toBe('paused');
    expect(stored.packages.find((entry) => entry.id === 'running')!.state).toBe('running');
    expect(stored.packages.find((entry) => entry.id === 'waiting')!.state).toBe('ready');
    expect(stored.pausedByEmail).toBe('owner@example.com');
    // Pause is not a kill switch.
    expect(workflowService.cancelWorkflowInstance).not.toHaveBeenCalled();

    const tick = await service.reconcile({ programmeId: PROGRAMME_ID });
    expect(tick.dispatched).toBe(0);
    expect(workflowService.startWorkflow).not.toHaveBeenCalled();
    stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.packages.find((entry) => entry.id === 'running')!.state).toBe('running');

    const resumed: any = await service.resume({ programmeId: PROGRAMME_ID });
    expect(resumed.resumed).toBe(true);
    expect(store.snapshot(PROGRAMME_ID)!.state).toBe('active');

    await service.reconcile({ programmeId: PROGRAMME_ID });
    stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.packages.find((entry) => entry.id === 'running')!.state).toBe('running');
    expect(stored.packages.find((entry) => entry.id === 'waiting')!.state).toBe('running');
    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);
  });

  it('refuses pause from a non-owner without an administrative role', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    service.context = buildContext({ _id: otherId, email: 'stranger@example.com', roles: ['USER'] }) as any;

    const result: any = await service.pause({ programmeId: PROGRAMME_ID });
    expect(result.paused).toBe(false);
    expect(result.code).toBe('not_authorised');
    expect(store.snapshot(PROGRAMME_ID)!.state).toBe('active');
  });

  it('allows an administrator to abort, but never the system account', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    service.context = buildContext({ _id: otherId, email: 'admin@example.com', roles: ['ADMIN'] }) as any;
    const admin: any = await service.abort({ programmeId: PROGRAMME_ID, reason: 'owner asked' });
    expect(admin.aborted).toBe(true);

    store.seed({ ...baseProgramme({ programmeId: 'second', packages: [pkg()] }) } as any);
    const previous = process.env.SYSTEM_USER_EMAIL;
    process.env.SYSTEM_USER_EMAIL = 'system@reactory.net';
    try {
      service.context = buildContext({ _id: otherId, email: 'system@reactory.net', roles: ['ADMIN'] }) as any;
      const system: any = await service.abort({ programmeId: 'second' });
      expect(system.aborted).toBe(false);
      expect(system.code).toBe('system_caller');
    } finally {
      if (previous === undefined) delete process.env.SYSTEM_USER_EMAIL;
      else process.env.SYSTEM_USER_EMAIL = previous;
    }
  });
});

// ── AC: abort cancels non-terminal children and marks the rest ───────────────

describe('abort', () => {
  it('cancels the running child and marks every non-terminal package', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'live', state: 'running', childInstanceId: 'child-live', dispatchId: 'd-live', attempt: 1 }),
          pkg({ id: 'dispatching', state: 'dispatching', dispatchId: 'd-in-flight', attempt: 1 }),
          pkg({ id: 'queued', state: 'pending', dependsOn: ['live'] }),
          pkg({ id: 'done', state: 'succeeded', mergedSha: 'abc', attempt: 1 }),
        ],
      }),
    );

    const result: any = await service.abort({ programmeId: PROGRAMME_ID, reason: 'scope changed' });

    expect(result.aborted).toBe(true);
    expect(result.cancelled).toBe(3);
    expect(workflowService.cancelWorkflowInstance).toHaveBeenCalledWith('child-live');

    const stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.state).toBe('aborted');
    const byId = new Map(stored.packages.map((entry) => [entry.id, entry]));
    expect(byId.get('live')!.state).toBe('cancelled');
    expect(byId.get('dispatching')!.state).toBe('cancelled');
    expect(byId.get('queued')!.state).toBe('cancelled');
    // A finished package keeps its outcome: abort does not rewrite history.
    expect(byId.get('done')!.state).toBe('succeeded');
    expect(stored.abortedByEmail).toBe('owner@example.com');
    expect(communicator.send).toHaveBeenCalledTimes(1);
  });

  it('stops a concurrent tick from dispatching after the abort write', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    await service.abort({ programmeId: PROGRAMME_ID });

    await service.reconcile({ programmeId: PROGRAMME_ID });
    expect(workflowService.startWorkflow).not.toHaveBeenCalled();
  });
});

// ── AC: completion and failure notifications via the communicator ────────────

describe('programme notifications', () => {
  it('notifies once on completion, through the communicator', async () => {
    store.seed(baseProgramme({ packages: [pkg({ state: 'succeeded', mergedSha: 'sha-1', attempt: 1 })] }));

    await service.reconcile({ programmeId: PROGRAMME_ID });
    await service.reconcile({ programmeId: PROGRAMME_ID });

    expect(store.snapshot(PROGRAMME_ID)!.state).toBe('completed');
    expect(communicator.send).toHaveBeenCalledTimes(1);
    const payload = communicator.send.mock.calls[0][0] as any;
    expect(payload.to).toBe('owner@example.com');
    expect(payload.content.subject).toContain('completed');
    expect(payload.metadata).toMatchObject({ programmeId: PROGRAMME_ID, event: 'completed' });
    // The task surface is written as well: "never silent" cannot depend on one channel.
    expect(mockTaskDocuments.length).toBe(1);
  });

  it('notifies once on failure, through the communicator', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'broken', state: 'failed', lastError: 'tests never went green', attempt: 3 }),
          pkg({ id: 'dependent', state: 'blocked', dependsOn: ['broken'] }),
        ],
      }),
    );

    await service.reconcile({ programmeId: PROGRAMME_ID });

    expect(store.snapshot(PROGRAMME_ID)!.state).toBe('failed');
    expect(communicator.send).toHaveBeenCalledTimes(1);
    const payload = communicator.send.mock.calls[0][0] as any;
    expect(payload.content.subject).toContain('stopped with failures');
    expect(payload.content.text).toContain('tests never went green');
  });

  it('still records a task when the communicator refuses', async () => {
    communicator.send.mockResolvedValueOnce({ success: false, error: 'no provider' } as any);
    store.seed(baseProgramme({ packages: [pkg({ state: 'succeeded' })] }));

    await service.reconcile({ programmeId: PROGRAMME_ID });

    expect(mockTaskDocuments.length).toBe(1);
    const stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.notificationChannel).toBe('task');
    expect(stored.notificationError).toBe('no provider');
  });
});

// ── stalls ───────────────────────────────────────────────────────────────────

describe('stall escalation', () => {
  it('escalates once per window, then fails when the stall budget is spent', async () => {
    const longAgo = new Date(Date.now() - minutes(90));
    store.seed(
      baseProgramme({
        slaMinutes: 45,
        maxAttempts: 2,
        lastProgressAt: longAgo,
        createdAt: longAgo,
        packages: [
          pkg({
            state: 'running',
            childInstanceId: 'child-quiet',
            dispatchId: 'd-quiet',
            // One dispatch attempt, no stall windows yet.
            attempt: 1,
            stallCount: 0,
            dispatchedAt: longAgo,
            lastProgressAt: longAgo,
          }),
        ],
      }),
    );

    await service.reconcile({ programmeId: PROGRAMME_ID });

    let stored = store.snapshot(PROGRAMME_ID)!;
    let packageDoc = stored.packages[0];
    expect(packageDoc.state).toBe('running');
    // Dispatch attempts and stall windows are separate budgets: one start plus one
    // silent window is NOT two dispatch attempts.
    expect(packageDoc.attempt).toBe(1);
    expect(packageDoc.stallCount).toBe(1);
    expect(packageDoc.stalledNotifiedAt).toBeTruthy();
    expect(communicator.send).toHaveBeenCalledTimes(1);
    expect((communicator.send.mock.calls[0][0] as any).content.subject).toContain('gone silent');

    // A second tick inside the same window must not notify again.
    await service.reconcile({ programmeId: PROGRAMME_ID });
    expect(communicator.send).toHaveBeenCalledTimes(1);

    // The next window spends the last unit of the stall budget: the package fails.
    const previousWindow = new Date(Date.now() - minutes(120));
    const current = store.snapshot(PROGRAMME_ID)!;
    store.seed({
      ...current,
      lastProgressAt: previousWindow,
      packages: [
        {
          ...current.packages[0],
          lastProgressAt: previousWindow,
          stalledNotifiedAt: previousWindow,
          dispatchedAt: previousWindow,
        },
      ],
    } as any);

    // Window B spends the second (and last) unit of the stall budget; the package
    // is still running, because a stall is an observation, not a verdict.
    await service.reconcile({ programmeId: PROGRAMME_ID });
    stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.packages[0].state).toBe('running');
    expect(stored.packages[0].stallCount).toBe(2);
    expect(communicator.send).toHaveBeenCalledTimes(2);

    // Window C has nothing left to spend: the package fails and the programme
    // settles with its own terminal notification.
    const exhaustedWindow = new Date(Date.now() - minutes(180));
    const spent = store.snapshot(PROGRAMME_ID)!;
    store.seed({
      ...spent,
      lastProgressAt: exhaustedWindow,
      packages: [
        {
          ...spent.packages[0],
          lastProgressAt: exhaustedWindow,
          stalledNotifiedAt: exhaustedWindow,
          dispatchedAt: exhaustedWindow,
        },
      ],
    } as any);

    await service.reconcile({ programmeId: PROGRAMME_ID });
    stored = store.snapshot(PROGRAMME_ID)!;
    packageDoc = stored.packages[0];
    expect(packageDoc.state).toBe('failed');
    expect(packageDoc.lastError).toContain('stall window(s) of 2 exhausted');
    // The package-level failure message is distinguishable from the terminal one.
    const subjects = communicator.send.mock.calls.map((call: any[]) => call[0].content.subject);
    expect(subjects.some((subject: string) => subject.includes('package pkg-1 failed'))).toBe(true);
    expect(subjects.some((subject: string) => subject.includes('stopped with failures'))).toBe(true);
  });

  it('does not let a progressing sibling mask a silent package', async () => {
    const longAgo = new Date(Date.now() - minutes(90));
    store.seed(
      baseProgramme({
        slaMinutes: 45,
        maxAttempts: 3,
        // The programme watermark is FRESH because a sibling moved. It must not be
        // allowed to speak for the quiet package: the SLA is per package.
        lastProgressAt: new Date(),
        createdAt: longAgo,
        packages: [
          pkg({
            id: 'quiet',
            state: 'running',
            childInstanceId: 'child-quiet',
            dispatchId: 'dispatch-quiet',
            attempt: 1,
            stallCount: 0,
            dispatchedAt: longAgo,
            lastProgressAt: longAgo,
          }),
          pkg({
            id: 'lively',
            state: 'running',
            childInstanceId: 'child-lively',
            dispatchId: 'dispatch-lively',
            attempt: 1,
            stallCount: 0,
            dispatchedAt: new Date(),
            lastProgressAt: new Date(),
          }),
        ],
      }),
    );

    await service.reconcile({ programmeId: PROGRAMME_ID });

    const stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.packages.find((entry) => entry.id === 'quiet')!.stallCount).toBe(1);
    expect(stored.packages.find((entry) => entry.id === 'quiet')!.stalledNotifiedAt).toBeTruthy();
    expect(stored.packages.find((entry) => entry.id === 'lively')!.stallCount).toBe(0);
    expect(communicator.send).toHaveBeenCalledTimes(1);
  });
});

// ── push, then verify ────────────────────────────────────────────────────────

describe('push-reported outcomes and gh verification', () => {
  it('marks a package succeeded from a pushed merge SHA without ever calling gh', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({
            state: 'running',
            childInstanceId: 'child-1',
            dispatchId: 'dispatch-1',
            attempt: 1,
            prUrl: 'https://github.com/reactorynet/reactory-reactor/pull/9',
          }),
        ],
      }),
    );

    const result: any = await service.reportPackageOutcome({
      dispatchId: 'dispatch-1',
      status: 'completed',
      prUrl: 'https://github.com/reactorynet/reactory-reactor/pull/9',
      mergedSha: 'deadbeef',
    });

    expect(result.reported).toBe(true);
    expect(result.state).toBe('succeeded');

    await service.reconcile({ programmeId: PROGRAMME_ID });
    expect(service.ghVerifier).not.toHaveBeenCalled();
    expect(store.snapshot(PROGRAMME_ID)!.state).toBe('completed');
  });

  it('treats "completed with a PR but no merge SHA" as a claim and verifies it with gh', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({
            state: 'running',
            childInstanceId: 'child-1',
            dispatchId: 'dispatch-1',
            attempt: 1,
            prUrl: 'https://github.com/reactorynet/reactory-reactor/pull/9',
            status: 'completed',
          }),
        ],
      }),
    );
    const report: any = await service.reportPackageOutcome({
      dispatchId: 'dispatch-1',
      status: 'completed',
      prUrl: 'https://github.com/reactorynet/reactory-reactor/pull/9',
    });
    expect(report.awaitingVerification).toBe(true);
    expect(report.state).toBe('running');

    service.ghVerifier = jest.fn(async () => ({ kind: 'merged', mergedSha: 'sha-merged' })) as any;
    await service.reconcile({ programmeId: PROGRAMME_ID });

    expect(service.ghVerifier).toHaveBeenCalledTimes(1);
    const stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.packages[0].state).toBe('succeeded');
    expect(stored.packages[0].mergedSha).toBe('sha-merged');
    expect(stored.packages[0].outcomeSource).toBe('gh');
  });

  it('records a transient gh failure without failing the package', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({
            state: 'running',
            childInstanceId: 'child-1',
            dispatchId: 'dispatch-1',
            attempt: 1,
            prUrl: 'https://github.com/reactorynet/reactory-reactor/pull/9',
            status: 'awaiting_merge',
          }),
        ],
      }),
    );
    service.ghVerifier = jest.fn(async () => ({ kind: 'error', error: 'gh: rate limited' })) as any;

    await service.reconcile({ programmeId: PROGRAMME_ID });

    const stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.packages[0].state).toBe('running');
    expect(stored.packages[0].lastVerificationError).toBe('gh: rate limited');
    expect(stored.state).toBe('active');
  });

  it('does not call gh for a package that has no pull request yet', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({
            state: 'running',
            childInstanceId: 'child-1',
            dispatchId: 'dispatch-1',
            attempt: 1,
            lastProgressAt: new Date(),
          }),
        ],
      }),
    );

    await service.reconcile({ programmeId: PROGRAMME_ID });
    expect(service.ghVerifier).not.toHaveBeenCalled();
  });

  it('rejects a report for an unknown or already-terminal dispatch', async () => {
    store.seed(
      baseProgramme({
        packages: [pkg({ state: 'succeeded', dispatchId: 'dispatch-done', attempt: 1, mergedSha: 'x' })],
      }),
    );

    const unknown: any = await service.reportPackageOutcome({ dispatchId: 'nope', status: 'completed' });
    expect(unknown.reported).toBe(false);

    const terminal: any = await service.reportPackageOutcome({ dispatchId: 'dispatch-done', status: 'failed' });
    expect(terminal.reported).toBe(false);
    expect(terminal.reason).toContain('already succeeded');
  });

  it('fails a package when the child reports failure', async () => {
    store.seed(
      baseProgramme({
        packages: [pkg({ state: 'running', dispatchId: 'dispatch-1', attempt: 1 })],
      }),
    );

    const report: any = await service.reportPackageOutcome({
      dispatchId: 'dispatch-1',
      status: 'failed',
      error: 'review rejected three times',
    });
    expect(report.state).toBe('failed');

    await service.reconcile({ programmeId: PROGRAMME_ID });
    const stored = store.snapshot(PROGRAMME_ID)!;
    expect(stored.state).toBe('failed');
    expect(stored.packages[0].lastError).toBe('review rejected three times');
  });
});

// ── dependency graph ────────────────────────────────────────────────────────

describe('dependency graph', () => {
  it('blocks dependents of a failed package and settles the programme', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'schema', state: 'failed', attempt: 3, lastError: 'cannot migrate' }),
          pkg({ id: 'api', state: 'pending', dependsOn: ['schema'] }),
          pkg({ id: 'docs', state: 'ready' }),
        ],
      }),
    );

    await service.reconcile({ programmeId: PROGRAMME_ID });

    const stored = store.snapshot(PROGRAMME_ID)!;
    const byId = new Map(stored.packages.map((entry) => [entry.id, entry]));
    expect(byId.get('api')!.state).toBe('blocked');
    // An independent branch still ran: one failure must not stop the whole wave.
    expect(byId.get('docs')!.state).toBe('running');
    expect(stored.state).toBe('active');

    // Once the independent branch also lands, the programme settles as failed.
    await service.reportPackageOutcome({ dispatchId: byId.get('docs')!.dispatchId!, status: 'completed' });
    await service.reconcile({ programmeId: PROGRAMME_ID });
    expect(store.snapshot(PROGRAMME_ID)!.state).toBe('failed');
  });
});

// ── pure helpers ────────────────────────────────────────────────────────────

describe('helpers', () => {
  it('dependencyVerdict distinguishes satisfied, waiting and blocked', () => {
    const byId = new Map<string, any>([
      ['a', { id: 'a', state: 'succeeded' }],
      ['b', { id: 'b', state: 'running' }],
      ['c', { id: 'c', state: 'failed' }],
    ]);
    expect(dependencyVerdict({ dependsOn: [] }, byId)).toBe('satisfied');
    expect(dependencyVerdict({ dependsOn: ['a'] }, byId)).toBe('satisfied');
    expect(dependencyVerdict({ dependsOn: ['a', 'b'] }, byId)).toBe('waiting');
    expect(dependencyVerdict({ dependsOn: ['c'] }, byId)).toBe('blocked');
    expect(dependencyVerdict({ dependsOn: ['missing'] }, byId)).toBe('blocked');
  });

  it('summariseProgrammeOutcome does not settle while an actionable package remains', () => {
    expect(summariseProgrammeOutcome([{ state: 'failed' }, { state: 'running' }])).toBeNull();
    expect(summariseProgrammeOutcome([{ state: 'failed' }, { state: 'blocked' }])).toBe('failed');
    expect(summariseProgrammeOutcome([{ state: 'succeeded' }, { state: 'succeeded' }])).toBe('completed');
    expect(summariseProgrammeOutcome([{ state: 'cancelled' }, { state: 'cancelled' }])).toBe('aborted');
    expect(summariseProgrammeOutcome([])).toBe('failed');
  });

  it('normaliseChildStatus is strict about the three values it understands', () => {
    expect(normaliseChildStatus('COMPLETE')).toBe('completed');
    expect(normaliseChildStatus('failed')).toBe('failed');
    expect(normaliseChildStatus('in-progress')).toBe('running');
    expect(normaliseChildStatus('banana')).toBeUndefined();
    expect(normaliseChildStatus(undefined)).toBeUndefined();
  });

  it('sanitiseOptionalString rejects unresolved YAML tokens', () => {
    expect(sanitiseOptionalString('${input.programmeId}')).toBeUndefined();
    expect(sanitiseOptionalString('  ')).toBeUndefined();
    expect(sanitiseOptionalString('null')).toBeUndefined();
    expect(sanitiseOptionalString('reactor-hardening')).toBe('reactor-hardening');
  });

  it('validateProgrammePackages accepts a valid DAG and reports self-dependencies', () => {
    expect(validateProgrammePackages([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a', 'b'] },
    ])).toEqual([]);
    expect(validateProgrammePackages([{ id: 'a', dependsOn: ['a'] }]).join(' ')).toContain('depends on itself');
  });

  it('initialPackageState and mintDispatchId are deterministic in shape', () => {
    expect(initialPackageState({ dependsOn: [] })).toBe('ready');
    expect(initialPackageState({ dependsOn: ['a'] })).toBe('pending');
    const id = mintDispatchId('prog', 'pkg');
    expect(id.startsWith('prog:pkg:')).toBe(true);
    expect(mintDispatchId('prog', 'pkg')).not.toBe(id);
  });
});
