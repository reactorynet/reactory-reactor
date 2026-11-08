import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';

/**
 * Regression tests for the revision-3 review.
 *
 * F2 is the important one: the abort/dispatch race. A tick could claim a package,
 * call `startWorkflow`, and have an abort land *during* that call. Abort saw no child
 * (it did not exist yet), marked the package cancelled and reported a clean cancel;
 * the tick then started the child anyway, its adopt write failed silently, and it
 * counted the dispatch. Result: a live child nobody points at, after a human said
 * stop. Two fixes are pinned here — the claim now carries the programme state (so
 * abort and dispatch contend for the same document), and a lost adopt cancels the
 * child it just started.
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
  HISTORY_PAGE_SIZE,
  HISTORY_SKEW_MS,
  WORKFLOW_SERVICE_ID,
  classifyChildStatus,
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

const tickOptions = (now = new Date()): any => ({
  now,
  staleMs: 120_000,
  leaseMs: 55_000,
  maxDispatchesPerTick: 4,
  maxVerificationsPerTick: 3,
  verificationIntervalMs: 5 * 60_000,
});

/** A promise plus its resolver, for gating an in-flight start. */
const deferred = (): { promise: Promise<any>; release: (value?: any) => void } => {
  let release: (value?: any) => void = () => undefined;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

beforeEach(() => {
  store = new InMemoryProgrammeStore();
  communicator = { send: jest.fn(async () => ({ success: true })) };
  workflowService = {
    startWorkflow: jest.fn(async () => ({ id: 'child-1' })),
    cancelWorkflowInstance: jest.fn(async () => ({ success: true })),
    getWorkflowHistory: jest.fn(async () => ({ instances: [] })),
    getWorkflowHistoryById: jest.fn(async () => ({ status: 0, statusLabel: 'Runnable' })),
  };
  service = Object.create(WorkflowProgrammeService.prototype);
  service.context = buildContext({ _id: ownerId, email: 'owner@example.com', roles: ['USER'] }) as any;
  service.store = store;
  service.ownerContextBuilder = jest.fn(async () => undefined) as any;
  service.ghVerifier = jest.fn(async () => ({ kind: 'skipped' })) as any;
  service.childStatusLookup = jest.fn(async () => ({ status: 0, statusLabel: 'Runnable' })) as any;
  mockTaskSave.mockClear();
});

// ── F2: the abort/dispatch race ─────────────────────────────────────────────

describe('F2 — abort during a blocked child start', () => {
  it('cancels the child that started after the abort, and never counts it as dispatched', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));

    // The child start blocks, exactly as an engine round-trip does.
    const gate = deferred();
    const started: string[] = [];
    service.startChild = jest.fn(async () => {
      await gate.promise;
      started.push('child-started-late');
      return { id: 'child-started-late' };
    }) as any;

    // A tick claims the package, then blocks inside startChild.
    const dispatching = service.dispatchReadyPackages(store.snapshot('p1') as any, tickOptions());
    await new Promise((resolve) => setImmediate(resolve));

    // A human aborts while the start is in flight. There is no child to find yet.
    service.findChildByDispatchId = jest.fn(async () => undefined) as any;
    const abortResult: any = await service.abort({ programmeId: 'p1', reason: 'human stop' });

    expect(abortResult.aborted).toBe(true);
    expect(abortResult.cancelled).toBe(1);
    // Nothing had failed: the uncertainty is reported separately, not as a failure.
    expect(abortResult.cancelFailures).toBe(0);
    expect(abortResult.pendingDispatch).toBe(1);
    expect(store.snapshot('p1')!.packages[0].lastError).toContain('a child start was in flight');

    // Release the start: it succeeds, but the adopt must now fail.
    gate.release();
    const dispatched = await dispatching;

    // THE regression: the child is not left running and the tick does not claim credit.
    expect(started).toHaveLength(1);
    expect(workflowService.cancelWorkflowInstance).toHaveBeenCalledWith('child-started-late');
    expect(dispatched).toBe(0);

    const stored = store.snapshot('p1')!.packages[0];
    expect(stored.state).toBe('cancelled');
    expect(stored.childInstanceId).toBeUndefined();
    expect(stored.lastError).toContain('could not be adopted');
    expect(stored.lastError).toContain('the child was cancelled');
  });

  it('records the child that could NOT be cancelled instead of hiding it', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    const gate = deferred();
    service.startChild = jest.fn(async () => {
      await gate.promise;
      return { id: 'child-stubborn' };
    }) as any;
    workflowService.cancelWorkflowInstance = jest.fn(async () => ({ success: false, message: 'engine refused' }));

    const dispatching = service.dispatchReadyPackages(store.snapshot('p1') as any, tickOptions());
    await new Promise((resolve) => setImmediate(resolve));
    service.findChildByDispatchId = jest.fn(async () => undefined) as any;
    await service.abort({ programmeId: 'p1' });

    gate.release();
    expect(await dispatching).toBe(0);

    const stored = store.snapshot('p1')!.packages[0];
    expect(stored.lastError).toContain('could NOT be cancelled');
    expect(stored.lastError).toContain('engine refused');
  });

  it('refuses a claim once the programme is no longer active, without starting anything', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    // The tick holds a snapshot from before the abort: the worst case.
    const stale = store.snapshot('p1') as any;
    await service.abort({ programmeId: 'p1', reason: 'human stop' });

    const dispatched = await service.dispatchReadyPackages(stale, tickOptions());

    expect(dispatched).toBe(0);
    expect(workflowService.startWorkflow).not.toHaveBeenCalled();
    expect(store.snapshot('p1')!.packages[0].state).toBe('cancelled');
  });

  it('refuses a claim once the programme is paused, without starting anything', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    const stale = store.snapshot('p1') as any;
    await service.pause({ programmeId: 'p1', reason: 'review' });

    expect(await service.dispatchReadyPackages(stale, tickOptions())).toBe(0);
    expect(workflowService.startWorkflow).not.toHaveBeenCalled();
  });
});

// ── F4: the recovery window ─────────────────────────────────────────────────

describe('F4 — the dispatch-id lookup is bounded and paginates', () => {
  it('bounds the window with the dispatch timestamp', async () => {
    const dispatchedAt = new Date('2026-01-01T00:00:00.000Z');
    workflowService.getWorkflowHistory.mockResolvedValue({ instances: [] });

    await service.findChildByDispatchId('d-1', baseProgramme(), { dispatchedAt } as any);

    const [filter] = workflowService.getWorkflowHistory.mock.calls[0] as any[];
    expect(filter.createdAfter).toEqual(new Date(dispatchedAt.getTime() - HISTORY_SKEW_MS));
  });

  it('walks past a full first page and adopts the match on the second', async () => {
    const filler = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) => ({
      id: `other-${index}`,
      data: { inputs: { dispatchId: `someone-else-${index}` } },
    }));
    workflowService.getWorkflowHistory
      .mockResolvedValueOnce({ instances: filler })
      .mockResolvedValueOnce({ instances: [{ id: 'child-found', data: { inputs: { dispatchId: 'd-1' } } }] });

    const found: any = await service.findChildByDispatchId('d-1', baseProgramme());

    expect(found?.id).toBe('child-found');
    expect(workflowService.getWorkflowHistory).toHaveBeenCalledTimes(2);
    expect((workflowService.getWorkflowHistory.mock.calls[1] as any[])[1]).toMatchObject({ page: 2 });
  });

  it('does not re-arm a package whose child sits on a later page', async () => {
    const dispatchedAt = new Date(Date.now() - minutes(10));
    store.seed(
      baseProgramme({
        packages: [
          pkg({ state: 'dispatching', dispatchId: 'd-deep', attempt: 1, dispatchedAt }),
        ],
      }),
    );
    const filler = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) => ({
      id: `other-${index}`,
      data: { inputs: { dispatchId: `someone-else-${index}` } },
    }));
    workflowService.getWorkflowHistory
      .mockResolvedValueOnce({ instances: filler })
      .mockResolvedValueOnce({ instances: [{ id: 'child-deep', data: { inputs: { dispatchId: 'd-deep' } } }] });

    const result = await service.reconcile({ programmeId: 'p1' });

    expect(result.adopted).toBe(1);
    expect(result.ticks[0].redispatched).toBe(0);
    // Exactly one child: the one that already existed.
    expect(workflowService.startWorkflow).not.toHaveBeenCalled();
    expect(store.snapshot('p1')!.packages[0].childInstanceId).toBe('child-deep');
  });

  it('stops after a short page instead of paging forever', async () => {
    workflowService.getWorkflowHistory.mockResolvedValue({ instances: [{ id: 'x', data: {} }] });
    expect(await service.findChildByDispatchId('d-1', baseProgramme())).toBeUndefined();
    expect(workflowService.getWorkflowHistory).toHaveBeenCalledTimes(1);
  });
});

// ── F3: a live child is never "silent" ──────────────────────────────────────

describe('F3 — child instance status is consulted before declaring a stall', () => {
  const stale = () => {
    const longAgo = new Date(Date.now() - minutes(90));
    return baseProgramme({
      slaMinutes: 45,
      lastProgressAt: longAgo,
      createdAt: longAgo,
      packages: [
        pkg({
          state: 'running',
          childInstanceId: 'child-long',
          dispatchId: 'd-long',
          attempt: 1,
          dispatchedAt: longAgo,
          lastProgressAt: longAgo,
        }),
      ],
    });
  };

  it('does not escalate a package whose child is still running', async () => {
    store.seed(stale());
    service.childStatusLookup = jest.fn(async () => ({ status: 0, statusLabel: 'Runnable' })) as any;

    await service.reconcile({ programmeId: 'p1' });

    const stored = store.snapshot('p1')!.packages[0];
    expect(stored.state).toBe('running');
    expect(stored.stallCount).toBe(0);
    expect(stored.lastProgressAt!.toString()).not.toBe(stale().packages[0].lastProgressAt.toString());
    expect(communicator.send).not.toHaveBeenCalled();
  });

  it('treats a suspended child as alive', async () => {
    store.seed(stale());
    service.childStatusLookup = jest.fn(async () => ({ status: 1, statusLabel: 'Suspended' })) as any;

    await service.reconcile({ programmeId: 'p1' });

    expect(store.snapshot('p1')!.packages[0].state).toBe('running');
    expect(store.snapshot('p1')!.packages[0].stallCount).toBe(0);
  });

  it('fails a package whose child completed without reporting, with an accurate reason', async () => {
    store.seed(stale());
    service.childStatusLookup = jest.fn(async () => ({ status: 2, statusLabel: 'Complete' })) as any;

    await service.reconcile({ programmeId: 'p1' });

    const stored = store.snapshot('p1')!.packages[0];
    expect(stored.state).toBe('failed');
    expect(stored.status).toBe('child_completed_unreported');
    // NOT "gone silent": the child finished and said nothing.
    expect(stored.lastError).toContain('completed without reporting an outcome');
    // Two messages: the package escalation, then the programme's terminal notice
    // (this programme has exactly one package, so it settles immediately).
    const subjects = communicator.send.mock.calls.map((call: any[]) => call[0].content.subject);
    expect(subjects).toHaveLength(2);
    expect(subjects[0]).toContain('package pkg-1 failed');
    expect(subjects[1]).toContain('stopped with failures');
  });

  it('fails a package whose child was terminated', async () => {
    store.seed(stale());
    service.childStatusLookup = jest.fn(async () => ({ status: 3, statusLabel: 'Terminated' })) as any;

    await service.reconcile({ programmeId: 'p1' });

    const stored = store.snapshot('p1')!.packages[0];
    expect(stored.state).toBe('failed');
    expect(stored.lastError).toContain('terminated without reporting an outcome');
  });

  it('falls back to the SLA path when the child status cannot be read', async () => {
    store.seed(stale());
    service.childStatusLookup = jest.fn(async () => {
      throw new Error('engine unavailable');
    }) as any;

    await service.reconcile({ programmeId: 'p1' });

    const stored = store.snapshot('p1')!.packages[0];
    // Conservative: no verdict was fabricated, the stall window is consumed instead.
    expect(stored.state).toBe('running');
    expect(stored.stallCount).toBe(1);
    expect(stored.lastVerificationError).toContain('child status lookup failed');
  });

  it('classifies every engine status without guessing', () => {
    expect(classifyChildStatus(0)).toBe('alive');
    expect(classifyChildStatus(1)).toBe('alive');
    expect(classifyChildStatus(2)).toBe('complete');
    expect(classifyChildStatus(3)).toBe('terminated');
    expect(classifyChildStatus(4)).toBe('terminated');
    expect(classifyChildStatus(99)).toBe('unknown');
    expect(classifyChildStatus('Runnable')).toBe('alive');
    expect(classifyChildStatus('Complete')).toBe('complete');
    expect(classifyChildStatus('Terminated')).toBe('terminated');
    expect(classifyChildStatus(undefined)).toBe('unknown');
    expect(classifyChildStatus(null)).toBe('unknown');
    expect(classifyChildStatus('nonsense')).toBe('unknown');
  });
});

// ── F7 / F8 / F9 ────────────────────────────────────────────────────────────

describe('F7 — the startup check reads the same root the Scheduler does', () => {
  const previous = { app: process.env.APP_DATA_ROOT, data: process.env.REACTORY_DATA };

  afterEach(() => {
    if (previous.app === undefined) delete process.env.APP_DATA_ROOT;
    else process.env.APP_DATA_ROOT = previous.app;
    if (previous.data === undefined) delete process.env.REACTORY_DATA;
    else process.env.REACTORY_DATA = previous.data;
  });

  it('checks ./data when no root is configured, instead of silently skipping', async () => {
    delete process.env.APP_DATA_ROOT;
    delete process.env.REACTORY_DATA;

    const result: any = await service.onStartup();

    expect(result.scheduleChecked).toBe(true);
    expect(result.scheduleInstalled).toBe(false);
    expect((service.context as any).log).toHaveBeenCalled();
  });
});

describe('F8 — a non-admin list is filtered in the query, not after a global page', () => {
  it('passes the owner scope to the store', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    store.seed(baseProgramme({ programmeId: 'theirs', ownerUserId: new ObjectId(), packages: [pkg()] }));
    const spy = jest.spyOn(store, 'findMany');

    const result: any = await service.listProgrammes({});

    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0] as any[])[0]).toMatchObject({ ownerUserId: String(ownerId) });
    expect(result.programmes.map((entry: any) => entry.programmeId)).toEqual(['p1']);
  });
});

describe('F9 — the system identity can read, and an anonymous caller cannot', () => {
  it('admits a system user that carries an _id', async () => {
    const previous = process.env.SYSTEM_USER_ID;
    process.env.SYSTEM_USER_ID = String(ownerId);
    try {
      store.seed(baseProgramme({ packages: [pkg()] }));
      service.context = buildContext({ _id: ownerId, roles: [] }) as any;

      const result: any = await service.getProgramme({ programmeId: 'p1' });

      expect(result.found).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SYSTEM_USER_ID;
      else process.env.SYSTEM_USER_ID = previous;
    }
  });

  it('refuses an anonymous caller', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    service.context = { ...(service.context as any), user: undefined } as any;

    const result: any = await service.getProgramme({ programmeId: 'p1' });
    expect(result.code).toBe('no_identity');
  });
});
