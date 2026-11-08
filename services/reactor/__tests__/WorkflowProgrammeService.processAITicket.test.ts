import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';
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
 * succeed required a completion bridge inside the child workflow. `ProcessAITicket`
 * 1.4.8 adds exactly that: an optional `dispatchId` input, a gate that opens only
 * for programme-dispatched runs, and a `reportPackageOutcome` push on every
 * terminal path. The `ProcessAITicket reporting bridge` block at the bottom of this
 * file drives that bridge for real — the YAML's own scripts, the real service — so
 * the end-to-end path is measured rather than assumed. The tests above still pin
 * the pre-bridge truth, because it is the falsification baseline:
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
    expect(workflowId).toBe('core.ProcessAITicket@1.4.8');

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

// ── the 1.4.8 completion bridge: definition → service → package ─────────────
//
// The reconciler half is proven above. These tests prove the OTHER half by driving
// the SHIPPED definition: they locate each report call by its SCOPE (which branch
// it belongs to, and where it sits relative to the step that halts), execute the
// scripts the definition names, substitute the outputs exactly as the engine's
// resolver would, and hand the resulting params to the real reportPackageOutcome.
//
// Nothing here short-circuits on "is the step present": a call site is found by
// ancestry, so a bridge wired into the wrong branch, or placed after the step that
// terminates the instance, is simply not found — and the path it was meant to cover
// then has to fall back to the reconciler's `child_completed_unreported`.

const WORKFLOW_FILE = path.resolve(__dirname, '..', '..', '..', 'workflow', 'ProcessAITicket.yaml');

type Branch = 'root' | 'thenSteps' | 'elseSteps' | 'steps';
type TerminalPath = 'fallthrough' | 'publish_blocked' | 'baseline_blocked';

interface IWorkflowStep {
  id: string;
  type?: string;
  dependsOn?: string | string[];
  continueOnError?: boolean;
  retryPolicy?: any;
  config?: Record<string, any>;
}

interface IScopeRef { id: string; branch: Branch }
interface ISite { step: IWorkflowStep; ancestors: IScopeRef[]; scopeOrder: string[] }

/** Parse the shipped definition; `mutate` produces a deliberately damaged copy. */
const loadWorkflow = (mutate?: (def: any) => void): any => {
  const def: any = yaml.load(fs.readFileSync(WORKFLOW_FILE, 'utf8'));
  if (mutate) mutate(def);
  return def;
};

/** Every step with the scope chain that reaches it. */
const collectSites = (def: any): ISite[] => {
  const out: ISite[] = [];
  const visit = (steps: IWorkflowStep[], ancestors: IScopeRef[]): void => {
    const scopeOrder = (steps || []).map((step) => step.id);
    (steps || []).forEach((step) => {
      out.push({ step, ancestors, scopeOrder });
      const cfg = step.config || {};
      (['thenSteps', 'elseSteps', 'steps'] as Branch[]).forEach((key) => {
        if (Array.isArray(cfg[key])) visit(cfg[key], [...ancestors, { id: step.id, branch: key }]);
      });
    });
  };
  visit(def.steps || [], []);
  return out;
};

const REPORT_METHOD = 'reportPackageOutcome';

const reportSites = (def: any): ISite[] =>
  collectSites(def).filter((site) => site.step.config?.method === REPORT_METHOD);

const inBranch = (site: ISite, gateId: string, branch: Branch): boolean =>
  site.ancestors.some((ancestor) => ancestor.id === gateId && ancestor.branch === branch);

/**
 * The report call a given terminal path is wired to.
 *
 * `[]` means the path has NO report — which is exactly what an unwired (or
 * mis-nested, or post-halt) bridge looks like from here.
 */
const sitesForPath = (def: any, terminal: TerminalPath): ISite[] =>
  reportSites(def).filter((site) => {
    if (terminal === 'publish_blocked') return inBranch(site, 'publishReadinessGate', 'elseSteps');
    if (terminal === 'baseline_blocked') return inBranch(site, 'submoduleBaselineGate', 'elseSteps');
    return site.ancestors.some((ancestor) => ancestor.id === 'programmeOutcomeGate');
  });

/**
 * The authored order of the scope that CONTAINS a site's nearest ancestor gate.
 * That is the list in which the gate and the halt it precedes are siblings.
 */
const siblingOrder = (def: any, site: ISite): string[] => {
  const nearest = site.ancestors[site.ancestors.length - 1];
  if (!nearest) return site.scopeOrder;
  const parent = collectSites(def).find((entry) => entry.step.id === nearest.id);
  return parent ? parent.scopeOrder : site.scopeOrder;
};

const stepById = (def: any, id: string): IWorkflowStep => {
  const hit = collectSites(def).find((site) => site.step.id === id);
  if (!hit) throw new Error(`step "${id}" not found in ProcessAITicket.yaml`);
  return hit.step;
};

const scriptOf = (def: any, id: string): string => {
  const args = stepById(def, id).config?.args;
  if (!Array.isArray(args) || typeof args[1] !== 'string') {
    throw new Error(`step "${id}" does not carry an inline script`);
  }
  return args[1];
};

const runNode = (script: string, env: Record<string, string>): string =>
  execFileSync(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** What the engine leaves behind for an unset optional input: a TRUTHY token. */
const unset = (expression: string): string => '${' + expression + '}';

/**
 * Resolve a report site's `params` the way ServiceInvokeStep does: interpolate
 * `${steps.<id>.outputs.<key>}` (and `${variables.<key>}`) from what the run
 * produced, and leave anything unresolved as the original token.
 */
const resolveSiteParams = (
  site: ISite,
  outputs: Record<string, string>,
  variables: Record<string, string> = {},
): any => {
  const resolve = (value: any): any => {
    if (typeof value !== 'string') return value;
    return value.replace(/\$\{([^}]+)\}/g, (match, expression) => {
      const path = String(expression).trim();
      const stepRef = path.match(/^steps\.([^.]+)\.outputs\.([A-Za-z0-9_]+)$/);
      if (stepRef && outputs[stepRef[1]] !== undefined) return outputs[stepRef[1]];
      const varRef = path.match(/^variables\.([A-Za-z0-9_.]+)$/);
      if (varRef && variables[varRef[1]] !== undefined) return variables[varRef[1]];
      return match;
    });
  };
  const resolved: any = {};
  Object.entries(site.step.config?.params || {}).forEach(([key, value]) => {
    resolved[key] = resolve(value);
  });
  return resolved;
};

/** The probe step's value for a run: absent on the Support path, exact otherwise. */
const probeValue = (def: any, dispatchId?: string): string =>
  runNode(scriptOf(def, 'readProgrammeDispatch'), {
    DISPATCH_ID: dispatchId === undefined ? unset('input.dispatchId') : dispatchId,
  });

/**
 * Resolve the FALL-THROUGH site for a run whose own verdict is `runStatus` and
 * whose publish step produced `prUrl` (absent when no pull request was opened).
 * The three derived readers are the definition's own scripts.
 */
const resolveFallthroughParams = (
  def: any,
  dispatchId: string,
  run: { runStatus: string; prUrl?: string; reference?: string; verdict?: string; cycles?: string; prState?: string },
): any => {
  const site = sitesForPath(def, 'fallthrough')[0];
  if (!site) return null;
  const env: Record<string, string> = {
    RUN_STATUS: run.runStatus,
    PR_URL: run.prUrl === undefined ? unset('steps.readPrUrl.outputs.stdout') : run.prUrl,
    REF: run.reference === undefined ? unset('steps.loadTicket.result.reference') : run.reference,
    VERDICT: run.verdict === undefined ? 'pending' : run.verdict,
    CYCLES: run.cycles === undefined ? '0' : run.cycles,
    PR_STATE: run.prState === undefined ? 'unknown' : run.prState,
  };
  const outputs = {
    // The report's own dispatchId comes from the probe step, so resolve that first:
    // a run whose probe yields '' can never produce an attributable report.
    readProgrammeDispatch: probeValue(def, dispatchId),
    readProgrammeReportStatus: runNode(scriptOf(def, 'readProgrammeReportStatus'), env),
    readProgrammeReportPrUrl: runNode(scriptOf(def, 'readProgrammeReportPrUrl'), env),
    readProgrammeReportError: runNode(scriptOf(def, 'readProgrammeReportError'), env),
  };
  return resolveSiteParams(site, outputs);
};

/** Dispatch one package and return the dispatch id the child would have received. */
const dispatchPackage = async (): Promise<string> => {
  seedProgramme();
  const tick: any = await service.reconcile({ programmeId: PROGRAMME_ID, now: T0 });
  expect(tick.dispatched).toBe(1);
  return store.snapshot(PROGRAMME_ID)!.packages[0].dispatchId!;
};

const packageNow = () => store.snapshot(PROGRAMME_ID)!.packages[0];

const tempDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe('ProcessAITicket reporting bridge (1.4.8)', () => {
  const shipped = loadWorkflow();

  it('reports completed and the package SUCCEEDS end to end when the run finished with no pull request', async () => {
    const dispatchId = await dispatchPackage();

    const params = resolveFallthroughParams(shipped, dispatchId, { runStatus: 'completed' });
    expect(params).not.toBeNull();
    expect(params.status).toBe('completed');
    // There is genuinely nothing to merge, so it reports no prUrl — and invents no
    // merge SHA to claim a merge it cannot know about.
    expect(params.prUrl).toBe('');
    expect(params.error).toBe('');
    expect(params).not.toHaveProperty('mergedSha');

    const reported: any = await service.reportPackageOutcome(params);
    expect(reported.reported).toBe(true);
    expect(reported.state).toBe('succeeded');

    const pkg = packageNow();
    expect(pkg.state).toBe('succeeded');
    expect(pkg.outcomeSource).toBe('push');
    expect(pkg.prUrl).toBeUndefined();

    // The programme itself settles — the whole point of the ticket.
    await service.reconcile({ programmeId: PROGRAMME_ID, now: new Date(T0.getTime() + minutes(1)) });
    expect(store.snapshot(PROGRAMME_ID)!.state).toBe('completed');
  });

  it('reports the pull request url, and the package succeeds only once the merge is verified', async () => {
    const dispatchId = await dispatchPackage();
    const prUrl = 'https://github.com/reactorynet/reactory-reactor/pull/9';

    const params = resolveFallthroughParams(shipped, dispatchId, {
      runStatus: 'completed',
      prUrl,
      prState: 'OPEN',
    });
    expect(params.status).toBe('completed');
    expect(params.prUrl).toBe(prUrl);

    await service.reportPackageOutcome(params);
    expect(packageNow().state).toBe('running');
    expect(packageNow().status).toBe('awaiting_merge');

    service.ghVerifier = jest.fn(async () => ({ kind: 'merged', mergedSha: 'cafebabe', prUrl })) as any;
    await service.reconcile({ programmeId: PROGRAMME_ID, now: new Date(T0.getTime() + minutes(6)) });

    expect(packageNow().state).toBe('succeeded');
    expect(packageNow().mergedSha).toBe('cafebabe');
    expect(packageNow().outcomeSource).toBe('gh');
  });

  it('reports an ERROR, never a success, for a run that halted', async () => {
    const dispatchId = await dispatchPackage();

    const params = resolveFallthroughParams(shipped, dispatchId, {
      runStatus: 'blocked',
      // A leftover URL must not turn a halt into a completed report.
      prUrl: 'https://github.com/reactorynet/reactory-reactor/pull/11',
      prState: 'NOT_OPENED',
      reference: 'REF-1',
      verdict: 'rejected',
      cycles: '3',
    });

    expect(params.status).toBe('failed');
    expect(params.prUrl).toBe('');
    expect(params.error).toMatch(/runStatus 'blocked'/);
    expect(params.error).toMatch(/rejected/);

    await service.reportPackageOutcome(params);

    const pkg = packageNow();
    expect(pkg.state).toBe('failed');
    expect(pkg.status).toBe('failed');
    expect(pkg.lastError).toMatch(/runStatus 'blocked'/);
    expect(store.packageTransitions.map((entry) => entry.state)).not.toContain('succeeded');
  });

  // ── the two paths that ABORT the instance ────────────────────────────────
  // A step after a terminating step never runs, so these paths must report from
  // inside their own branch. Before 1.4.8 they reported nothing at all and were
  // failed as `child_terminated` with no reason.

  it('reports a publish-readiness block with the block detail, and the package FAILS with that reason', async () => {
    const dispatchId = await dispatchPackage();

    // Run the definition's own `describePublishBlock` against a worktree whose
    // publish-readiness record carries a detail, exactly as the workflow would.
    const worktree = tempDir('pa-publish-block-');
    fs.mkdirSync(path.join(worktree, '.ai-agent'), { recursive: true });
    const detail = 'the branch carries no commit that could be published (commitChanges reported nothing to commit)';
    fs.writeFileSync(
      path.join(worktree, '.ai-agent', 'publish-readiness.json'),
      JSON.stringify({ ready: false, detail }),
      'utf8',
    );
    const blockDetail = runNode(scriptOf(shipped, 'describePublishBlock'), { WT: worktree });
    expect(blockDetail).toBe(detail);

    const [site] = sitesForPath(shipped, 'publish_blocked');
    expect(site).toBeDefined();

    // The gate is authored BEFORE the halt that terminates the instance. Its own
    // sibling list is what matters: the report lives inside the gate's branch.
    const order = siblingOrder(shipped, site);
    expect(order.indexOf('publishBlockReportGate')).toBeGreaterThan(-1);
    expect(order.indexOf('publishBlockReportGate')).toBeLessThan(order.indexOf('publishBlockHalt'));

    const params = resolveSiteParams(site, { readProgrammeDispatch: probeValue(shipped, dispatchId), describePublishBlock: blockDetail });
    expect(params.status).toBe('failed');
    expect(params.dispatchId).toBe(dispatchId);
    expect(params.error).toBe(detail);
    expect(params).not.toHaveProperty('prUrl');

    const reported: any = await service.reportPackageOutcome(params);
    expect(reported.reported).toBe(true);

    const pkg = packageNow();
    expect(pkg.state).toBe('failed');
    expect(pkg.status).toBe('failed');
    expect(pkg.lastError).toBe(detail);
    // Not the reconciler's verdict, and not a success.
    expect(pkg.outcomeSource).toBe('push');
    expect(store.packageTransitions.map((entry) => entry.state)).not.toContain('succeeded');
  });

  it('reports a refused baseline as a readable error, and the package FAILS with that reason', async () => {
    const dispatchId = await dispatchPackage();

    const guard = {
      baselineReady: false,
      violations: ['src/modules/reactory-reactor is on feature/x', 'held by run ai-123'],
    };
    const summary = runNode(scriptOf(shipped, 'readProgrammeBaselineBlock'), {
      GUARD: JSON.stringify(guard),
    });
    expect(summary).toContain('primary-checkout baseline is not usable');
    expect(summary).toContain('is on feature/x');
    expect(summary).toContain('held by run ai-123');

    const [site] = sitesForPath(shipped, 'baseline_blocked');
    expect(site).toBeDefined();
    const order = siblingOrder(shipped, site);
    expect(order.indexOf('submoduleBaselineReportGate')).toBeLessThan(order.indexOf('submoduleBaselineHalt'));

    const params = resolveSiteParams(site, { readProgrammeDispatch: probeValue(shipped, dispatchId), readProgrammeBaselineBlock: summary });
    expect(params.status).toBe('failed');
    expect(params.error).toBe(summary);

    await service.reportPackageOutcome(params);

    const pkg = packageNow();
    expect(pkg.state).toBe('failed');
    expect(pkg.lastError).toContain('is on feature/x');
    expect(store.packageTransitions.map((entry) => entry.state)).not.toContain('succeeded');
  });

  it('a Support-path run (no dispatchId) never opens any gate and reports nothing', async () => {
    // The Support dispatcher sends no dispatchId, so the engine leaves the token in
    // place. A naive truthiness check would accept it; the probe must not.
    expect(probeValue(shipped)).toBe('');
    expect(probeValue(shipped, '')).toBe('');
    expect(probeValue(shipped, 'undefined')).toBe('');

    // Every report site sits inside a gate that compares THAT probe's stdout, so a
    // closed gate cannot reach any of them.
    reportSites(shipped).forEach((site) => {
      const gate = [...site.ancestors].reverse().find((a) => stepById(shipped, a.id).type === 'condition');
      expect(gate).toBeDefined();
      expect(String(stepById(shipped, gate!.id).config!.condition)).toBe(
        "steps.readProgrammeDispatch.stdout !== ''",
      );
    });

    // And the Support path's own outcome is unchanged: a child that completes
    // without reporting is still failed, not silently blessed.
    const dispatchId = await dispatchPackage();
    workflowService.getWorkflowHistoryById = jest.fn(async () => completedChildInstance(dispatchId));
    await service.reconcile({ programmeId: PROGRAMME_ID, now: new Date(T0.getTime() + minutes(46)) });

    expect(packageNow().state).toBe('failed');
    expect(packageNow().status).toBe('child_completed_unreported');
  });

  // ── falsification ────────────────────────────────────────────────────────
  // Driven through the DEFINITION, not through a helper flag: the counterfactual
  // removes the bridge from the graph, and the assertion is that the path then has
  // no report site at all — so a silent child is failed, as it must be.

  it('FALSIFICATION: deleting a path\'s report gate leaves it unreported and the package fails', async () => {
    // Sanity: the shipped definition DOES cover both halting paths.
    expect(sitesForPath(shipped, 'publish_blocked')).toHaveLength(1);
    expect(sitesForPath(shipped, 'baseline_blocked')).toHaveLength(1);
    expect(sitesForPath(shipped, 'fallthrough')).toHaveLength(1);

    // Damage a COPY the way an incomplete backport would: the halt still halts,
    // but nothing reports on the path that reaches it.
    const damaged = loadWorkflow((def) => {
      const gate = collectSites(def).find((site) => site.step.id === 'publishReadinessGate')!;
      gate.step.config.elseSteps = gate.step.config.elseSteps.filter(
        (step: IWorkflowStep) => step.id !== 'publishBlockReportGate',
      );
      // The end-of-run gate cannot cover it either: the halt terminates first.
      def.steps = def.steps.filter((step: IWorkflowStep) => step.id !== 'programmeOutcomeGate');
    });

    expect(sitesForPath(damaged, 'publish_blocked')).toEqual([]);
    expect(sitesForPath(damaged, 'fallthrough')).toEqual([]);
    // The halt is still there — deleting the bridge changed nothing about stopping.
    expect(stepById(damaged, 'publishBlockHalt')).toBeDefined();

    // A programme-dispatched child that ends silently is FAILED, with the accurate
    // reason. This is the behaviour the bridge removes and the refusal that must
    // survive it.
    const dispatchId = await dispatchPackage();
    workflowService.getWorkflowHistoryById = jest.fn(async () => completedChildInstance(dispatchId));
    const tick: any = await service.reconcile({
      programmeId: PROGRAMME_ID,
      now: new Date(T0.getTime() + minutes(46)),
    });

    const pkg = packageNow();
    expect(pkg.state).toBe('failed');
    expect(pkg.status).toBe('child_completed_unreported');
    expect(pkg.outcomeSource).toBe('reconciler');
    expect(pkg.lastError).toMatch(/completed without reporting an outcome/);
    expect(store.packageTransitions.map((entry) => entry.state)).not.toContain('succeeded');
    expect(tick.ticks[0].settled).toBe('failed');
  });
});
