import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression tests for the review findings on the reconciler.
 *
 * Each `describe` names the defect it pins, because every one of them was a
 * *reproduced* behaviour rather than a suspicion:
 *
 *  Q1  one throwing programme aborted the whole pass and starved every programme
 *      after it (findMany sorts by created time with a limit, so it was permanent).
 *  Q2  a package-level failure stamped the PROGRAMME's notification evidence, so
 *      the terminal "stopped with failures" message was suppressed — and two
 *      packages failing in one tick sent two identical emails.
 *  Q5  abort marked a `dispatching` package cancelled without cancelling the child
 *      that the dispatch id could still find.
 *  Q7  `authoriseRead` treated "no resolved user" as authorised, which is also what
 *      an anonymous caller looks like.
 *  Q9  `redispatched` was declared but never incremented, so a tick that rescued
 *      stuck dispatches reported `idle`.
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
  mockTaskSave.mockClear();
});

const subjects = (): string[] => communicator.send.mock.calls.map((call: any[]) => call[0].content.subject);

// ── Q1: per-programme error isolation ────────────────────────────────────────

describe('Q1 — reconcile isolates a throwing programme', () => {
  it('continues the pass and dispatches the healthy programme that follows it', async () => {
    const longAgo = new Date(Date.now() - minutes(10));
    // p1 is seeded first, so findMany returns it first: exactly the ordering that
    // made a throwing programme permanent.
    store.seed(
      baseProgramme({
        programmeId: 'p1',
        createdAt: longAgo,
        packages: [
          pkg({ id: 'a', state: 'dispatching', dispatchId: 'dispatch-a', attempt: 1, dispatchedAt: longAgo }),
        ],
      }),
    );
    store.seed(
      baseProgramme({
        programmeId: 'p2',
        name: 'Healthy',
        createdAt: new Date(),
        packages: [pkg({ id: 'b', state: 'ready' })],
      }),
    );

    service.findChildByDispatchId = jest.fn(async (dispatchId: string) => {
      if (dispatchId === 'dispatch-a') throw new Error('workflow history unavailable');
      return undefined;
    }) as any;

    const result = await service.reconcile({});

    // The pass survives, and the failure is counted and attributed.
    expect(result.programmes).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.ticks.find((tick) => tick.programmeId === 'p1')!.outcome).toBe('error');
    expect(result.ticks.find((tick) => tick.programmeId === 'p1')!.error).toContain(
      'workflow history unavailable',
    );

    // p2 advanced: the defect was that it never did.
    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);
    expect(store.snapshot('p2')!.packages[0].state).toBe('running');

    // p1 is diagnosable from its own record, and its lease was released.
    expect(store.snapshot('p1')!.lastError).toContain('workflow history unavailable');
    expect(store.snapshot('p1')!.leaseOwner).toBeUndefined();
    expect(store.snapshot('p1')!.packages[0].state).toBe('dispatching');
  });

  it('reports zero errors when every programme ticks cleanly', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    const result = await service.reconcile({});
    expect(result.errors).toBe(0);
  });

  it('still propagates a failure that invalidates the whole pass (the store)', async () => {
    jest.spyOn(store, 'findMany').mockRejectedValue(new Error('mongo unreachable'));
    await expect(service.reconcile({})).rejects.toThrow('mongo unreachable');
  });
});

// ── Q2: package failures vs the programme's terminal notification ────────────

describe('Q2 — package escalation never consumes the terminal notification', () => {
  const stalled = (id: string, extra: Record<string, any> = {}) => {
    const longAgo = new Date(Date.now() - minutes(90));
    return pkg({
      id,
      state: 'running',
      childInstanceId: `child-${id}`,
      dispatchId: `dispatch-${id}`,
      attempt: 1,
      // Budget already spent, so the next observation FAILS the package.
      stallCount: 2,
      dispatchedAt: longAgo,
      lastProgressAt: longAgo,
      ...extra,
    });
  };

  const staleProgramme = (packages: any[]) => {
    const longAgo = new Date(Date.now() - minutes(90));
    return baseProgramme({
      name: 'Probe',
      maxAttempts: 2,
      slaMinutes: 45,
      lastProgressAt: longAgo,
      createdAt: longAgo,
      packages,
    });
  };

  it('notifies per package in different ticks, then exactly one terminal message', async () => {
    const longAgo = new Date(Date.now() - minutes(90));
    store.seed(
      staleProgramme([
        stalled('a'),
        // B is fresh, so it fails in a LATER tick — the case that used to suppress
        // the terminal notification.
        pkg({
          id: 'b',
          state: 'running',
          childInstanceId: 'child-b',
          dispatchId: 'dispatch-b',
          attempt: 1,
          stallCount: 2,
          dispatchedAt: new Date(),
          lastProgressAt: new Date(),
        }),
      ]),
    );

    // ── tick 1: only package A is overdue ───────────────────────────────────
    await service.reconcile({ programmeId: 'p1' });
    let stored = store.snapshot('p1')!;
    expect(stored.packages.find((entry) => entry.id === 'a')!.state).toBe('failed');
    expect(subjects()).toHaveLength(1);
    expect(subjects()[0]).toContain('package a failed');
    // THE regression: the package escalation must NOT stamp the programme.
    expect(stored.notifiedEvent).toBeUndefined();
    expect(stored.notifiedAt).toBeUndefined();
    expect(stored.state).toBe('active');

    // ── tick 2: package B is now overdue and the programme settles ──────────
    store.seed({
      ...store.snapshot('p1')!,
      lastProgressAt: longAgo,
      packages: [
        store.snapshot('p1')!.packages.find((entry) => entry.id === 'a')!,
        { ...store.snapshot('p1')!.packages.find((entry) => entry.id === 'b')!, lastProgressAt: longAgo, dispatchedAt: longAgo },
      ],
    } as any);

    await service.reconcile({ programmeId: 'p1' });
    stored = store.snapshot('p1')!;

    expect(stored.state).toBe('failed');
    expect(subjects()).toHaveLength(3);
    expect(subjects()[1]).toContain('package b failed');
    // The terminal message the owner must receive, and it is distinguishable.
    expect(subjects()[2]).toContain('stopped with failures');
    expect(new Set(subjects()).size).toBe(3);
    expect(stored.notifiedEvent).toBe('failed');
    expect(stored.notificationChannel).toBe('communicator+task');
  });

  it('notifies once per package when two fail in the same tick, with no duplicates', async () => {
    store.seed(staleProgramme([stalled('a'), stalled('b')]));

    await service.reconcile({ programmeId: 'p1' });

    const stored = store.snapshot('p1')!;
    expect(stored.state).toBe('failed');
    // Two package messages plus exactly one terminal message.
    expect(communicator.send).toHaveBeenCalledTimes(3);
    const all = subjects();
    expect(new Set(all).size).toBe(3);
    expect(all.filter((subject: string) => subject.includes('package a failed'))).toHaveLength(1);
    expect(all.filter((subject: string) => subject.includes('package b failed'))).toHaveLength(1);
    expect(all.filter((subject: string) => subject.includes('stopped with failures'))).toHaveLength(1);
  });

  it('does not re-notify a package failure on a later tick', async () => {
    store.seed(staleProgramme([stalled('a')]));

    await service.reconcile({ programmeId: 'p1' });
    const afterFirst = communicator.send.mock.calls.length;

    await service.reconcile({ programmeId: 'p1' });

    // Already terminal, so nothing further is sent at all.
    expect(communicator.send.mock.calls.length).toBe(afterFirst);
  });

  it('keeps the completion notification independent of package history', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'a', state: 'succeeded', attempt: 1, mergedSha: 'sha-a' }),
          pkg({ id: 'b', state: 'succeeded', attempt: 1, mergedSha: 'sha-b' }),
        ],
      }),
    );

    await service.reconcile({ programmeId: 'p1' });
    await service.reconcile({ programmeId: 'p1' });

    expect(store.snapshot('p1')!.state).toBe('completed');
    expect(communicator.send).toHaveBeenCalledTimes(1);
    expect(subjects()[0]).toContain('completed successfully');
  });

  it('sends a package-level message when a CHILD reports failure', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'a', state: 'running', dispatchId: 'dispatch-a', attempt: 1 }),
          pkg({ id: 'b', state: 'running', dispatchId: 'dispatch-b', attempt: 1, lastProgressAt: new Date() }),
        ],
      }),
    );

    const report: any = await service.reportPackageOutcome({
      dispatchId: 'dispatch-a',
      status: 'failed',
      error: 'review rejected three times',
    });

    expect(report.state).toBe('failed');
    expect(subjects()).toHaveLength(1);
    expect(subjects()[0]).toContain('package a failed');
    // The programme is still running, so nothing terminal has been sent.
    expect(store.snapshot('p1')!.state).toBe('active');
    expect(store.snapshot('p1')!.notifiedEvent).toBeUndefined();
    expect(store.snapshot('p1')!.packages[0].failedNotifiedAt).toBeTruthy();
  });
});

// ── Q5: abort must cancel a child it can still resolve ───────────────────────

describe('Q5 — abort cancels a dispatching child resolved by dispatch id', () => {
  it('cancels the child of a dispatching package that was never adopted', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'in-flight', state: 'dispatching', dispatchId: 'dispatch-live', attempt: 1, dispatchedAt: new Date() }),
        ],
      }),
    );
    service.findChildByDispatchId = jest.fn(async () => ({ id: 'child-never-adopted' })) as any;

    const result: any = await service.abort({ programmeId: 'p1', reason: 'scope changed' });

    expect(result.aborted).toBe(true);
    expect(result.cancelFailures).toBe(0);
    expect(service.findChildByDispatchId).toHaveBeenCalledWith(
      'dispatch-live',
      expect.anything(),
      expect.objectContaining({ id: 'in-flight' }),
    );
    expect(workflowService.cancelWorkflowInstance).toHaveBeenCalledWith('child-never-adopted');
    expect(store.snapshot('p1')!.packages[0].state).toBe('cancelled');
  });

  it('still marks the package cancelled when no child can be found', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'in-flight', state: 'dispatching', dispatchId: 'dispatch-lost', attempt: 1, dispatchedAt: new Date() }),
        ],
      }),
    );
    service.findChildByDispatchId = jest.fn(async () => undefined) as any;

    const result: any = await service.abort({ programmeId: 'p1' });

    expect(result.cancelled).toBe(1);
    expect(workflowService.cancelWorkflowInstance).not.toHaveBeenCalled();
    expect(store.snapshot('p1')!.packages[0].state).toBe('cancelled');
  });

  it('records a lookup failure on the package instead of claiming a clean cancel', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'in-flight', state: 'dispatching', dispatchId: 'dispatch-live', attempt: 1, dispatchedAt: new Date() }),
        ],
      }),
    );
    service.findChildByDispatchId = jest.fn(async () => {
      throw new Error('history unavailable');
    }) as any;

    const result: any = await service.abort({ programmeId: 'p1' });

    expect(result.cancelled).toBe(1);
    expect(store.snapshot('p1')!.packages[0].state).toBe('cancelled');
    expect(store.snapshot('p1')!.packages[0].lastError).toContain('child lookup failed');
  });
});

// ── Q7: an identity-less caller is not the reconciler ───────────────────────

describe('Q7 — reading a programme requires an identity', () => {
  it('refuses an identity-less caller with no_identity', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    service.context = { ...(service.context as any), user: undefined, hasRole: () => false } as any;

    const result: any = await service.getProgramme({ programmeId: 'p1' });

    expect(result.found).toBe(false);
    expect(result.code).toBe('no_identity');
    // Matches what listProgrammes already does for the same caller.
    const list: any = await service.listProgrammes({});
    expect(list.code).toBe('no_identity');
  });

  it('allows the platform system identity through', async () => {
    const previous = process.env.SYSTEM_USER_ID;
    process.env.SYSTEM_USER_ID = String(ownerId);
    try {
      store.seed(baseProgramme({ packages: [pkg()] }));
      service.context = { ...(service.context as any), user: { _id: ownerId }, hasRole: () => false } as any;
      const result: any = await service.getProgramme({ programmeId: 'p1' });
      expect(result.found).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SYSTEM_USER_ID;
      else process.env.SYSTEM_USER_ID = previous;
    }
  });

  it('still refuses another user without an admin role', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    service.context = buildContext({ _id: new ObjectId(), email: 'stranger@example.com', roles: ['USER'] }) as any;
    const result: any = await service.getProgramme({ programmeId: 'p1' });
    expect(result.code).toBe('not_authorised');
  });
});

// ── Q9: redispatched is a real metric ───────────────────────────────────────

describe('Q9 — a re-armed dispatch is counted as progress', () => {
  it('reports redispatched and "advanced" when it rescues a stuck dispatch', async () => {
    const longAgo = new Date(Date.now() - minutes(10));
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'stuck', state: 'dispatching', dispatchId: 'dispatch-gone', attempt: 1, dispatchedAt: longAgo }),
        ],
      }),
    );
    service.findChildByDispatchId = jest.fn(async () => undefined) as any;

    const result = await service.reconcile({ programmeId: 'p1' });

    expect(result.ticks[0].redispatched).toBe(1);
    expect(result.ticks[0].outcome).toBe('advanced');
    expect(store.snapshot('p1')!.packages[0].state).toBe('running');
  });

  it('does not count anything when the dispatch is still inside its stale window', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'stuck', state: 'dispatching', dispatchId: 'dispatch-live', attempt: 1, dispatchedAt: new Date() }),
        ],
      }),
    );
    service.findChildByDispatchId = jest.fn(async () => undefined) as any;

    const result = await service.reconcile({ programmeId: 'p1' });

    expect(result.ticks[0].redispatched).toBe(0);
    expect(result.ticks[0].outcome).toBe('idle');
  });
});

// ── Q8: the startup check tells an operator when the tick cannot run ────────

describe('Q8 — startup verifies the schedule is installed', () => {
  const previous = { app: process.env.APP_DATA_ROOT, data: process.env.REACTORY_DATA };

  afterEach(() => {
    if (previous.app === undefined) delete process.env.APP_DATA_ROOT;
    else process.env.APP_DATA_ROOT = previous.app;
    if (previous.data === undefined) delete process.env.REACTORY_DATA;
    else process.env.REACTORY_DATA = previous.data;
  });

  it('reports the schedule as missing when no root holds it', async () => {
    // Both roots must point somewhere empty: REACTORY_DATA is set by the harness,
    // and the real data root legitimately holds the runtime copy.
    const empty = fs.mkdtempSync(path.join(require('os').tmpdir(), 'programme-schedule-'));
    process.env.APP_DATA_ROOT = empty;
    process.env.REACTORY_DATA = empty;
    const result: any = await service.onStartup();
    expect(result.scheduleChecked).toBe(true);
    expect(result.scheduleInstalled).toBe(false);
    // The warning path is exercised: the operator is told the tick will not run.
    expect((service.context as any).log).toHaveBeenCalled();
  });

  it('reports it as installed when the runtime copy is present', async () => {
    process.env.APP_DATA_ROOT = '/Users/wernerw/Projects/reactory/reactory-data';
    const result: any = await service.onStartup();
    expect(result.scheduleInstalled).toBe(true);
    expect(String(result.file)).toContain('reactor.workflowprogrammereconciler-1.0.0-schedule.yaml');
  });
});
