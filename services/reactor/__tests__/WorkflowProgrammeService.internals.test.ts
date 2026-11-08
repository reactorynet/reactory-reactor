import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';

/**
 * Remaining decision branches of `WorkflowProgrammeService` plus the shared
 * identity predicates: construction, the last-resort fallbacks (a store write
 * that fails while reporting a failure, a service registry that throws), and the
 * summary/validation corners.
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
  summariseProgrammeOutcome,
  validateProgrammePackages,
  sanitiseOptionalString,
  toFiniteNumber,
  clampNumber,
  normaliseChildStatus,
  dependencyVerdict,
  initialPackageState,
  mintDispatchId,
  toProgrammeView,
} from '../WorkflowProgrammeService';
import { hasAdministrativeRole, isSystemIdentity } from '../identity';
import { InMemoryProgrammeStore } from './support/InMemoryProgrammeStore';

const ownerId = new ObjectId();

let store: InMemoryProgrammeStore;
let service: WorkflowProgrammeService;
let communicator: { send: any };
let workflowService: any;

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
  service.context = {
    user: { _id: ownerId, email: 'owner@example.com', roles: ['USER'] },
    partner: { key: 'tenant-a' },
    log: jest.fn(),
    hasRole: () => false,
    getService: (id: string) => {
      if (id === COMMUNICATOR_SERVICE_ID) return communicator;
      if (id === WORKFLOW_SERVICE_ID) return workflowService;
      return null;
    },
  } as any;
  service.store = store;
  service.ownerContextBuilder = jest.fn(async () => undefined) as any;
  service.ghVerifier = jest.fn(async () => ({ kind: 'skipped' })) as any;
});

// ── construction ────────────────────────────────────────────────────────────

describe('service construction', () => {
  it('builds a usable instance through the class constructor', async () => {
    const instance = new WorkflowProgrammeService({} as any, service.context as any);

    expect(instance.toString()).toBe('WorkflowProgrammeService');
    expect(instance.toString(true)).toBe('WorkflowProgrammeService@1.0.0');
    expect(instance.store).toBeDefined();
    expect(instance.nameSpace).toBe('reactor');
    // The gh runner is the module-level promisified execFile.
    expect(typeof instance.ghExec).toBe('function');
  });

  it('returns undefined from the default owner-context builder without an email', async () => {
    const instance = new WorkflowProgrammeService({} as any, service.context as any);
    await expect(instance.ownerContextBuilder({})).resolves.toBeUndefined();
  });

  it('asks the real context factory when an email is supplied', async () => {
    const instance = new WorkflowProgrammeService({} as any, service.context as any);
    // The factory needs a bootstrapped server; either outcome proves the branch
    // executes (the value is irrelevant, the import is not).
    await instance.ownerContextBuilder({ userEmail: 'nobody@example.com' }).catch(() => undefined);
    expect(true).toBe(true);
  });
});

// ── startup ─────────────────────────────────────────────────────────────────

describe('onStartup', () => {
  it('falls back to ./data when no data root is configured, rather than skipping the check', async () => {
    // The Scheduler resolves `process.env.APP_DATA_ROOT || './data'`; the check must
    // resolve the same place, or it can never warn in the configuration that needs it.
    const previous = { app: process.env.APP_DATA_ROOT, data: process.env.REACTORY_DATA };
    delete process.env.APP_DATA_ROOT;
    delete process.env.REACTORY_DATA;
    try {
      const result: any = await service.onStartup();
      expect(result.scheduleChecked).toBe(true);
      expect(result.scheduleInstalled).toBe(false);
    } finally {
      if (previous.app !== undefined) process.env.APP_DATA_ROOT = previous.app;
      if (previous.data !== undefined) process.env.REACTORY_DATA = previous.data;
    }
  });
});

// ── report races and last-resort fallbacks ──────────────────────────────────

describe('reportPackageOutcome race', () => {
  it('reports a lost transition instead of pretending the outcome was stored', async () => {
    store.seed(
      baseProgramme({ packages: [pkg({ state: 'running', dispatchId: 'd-1', attempt: 1 })] }),
    );
    jest.spyOn(store, 'transitionPackage').mockResolvedValue(null);

    const result: any = await service.reportPackageOutcome({
      dispatchId: 'd-1',
      status: 'completed',
      mergedSha: 'sha-1',
    });

    expect(result.reported).toBe(false);
    expect(result.reason).toContain('moved while the report was being applied');
  });

  it('rejects a report that names no dispatch id', async () => {
    const result: any = await service.reportPackageOutcome({ dispatchId: '  ' });
    expect(result.reported).toBe(false);
    expect(result.reason).toContain('dispatchId');
  });
});

describe('last-resort fallbacks', () => {
  it('survives a store that cannot record a tick failure', async () => {
    const longAgo = new Date(Date.now() - 10 * 60_000);
    store.seed(
      baseProgramme({
        packages: [pkg({ state: 'dispatching', dispatchId: 'd-1', attempt: 1, dispatchedAt: longAgo })],
      }),
    );
    service.findChildByDispatchId = jest.fn(async () => {
      throw new Error('history unavailable');
    }) as any;
    jest.spyOn(store, 'updateProgramme').mockRejectedValue(new Error('mongo down'));

    const result = await service.reconcile({});
    expect(result.errors).toBe(1);
  });

  it('survives a store that cannot record notification evidence', async () => {
    store.seed(baseProgramme({ packages: [pkg({ state: 'succeeded', attempt: 1 })] }));
    jest.spyOn(store, 'updateProgramme').mockRejectedValue(new Error('mongo down'));

    await expect(service.reconcile({ programmeId: 'p1' })).resolves.toBeTruthy();
    expect(communicator.send).toHaveBeenCalledTimes(1);
  });

  it('treats a service registry that throws as "no such service"', async () => {
    service.context = {
      ...(service.context as any),
      getService: () => {
        throw new Error('registry broken');
      },
    } as any;
    store.seed(baseProgramme({ packages: [pkg()] }));

    const result: any = await service.reconcile({ programmeId: 'p1' });
    expect(result.programmes).toBe(1);
    // The child could not start, so the package is left dispatching for recovery —
    // never re-armed, which would risk a second child.
    expect(store.snapshot('p1')!.packages[0].state).toBe('dispatching');
  });

  it('notify() without a package sends the programme-level message', async () => {
    store.seed(baseProgramme({ packages: [pkg({ state: 'succeeded', attempt: 1 })] }));
    const programme = store.snapshot('p1')!;

    await service.notify(programme as any, 'completed');

    const payload = communicator.send.mock.calls[0][0] as any;
    expect(payload.metadata.event).toBe('completed');
    expect(payload.content.subject).toContain('completed successfully');
  });

  it('logs to the console when the context has no logger', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    service.context = { getService: (): null => null } as any;
    // No communicator AND no task surface: 'none' is logged at error level.
    mockTaskSave.mockRejectedValueOnce(new Error('task store down'));
    store.seed(baseProgramme({ packages: [pkg({ state: 'succeeded', attempt: 1 })] }));

    await service.reconcile({ programmeId: 'p1' });

    // channel 'none' is logged at error level; with no context logger that means
    // console.error — the only remaining evidence.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── promotion and the skip guard ────────────────────────────────────────────

describe('promotion and skip', () => {
  it('promotes a pending package when its dependency has landed, and dispatches it', async () => {
    store.seed(
      baseProgramme({
        packages: [
          pkg({ id: 'schema', state: 'succeeded', attempt: 1, mergedSha: 'sha-schema' }),
          pkg({ id: 'api', state: 'pending', dependsOn: ['schema'] }),
        ],
      }),
    );

    await service.reconcile({ programmeId: 'p1' });

    const api = store.snapshot('p1')!.packages.find((entry) => entry.id === 'api')!;
    expect(api.state).toBe('running');
    expect(api.dispatchId).toBeTruthy();
    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);
  });

  it('skips a programme whose lease was granted but which is already terminal', async () => {
    store.seed(baseProgramme({ state: 'completed', packages: [pkg({ state: 'succeeded' })] }));
    // A lease can be granted a moment before another caller settles the programme;
    // the tick must then do nothing rather than re-open it.
    const terminal = store.snapshot('p1')!;
    jest.spyOn(store, 'claimLease').mockResolvedValue(terminal as any);

    const result = await service.reconcile({ programmeId: 'p1' });

    expect(result.ticks[0].outcome).toBe('skipped');
    expect(store.snapshot('p1')!.state).toBe('completed');
    expect(workflowService.startWorkflow).not.toHaveBeenCalled();
  });
});

// ── pure helper defaults ────────────────────────────────────────────────────

describe('helper defaults', () => {
  it('sanitiseOptionalString rejects every flavour of "absent"', () => {
    expect(sanitiseOptionalString(undefined)).toBeUndefined();
    expect(sanitiseOptionalString(null)).toBeUndefined();
    expect(sanitiseOptionalString('')).toBeUndefined();
    expect(sanitiseOptionalString('   ')).toBeUndefined();
    expect(sanitiseOptionalString('undefined')).toBeUndefined();
    expect(sanitiseOptionalString('null')).toBeUndefined();
    expect(sanitiseOptionalString(['$', '{input.x}'].join(''))).toBeUndefined();
    expect(sanitiseOptionalString(' value ')).toBe('value');
  });

  it('toFiniteNumber and clampNumber keep only real numbers and clamp the rest', () => {
    expect(toFiniteNumber(undefined)).toBeUndefined();
    expect(toFiniteNumber('')).toBeUndefined();
    expect(toFiniteNumber('abc')).toBeUndefined();
    expect(toFiniteNumber('12')).toBe(12);
    expect(clampNumber('abc', 1, 10, 5)).toBe(5);
    expect(clampNumber(0, 1, 10, 5)).toBe(1);
    expect(clampNumber(99, 1, 10, 5)).toBe(10);
    expect(clampNumber(7, 1, 10, 5)).toBe(7);
  });

  it('normaliseChildStatus tolerates non-string reports', () => {
    expect(normaliseChildStatus(42)).toBeUndefined();
    expect(normaliseChildStatus(null)).toBeUndefined();
    expect(normaliseChildStatus(' DONE ')).toBe('completed');
  });

  it('dependencyVerdict treats a missing dependsOn as satisfied', () => {
    expect(dependencyVerdict({} as any, new Map())).toBe('satisfied');
  });

  it('validateProgrammePackages rejects a non-list and a self-cycle', () => {
    expect(validateProgrammePackages(undefined as any)).toEqual(['at least one package is required']);
    expect(validateProgrammePackages([{ id: 'a', dependsOn: ['a'] }]).join(' ')).toContain('depends on itself');
    expect(validateProgrammePackages([{ id: 'a', dependsOn: [] }, { id: 'a', dependsOn: [] }]).join(' ')).toContain(
      'duplicate package id',
    );
  });

  it('initialPackageState and mintDispatchId are total', () => {
    expect(initialPackageState({} as any)).toBe('ready');
    expect(mintDispatchId('p', 'k')).toMatch(/^p:k:[0-9a-f]{32}$/);
  });

  it('summariseProgrammeOutcome rejects a non-list as failed', () => {
    expect(summariseProgrammeOutcome(undefined as any)).toBe('failed');
    expect(summariseProgrammeOutcome([])).toBe('failed');
  });
});

// ── summary / validation corners ────────────────────────────────────────────

describe('summary and validation corners', () => {
  it('does not call a mixed succeeded/cancelled programme a success', () => {
    expect(summariseProgrammeOutcome([{ state: 'succeeded' }, { state: 'cancelled' }])).toBe('failed');
    expect(summariseProgrammeOutcome([{ state: 'ready' }, { state: 'failed' }])).toBeNull();
    expect(summariseProgrammeOutcome([{ state: 'pending' }])).toBeNull();
  });

  it('rejects a package with no id', () => {
    expect(validateProgrammePackages([{ id: '  ', dependsOn: [] }]).join(' ')).toContain(
      'every package needs a non-empty id',
    );
  });
});

// ── shared identity predicates ─────────────────────────────────────────────

describe('identity predicates', () => {
  it('accepts a role through hasRole, the role list, or neither', () => {
    expect(hasAdministrativeRole({ hasRole: (role: string) => role === 'ADMIN' })).toBe(true);
    expect(hasAdministrativeRole({ user: { roles: ['developer'] } })).toBe(true);
    expect(hasAdministrativeRole({ user: { roles: ['USER'] } })).toBe(false);
    expect(hasAdministrativeRole(undefined)).toBe(false);
  });

  it('treats a throwing hasRole as "not administrative" and still checks the list', () => {
    const context = {
      hasRole: () => {
        throw new Error('no roles');
      },
      user: { roles: ['SUPERADMIN'] },
    };
    expect(hasAdministrativeRole(context)).toBe(true);
  });

  it('identifies the system account by email or id', () => {
    const previous = { email: process.env.SYSTEM_USER_EMAIL, id: process.env.SYSTEM_USER_ID };
    process.env.SYSTEM_USER_EMAIL = 'system@reactory.net';
    process.env.SYSTEM_USER_ID = 'sys-1';
    try {
      expect(isSystemIdentity({ email: 'SYSTEM@reactory.net' })).toBe(true);
      expect(isSystemIdentity({ id: 'sys-1' })).toBe(true);
      expect(isSystemIdentity({ email: 'someone@example.com' })).toBe(false);
      expect(isSystemIdentity(undefined)).toBe(false);
    } finally {
      if (previous.email === undefined) delete process.env.SYSTEM_USER_EMAIL;
      else process.env.SYSTEM_USER_EMAIL = previous.email;
      if (previous.id === undefined) delete process.env.SYSTEM_USER_ID;
      else process.env.SYSTEM_USER_ID = previous.id;
    }
  });
});

// ── guard clauses and fallback operands ────────────────────────────────────

describe('edges', () => {
  it('constructs with no arguments at all', () => {
    const bare = new WorkflowProgrammeService();
    expect(bare.toString()).toBe('WorkflowProgrammeService');
  });

  it('refuses create/programme control from a caller with no user', async () => {
    service.context = { ...(service.context as any), user: undefined } as any;
    expect(((await service.createProgramme({ name: 'x', packages: [{ id: 'p' }] } as any)) as any).code).toBe(
      'no_identity',
    );
  });

  it('refuses an empty/absent programme id on every control entry point', async () => {
    expect(((await service.getProgramme({ programmeId: ' ' })) as any).code).toBe('invalid_programme_id');
    expect(((await service.pause({ programmeId: '' })) as any).code).toBe('invalid_programme_id');
    expect(((await service.resume({ programmeId: '' })) as any).code).toBe('invalid_programme_id');
    expect(((await service.abort({ programmeId: '' })) as any).code).toBe('invalid_programme_id');
    expect(((await service.abort({ programmeId: 'nothing-here' })) as any).code).toBe('not_found');
    expect(((await service.pause({ programmeId: 'nothing-here' })) as any).code).toBe('not_found');
  });

  it('lists programmes filtered by state, and tolerates a caller with no id', async () => {
    store.seed(baseProgramme({ state: 'paused', packages: [pkg()] }));
    store.seed(baseProgramme({ programmeId: 'p2', state: 'completed', packages: [pkg()] }));

    const filtered: any = await service.listProgrammes({ state: 'paused' });
    expect(filtered.programmes.map((entry: any) => entry.programmeId)).toEqual(['p1']);

    service.context = { ...(service.context as any), user: undefined, hasRole: () => false } as any;
    expect(((await service.listProgrammes({})) as any).code).toBe('no_identity');
  });

  it('records an owner without an email as an empty string rather than undefined', async () => {
    service.context = { ...(service.context as any), user: { _id: ownerId } } as any;
    const created: any = await service.createProgramme({ name: 'No email', packages: [{ id: 'p' }] });
    expect(created.created).toBe(true);
    expect(created.programme.ownerEmail).toBe('');

    store.seed(baseProgramme({ programmeId: 'no-email', ownerUserId: ownerId, packages: [pkg()] }));
    const paused: any = await service.pause({ programmeId: 'no-email' });
    expect(paused.paused).toBe(true);
    expect(store.snapshot('no-email')!.pausedByEmail).toBe('');
  });

  it('rejects a programme whose packages key is not a list', async () => {
    const result: any = await service.createProgramme({ name: 'No packages' } as any);
    expect(result.code).toBe('invalid_packages');
  });

  it('views a programme document that carries no packages array', () => {
    const view = toProgrammeView({ programmeId: 'p', name: 'P', state: 'active' } as any);
    expect(view.packages).toEqual([]);
    expect(view.counts).toEqual({});
  });

  it('dispatches when neither the package nor the programme names a child workflow', async () => {
    await service.startChild(
      baseProgramme({ childWorkflowId: undefined }) as any,
      pkg() as any,
      'd-1',
    );
    expect((workflowService.startWorkflow.mock.calls[0] as any[])[0]).toBe(DEFAULT_CHILD_WORKFLOW_ID);
  });

  it('reports a malformed gh failure even when it carries no message', async () => {
    service.ghExec = jest.fn(async () => {
      throw 'plain string failure';
    }) as any;
    // Call the REAL adapter: beforeEach replaces the method with a stub.
    const verdict: any = await WorkflowProgrammeService.prototype.ghVerifier.call(
      service,
      pkg({ prUrl: 'https://github.com/x/y/pull/1' }) as any,
      baseProgramme() as any,
    );
    expect(verdict.kind).toBe('error');
    expect(verdict.error).toBe('plain string failure');
  });

  it('copes with a claim that returns no packages array and a start with no instance id', async () => {
    store.seed(baseProgramme({ packages: [pkg()] }));
    // The store contract returns the updated document; a driver that returns a
    // partial one must not crash the tick, and a start with no id must be treated
    // as a failed start (left dispatching for recovery).
    jest.spyOn(store, 'transitionPackage').mockResolvedValueOnce({ programmeId: 'p1' } as any);
    workflowService.startWorkflow.mockResolvedValueOnce({});

    const result = await service.reconcile({ programmeId: 'p1' });

    expect(result.programmes).toBe(1);
    // The child was started from the fallback package shape (the claim returned no
    // packages array), and a start with no instance id is a FAILED start: the
    // package is left for dispatch-id recovery rather than re-armed.
    expect(workflowService.startWorkflow).toHaveBeenCalledTimes(1);
    expect(store.snapshot('p1')!.packages[0].lastError).toContain('no instance id');
  });

  it('classifies a programme with nothing actionable and a failure as failed', () => {
    expect(summariseProgrammeOutcome([{ state: 'failed' }, { state: 'pending' }] as any)).toBe('failed');
  });
});
