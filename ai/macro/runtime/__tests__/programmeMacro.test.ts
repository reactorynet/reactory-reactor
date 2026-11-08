import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';

/**
 * `programme` — the front door of `reactor.WorkflowProgrammeService@1.0.0`.
 *
 * The ticket's constraint is unusual and worth restating: the macro must add NO
 * business logic. These tests are therefore split in two, and the split is the
 * point:
 *
 *  - **Delegation** (spy service): for every one of the eight actions, the service
 *    method is called with exactly the caller's arguments and its result is
 *    returned unchanged. If someone later "fixes" a refusal in the macro instead of
 *    in the service, these fail.
 *  - **Behaviour** (the real service over an in-memory store): create records the
 *    calling user as owner, the dependency graph is honoured, pause leaves a
 *    running child alone, abort cancels the non-terminal packages and leaves the
 *    terminal ones, `tick` dispatches and adopts, and the system identity is
 *    refused even with an ADMIN role.
 *
 * The behaviour half deliberately goes through the REAL service. A mock cannot
 * prove "createProgramme records the right ownerUserId", because the owner is read
 * from the service's own context — which is exactly the property that was broken
 * while no front door existed.
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
} from '../../../../services/reactor/WorkflowProgrammeService';
import { InMemoryProgrammeStore } from '../../../../services/reactor/__tests__/support/InMemoryProgrammeStore';
import {
  ProgrammeMacro,
  ProgrammeMacroRegistry,
  PROGRAMME_ACTIONS,
  PROGRAMME_SERVICE_ID,
  type IProgrammeMacroProps,
} from '../programmeMacro.macro';

const ownerId = new ObjectId();

let store: InMemoryProgrammeStore;
let service: WorkflowProgrammeService;
let communicator: { send: any };
let workflowService: any;
let context: any;

/** A ChatState is only used as a fallback for `context`; the macro gets it directly. */
const state: any = { id: 'session-1' };

const buildContext = (user: any): any => ({
  user,
  partner: { key: 'tenant-a' },
  log: jest.fn(),
  hasRole: (role: string) => (user?.roles || []).includes(role),
  getService: (id: string) => {
    if (id === PROGRAMME_SERVICE_ID) return service;
    if (id === COMMUNICATOR_SERVICE_ID) return communicator;
    if (id === WORKFLOW_SERVICE_ID) return workflowService;
    return null;
  },
});

const call = (props: IProgrammeMacroProps, ctx: any = context): any =>
  ProgrammeMacro(props as any, state, ctx);

beforeEach(() => {
  store = new InMemoryProgrammeStore();
  communicator = { send: jest.fn(async () => ({ success: true })) };
  workflowService = {
    startWorkflow: jest.fn(async () => ({ id: 'child-1' })),
    cancelWorkflowInstance: jest.fn(async () => ({ success: true })),
    getWorkflowHistory: jest.fn(async () => ({ instances: [] })),
    getWorkflowHistoryById: jest.fn(async () => undefined),
  };

  // The real service, built the way `@service` builds it: an instance whose
  // `context` is the caller's context. That is what makes "operates as the calling
  // user" a real assertion instead of a mock's promise.
  service = Object.create(WorkflowProgrammeService.prototype);
  context = buildContext({ _id: ownerId, email: 'owner@example.com', roles: ['USER'] });
  service.context = context;
  service.store = store;
  service.ownerContextBuilder = jest.fn(async () => undefined) as any;
  service.ghVerifier = jest.fn(async () => ({ kind: 'skipped' })) as any;

  mockTaskSave.mockClear();
});

// ── the registration contract ────────────────────────────────────────────────

describe('programme macro registration', () => {
  it('registers ONE macro named `programme` with the eight actions', () => {
    expect(ProgrammeMacroRegistry.name).toBe('programme');
    expect(ProgrammeMacroRegistry.alias).toBe('programme');

    const parameters: any = ProgrammeMacroRegistry.tools![0].function.parameters;
    // Closed set: adding a ninth action has to be deliberate.
    expect(parameters.properties.action.enum).toEqual([
      'create',
      'get',
      'list',
      'pause',
      'resume',
      'abort',
      'report',
      'tick',
    ]);
    expect(parameters.required).toEqual(['action']);
  });

  it('is the only surface, not one of eight macros', () => {
    expect([...PROGRAMME_ACTIONS]).toHaveLength(8);
    // `PROGRAMME_ACTIONS` is the single list the tool enum is built from.
    const parameters: any = ProgrammeMacroRegistry.tools![0].function.parameters;
    expect(parameters.properties.action.enum).toEqual([...PROGRAMME_ACTIONS]);
  });

  it('names the service FQN the module registers', () => {
    expect(PROGRAMME_SERVICE_ID).toBe('reactor.WorkflowProgrammeService@1.0.0');
  });

  it('documents the push limitation of `report` in the tool description', () => {
    const description = ProgrammeMacroRegistry.tools![0].function.description;
    // A model reads this, not the source. It must not be able to conclude that a
    // silent child "still succeeds".
    expect(description).toMatch(/reportPackageOutcome|child→programme push/);
    expect(description).toMatch(/failed \(child_completed_unreported\)|never as succeeded/);
  });
});

// ── 1:1 delegation ───────────────────────────────────────────────────────────

describe('programme macro delegates 1:1 to the service', () => {
  let spy: any;
  const sentinel = { from: 'service' };

  beforeEach(() => {
    spy = {
      createProgramme: jest.fn(async () => sentinel),
      getProgramme: jest.fn(async () => sentinel),
      listProgrammes: jest.fn(async () => sentinel),
      pause: jest.fn(async () => sentinel),
      resume: jest.fn(async () => sentinel),
      abort: jest.fn(async () => sentinel),
      reportPackageOutcome: jest.fn(async () => sentinel),
      reconcile: jest.fn(async () => sentinel),
    };
    context = { user: { _id: ownerId, email: 'owner@example.com' }, getService: () => spy };
  });

  const createProps: IProgrammeMacroProps = {
    action: 'create',
    programmeId: 'reactor-hardening',
    name: 'Reactor hardening',
    description: 'two packages',
    childWorkflowId: 'core.ProcessAITicket@1.4.8',
    childInputDefaults: { agentId: 'ReactorAIPersona' },
    slaMinutes: 30,
    maxAttempts: 2,
    packages: [{ id: 'schema' }, { id: 'api', dependsOn: ['schema'], input: { ticketId: 't1' } }],
  };

  it('create → createProgramme, with the caller arguments and nothing added', async () => {
    const result = await call(createProps);

    // Identity: the service's result is returned verbatim, not re-wrapped.
    expect(result).toBe(sentinel);
    expect(spy.createProgramme).toHaveBeenCalledTimes(1);
    expect(spy.createProgramme.mock.calls[0][0]).toEqual({
      programmeId: 'reactor-hardening',
      name: 'Reactor hardening',
      description: 'two packages',
      childWorkflowId: 'core.ProcessAITicket@1.4.8',
      childInputDefaults: { agentId: 'ReactorAIPersona' },
      slaMinutes: 30,
      maxAttempts: 2,
      packages: [
        { id: 'schema' },
        { id: 'api', dependsOn: ['schema'], input: { ticketId: 't1' } },
      ],
    });
  });

  it('get → getProgramme', async () => {
    const result = await call({ action: 'get', programmeId: 'p1' });

    expect(result).toBe(sentinel);
    expect(spy.getProgramme).toHaveBeenCalledWith({ programmeId: 'p1' });
  });

  it('list → listProgrammes', async () => {
    const result = await call({ action: 'list', state: 'active', limit: 7 });

    expect(result).toBe(sentinel);
    expect(spy.listProgrammes).toHaveBeenCalledWith({ state: 'active', limit: 7 });
  });

  it.each(['pause', 'resume', 'abort'] as const)(
    '%s → the same-named service method, with the reason passed through',
    async (action) => {
      const result = await call({ action, programmeId: 'p1', reason: 'operator asked' });

      expect(result).toBe(sentinel);
      expect(spy[action]).toHaveBeenCalledWith({
        programmeId: 'p1',
        reason: 'operator asked',
      });
    },
  );

  it('report → reportPackageOutcome', async () => {
    const result = await call({
      action: 'report',
      dispatchId: 'd-1',
      status: 'completed',
      prUrl: 'https://github.com/o/r/pull/1',
      mergedSha: 'abc123',
      error: undefined,
      notes: 'done',
    });

    expect(result).toBe(sentinel);
    expect(spy.reportPackageOutcome).toHaveBeenCalledWith({
      dispatchId: 'd-1',
      status: 'completed',
      prUrl: 'https://github.com/o/r/pull/1',
      mergedSha: 'abc123',
      error: undefined,
      notes: 'done',
    });
  });

  it('tick → reconcile, with the tick knobs passed through', async () => {
    const result = await call({ action: 'tick', programmeId: 'p1', limit: 3, maxDispatchesPerTick: 1 });

    expect(result).toBe(sentinel);
    expect(spy.reconcile).toHaveBeenCalledWith({
      programmeId: 'p1',
      limit: 3,
      staleMs: undefined,
      leaseMs: undefined,
      maxDispatchesPerTick: 1,
      maxVerificationsPerTick: undefined,
      verificationIntervalMs: undefined,
      now: undefined,
    });
  });

  it('refuses an unknown action without calling the service', async () => {
    const result: any = await call({ action: 'deleteEverything' as any });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown programme action');
    Object.values(spy).forEach((fn: any) => expect(fn).not.toHaveBeenCalled());
  });

  it('returns a failure envelope (not a rejected promise) when the service is missing', async () => {
    const result: any = await call({ action: 'list' }, { user: { _id: ownerId }, getService: (): any => null });

    expect(result.success).toBe(false);
    expect(result.error).toContain(PROGRAMME_SERVICE_ID);
  });

  it('returns a failure envelope when the registry lookup throws', async () => {
    const result: any = await call(
      { action: 'list' },
      {
        user: { _id: ownerId },
        getService: () => {
          throw new Error('registry down');
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('registry down');
  });
});

// ── behaviour through the real service ───────────────────────────────────────

describe('programme macro behaviour (real service)', () => {
  it('create records the CALLING user as owner and the programme appears in list', async () => {
    const created: any = await call({
      action: 'create',
      name: 'Reactor hardening',
      packages: [{ id: 'schema' }, { id: 'api', dependsOn: ['schema'] }],
    });

    expect(created.created).toBe(true);
    expect(created.programme.programmeId).toMatch(/^reactor-hardening-[0-9a-f]+$/);
    expect(created.programme.ownerEmail).toBe('owner@example.com');

    const stored = store.snapshot(created.programme.programmeId)!;
    // The property the ticket names: the macro must not impersonate.
    expect(String(stored.ownerUserId)).toBe(String(ownerId));

    const listed: any = await call({ action: 'list' });
    expect(listed.programmes.map((p: any) => p.programmeId)).toContain(
      created.programme.programmeId,
    );
  });

  it('marks dependency-free packages ready and their dependents pending, then promotes after success', async () => {
    const created: any = await call({
      action: 'create',
      name: 'Graph',
      packages: [{ id: 'pkg-1' }, { id: 'pkg-2', dependsOn: ['pkg-1'] }],
    });
    const programmeId = created.programme.programmeId;

    const initial = store.snapshot(programmeId)!;
    expect(initial.packages.find((p) => p.id === 'pkg-1')!.state).toBe('ready');
    expect(initial.packages.find((p) => p.id === 'pkg-2')!.state).toBe('pending');

    // pkg-1 is dispatched by a tick, then reports success by pushing a merge SHA.
    await call({ action: 'tick', programmeId });
    const dispatched = store.snapshot(programmeId)!.packages.find((p) => p.id === 'pkg-1')!;
    expect(dispatched.state).toBe('running');
    expect(dispatched.childInstanceId).toBe('child-1');

    const reported: any = await call({
      action: 'report',
      dispatchId: dispatched.dispatchId,
      status: 'completed',
      mergedSha: 'abc123',
    });
    expect(reported.reported).toBe(true);
    expect(reported.state).toBe('succeeded');

    // The next tick promotes the dependent and, in the same pass, dispatches it.
    // The promotion itself is observable in the store's transition log: the tick is
    // allowed to do both, so asserting only the final state would hide whether the
    // dependency gate opened at all.
    await call({ action: 'tick', programmeId });
    const transitions = store.packageTransitions
      .filter((entry) => entry.packageId === 'pkg-2')
      .map((entry) => entry.state);
    expect(transitions).toContain('ready');
    expect(transitions.indexOf('ready')).toBeLessThan(transitions.indexOf('running'));
    expect(store.snapshot(programmeId)!.packages.find((p) => p.id === 'pkg-2')!.state).toBe('running');
  });

  it('list filters by state', async () => {
    const a: any = await call({ action: 'create', name: 'Alpha', packages: [{ id: 'pkg-1' }] });
    const b: any = await call({ action: 'create', name: 'Beta', packages: [{ id: 'pkg-1' }] });

    const paused: any = await call({ action: 'pause', programmeId: b.programme.programmeId });
    expect(paused.paused).toBe(true);

    const pausedList: any = await call({ action: 'list', state: 'paused' });
    expect(pausedList.programmes.map((p: any) => p.programmeId)).toEqual([
      b.programme.programmeId,
    ]);

    const activeList: any = await call({ action: 'list', state: 'active' });
    expect(activeList.programmes.map((p: any) => p.programmeId)).toEqual([
      a.programme.programmeId,
    ]);
  });

  it('get returns an envelope for an unknown id rather than throwing', async () => {
    const result: any = await call({ action: 'get', programmeId: 'does-not-exist' });

    expect(result.found).toBe(false);
    expect(result.code).toBe('not_found');
    expect(result.error).toContain('does-not-exist');
  });

  it('pause stops new dispatch and leaves a running package child untouched; resume continues', async () => {
    const now = new Date();
    store.seed({
      programmeId: 'p-running',
      name: 'Running',
      state: 'active',
      ownerUserId: String(ownerId),
      ownerEmail: 'owner@example.com',
      childWorkflowId: DEFAULT_CHILD_WORKFLOW_ID,
      packages: [
        {
          id: 'live',
          title: 'live',
          dependsOn: [],
          state: 'running',
          attempt: 1,
          stallCount: 0,
          childInstanceId: 'child-live',
          dispatchId: 'd-live',
          lastProgressAt: now,
        },
        {
          id: 'waiting',
          title: 'waiting',
          dependsOn: [],
          state: 'ready',
          attempt: 0,
          stallCount: 0,
        },
      ],
    } as any);

    const paused: any = await call({ action: 'pause', programmeId: 'p-running', reason: 'hold' });
    expect(paused.paused).toBe(true);
    expect(paused.runningPackages).toBe(1);

    // A paused programme dispatches nothing, and the running child is untouched.
    await call({ action: 'tick', programmeId: 'p-running' });
    const pausedDoc = store.snapshot('p-running')!;
    expect(pausedDoc.state).toBe('paused');
    expect(pausedDoc.packages.find((p) => p.id === 'live')!.childInstanceId).toBe('child-live');
    expect(pausedDoc.packages.find((p) => p.id === 'waiting')!.state).toBe('ready');
    expect(workflowService.startWorkflow).not.toHaveBeenCalled();

    // Resume continues from actual state: the still-ready package is dispatched.
    const resumed: any = await call({ action: 'resume', programmeId: 'p-running' });
    expect(resumed.resumed).toBe(true);

    await call({ action: 'tick', programmeId: 'p-running' });
    const resumedDoc = store.snapshot('p-running')!;
    expect(resumedDoc.state).toBe('active');
    expect(resumedDoc.packages.find((p) => p.id === 'waiting')!.state).toBe('running');
    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);
  });

  it('abort cancels non-terminal packages and leaves terminal ones alone', async () => {
    store.seed({
      programmeId: 'p-abort',
      name: 'Abort',
      state: 'active',
      ownerUserId: String(ownerId),
      ownerEmail: 'owner@example.com',
      childWorkflowId: DEFAULT_CHILD_WORKFLOW_ID,
      packages: [
        {
          id: 'live',
          title: 'live',
          dependsOn: [],
          state: 'running',
          attempt: 1,
          stallCount: 0,
          childInstanceId: 'child-live',
          dispatchId: 'd-live',
        },
        { id: 'waiting', title: 'waiting', dependsOn: [], state: 'ready', attempt: 0, stallCount: 0 },
        {
          id: 'done',
          title: 'done',
          dependsOn: [],
          state: 'succeeded',
          attempt: 1,
          stallCount: 0,
          mergedSha: 'abc123',
        },
      ],
    } as any);

    const result: any = await call({ action: 'abort', programmeId: 'p-abort', reason: 'stop' });

    expect(result.aborted).toBe(true);
    expect(result.cancelled).toBe(2);
    expect(result.cancelFailures).toBe(0);
    expect(workflowService.cancelWorkflowInstance).toHaveBeenCalledWith('child-live');

    const doc = store.snapshot('p-abort')!;
    expect(doc.state).toBe('aborted');
    expect(doc.packages.find((p) => p.id === 'live')!.state).toBe('cancelled');
    expect(doc.packages.find((p) => p.id === 'waiting')!.state).toBe('cancelled');
    // Terminal packages are not touched, and their evidence is preserved.
    expect(doc.packages.find((p) => p.id === 'done')!.state).toBe('succeeded');
    expect(doc.packages.find((p) => p.id === 'done')!.mergedSha).toBe('abc123');
  });

  it('tick dispatches the ready package and adopts the child instance id, threading the reconciler fields', async () => {
    const created: any = await call({
      action: 'create',
      name: 'Dispatch',
      childInputDefaults: { agentId: 'ReactorAIPersona' },
      packages: [{ id: 'pkg-1', input: { ticketId: 't-1' } }],
    });
    const programmeId = created.programme.programmeId;

    const tick: any = await call({ action: 'tick', programmeId });
    expect(tick.dispatched).toBe(1);

    const pkg = store.snapshot(programmeId)!.packages[0];
    expect(pkg.state).toBe('running');
    expect(pkg.childInstanceId).toBe('child-1');

    const [workflowId, execution] = workflowService.startWorkflow.mock.calls[0] as any[];
    expect(workflowId).toBe(DEFAULT_CHILD_WORKFLOW_ID);
    // The dispatch id is threaded INTO the child: that is how recovery finds it.
    expect(execution.input).toEqual({
      agentId: 'ReactorAIPersona',
      ticketId: 't-1',
      dispatchId: pkg.dispatchId,
      programmeId,
      packageId: 'pkg-1',
    });
  });
});

// ── identity ─────────────────────────────────────────────────────────────────

describe('programme macro identity', () => {
  const previousEmail = process.env.SYSTEM_USER_EMAIL;

  afterEach(() => {
    if (previousEmail === undefined) delete process.env.SYSTEM_USER_EMAIL;
    else process.env.SYSTEM_USER_EMAIL = previousEmail;
  });

  const systemUser = { _id: new ObjectId(), email: 'system@reactory.net', roles: ['ADMIN', 'SUPERADMIN'] };

  beforeEach(() => {
    process.env.SYSTEM_USER_EMAIL = 'system@reactory.net';
    context = buildContext(systemUser);
    service.context = context;
  });

  it('create is refused for the system account (it must own nothing it can later pause)', async () => {
    const result: any = await call({ action: 'create', name: 'System programme', packages: [] });

    expect(result.created).toBe(false);
    expect(result.code).toBe('system_caller');
  });

  it.each(['pause', 'resume', 'abort'] as const)(
    '%s is refused for the system account even with ADMIN',
    async (action) => {
      store.seed({
        programmeId: 'p-system',
        name: 'System',
        state: 'active',
        ownerUserId: String(systemUser._id),
        ownerEmail: systemUser.email,
        packages: [{ id: 'pkg-1', title: 'p', dependsOn: [], state: 'ready', attempt: 0, stallCount: 0 }],
      } as any);

      const result: any = await call({ action, programmeId: 'p-system' });

      expect(result.code).toBe('system_caller');
      expect(result[action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'aborted']).toBe(false);
      expect(store.snapshot('p-system')!.state).toBe('active');
    },
  );
});
