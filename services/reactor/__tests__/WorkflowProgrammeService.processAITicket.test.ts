import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';

/**
 * `core.ProcessAITicket` as a programme child — the §3 integration question.
 *
 * THE QUESTION
 * ------------
 * `childStatusLookup`'s own comment names `core.ProcessAITicket` as the intended
 * child ("a healthy 12-hour run was escalated as gone silent"), and `startChild`
 * already threads `{ ...childInputDefaults, ...pkg.input, dispatchId, programmeId,
 * packageId }` into it. But a `ProcessAITicket` child completes by setting its OWN
 * instance status: it never calls `reportPackageOutcome`, so it never pushes a
 * `prUrl` or a `mergedSha` into the package.
 *
 * The reconciler's success rule is "push-reported merge SHA, verified merge, or no
 * merge to wait for". The dangerous outcome would be:
 *
 *   child instance completes  →  package settles `succeeded`  →  no PR was ever
 *   verified, and the programme claims work that may not have merged.
 *
 * THE ANSWER (measured here, not assumed)
 * ---------------------------------------
 * That does NOT happen. The "no merge to wait for" branch is PUSH-ONLY: it lives in
 * `reportPackageOutcome` and requires the child to send `status: 'completed'` with
 * no `prUrl`. A child that only changes its instance status reaches a different
 * branch entirely — `observePackages` → `childStatusLookup` → `classifyChildStatus`
 * → `child_completed_unreported` → package **failed**.
 *
 * So a real `ProcessAITicket` child is observed (never mistaken for silence) and is
 * never silently called successful; it is FAILED for not reporting. Making it
 * succeed requires a completion bridge inside the child workflow (out of scope for
 * this ticket — `workflow/ProcessAITicket.yaml` must not be touched). These tests
 * pin the current truth so that neither half can change silently:
 *
 *  - the "no merge" success branch is reachable only by a push;
 *  - an instance-status-only completion is failed, never succeeded;
 *  - observation happens on the SLA window, not the moment the child ends.
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
const PROGRAMME_ID = 'process-ai-ticket-programme';
const CHILD_INSTANCE_ID = 'process-ai-ticket-instance-1';
const minutes = (value: number) => value * 60_000;

const T0 = new Date('2026-11-08T08:00:00.000Z');

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

/** The programme an agent would create through the new front door. */
const seedProgramme = (overrides: Record<string, any> = {}) =>
  store.seed({
    programmeId: PROGRAMME_ID,
    name: 'ProcessAITicket child',
    state: 'active',
    ownerUserId: String(ownerId),
    ownerEmail: 'owner@example.com',
    // The default child — the one `childStatusLookup` says is intended.
    childWorkflowId: DEFAULT_CHILD_WORKFLOW_ID,
    childInputDefaults: { agentId: 'ReactorAIPersona', taskType: 'feature' },
    slaMinutes: 45,
    maxAttempts: 3,
    // Pinned to the tick clock: `lastProgressAt` falls back to `createdAt`, so a
    // seed stamped with the wall clock would make the SLA window unmeasurable.
    createdAt: T0,
    lastProgressAt: T0,
    packages: [
      {
        id: 'pkg-1',
        title: 'ticket work',
        dependsOn: [],
        state: 'ready',
        attempt: 0,
        stallCount: 0,
        input: { ticketReference: 'REACTORY-302016408/20261108/4281970977' },
      },
    ],
    ...overrides,
  } as any);

/**
 * The engine's view of a child that COMPLETED BY SETTING ITS OWN STATUS.
 *
 * `data.inputs` is what the dispatch threaded in, exactly as a real instance would
 * carry it. Nothing else is simulated: in particular this child makes no service
 * call, which is the whole point — `ProcessAITicket` does not push.
 */
const completedChildInstance = (dispatchId: string) => ({
  id: CHILD_INSTANCE_ID,
  instanceId: CHILD_INSTANCE_ID,
  status: 2, // WorkflowESStatus COMPLETE
  statusLabel: 'Complete',
  data: {
    inputs: {
      dispatchId,
      programmeId: PROGRAMME_ID,
      packageId: 'pkg-1',
    },
  },
});

beforeEach(() => {
  store = new InMemoryProgrammeStore();
  communicator = { send: jest.fn(async () => ({ success: true })) };
  workflowService = {
    startWorkflow: jest.fn(async () => ({ id: CHILD_INSTANCE_ID })),
    cancelWorkflowInstance: jest.fn(async () => ({ success: true })),
    getWorkflowHistory: jest.fn(async () => ({ instances: [] })),
    getWorkflowHistoryById: jest.fn(async () => undefined),
  };

  service = Object.create(WorkflowProgrammeService.prototype);
  service.context = buildContext({ _id: ownerId, email: 'owner@example.com', roles: ['USER'] }) as any;
  service.store = store;
  service.ownerContextBuilder = jest.fn(async () => undefined) as any;
  service.ghVerifier = jest.fn(async () => ({ kind: 'skipped' })) as any;
});

// ── the dispatch half ────────────────────────────────────────────────────────

describe('ProcessAITicket dispatch', () => {
  it('starts the ProcessAITicket child with the reconciler fields threaded into its input', async () => {
    seedProgramme();

    const tick: any = await service.reconcile({ programmeId: PROGRAMME_ID, now: T0 });
    expect(tick.dispatched).toBe(1);

    const [workflowId, execution] = workflowService.startWorkflow.mock.calls[0] as any[];
    expect(workflowId).toBe('core.ProcessAITicket@1.4.7');

    const stored = store.snapshot(PROGRAMME_ID)!.packages[0];
    expect(execution.input).toEqual({
      // programme defaults
      agentId: 'ReactorAIPersona',
      taskType: 'feature',
      // package input
      ticketReference: 'REACTORY-302016408/20261108/4281970977',
      // threaded by the reconciler, so the child can report back and be found again
      dispatchId: stored.dispatchId,
      programmeId: PROGRAMME_ID,
      packageId: 'pkg-1',
    });

    // Adoption is real, not assumed.
    expect(stored.state).toBe('running');
    expect(stored.childInstanceId).toBe(CHILD_INSTANCE_ID);
  });
});

// ── the completion half: the actual answer to §3 ─────────────────────────────

describe('ProcessAITicket completion — the branch that fires', () => {
  it('does NOT settle the package as succeeded when the child only sets its instance status', async () => {
    seedProgramme();
    await service.reconcile({ programmeId: PROGRAMME_ID, now: T0 });
    const dispatcher = store.snapshot(PROGRAMME_ID)!.packages[0];
    const dispatchId = dispatcher.dispatchId!;

    // The child finished. Its ONLY observable effect is its instance status; it
    // never called reportPackageOutcome (it cannot — ProcessAITicket has no bridge).
    workflowService.getWorkflowHistoryById = jest.fn(async () => completedChildInstance(dispatchId));

    // Five minutes later: the child is complete in the engine, but the package is
    // not overdue, so the tick has not looked at the child yet. This is the second
    // half of the answer — the programme does not "settle the moment it ends".
    await service.reconcile({ programmeId: PROGRAMME_ID, now: new Date(T0.getTime() + minutes(5)) });
    expect(store.snapshot(PROGRAMME_ID)!.packages[0].state).toBe('running');
    expect(service.childStatusLookup).toBeDefined();
    // The lookup is only paid for when a package looks overdue.
    expect(workflowService.getWorkflowHistoryById).not.toHaveBeenCalled();

    // Past the SLA (45 minutes of no progress) the tick consults the child.
    const terminalTick: any = await service.reconcile({
      programmeId: PROGRAMME_ID,
      now: new Date(T0.getTime() + minutes(46)),
    });

    const stored = store.snapshot(PROGRAMME_ID)!.packages[0];
    expect(stored.state).toBe('failed');
    expect(stored.status).toBe('child_completed_unreported');
    expect(stored.outcomeSource).toBe('reconciler');
    expect(stored.lastError).toMatch(/completed without reporting an outcome/);

    // Never succeeded, at any point in the package's history.
    expect(store.packageTransitions.map((entry) => entry.state)).not.toContain('succeeded');

    // The programme settles FAILED, and the owner is told.
    expect(store.snapshot(PROGRAMME_ID)!.state).toBe('failed');
    // `reconcile` returns a pass summary; the per-programme verdict is on its tick.
    expect(terminalTick.settled).toBe(1);
    expect(terminalTick.ticks[0].settled).toBe('failed');
    const subjects = communicator.send.mock.calls.map((call: any[]) => call[0].content.subject);
    expect(subjects.some((subject: string) => /stopped with failures/.test(subject))).toBe(true);

    // No PR was ever involved, so `gh` was never consulted: the failure is "nothing
    // was reported", not "a merge could not be verified".
    expect(service.ghVerifier).not.toHaveBeenCalled();
  });

  it('the "no merge to wait for" success branch is PUSH-ONLY', async () => {
    // Same package, same child type. The difference is that this child CAN push:
    // a report with status=completed and no prUrl is the only way to reach the
    // "nothing to merge" branch.
    seedProgramme();
    await service.reconcile({ programmeId: PROGRAMME_ID, now: T0 });
    const dispatchId = store.snapshot(PROGRAMME_ID)!.packages[0].dispatchId!;

    const reported: any = await service.reportPackageOutcome({
      dispatchId,
      status: 'completed',
    });

    expect(reported.reported).toBe(true);
    expect(reported.state).toBe('succeeded');
    expect(reported.awaitingVerification).toBe(false);
    expect(store.snapshot(PROGRAMME_ID)!.packages[0].outcomeSource).toBe('push');
  });

  it('a bridge that pushes prUrl (not a merge SHA) is verified with gh before it succeeds', async () => {
    // This is the contract a future completion bridge would have to satisfy: report
    // the PR, let the reconciler verify the merge. It is asserted here so the
    // recommendation in the completion report is grounded in the code that exists.
    seedProgramme();
    await service.reconcile({ programmeId: PROGRAMME_ID, now: T0 });
    const dispatchId = store.snapshot(PROGRAMME_ID)!.packages[0].dispatchId!;

    await service.reportPackageOutcome({
      dispatchId,
      status: 'completed',
      prUrl: 'https://github.com/reactorynet/reactory-reactor/pull/1',
    });
    // A claim, not a success.
    expect(store.snapshot(PROGRAMME_ID)!.packages[0].state).toBe('running');
    expect(store.snapshot(PROGRAMME_ID)!.packages[0].status).toBe('awaiting_merge');

    service.ghVerifier = jest.fn(async () => ({
      kind: 'merged',
      mergedSha: 'deadbeef',
      prUrl: 'https://github.com/reactorynet/reactory-reactor/pull/1',
    })) as any;

    await service.reconcile({
      programmeId: PROGRAMME_ID,
      now: new Date(T0.getTime() + minutes(6)),
    });

    const stored = store.snapshot(PROGRAMME_ID)!.packages[0];
    expect(stored.state).toBe('succeeded');
    expect(stored.mergedSha).toBe('deadbeef');
    expect(stored.outcomeSource).toBe('gh');
  });
});
