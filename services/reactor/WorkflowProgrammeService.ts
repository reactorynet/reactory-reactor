import Reactory from '@reactorynet/reactory-core';
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { service } from '@reactory/server-core/application/decorators/service';
import WorkflowProgrammeModel, {
  IProgrammePackage,
  IWorkflowProgramme,
  IWorkflowProgrammeDocument,
  PackageState,
  ProgrammeState,
} from '../../models/WorkflowProgramme';
import { hasAdministrativeRole, isSystemIdentity } from './identity';
import {
  defaultProgrammeStore,
  IProgrammeQuery,
  IProgrammeStore,
} from './workflowProgramme/ProgrammeStore';

/**
 * reactor.WorkflowProgrammeService@1.0.0
 *
 * The decision logic behind the programme reconciler. See
 * `models/WorkflowProgramme.ts` for the state model and
 * `workflow/WorkflowProgrammeReconciler.yaml` for the durable 60s tick.
 *
 * ── Why a service, not YAML ──────────────────────────────────────────────────
 *
 * A reconciler is a compare-and-set state machine: claim package → start child →
 * adopt instance → observe → settle. YAML has no vocabulary for "update this
 * subdocument only if it still says `ready` and has never been dispatched", and a
 * YAML `invoke_workflow(waitForCompletion: true)` is exactly the duplicating
 * parent pattern this feature replaces. Keeping the decisions here also makes
 * every acceptance criterion testable without a workflow engine.
 *
 * ── The three properties the design depends on ───────────────────────────────
 *
 * 1. **Idempotency is a predicate, not a lock.** `dispatchReadyPackages` claims a
 *    package with one conditional write. `null` means another tick won, which is
 *    success. Two concurrent ticks therefore start exactly one child.
 *
 * 2. **Recovery is by `dispatchId`, never heuristic.** The dispatch id is minted
 *    BEFORE the child is started and passed INTO it as input, so a crash between
 *    "start" and "adopt the instance id" is repaired by looking the child up by
 *    that exact value. A `startWorkflow` that threw is deliberately NOT re-armed
 *    in the catch block: it may still have created a child, and re-arming there
 *    is precisely the duplicate-child bug.
 *
 * 3. **Push, then verify.** Children write their own outcome; the tick reads Mongo
 *    in the common case and only shells out to `gh` for a package whose child
 *    claims success without a merge SHA. A transient `gh` failure is recorded and
 *    never blocks a wave.
 *
 * Pause/abort are document state only: pause does not touch in-flight children,
 * and both require a real person (the owner or an admin), never the system user.
 */

/** The durable tick. One instance per minute; see the schedule file. */
export const PROGRAMME_RECONCILER_WORKFLOW_ID = 'reactor.WorkflowProgrammeReconciler@1.0.0';

/** The communicator's public send entry point (best-effort, like continuations). */
export const COMMUNICATOR_SERVICE_ID = 'communicator.CommunicatorService@1.0.0';

/** The core workflow service used to start/observe/cancel children. */
export const WORKFLOW_SERVICE_ID = 'core.ReactoryWorkflowService@1.0.0';

/** The child workflow an AI engineering package is dispatched to by default. */
export const DEFAULT_CHILD_WORKFLOW_ID = 'core.ProcessAITicket@1.4.7';

/** A running package silent for this long is a stall. */
export const DEFAULT_SLA_MINUTES = 45;

/** Dispatch attempts + stall escalations before a package is failed. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Lease shorter than the tick interval, so a crashed tick is recovered next tick. */
export const DEFAULT_LEASE_MS = 55_000;

/** A `dispatching` package older than this with no child found is re-armed. */
export const DEFAULT_DISPATCH_STALE_MS = 120_000;

/** Children started per programme per tick. */
export const DEFAULT_MAX_DISPATCHES_PER_TICK = 4;

/** External `gh` calls per programme per tick. */
export const DEFAULT_MAX_VERIFICATIONS_PER_TICK = 3;

/** Minimum gap between two `gh` verifications of the same package. */
export const DEFAULT_VERIFICATION_INTERVAL_MS = 5 * 60_000;

/** Instances per history page when looking a child up by dispatch id. */
export const HISTORY_PAGE_SIZE = 200;

/** How many history pages one lookup may walk. Bounded on purpose. */
export const HISTORY_MAX_PAGES = 5;

/** Skew margin applied to `createdAfter` when bounding the history window. */
export const HISTORY_SKEW_MS = 5 * 60_000;

/** Hard bound on a `gh` call: a hung CLI must not hold the tick's lease. */
export const GH_TIMEOUT_MS = 20_000;

/** Packages that never change again. */
export const TERMINAL_PACKAGE_STATES: PackageState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
];

/** Package states that mean a child may still be running. */
export const LIVE_PACKAGE_STATES: PackageState[] = ['dispatching', 'running'];

export const isTerminalPackageState = (state: PackageState): boolean =>
  TERMINAL_PACKAGE_STATES.includes(state);

// ── pure helpers (exported so the tests describe behaviour, not internals) ────

/**
 * Treat a value as "absent" when it is empty, the literal strings `undefined` /
 * `null`, or an UNRESOLVED YAML template token.
 *
 * The last case matters: `service_invoke` leaves an unresolvable `${input.x}` as
 * the original token, so a naive `String(value)` would try to look up a programme
 * literally named `${input.programmeId}`.
 */
export function sanitiseOptionalString(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text === 'undefined' || text === 'null') return undefined;
  if (/^\$\{[^}]*\}$/.test(text)) return undefined;
  return text;
}

export function toFiniteNumber(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function clampNumber(value: any, min: number, max: number, fallback: number): number {
  const number = toFiniteNumber(value);
  if (number === undefined) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** Map a child-reported status onto the three values the reconciler understands. */
export function normaliseChildStatus(raw: any): 'completed' | 'failed' | 'running' | undefined {
  const text = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[\s_-]+/g, '_');
  if (!text) return undefined;
  if (['completed', 'complete', 'done', 'finished', 'success', 'succeeded', 'merged'].includes(text)) {
    return 'completed';
  }
  if (['failed', 'fail', 'error', 'errored', 'broken', 'aborted', 'cancelled'].includes(text)) {
    return 'failed';
  }
  if (['running', 'in_progress', 'working', 'dispatched', 'awaiting_merge', 'pending', 'started'].includes(text)) {
    return 'running';
  }
  return undefined;
}

export type DependencyVerdict = 'satisfied' | 'waiting' | 'blocked';

/** Whether a package's dependencies allow it to run, forbid it, or are still moving. */
export function dependencyVerdict(
  pkg: Pick<IProgrammePackage, 'dependsOn'>,
  byId: Map<string, Pick<IProgrammePackage, 'id' | 'state'>>,
): DependencyVerdict {
  const dependencies = (pkg.dependsOn || []).map((id) => byId.get(id));
  // An unknown dependency can never be satisfied. Validation rejects this at
  // creation, but a hand-edited document must fail closed rather than dispatch work
  // whose prerequisite does not exist.
  if (dependencies.some((dep) => !dep)) return 'blocked';
  if (dependencies.some((dep) => ['failed', 'blocked', 'cancelled'].includes(dep!.state))) return 'blocked';
  if (dependencies.every((dep) => dep!.state === 'succeeded')) return 'satisfied';
  return 'waiting';
}

/**
 * The programme verdict when no package can make further progress.
 *
 * `null` means "still running" — the caller must not settle. A single failed
 * package does NOT fail a programme while an independent branch is still working:
 * a failed engineering run needs a human, but the rest of the wave is still useful.
 */
export function summariseProgrammeOutcome(
  packages: Pick<IProgrammePackage, 'state'>[],
): 'completed' | 'failed' | 'aborted' | null {
  if (!Array.isArray(packages) || packages.length === 0) return 'failed';
  const remaining = packages.filter((pkg) => !isTerminalPackageState(pkg.state));
  const anyFailure = packages.some((pkg) => pkg.state === 'failed' || pkg.state === 'blocked');

  if (remaining.length === 0) {
    if (anyFailure) return 'failed';
    if (packages.every((pkg) => pkg.state === 'succeeded')) return 'completed';
    if (packages.every((pkg) => pkg.state === 'cancelled')) return 'aborted';
    return 'failed';
  }

  const actionable = remaining.some((pkg) => ['ready', 'dispatching', 'running'].includes(pkg.state));
  if (!actionable && anyFailure) return 'failed';
  return null;
}

/**
 * Validate a package graph before anything is persisted.
 *
 * A dependency cycle is fatal rather than "eventually blocked": blocked is a
 * terminal state a human must resolve, and a cycle would produce a programme that
 * silently never dispatches its last packages.
 */
export function validateProgrammePackages(
  packages: Array<Pick<IProgrammePackage, 'id' | 'dependsOn'>>,
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(packages) || packages.length === 0) {
    return ['at least one package is required'];
  }

  const ids = new Set<string>();
  packages.forEach((pkg) => {
    const id = String(pkg?.id || '').trim();
    if (!id) {
      errors.push('every package needs a non-empty id');
      return;
    }
    if (ids.has(id)) errors.push(`duplicate package id "${id}"`);
    ids.add(id);
  });

  packages.forEach((pkg) => {
    const id = String(pkg?.id || '').trim();
    (pkg?.dependsOn || []).forEach((dep) => {
      if (dep === id) errors.push(`package "${id}" depends on itself`);
      else if (!ids.has(dep)) errors.push(`package "${id}" depends on unknown package "${dep}"`);
    });
  });

  // Depth-first cycle detection over the declared edges.
  const colour = new Map<string, 'white' | 'grey' | 'black'>();
  const byId = new Map(packages.map((pkg) => [String(pkg.id), pkg]));
  const visit = (id: string, path: string[]): void => {
    const state = colour.get(id) || 'white';
    if (state === 'black') return;
    if (state === 'grey') {
      const cycleStart = path.indexOf(id);
      const cycle = [...path.slice(cycleStart === -1 ? 0 : cycleStart), id];
      errors.push(`dependency cycle: ${cycle.join(' → ')}`);
      return;
    }
    colour.set(id, 'grey');
    const pkg = byId.get(id);
    (pkg?.dependsOn || []).forEach((dep) => {
      if (byId.has(dep)) visit(dep, [...path, id]);
    });
    colour.set(id, 'black');
  };
  Array.from(ids).forEach((id) => visit(id, []));

  return errors;
}

/**
 * Workflow engine statuses (`WorkflowESStatus`): 0 Runnable, 1 Suspended,
 * 2 Complete, 3 Terminated, 4 DeadLettered.
 */
export const CHILD_ALIVE_STATUSES = [0, 1];

/** Map a child instance status onto what the reconciler may conclude from it. */
export function classifyChildStatus(
  status: any,
): 'alive' | 'complete' | 'terminated' | 'unknown' {
  if (status === undefined || status === null || status === '') return 'unknown';
  const numeric = Number(status);
  if (Number.isFinite(numeric)) {
    if (CHILD_ALIVE_STATUSES.includes(numeric)) return 'alive';
    if (numeric === 2) return 'complete';
    if (numeric === 3 || numeric === 4) return 'terminated';
    return 'unknown';
  }
  const text = String(status).trim().toLowerCase();
  if (['runnable', 'running', 'suspended', 'pending', '1', '0'].includes(text)) return 'alive';
  if (['complete', 'completed', '2'].includes(text)) return 'complete';
  if (['terminated', '3', 'deadlettered', 'dead_lettered', '4'].includes(text)) return 'terminated';
  return 'unknown';
}

/** Packages with no dependencies are ready immediately; everything else waits. */
export function initialPackageState(pkg: { dependsOn?: string[] }): PackageState {
  return (pkg?.dependsOn || []).length === 0 ? 'ready' : 'pending';
}

export function mintDispatchId(programmeId: string, packageId: string): string {
  return `${programmeId}:${packageId}:${randomBytes(16).toString('hex')}`;
}

// ── types ────────────────────────────────────────────────────────────────────

export interface IProgrammePackageInput {
  id: string;
  title?: string;
  dependsOn?: string[];
  /** Extra child-workflow input for this package. */
  input?: Record<string, any>;
  notes?: string;
}

export interface ICreateProgrammeInput {
  programmeId?: string;
  name: string;
  description?: string;
  childWorkflowId?: string;
  childInputDefaults?: Record<string, any>;
  slaMinutes?: number;
  maxAttempts?: number;
  packages: IProgrammePackageInput[];
}

export interface IProgrammeControlInput {
  programmeId: string;
  reason?: string;
}

export interface IReportPackageOutcomeInput {
  dispatchId: string;
  status?: string;
  prUrl?: string;
  mergedSha?: string;
  error?: string;
  notes?: string;
}

export interface IReconcileInput {
  programmeId?: string;
  limit?: number;
  /** A `dispatching` package older than this with no child is re-armed. */
  staleMs?: number;
  leaseMs?: number;
  maxDispatchesPerTick?: number;
  maxVerificationsPerTick?: number;
  verificationIntervalMs?: number;
  now?: Date | string;
}

export interface IProgrammeTickResult {
  programmeId: string;
  /** `leased` means another tick owns this programme — success, not an error. */
  outcome: 'leased' | 'skipped' | 'idle' | 'advanced' | 'settled' | 'error';
  state: ProgrammeState;
  adopted: number;
  redispatched: number;
  blocked: number;
  dispatched: number;
  verified: number;
  stalled: number;
  settled?: 'completed' | 'failed' | 'aborted';
  /** Present only when `outcome === 'error'`: the message persisted on the programme. */
  error?: string;
}

export interface IReconcileResult {
  now: string;
  programmes: number;
  dispatched: number;
  adopted: number;
  verified: number;
  stalled: number;
  settled: number;
  /** Programmes whose tick threw. Isolated per programme; never fatal to the pass. */
  errors: number;
  ticks: IProgrammeTickResult[];
}

export interface IProgrammeView {
  programmeId: string;
  name: string;
  description?: string;
  state: ProgrammeState;
  ownerEmail: string;
  childWorkflowId: string;
  slaMinutes: number;
  maxAttempts: number;
  counts: Record<string, number>;
  packages: Array<Record<string, any>>;
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
  pausedAt?: Date;
  abortedAt?: Date;
  notificationChannel?: string;
  notifiedEvent?: string;
}

export interface IControlResult {
  paused?: boolean;
  resumed?: boolean;
  aborted?: boolean;
  state?: ProgrammeState;
  reason?: string;
  code?: string;
  runningPackages?: number;
  cancelled?: number;
  cancelFailures?: number;
  /**
   * Packages that were mid-dispatch when the abort ran: a child MAY have been
   * starting and could not be seen yet.
   *
   * Reported separately from `cancelFailures` because nothing had failed — the
   * uncertainty is real but it is not an error, and the dispatch path cancels any
   * child it manages to start (see `dispatchReadyPackages`). Without it, an abort
   * that raced a start would look like a clean cancel of something nobody looked at.
   */
  pendingDispatch?: number;
  notificationChannel?: string;
}

export interface IReportPackageOutcomeResult {
  reported: boolean;
  reason?: string;
  programmeId?: string;
  packageId?: string;
  state?: PackageState;
  awaitingVerification?: boolean;
}

type GhVerdict =
  | { kind: 'merged'; mergedSha?: string; prUrl?: string }
  | { kind: 'closed'; prUrl?: string }
  | { kind: 'open'; prUrl?: string }
  | { kind: 'error'; error: string }
  | { kind: 'skipped' };

export interface ITickOptions {
  now: Date;
  staleMs: number;
  leaseMs: number;
  maxDispatchesPerTick: number;
  maxVerificationsPerTick: number;
  verificationIntervalMs: number;
}

/**
 * Default `gh` runner, promisified ONCE at module load.
 *
 * Kept as a module-level constant and exposed as the `ghExec` field so the real
 * `ghVerifier` body (argv construction, URL guard, JSON parse, state mapping) can
 * be exercised by a test without a live GitHub CLI — and so a test that replaces
 * it replaces the whole adapter, not a piece of it.
 */
const defaultGhExec = promisify(execFile);

/** Materialise a document (or a plain snapshot) into the shape the helpers need. */
const asPlain = (doc: any): IWorkflowProgramme =>
  typeof doc?.toObject === 'function' ? doc.toObject({ depopulate: true }) : (doc as IWorkflowProgramme);

export function toProgrammeView(doc: any): IProgrammeView {
  const programme = asPlain(doc);
  const counts: Record<string, number> = {};
  (programme.packages || []).forEach((pkg) => {
    counts[pkg.state] = (counts[pkg.state] || 0) + 1;
  });
  return {
    programmeId: programme.programmeId,
    name: programme.name,
    description: programme.description,
    state: programme.state,
    ownerEmail: programme.ownerEmail,
    childWorkflowId: programme.childWorkflowId,
    slaMinutes: programme.slaMinutes,
    maxAttempts: programme.maxAttempts,
    counts,
    packages: (programme.packages || []).map((pkg) => ({
      id: pkg.id,
      title: pkg.title,
      dependsOn: pkg.dependsOn || [],
      state: pkg.state,
      attempt: pkg.attempt,
      dispatchId: pkg.dispatchId,
      childInstanceId: pkg.childInstanceId,
      dispatchedAt: pkg.dispatchedAt,
      lastProgressAt: pkg.lastProgressAt,
      completedAt: pkg.completedAt,
      prUrl: pkg.prUrl,
      mergedSha: pkg.mergedSha,
      status: pkg.status,
      outcomeSource: pkg.outcomeSource,
      lastError: pkg.lastError,
    })),
    createdAt: programme.createdAt,
    updatedAt: programme.updatedAt,
    completedAt: programme.completedAt,
    pausedAt: programme.pausedAt,
    abortedAt: programme.abortedAt,
    notificationChannel: programme.notificationChannel,
    notifiedEvent: programme.notifiedEvent,
  };
}

/**
 * Result of an authorisation check. One flat shape, so callers can read `code` and
 * `error` without relying on discriminated-union narrowing.
 */
interface IAuthorisationResult {
  ok: boolean;
  code?: string;
  error?: string;
  user?: any;
}

/**
 * `lifeCycle` stays at the decorator default (`instance`) so the service is built
 * with the context that resolves it. That is what lets the tick hold the
 * reconciler instance's identity while child dispatch is deliberately performed
 * under the PROGRAMME OWNER's rebuilt context (see `dispatchContext`).
 */
@service({
  id: 'reactor.WorkflowProgrammeService@1.0.0',
  name: 'Workflow Programme Service',
  nameSpace: 'reactor',
  version: '1.0.0',
  description:
    'Dependency-graph programme reconciler: dispatches ready packages exactly once, adopts children by dispatch id, verifies pushed outcomes, and settles the programme.',
  serviceType: 'data',
})
class WorkflowProgrammeService {
  context: Reactory.Server.IReactoryContext;

  nameSpace = 'reactor';
  name = 'Workflow Programme Service';
  version = '1.0.0';
  tags: string[] = ['reactor', 'workflow', 'programme', 'reconciler', 'orchestration'];

  /** Persistence. Tests assign an in-memory implementation. */
  store: IProgrammeStore = defaultProgrammeStore;

  /** `gh` runner. Tests assign a fake so the adapter body runs for real. */
  ghExec: (file: string, args: string[], options?: any) => Promise<{ stdout?: any; stderr?: any }> =
    defaultGhExec as any;

  /**
   * Looks up a child instance by the dispatch id threaded into its input. Overridable
   * so crash-recovery can be tested without a workflow engine.
   */
  async findChildByDispatchId(
    dispatchId: string,
    programme: IWorkflowProgramme,
    pkg?: Pick<IProgrammePackage, 'childWorkflowId' | 'dispatchedAt'>,
  ): Promise<{ id?: string; instanceId?: string; status?: any; data?: any } | undefined> {
    const workflowService = this.getWorkflowService();
    if (!workflowService || typeof workflowService.getWorkflowHistory !== 'function') return undefined;

    // The DISPATCH may have used a package-level override (see `startChild`), so
    // recovery must search the same definition the child was started under.
    // Searching the programme default instead would never find the child, re-arm
    // after `staleMs` and start a SECOND one — the duplicate this exists to stop.
    const childWorkflowId =
      sanitiseOptionalString(pkg?.childWorkflowId) ||
      sanitiseOptionalString(programme.childWorkflowId) ||
      DEFAULT_CHILD_WORKFLOW_ID;

    // Bound the window with the dispatch's own timestamp: "the newest 200 instances
    // of this definition" misses an older dispatch on a busy tenant, and a miss means
    // a re-arm and therefore a SECOND child — the duplicate this exists to prevent. A
    // small skew margin covers clock and insert-order differences.
    const filter: Record<string, any> = { workflowDefinitionId: childWorkflowId };
    const dispatchedAt = pkg?.dispatchedAt ? new Date(pkg.dispatchedAt).getTime() : NaN;
    if (Number.isFinite(dispatchedAt)) {
      filter.createdAfter = new Date(dispatchedAt - HISTORY_SKEW_MS);
    }

    for (let page = 1; page <= HISTORY_MAX_PAGES; page += 1) {
      const result: any = await workflowService.getWorkflowHistory(filter, {
        page,
        limit: HISTORY_PAGE_SIZE,
        sortField: 'createTime',
        sortOrder: 'desc',
      });
      const instances: any[] = result?.instances || [];
      const match = instances.find(
        (item) => String(item?.data?.inputs?.dispatchId || '') === String(dispatchId),
      );
      if (match) return match;
      // A short page is the last page; paginating past it would burn queries per tick.
      if (instances.length < HISTORY_PAGE_SIZE) break;
    }
    return undefined;
  }

  /** Starts one child. Overridable in tests. */
  async startChild(
    programme: IWorkflowProgramme,
    pkg: IProgrammePackage,
    dispatchId: string,
  ): Promise<any> {
    const context = await this.dispatchContext(programme);
    const workflowService = this.getServiceFrom(context, WORKFLOW_SERVICE_ID);
    if (!workflowService || typeof workflowService.startWorkflow !== 'function') {
      throw new Error(`${WORKFLOW_SERVICE_ID} is unavailable`);
    }
    const input: Record<string, any> = {
      ...(programme.childInputDefaults || {}),
      ...(pkg.input || {}),
      // Threaded INTO the child so the next tick can find it by this exact value.
      dispatchId,
      programmeId: programme.programmeId,
      packageId: pkg.id,
    };
    return workflowService.startWorkflow(
      pkg.childWorkflowId || programme.childWorkflowId || DEFAULT_CHILD_WORKFLOW_ID,
      { input },
    );
  }

  /**
   * Reads a child INSTANCE's own status. Overridable in tests.
   *
   * This is the difference between "the package has not reported" and "the child is
   * dead": without it, a healthy 12-hour `core.ProcessAITicket` run was escalated as
   * "gone silent" at 45/90/135 minutes and failed at ~180 while still working.
   */
  async childStatusLookup(instanceId: string): Promise<{ status?: any; statusLabel?: string } | undefined> {
    const workflowService = this.getWorkflowService();
    if (!workflowService || typeof workflowService.getWorkflowHistoryById !== 'function') return undefined;
    const item: any = await workflowService.getWorkflowHistoryById(instanceId);
    return item || undefined;
  }

  /** Reads a PR's merged state. Overridable; production shells out to `gh`. */
  async ghVerifier(pkg: IProgrammePackage, _programme: IWorkflowProgramme): Promise<GhVerdict> {
    const prUrl = String(pkg?.prUrl || '').trim();
    if (!prUrl) return { kind: 'skipped' };
    // Only URLs, and only as a single argv entry: `execFile` does not involve a
    // shell, and the value came from a child report so it must not be trusted to
    // start with `--`.
    if (!/^https?:\/\//i.test(prUrl)) return { kind: 'error', error: 'prUrl is not an http(s) URL' };
    try {
      const { stdout } = await this.ghExec(
        'gh',
        ['pr', 'view', prUrl, '--json', 'state,mergeCommit,mergedAt,url,number'],
        { timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      const parsed = JSON.parse(String(stdout || '{}'));
      const state = String(parsed.state || '').toUpperCase();
      if (state === 'MERGED') {
        return {
          kind: 'merged',
          mergedSha: sanitiseOptionalString(parsed?.mergeCommit?.oid),
          prUrl: sanitiseOptionalString(parsed.url) || prUrl,
        };
      }
      if (state === 'CLOSED') return { kind: 'closed', prUrl };
      return { kind: 'open', prUrl };
    } catch (error: any) {
      return { kind: 'error', error: error?.message || String(error) };
    }
  }

  /**
   * Rebuilds the PROGRAMME OWNER's context for a dispatch, so the child workflow
   * (and every chat session / task it creates) belongs to the person who created
   * the programme rather than to the reconciler's system identity.
   *
   * Falls back to the current context when no owner email is recorded — the tick
   * must still dispatch, and the child's own identity checks remain in force.
   */
  async ownerContextBuilder(identity: {
    userEmail?: string;
    partnerKey?: string;
  }): Promise<Reactory.Server.IReactoryContext | undefined> {
    if (!identity?.userEmail) return undefined;
    const { createWorkflowContext } = await import(
      '@reactory/server-modules/reactory-core/workflow/YamlFlow/execution/YamlFlowRuntime'
    );
    return createWorkflowContext(identity);
  }

  constructor(_props?: Reactory.Service.IReactoryServiceProps, context?: Reactory.Server.IReactoryContext) {
    this.context = context as Reactory.Server.IReactoryContext;
  }

  toString(includeVersion?: boolean): string {
    return `WorkflowProgrammeService${includeVersion ? '@1.0.0' : ''}`;
  }

  /** The schedule id whose presence this service verifies at startup. */
  static readonly SCHEDULE_ID = 'reactor.workflowprogrammereconciler-1.0.0';

  /**
   * Startup check: warn (never throw) when the 60-second schedule is not installed
   * where the Scheduler actually reads it.
   *
   * The module ships a reviewable copy under `workflow/schedules/`, but the
   * Scheduler loads `<APP_DATA_ROOT>/workflows/schedules` and nothing copies files
   * there. On a fresh deployment the tick would therefore never run and nothing
   * would say so — which is precisely the kind of silence this feature exists to
   * remove. A warning is the honest signal: the rest of the module still starts.
   */
  async onStartup(): Promise<any> {
    // Mirrors the Scheduler's own resolution (`process.env.APP_DATA_ROOT || './data'`)
    // so this check can never disagree with where the tick actually looks. The
    // previous version returned "not checked" when neither variable was set — in
    // exactly the configuration where the warning mattered most.
    const roots = [
      String(process.env.APP_DATA_ROOT || './data').trim(),
      String(process.env.REACTORY_DATA || '').trim(),
    ].filter((value) => !!value);

    const filename = `${WorkflowProgrammeService.SCHEDULE_ID}-schedule.yaml`;
    for (const root of roots) {
      const file = path.join(root, 'workflows', 'schedules', filename);
      if (fs.existsSync(file)) return { scheduleChecked: true, scheduleInstalled: true, file };
    }

    this.log(
      'warn',
      'workflow programme reconciler schedule is NOT installed; the 60s tick will not run. ' +
        `Copy workflow/schedules/${filename} to <APP_DATA_ROOT>/workflows/schedules/`,
      { searchedRoots: roots, filename },
    );
    return { scheduleChecked: true, scheduleInstalled: false };
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Create a programme. Owner-scoped; every package starts per its dependencies. */
  async createProgramme(input: ICreateProgrammeInput): Promise<any> {
    const user: any = (this.context as any)?.user;
    if (!user?._id) return { created: false, code: 'no_identity', error: 'A signed-in user is required.' };
    if (isSystemIdentity(user)) {
      return {
        created: false,
        code: 'system_caller',
        error: 'The system account cannot own a programme: pause/abort must name a person.',
      };
    }

    const name = sanitiseOptionalString(input?.name);
    if (!name) return { created: false, code: 'invalid_name', error: '`name` is required.' };

    const requestedId = sanitiseOptionalString(input?.programmeId);
    const programmeId = requestedId || this.deriveProgrammeId(name);
    if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(programmeId)) {
      return {
        created: false,
        code: 'invalid_programme_id',
        error: '`programmeId` must be 3-80 characters of letters, digits, dot, underscore or hyphen.',
      };
    }

    const packages: IProgrammePackageInput[] = Array.isArray(input?.packages) ? input.packages : [];
    const errors = validateProgrammePackages(
      packages.map((pkg) => ({ id: String(pkg?.id || ''), dependsOn: pkg?.dependsOn || [] })),
    );
    if (errors.length > 0) {
      return { created: false, code: 'invalid_packages', error: errors.join('; '), errors };
    }

    if (await this.store.findByProgrammeId(programmeId)) {
      return {
        created: false,
        code: 'duplicate',
        error: `A programme with id "${programmeId}" already exists.`,
      };
    }

    const now = new Date();
    const doc = await this.store.create({
      programmeId,
      name,
      description: sanitiseOptionalString(input?.description),
      state: 'active',
      ownerUserId: user._id,
      ownerEmail: String(user.email || ''),
      partnerKey: (this.context as any)?.partner?.key,
      childWorkflowId: sanitiseOptionalString(input?.childWorkflowId) || DEFAULT_CHILD_WORKFLOW_ID,
      childInputDefaults: input?.childInputDefaults,
      slaMinutes: clampNumber(input?.slaMinutes, 1, 24 * 60, DEFAULT_SLA_MINUTES),
      maxAttempts: clampNumber(input?.maxAttempts, 1, 20, DEFAULT_MAX_ATTEMPTS),
      packages: packages.map((pkg) => ({
        id: String(pkg.id).trim(),
        title: sanitiseOptionalString(pkg.title) || String(pkg.id),
        dependsOn: (pkg.dependsOn || []).map((dep) => String(dep)),
        state: initialPackageState(pkg),
        attempt: 0,
        stallCount: 0,
        input: pkg.input,
        notes: sanitiseOptionalString(pkg.notes),
        lastProgressAt: now,
      })),
      lastProgressAt: now,
    } as any);

    this.log('info', 'programme created', {
      programmeId,
      packages: packages.length,
      childWorkflowId: (doc as any).childWorkflowId,
    });

    return { created: true, programme: toProgrammeView(doc) };
  }

  /** Read one programme. Owners and admins only; the system identity may read. */
  async getProgramme(input: { programmeId: string }): Promise<any> {
    const programmeId = sanitiseOptionalString(input?.programmeId);
    if (!programmeId) return { found: false, code: 'invalid_programme_id', error: '`programmeId` is required.' };
    const doc = await this.store.findByProgrammeId(programmeId);
    if (!doc) return { found: false, code: 'not_found', error: `No programme "${programmeId}".` };
    const auth = this.authoriseRead(doc);
    if (!auth.ok) return { found: false, code: auth.code, error: auth.error };
    return { found: true, programme: toProgrammeView(doc) };
  }

  /** List programmes visible to the caller (own, or all for an admin). */
  async listProgrammes(input: { state?: ProgrammeState; limit?: number } = {}): Promise<any> {
    const state = sanitiseOptionalString(input?.state) as ProgrammeState | undefined;
    const user: any = (this.context as any)?.user;
    const isAdmin = hasAdministrativeRole(this.context);
    const limit = clampNumber(input?.limit, 1, 200, 25);

    const query: IProgrammeQuery = {};
    if (state) query.state = state;
    if (!isAdmin) {
      if (!user?._id) return { programmes: [], total: 0, code: 'no_identity' };
      // Filtered IN THE QUERY (the model indexes { ownerUserId, state }): slicing a
      // global page and then filtering would hide a user's own older programmes
      // behind everyone else's.
      query.ownerUserId = String(user._id);
      const owned = await this.store.findMany(query, limit);
      return { programmes: owned.map(toProgrammeView), total: owned.length };
    }
    const docs = await this.store.findMany(query, limit);
    return { programmes: docs.map(toProgrammeView), total: docs.length };
  }

  /**
   * Pause new dispatch. Running children are left COMPLETELY untouched: a pause is
   * a statement about the programme's next step, not a kill switch.
   */
  async pause(input: IProgrammeControlInput): Promise<IControlResult> {
    const programmeId = sanitiseOptionalString(input?.programmeId);
    if (!programmeId) return { paused: false, code: 'invalid_programme_id', reason: '`programmeId` is required.' };
    const doc = await this.store.findByProgrammeId(programmeId);
    if (!doc) return { paused: false, code: 'not_found', reason: `No programme "${programmeId}".` };

    const auth = this.authoriseControl(doc);
    if (!auth.ok) return { paused: false, code: auth.code, reason: auth.error };

    const state = (doc as any).state as ProgrammeState;
    if (state !== 'active') {
      return { paused: false, code: 'invalid_state', reason: `Cannot pause a ${state} programme.` };
    }

    const user: any = (this.context as any).user;
    const updated = await this.store.transitionProgramme({
      programmeId,
      expectStates: ['active'],
      set: {
        state: 'paused',
        pausedAt: new Date(),
        pausedByUserId: String(user._id),
        pausedByEmail: String(user.email || ''),
        pauseReason: sanitiseOptionalString(input?.reason),
      },
    });
    if (!updated) {
      return { paused: false, code: 'raced', reason: 'Another caller changed the programme first; re-read and retry.' };
    }
    const runningPackages = (updated as any).packages.filter((pkg: IProgrammePackage) =>
      LIVE_PACKAGE_STATES.includes(pkg.state),
    ).length;
    this.log('info', 'programme paused (in-flight children untouched)', {
      programmeId,
      by: String(user._id),
      runningPackages,
    });
    return { paused: true, state: 'paused', runningPackages };
  }

  /** Resume from ACTUAL state: no package is re-dispatched; the next tick reads the graph. */
  async resume(input: IProgrammeControlInput): Promise<IControlResult> {
    const programmeId = sanitiseOptionalString(input?.programmeId);
    if (!programmeId) return { resumed: false, code: 'invalid_programme_id', reason: '`programmeId` is required.' };
    const doc = await this.store.findByProgrammeId(programmeId);
    if (!doc) return { resumed: false, code: 'not_found', reason: `No programme "${programmeId}".` };

    const auth = this.authoriseControl(doc);
    if (!auth.ok) return { resumed: false, code: auth.code, reason: auth.error };

    const state = (doc as any).state as ProgrammeState;
    if (state !== 'paused') return { resumed: false, code: 'invalid_state', reason: `Cannot resume a ${state} programme.` };

    const user: any = (this.context as any).user;
    const updated = await this.store.transitionProgramme({
      programmeId,
      expectStates: ['paused'],
      set: {
        state: 'active',
        resumedAt: new Date(),
        resumedByUserId: String(user._id),
      },
      unset: ['pauseReason'],
    });
    if (!updated) {
      return { resumed: false, code: 'raced', reason: 'Another caller changed the programme first; re-read and retry.' };
    }
    this.log('info', 'programme resumed from actual state', { programmeId, by: String(user._id) });
    return { resumed: true, state: 'active' };
  }

  /**
   * Abort: the document moves to `aborted` FIRST (so a concurrent tick cannot
   * dispatch another package), then every non-terminal child is cancelled and every
   * remaining package is marked terminal.
   */
  async abort(input: IProgrammeControlInput): Promise<IControlResult> {
    const programmeId = sanitiseOptionalString(input?.programmeId);
    if (!programmeId) return { aborted: false, code: 'invalid_programme_id', reason: '`programmeId` is required.' };
    const doc = await this.store.findByProgrammeId(programmeId);
    if (!doc) return { aborted: false, code: 'not_found', reason: `No programme "${programmeId}".` };

    const auth = this.authoriseControl(doc);
    if (!auth.ok) return { aborted: false, code: auth.code, reason: auth.error };

    const state = (doc as any).state as ProgrammeState;
    if (!['active', 'paused'].includes(state)) {
      return { aborted: false, code: 'invalid_state', reason: `Cannot abort a ${state} programme.` };
    }

    const user: any = (this.context as any).user;
    const reason = sanitiseOptionalString(input?.reason) || 'aborted by programme owner';
    const now = new Date();
    const stopped = await this.store.transitionProgramme({
      programmeId,
      expectStates: ['active', 'paused'],
      set: {
        state: 'aborted',
        abortedAt: now,
        abortedByUserId: String(user._id),
        abortedByEmail: String(user.email || ''),
        abortReason: reason,
        completedAt: now,
      },
      unset: ['leaseOwner', 'leaseExpiresAt'],
    });
    if (!stopped) {
      return { aborted: false, code: 'raced', reason: 'Another caller changed the programme first; re-read and retry.' };
    }

    const aborted = asPlain(stopped) as IWorkflowProgramme;
    let cancelled = 0;
    let cancelFailures = 0;
    let pendingDispatch = 0;

    for (const pkg of aborted.packages || []) {
      if (isTerminalPackageState(pkg.state)) continue;

      let cancelError: string | undefined;
      // A package in `dispatching` may own a live child that was never adopted —
      // exactly the crash window the dispatch id exists for. Resolve it by dispatch
      // id before declaring the package cancelled, otherwise the programme says
      // "aborted" while the child keeps running and its later report is rejected.
      let instanceId = pkg.childInstanceId;
      if (!instanceId && pkg.state === 'dispatching' && pkg.dispatchId) {
        try {
          const child = await this.findChildByDispatchId(pkg.dispatchId, aborted, pkg);
          instanceId = sanitiseOptionalString((child as any)?.id || (child as any)?.instanceId);
        } catch (lookupError: any) {
          cancelError = `child lookup failed: ${lookupError?.message || String(lookupError)}`;
        }
      }

      const inFlight = !instanceId && pkg.state === 'dispatching' && !!pkg.dispatchId;
      if (inFlight) pendingDispatch += 1;

      if (instanceId && LIVE_PACKAGE_STATES.includes(pkg.state)) {
        const outcome = await this.cancelChild(instanceId);
        if (!outcome.cancelled) {
          cancelError = outcome.error;
          cancelFailures += 1;
        }
      }

      const transitioned = await this.store.transitionPackage({
        programmeId,
        packageId: pkg.id,
        expect: { states: ['pending', 'ready', 'dispatching', 'running'] },
        set: {
          state: 'cancelled',
          completedAt: now,
          lastProgressAt: now,
          outcomeSource: 'reconciler',
          lastError: cancelError
            ? `${reason} (child not cancelled: ${cancelError})`
            : inFlight
              ? `${reason} (aborted while a child start was in flight; any child that starts will be cancelled)`
              : reason,
        },
      });
      if (transitioned) cancelled += 1;
    }

    await this.store.updateProgramme(programmeId, { lastProgressAt: now });
    const notification = await this.notifyProgramme(stopped as any, 'aborted');
    this.log('warn', 'programme aborted', {
      programmeId,
      by: String(user._id),
      cancelled,
      cancelFailures,
      pendingDispatch,
    });

    return {
      aborted: true,
      state: 'aborted',
      cancelled,
      cancelFailures,
      pendingDispatch,
      notificationChannel: notification.channel,
    };
  }

  /**
   * A child writes its own outcome here. Looked up by `dispatchId` — never by the
   * package id or by "the running package", both of which are ambiguous.
   */
  async reportPackageOutcome(input: IReportPackageOutcomeInput): Promise<IReportPackageOutcomeResult> {
    const dispatchId = sanitiseOptionalString(input?.dispatchId);
    if (!dispatchId) return { reported: false, reason: '`dispatchId` is required.' };

    const docs = await this.store.findMany({ dispatchId }, 1);
    const doc = docs[0];
    if (!doc) return { reported: false, reason: `No package owns dispatch id "${dispatchId}".` };

    const programme = asPlain(doc);
    const pkg = (programme.packages || []).find((entry) => entry.dispatchId === dispatchId);
    if (!pkg) return { reported: false, reason: `No package owns dispatch id "${dispatchId}".` };
    if (isTerminalPackageState(pkg.state)) {
      return {
        reported: false,
        reason: `Package "${pkg.id}" is already ${pkg.state}.`,
        programmeId: programme.programmeId,
        packageId: pkg.id,
        state: pkg.state,
      };
    }

    const now = new Date();
    const status = normaliseChildStatus(input?.status);
    const prUrl = sanitiseOptionalString(input?.prUrl);
    const mergedSha = sanitiseOptionalString(input?.mergedSha);
    const error = sanitiseOptionalString(input?.error);
    const notes = sanitiseOptionalString(input?.notes);

    const set: Record<string, any> = { lastProgressAt: now, outcomeSource: 'push' };
    if (status) set.status = status;
    if (prUrl) set.prUrl = prUrl;
    if (mergedSha) set.mergedSha = mergedSha;
    if (error) set.lastError = error;
    if (notes) set.notes = notes;

    let awaitingVerification = false;
    let packageFailed = false;
    if (status === 'failed') {
      set.state = 'failed';
      set.completedAt = now;
      packageFailed = true;
      if (!error) set.lastError = 'child reported failure';
    } else if (status === 'completed') {
      if (mergedSha || !prUrl) {
        // Definitive: a merge SHA, or nothing to merge (e.g. a documentation package).
        set.state = 'succeeded';
        set.completedAt = now;
        set.verifiedAt = now;
      } else {
        // Claims success with an open/unknown PR: the tick verifies with `gh`.
        set.status = 'awaiting_merge';
        awaitingVerification = true;
      }
    }

    const updated = await this.store.transitionPackage({
      programmeId: programme.programmeId,
      packageId: pkg.id,
      expect: { states: ['dispatching', 'running'] },
      set,
    });

    if (!updated) {
      return {
        reported: false,
        reason: `Package "${pkg.id}" moved while the report was being applied; re-read and retry.`,
        programmeId: programme.programmeId,
        packageId: pkg.id,
      };
    }

    await this.store.updateProgramme(programme.programmeId, { lastProgressAt: now });
    const updatedPackage = ((updated as any).packages || []).find((entry: IProgrammePackage) => entry.id === pkg.id);

    // A child that reported failure gets its own package-level escalation. It must
    // NOT consume the programme's terminal notification: other packages may still
    // be running, and the terminal message is sent when the programme settles.
    if (packageFailed) {
      await this.notifyPackage(
        asPlain(updated) as IWorkflowProgramme,
        (updatedPackage as IProgrammePackage) || ({ ...pkg, state: 'failed' } as IProgrammePackage),
        'failed',
      );
    }
    this.log('info', 'package outcome reported by child', {
      programmeId: programme.programmeId,
      packageId: pkg.id,
      state: updatedPackage?.state,
      status: updatedPackage?.status,
    });

    return {
      reported: true,
      programmeId: programme.programmeId,
      packageId: pkg.id,
      state: updatedPackage?.state,
      awaitingVerification,
    };
  }

  /** Read a package's state by dispatch id (a child asking "am I still wanted?"). */
  async getPackageStatus(input: { dispatchId: string }): Promise<any> {
    const dispatchId = sanitiseOptionalString(input?.dispatchId);
    if (!dispatchId) return { found: false, reason: '`dispatchId` is required.' };
    const doc = (await this.store.findMany({ dispatchId }, 1))[0];
    if (!doc) return { found: false, reason: `No package owns dispatch id "${dispatchId}".` };
    const programme = asPlain(doc);
    const pkg = (programme.packages || []).find((entry) => entry.dispatchId === dispatchId);
    if (!pkg) return { found: false, reason: `No package owns dispatch id "${dispatchId}".` };
    return {
      found: true,
      programme: {
        programmeId: programme.programmeId,
        name: programme.name,
        state: programme.state,
      },
      package: {
        id: pkg.id,
        title: pkg.title,
        state: pkg.state,
        attempt: pkg.attempt,
        status: pkg.status,
        prUrl: pkg.prUrl,
        mergedSha: pkg.mergedSha,
      },
    };
  }

  // ── the tick ───────────────────────────────────────────────────────────────

  /**
   * Reconcile every active/paused programme (or exactly one when addressed).
   *
   * ── Per-programme isolation is load-bearing ────────────────────────────────
   *
   * Each tick runs inside its own try/catch. Without it a single throwing
   * programme aborts the whole pass, and because `findMany` sorts by created time
   * with a limit, that programme permanently occupies the head of every tick —
   * every programme after it never advances again. `getWorkflowHistory` rethrows
   * after logging, so one transient engine failure was enough to cause exactly
   * that. Only a failure that invalidates the PASS itself (the store being
   * unreachable) may propagate: `findMany` runs before the loop, outside the
   * guard.
   */
  async reconcile(input: IReconcileInput = {}): Promise<IReconcileResult> {
    const now = input?.now ? new Date(input.now) : new Date();
    const limit = clampNumber(input?.limit, 1, 200, 25);
    const programmeId = sanitiseOptionalString(input?.programmeId);

    const options: ITickOptions = {
      now,
      staleMs: clampNumber(input?.staleMs, 1_000, 24 * 60 * 60_000, DEFAULT_DISPATCH_STALE_MS),
      leaseMs: clampNumber(input?.leaseMs, 1_000, 10 * 60_000, DEFAULT_LEASE_MS),
      maxDispatchesPerTick: clampNumber(input?.maxDispatchesPerTick, 1, 50, DEFAULT_MAX_DISPATCHES_PER_TICK),
      maxVerificationsPerTick: clampNumber(input?.maxVerificationsPerTick, 0, 50, DEFAULT_MAX_VERIFICATIONS_PER_TICK),
      verificationIntervalMs: clampNumber(
        input?.verificationIntervalMs,
        0,
        60 * 60_000,
        DEFAULT_VERIFICATION_INTERVAL_MS,
      ),
    };

    const query: IProgrammeQuery = programmeId
      ? { programmeId }
      : { state: ['active', 'paused'] };
    // Deliberately NOT wrapped: if the store cannot list programmes there is
    // nothing to isolate, and a silent empty result would be a lie.
    const programmes = await this.store.findMany(query, limit);

    const ticks: IProgrammeTickResult[] = [];
    for (const programme of programmes) {
      const id = String((programme as any)?.programmeId || '');
      try {
        ticks.push(await this.tickProgramme(id, options));
      } catch (error: any) {
        const message = error?.message || String(error);
        ticks.push({
          programmeId: id,
          outcome: 'error',
          state: (((programme as any)?.state || 'active') as ProgrammeState),
          adopted: 0,
          redispatched: 0,
          blocked: 0,
          dispatched: 0,
          verified: 0,
          stalled: 0,
          error: message,
        });
        // Persist the diagnosis: a programme that throws every tick must be
        // explainable from its own record, not only from a log line.
        try {
          await this.store.updateProgramme(id, { lastError: message, lastProgressAt: now });
        } catch (persistError: any) {
          this.log('warn', 'could not record a programme tick failure', {
            programmeId: id,
            error: persistError?.message,
          });
        }
        this.log('error', 'programme tick failed; continuing with the remaining programmes', {
          programmeId: id,
          error: message,
        });
      }
    }

    const result: IReconcileResult = {
      now: now.toISOString(),
      programmes: ticks.length,
      dispatched: ticks.reduce((sum, tick) => sum + tick.dispatched, 0),
      adopted: ticks.reduce((sum, tick) => sum + tick.adopted, 0),
      verified: ticks.reduce((sum, tick) => sum + tick.verified, 0),
      stalled: ticks.reduce((sum, tick) => sum + tick.stalled, 0),
      settled: ticks.filter((tick) => !!tick.settled).length,
      errors: ticks.filter((tick) => tick.outcome === 'error').length,
      ticks,
    };

    if (result.dispatched || result.settled || result.stalled || result.errors) {
      this.log(result.errors ? 'warn' : 'info', 'programme reconcile pass', {
        programmes: result.programmes,
        dispatched: result.dispatched,
        adopted: result.adopted,
        verified: result.verified,
        stalled: result.stalled,
        settled: result.settled,
        errors: result.errors,
      });
    }

    return result;
  }

  /** Reconcile ONE programme under a single-flight lease. */
  async tickProgramme(programmeId: string, options: ITickOptions): Promise<IProgrammeTickResult> {
    const owner = `reconciler:${process.pid}:${randomBytes(8).toString('hex')}`;
    const result: IProgrammeTickResult = {
      programmeId,
      outcome: 'idle',
      state: 'active',
      adopted: 0,
      redispatched: 0,
      blocked: 0,
      dispatched: 0,
      verified: 0,
      stalled: 0,
    };

    const claimed = await this.store.claimLease(programmeId, owner, options.now, options.leaseMs);
    if (!claimed) {
      const current = await this.store.findByProgrammeId(programmeId);
      const currentState = ((current as any)?.state || result.state) as ProgrammeState;
      // A programme that is already terminal is simply not eligible. Otherwise the
      // lease belongs to another tick — which is SUCCESS: the work is happening.
      const terminal = !['active', 'paused'].includes(currentState);
      return {
        ...result,
        outcome: terminal ? 'skipped' : 'leased',
        state: currentState,
      };
    }

    try {
      const startState = (claimed as any).state as ProgrammeState;
      result.state = startState;
      if (!['active', 'paused'].includes(startState)) {
        return { ...result, outcome: 'skipped' };
      }

      let programme: any = claimed;

      // 1. Adopt or re-arm packages whose dispatch is mid-flight.
      const recovered = await this.recoverDispatching(programme, options);
      result.adopted = recovered.adopted;
      result.redispatched = recovered.redispatched;
      programme = (await this.store.findByProgrammeId(programmeId)) || programme;

      // 2. Promote pending packages whose dependencies have landed.
      result.blocked = await this.promotePackages(programme, options);
      programme = (await this.store.findByProgrammeId(programmeId)) || programme;

      // 3. Observe running packages: push claims first, `gh` only when needed.
      const observed = await this.observePackages(programme, options);
      result.verified = observed.verified;
      result.stalled = observed.stalled;
      programme = (await this.store.findByProgrammeId(programmeId)) || programme;

      // 4. Settle the programme when nothing can advance further.
      const settled = await this.settleProgramme(programme, options);
      if (settled) result.settled = settled;
      programme = (await this.store.findByProgrammeId(programmeId)) || programme;

      // 5. Dispatch — never from a paused/aborted programme.
      if (programme.state === 'active') {
        result.dispatched = await this.dispatchReadyPackages(programme, options);
      }

      const final = await this.store.findByProgrammeId(programmeId);
      result.state = ((final as any)?.state || programme.state) as ProgrammeState;
      const advanced =
        result.adopted + result.redispatched + result.blocked + result.dispatched + result.verified + result.stalled;
      result.outcome = result.settled ? 'settled' : advanced > 0 ? 'advanced' : 'idle';
      return result;
    } finally {
      // Best effort: an expired lease is equally recoverable, but releasing lets the
      // next minute's tick start immediately instead of waiting out the lease.
      try {
        await this.store.releaseLease(programmeId, owner);
      } catch {
        /* the lease will expire */
      }
    }
  }

  /**
   * Resolve every `dispatching` package: adopt the child found by `dispatchId`, or
   * re-arm once the dispatch is provably stale.
   */
  async recoverDispatching(
    programme: IWorkflowProgramme,
    options: ITickOptions,
  ): Promise<{ adopted: number; redispatched: number }> {
    let adopted = 0;
    let redispatched = 0;

    // Re-arming is a real state change and must be counted, otherwise a tick that
    // rescued five stuck dispatches reports `outcome: 'idle'`.
    const rearm = async (
      pkg: IProgrammePackage,
      expect: { state: 'dispatching'; dispatchId?: string },
      set: Record<string, any>,
      unset: string[],
    ): Promise<boolean> => {
      const moved = await this.store.transitionPackage({
        programmeId: programme.programmeId,
        packageId: pkg.id,
        expect,
        set,
        unset,
      });
      if (moved) redispatched += 1;
      return !!moved;
    };

    for (const pkg of programme.packages || []) {
      if (pkg.state !== 'dispatching') continue;

      // Already adopted (crash after the adopt write, before the tick ended).
      if (pkg.childInstanceId) {
        const moved = await this.store.transitionPackage({
          programmeId: programme.programmeId,
          packageId: pkg.id,
          expect: { state: 'dispatching', dispatchId: pkg.dispatchId },
          set: { state: 'running', lastProgressAt: options.now },
        });
        if (moved) adopted += 1;
        continue;
      }

      if (!pkg.dispatchId) {
        // Cannot be looked up by an id that does not exist. No child can have been
        // identified, so re-arming is the only honest option.
        await rearm(
          pkg,
          { state: 'dispatching' },
          { state: 'ready', lastError: 'dispatching package had no dispatch id; re-armed' },
          ['dispatchedAt', 'childInstanceId'],
        );
        continue;
      }

      // The package's OWN child workflow id is what dispatch used (and recorded),
      // so the lookup must use the same one.
      const child = await this.findChildByDispatchId(pkg.dispatchId, programme, pkg);
      if (child) {
        const instanceId = sanitiseOptionalString((child as any).id || (child as any).instanceId);
        const moved = await this.store.transitionPackage({
          programmeId: programme.programmeId,
          packageId: pkg.id,
          expect: { state: 'dispatching', dispatchId: pkg.dispatchId },
          set: {
            state: 'running',
            childInstanceId: instanceId,
            lastProgressAt: options.now,
            lastError: undefined,
          },
          unset: ['lastError'],
        });
        if (moved) adopted += 1;
        continue;
      }

      const dispatchedAt = pkg.dispatchedAt ? new Date(pkg.dispatchedAt).getTime() : 0;
      if (dispatchedAt && options.now.getTime() - dispatchedAt < options.staleMs) {
        // The start may still be in flight. Waiting one stale window is cheaper than
        // risking a duplicate child.
        continue;
      }

      const attempts = Number(pkg.attempt || 0);
      if (attempts >= Number(programme.maxAttempts || DEFAULT_MAX_ATTEMPTS)) {
        await this.store.transitionPackage({
          programmeId: programme.programmeId,
          packageId: pkg.id,
          expect: { state: 'dispatching', dispatchId: pkg.dispatchId },
          set: {
            state: 'failed',
            completedAt: options.now,
            lastProgressAt: options.now,
            lastError: `no child was found for dispatch ${pkg.dispatchId} after ${attempts} dispatch attempt(s)`,
            outcomeSource: 'reconciler',
          },
        });
        continue;
      }

      await rearm(
        pkg,
        { state: 'dispatching', dispatchId: pkg.dispatchId },
        {
          state: 'ready',
          lastError: `dispatch ${pkg.dispatchId} produced no child; re-armed`,
          lastProgressAt: options.now,
        },
        ['dispatchId', 'dispatchedAt', 'childInstanceId'],
      );
    }

    return { adopted, redispatched };
  }

  /** Promote `pending` packages to `ready`, or `blocked` when a dependency died. */
  async promotePackages(programme: IWorkflowProgramme, options: ITickOptions): Promise<number> {
    const packages = programme.packages || [];
    const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
    let blocked = 0;

    for (const pkg of packages) {
      if (pkg.state !== 'pending') continue;
      const verdict = dependencyVerdict(pkg, byId);
      if (verdict === 'satisfied') {
        await this.store.transitionPackage({
          programmeId: programme.programmeId,
          packageId: pkg.id,
          expect: { state: 'pending' },
          set: { state: 'ready', lastProgressAt: options.now },
        });
      } else if (verdict === 'blocked') {
        const moved = await this.store.transitionPackage({
          programmeId: programme.programmeId,
          packageId: pkg.id,
          expect: { state: 'pending' },
          set: {
            state: 'blocked',
            completedAt: options.now,
            lastProgressAt: options.now,
            outcomeSource: 'reconciler',
            lastError: 'a dependency did not succeed',
          },
        });
        if (moved) blocked += 1;
      }
    }
    return blocked;
  }

  /**
   * Observe `running` packages.
   *
   * A child that reported `completed` with a PR but no merge SHA is a CLAIM; it is
   * verified with `gh`, at most once per `verificationIntervalMs` and at most
   * `maxVerificationsPerTick` calls per programme. A `gh` failure is recorded and
   * never treated as a failed package — a transient CLI failure must not block a
   * wave.
   */
  async observePackages(
    programme: IWorkflowProgramme,
    options: ITickOptions,
  ): Promise<{ verified: number; stalled: number }> {
    let verified = 0;
    let stalled = 0;
    let ghBudget = options.maxVerificationsPerTick;

    for (const pkg of programme.packages || []) {
      if (pkg.state !== 'running') continue;

      const nowMs = options.now.getTime();
      const lastProgressMs = this.lastProgressAt(pkg, programme).getTime();
      const slaMs = Math.max(1, Number(programme.slaMinutes || DEFAULT_SLA_MINUTES)) * 60_000;
      const overdue = nowMs - lastProgressMs >= slaMs;
      const prUrl = sanitiseOptionalString(pkg.prUrl);
      const claimsSuccessUnverified = !!prUrl && !sanitiseOptionalString(pkg.mergedSha);
      const lastVerifiedMs = pkg.verifiedAt ? new Date(pkg.verifiedAt).getTime() : 0;
      const verificationDue =
        claimsSuccessUnverified &&
        (nowMs - lastVerifiedMs >= options.verificationIntervalMs || overdue);

      if (verificationDue && ghBudget > 0) {
        ghBudget -= 1;
        const verdict = await this.ghVerifier(pkg, programme);

        if (verdict.kind === 'merged') {
          const moved = await this.store.transitionPackage({
            programmeId: programme.programmeId,
            packageId: pkg.id,
            expect: { state: 'running' },
            set: {
              state: 'succeeded',
              mergedSha: verdict.mergedSha,
              prUrl: verdict.prUrl || prUrl,
              verifiedAt: options.now,
              completedAt: options.now,
              lastProgressAt: options.now,
              outcomeSource: 'gh',
              status: 'merged',
            },
            unset: ['lastVerificationError', 'lastError'],
          });
          if (moved) {
            verified += 1;
            await this.store.updateProgramme(programme.programmeId, { lastProgressAt: options.now });
            continue;
          }
        } else if (verdict.kind === 'closed') {
          const moved = await this.store.transitionPackage({
            programmeId: programme.programmeId,
            packageId: pkg.id,
            expect: { state: 'running' },
            set: {
              state: 'failed',
              verifiedAt: options.now,
              completedAt: options.now,
              lastProgressAt: options.now,
              outcomeSource: 'gh',
              status: 'closed',
              lastError: 'pull request was closed without merging',
            },
          });
          if (moved) {
            verified += 1;
            continue;
          }
        } else if (verdict.kind === 'open') {
          // Evidence of life: reset the SLA window, because a PR awaiting a human
          // merge is not a silent child.
          await this.store.updatePackage(programme.programmeId, pkg.id, {
            verifiedAt: options.now,
            lastProgressAt: options.now,
            status: pkg.status === 'awaiting_merge' ? 'awaiting_merge' : pkg.status,
          });
          await this.store.updatePackage(
            programme.programmeId,
            pkg.id,
            {},
            ['lastVerificationError'],
          );
          continue;
        } else if (verdict.kind === 'error') {
          // Transient by assumption. Record the evidence and let the SLA decide.
          await this.store.updatePackage(programme.programmeId, pkg.id, {
            verifiedAt: options.now,
            lastVerificationError: verdict.error,
          });
        }

        // Verification did not produce a terminal verdict: fall through to the stall
        // check, which is what eventually asks a human for help.
      }

      if (!overdue) continue;

      // ── is the child actually still alive? ─────────────────────────────────
      // Consulted only when the package looks overdue, so the cost is one engine
      // read per package per SLA window — not per tick, and never an external call.
      if (pkg.childInstanceId) {
        let child: { status?: any; statusLabel?: string } | undefined;
        let lookupError: string | undefined;
        try {
          child = await this.childStatusLookup(pkg.childInstanceId);
        } catch (error: any) {
          lookupError = error?.message || String(error);
        }

        if (lookupError) {
          // Cannot tell: fall through to the SLA path, which is the conservative one.
          await this.store.updatePackage(programme.programmeId, pkg.id, {
            lastVerificationError: `child status lookup failed: ${lookupError}`,
          });
        } else if (child) {
          const verdict = classifyChildStatus(child.status);
          if (verdict === 'alive') {
            // Evidence of life: reset the window. A running child is never "silent".
            await this.store.updatePackage(programme.programmeId, pkg.id, {
              lastProgressAt: options.now,
              status: 'child_running',
            });
            continue;
          }
          if (verdict === 'complete' || verdict === 'terminated') {
            const moved = await this.store.transitionPackage({
              programmeId: programme.programmeId,
              packageId: pkg.id,
              expect: { state: 'running' },
              set: {
                state: 'failed',
                completedAt: options.now,
                lastProgressAt: options.now,
                outcomeSource: 'reconciler',
                status: verdict === 'complete' ? 'child_completed_unreported' : 'child_terminated',
                lastError:
                  verdict === 'complete'
                    ? 'child instance completed without reporting an outcome (reportPackageOutcome is not wired into the child workflow)'
                    : 'child instance was terminated without reporting an outcome',
              },
            });
            if (moved) {
              stalled += 1;
              await this.notifyPackage(
                programme,
                { ...pkg, state: 'failed', lastError: 'child instance ended without reporting an outcome' } as IProgrammePackage,
                'failed',
              );
            }
            continue;
          }
        }
      }

      // ── stall escalation ───────────────────────────────────────────────────
      const notifiedAtMs = pkg.stalledNotifiedAt ? new Date(pkg.stalledNotifiedAt).getTime() : 0;
      // One escalation per progress window, and at most one per SLA period.
      if (notifiedAtMs >= lastProgressMs && nowMs - notifiedAtMs < slaMs) continue;

      // `stallCount` is its own budget: "three failed starts" and "one start plus
      // two silent windows" are different diagnoses and must not share a counter.
      const stalls = Number(pkg.stallCount || 0);
      const maxAttempts = Math.max(1, Number(programme.maxAttempts || DEFAULT_MAX_ATTEMPTS));

      if (stalls >= maxAttempts) {
        const moved = await this.store.transitionPackage({
          programmeId: programme.programmeId,
          packageId: pkg.id,
          expect: { state: 'running' },
          set: {
            state: 'failed',
            completedAt: options.now,
            lastProgressAt: options.now,
            stalledNotifiedAt: options.now,
            outcomeSource: 'reconciler',
            lastError: `silent for ${Math.round((nowMs - lastProgressMs) / 60_000)} minutes; ${stalls} stall window(s) of ${maxAttempts} exhausted`,
          },
        });
        if (moved) {
          stalled += 1;
          await this.notifyPackage(programme, { ...pkg, state: 'failed' } as IProgrammePackage, 'failed');
        }
        continue;
      }

      const moved = await this.store.transitionPackage({
        programmeId: programme.programmeId,
        packageId: pkg.id,
        expect: { state: 'running' },
        inc: { stallCount: 1 },
        set: {
          stalledNotifiedAt: options.now,
          lastError: `silent for ${Math.round((nowMs - lastProgressMs) / 60_000)} minutes`,
        },
      });
      if (moved) {
        stalled += 1;
        await this.notifyPackage(programme, pkg, 'stalled');
      }
    }

    return { verified, stalled };
  }

  /** Settle the programme exactly once, and notify exactly once. */
  async settleProgramme(
    programme: IWorkflowProgramme,
    options: ITickOptions,
  ): Promise<'completed' | 'failed' | 'aborted' | undefined> {
    const outcome = summariseProgrammeOutcome(programme.packages || []);
    if (!outcome) return undefined;
    if (programme.state === outcome) return undefined;

    const updated = await this.store.transitionProgramme({
      programmeId: programme.programmeId,
      expectStates: ['active', 'paused'],
      set: {
        state: outcome,
        completedAt: options.now,
        lastProgressAt: options.now,
      },
    });
    if (!updated) return undefined;

    // The transition winner is the only caller that notifies, so a repeated tick
    // cannot produce a second email. This is the PROGRAMME terminal event and is
    // tracked separately from any per-package escalation.
    await this.notifyProgramme(updated as any, outcome);
    this.log(outcome === 'completed' ? 'info' : 'warn', 'programme settled', {
      programmeId: programme.programmeId,
      state: outcome,
    });
    return outcome;
  }

  /**
   * Claim and start every `ready` package, bounded per tick.
   *
   * The claim is the idempotency boundary. `transitionPackage` returns `null` when
   * another caller won, and that is treated as success — never as an error, and
   * never retried inside this tick.
   */
  async dispatchReadyPackages(programme: IWorkflowProgramme, options: ITickOptions): Promise<number> {
    if (programme.state !== 'active') return 0;
    let budget = options.maxDispatchesPerTick;
    let dispatched = 0;

    const ready = (programme.packages || []).filter((pkg) => pkg.state === 'ready');
    for (const pkg of ready) {
      if (budget <= 0) break;

      const dispatchId = mintDispatchId(programme.programmeId, pkg.id);
      const claimed = await this.store.transitionPackage({
        programmeId: programme.programmeId,
        packageId: pkg.id,
        // THE predicate: still ready, and never dispatched before.
        expect: { state: 'ready', dispatchIdAbsent: true },
        // ...AND the programme must still be active AT WRITE TIME. The guard above
        // reads a snapshot; this makes the claim contend with abort and pause for the
        // same document, so a control write that landed mid-tick wins and this claim
        // returns null.
        expectProgrammeStates: ['active'],
        set: {
          state: 'dispatching',
          dispatchId,
          dispatchedAt: options.now,
          lastProgressAt: options.now,
          childWorkflowId: pkg.childWorkflowId || programme.childWorkflowId,
        },
        unset: ['childInstanceId', 'lastVerificationError', 'lastError'],
        inc: { attempt: 1 },
      });
      if (!claimed) {
        // Either another tick won the package predicate, or the programme left
        // `active` under us (pause/abort). Neither is an error for THIS tick, but the
        // second means there is nothing left to dispatch at all.
        const current = await this.store.findByProgrammeId(programme.programmeId);
        if (!current || (current as any).state !== 'active') break;
        continue;
      }
      budget -= 1;

      const claimedPackage =
        ((claimed as any).packages || []).find((entry: IProgrammePackage) => entry.id === pkg.id) || {
          ...pkg,
          dispatchId,
        };

      try {
        const instance = await this.startChild(programme, claimedPackage as IProgrammePackage, dispatchId);
        const instanceId = sanitiseOptionalString(instance?.id || instance?._id || instance?.instanceId);
        if (!instanceId) throw new Error('startWorkflow returned no instance id');

        // Adoption is NOT assumed. If the package moved while the child was starting
        // (abort is the case that matters), the child exists but nothing points at
        // it: cancel it and record why, instead of leaving a live run behind a
        // human's stop.
        const adopted = await this.store.transitionPackage({
          programmeId: programme.programmeId,
          packageId: pkg.id,
          expect: { state: 'dispatching', dispatchId },
          set: {
            state: 'running',
            childInstanceId: instanceId,
            lastProgressAt: options.now,
          },
        });

        if (!adopted) {
          const cancel = await this.cancelChild(instanceId);
          const reason =
            `child ${instanceId} was started but could not be adopted (the package or ` +
            'programme moved while the start was in flight)' +
            (cancel.cancelled
              ? '; the child was cancelled'
              : `; the child could NOT be cancelled: ${cancel.error}`);
          await this.store.updatePackage(programme.programmeId, pkg.id, { lastError: reason });
          this.log('warn', 'programme package dispatch not adopted; child cancelled', {
            programmeId: programme.programmeId,
            packageId: pkg.id,
            dispatchId,
            instanceId,
            cancelled: cancel.cancelled,
          });
          continue; // NOT counted as dispatched
        }

        await this.store.updateProgramme(programme.programmeId, { lastProgressAt: options.now });
        dispatched += 1;
        this.log('info', 'programme package dispatched', {
          programmeId: programme.programmeId,
          packageId: pkg.id,
          dispatchId,
          instanceId,
        });
      } catch (error: any) {
        // Deliberately NOT re-armed. A start that threw may still have created a
        // child (timeout, lost response); the next tick's `dispatchId` lookup is the
        // only recovery that cannot create a duplicate.
        const message = error?.message || String(error);
        await this.store.updatePackage(programme.programmeId, pkg.id, {
          lastError: `dispatch failed: ${message}`,
        });
        this.log('error', 'programme package dispatch failed; recovery deferred to the next tick', {
          programmeId: programme.programmeId,
          packageId: pkg.id,
          dispatchId,
          error: message,
        });
      }
    }

    return dispatched;
  }

  // ── notification ───────────────────────────────────────────────────────────
  //
  // TWO kinds of message, with TWO separate dedupe keys. Conflating them was a
  // real defect: a package-level failure stamped `notifiedEvent='failed'` on the
  // PROGRAMME, so the terminal "stopped with failures" message was then suppressed
  // — and two packages failing in one tick each sent an identical email.
  //
  //   * programme terminal (`completed` | `failed` | `aborted`)
  //       dedupe: `notifiedEvent` + `notifiedAt` on the programme.
  //       Stamped ONLY by `notifyProgramme`, whose caller won a state transition,
  //       so a repeated tick cannot emit a second one.
  //   * package escalation (`stalled` | `failed`)
  //       dedupe: the package's own `stalledNotifiedAt` (window) and
  //       `failedNotifiedAt` (one per package, claimed atomically).
  //       Never writes programme-level fields, so it cannot consume the terminal
  //       notification, and every package gets exactly one of its own.

  /**
   * Tell the owner the programme reached a terminal state. Exactly once.
   */
  async notifyProgramme(
    programme: IWorkflowProgramme,
    event: 'completed' | 'failed' | 'aborted',
  ): Promise<{ channel: 'communicator' | 'task' | 'communicator+task' | 'none'; error?: string }> {
    if (programme.notifiedEvent === event && programme.notifiedAt) {
      return {
        channel: (programme.notificationChannel as any) || 'none',
        error: programme.notificationError,
      };
    }

    const message = this.buildNotification(programme, event);
    const outcome = await this.sendNotification(programme, event, undefined, message);

    try {
      await this.store.updateProgramme(programme.programmeId, {
        notifiedAt: new Date(),
        notifiedEvent: event,
        notificationChannel: outcome.channel,
        notificationError: outcome.error,
      });
    } catch (error: any) {
      this.log('warn', 'could not persist programme notification evidence', {
        programmeId: programme.programmeId,
        event,
        error: error?.message,
      });
    }

    this.log(outcome.channel === 'none' ? 'error' : 'info', 'programme notification sent', {
      programmeId: programme.programmeId,
      event,
      channel: outcome.channel,
      error: outcome.error,
    });

    return outcome;
  }

  /**
   * Tell the owner about ONE package. Never touches the programme's terminal
   * notification evidence.
   *
   * A `failed` escalation is claimed with a conditional write on the package
   * (`failedNotifiedAt` absent → set), so the same package can never produce two
   * messages while a different package still gets its own.
   */
  async notifyPackage(
    programme: IWorkflowProgramme,
    pkg: IProgrammePackage,
    event: 'stalled' | 'failed',
  ): Promise<{ channel: 'communicator' | 'task' | 'communicator+task' | 'none'; error?: string }> {
    if (event === 'failed') {
      if (pkg.failedNotifiedAt) return { channel: 'none' };
      const claimed = await this.store.transitionPackage({
        programmeId: programme.programmeId,
        packageId: pkg.id,
        // The package may already be `failed` (the caller just moved it) or still
        // running (a child reported failure). Either is claimable, once.
        expect: { states: ['failed', 'running', 'dispatching'], fieldAbsent: 'failedNotifiedAt' },
        set: { failedNotifiedAt: new Date() },
      });
      if (!claimed) return { channel: 'none' };
    }

    const message = this.buildNotification(programme, event, pkg);
    const outcome = await this.sendNotification(programme, event, pkg, message);

    this.log(outcome.channel === 'none' ? 'error' : 'warn', 'package notification sent', {
      programmeId: programme.programmeId,
      packageId: pkg.id,
      event,
      channel: outcome.channel,
      error: outcome.error,
    });

    return outcome;
  }

  /**
   * Backwards-compatible dispatcher: a package argument means a package-level
   * escalation, otherwise the event is the programme's terminal one.
   */
  async notify(
    programme: IWorkflowProgramme,
    event: 'completed' | 'failed' | 'aborted' | 'stalled',
    pkg?: IProgrammePackage,
  ): Promise<{ channel: 'communicator' | 'task' | 'communicator+task' | 'none'; error?: string }> {
    if (pkg && (event === 'stalled' || event === 'failed')) {
      return this.notifyPackage(programme, pkg, event);
    }
    return this.notifyProgramme(programme, event as 'completed' | 'failed' | 'aborted');
  }

  /**
   * One message, two channels. The communicator is the required channel; the task
   * surface is written as well so "never silent" survives a communicator outage —
   * the same compromise documented for continuations.
   */
  private async sendNotification(
    programme: IWorkflowProgramme,
    event: 'completed' | 'failed' | 'aborted' | 'stalled',
    pkg: IProgrammePackage | undefined,
    message: { subject: string; text: string },
  ): Promise<{ channel: 'communicator' | 'task' | 'communicator+task' | 'none'; error?: string }> {
    const recipient = String(programme.ownerEmail || '').trim();
    let communicatorAccepted = false;
    let communicatorError: string | undefined;

    if (recipient) {
      try {
        const communicator: any = this.getService(COMMUNICATOR_SERVICE_ID);
        if (communicator && typeof communicator.send === 'function') {
          const result: any = await communicator.send({
            channel: 'email',
            to: recipient,
            content: { subject: message.subject, text: message.text },
            metadata: {
              source: 'reactor.WorkflowProgramme',
              programmeId: programme.programmeId,
              event,
              packageId: pkg?.id,
            },
          });
          communicatorAccepted = result?.success === true;
          if (!communicatorAccepted) {
            communicatorError = String(result?.error || 'communicator did not accept the message');
          }
        }
      } catch (error: any) {
        communicatorError = error?.message || String(error);
      }
    }

    let taskRaised = false;
    try {
      const TaskModel: any = (await import('@reactory/server-modules/reactory-core/models/Task')).default;
      await new TaskModel({
        title: message.subject,
        description: message.text,
        category: 'workflow-programme',
        workflowStatus: event === 'completed' ? 'complete' : 'attention_required',
        status: 'pending',
        workflowId: PROGRAMME_RECONCILER_WORKFLOW_ID,
        instanceId: undefined,
        stepId: 'notify',
        componentProps: {
          programmeId: programme.programmeId,
          event,
          packageId: pkg?.id,
          notificationChannel: communicatorAccepted ? 'communicator+task' : 'task',
        },
        user: programme.ownerUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).save();
      taskRaised = true;
    } catch (error: any) {
      this.log('warn', 'could not raise the programme notification task', {
        programmeId: programme.programmeId,
        event,
        error: error?.message,
      });
    }

    const channel = communicatorAccepted
      ? taskRaised
        ? 'communicator+task'
        : 'communicator'
      : taskRaised
        ? 'task'
        : 'none';

    return { channel, error: communicatorError };
  }



  private buildNotification(
    programme: IWorkflowProgramme,
    event: 'completed' | 'failed' | 'aborted' | 'stalled',
    pkg?: IProgrammePackage,
  ): { subject: string; text: string } {
    const name = programme.name || programme.programmeId;
    const counts: Record<string, number> = {};
    (programme.packages || []).forEach((entry) => {
      counts[entry.state] = (counts[entry.state] || 0) + 1;
    });
    const summary = Object.keys(counts)
      .map((state) => `${state}=${counts[state]}`)
      .join(', ');

    // ── package-level messages ────────────────────────────────────────────────
    // The subject names the PACKAGE so it can never be mistaken for (or deduped
    // against) the programme's terminal message.
    if (event === 'stalled') {
      return {
        subject: `Programme "${name}" — package ${pkg?.id || '?'} has gone silent`,
        text: [
          `Programme: ${name} (${programme.programmeId})`,
          `Package: ${pkg?.id}${pkg?.title ? ` — ${pkg.title}` : ''}`,
          `Stall windows used: ${pkg?.stallCount ?? 0} of ${programme.maxAttempts}`,
          `Last progress: ${pkg?.lastProgressAt ? new Date(pkg.lastProgressAt).toISOString() : 'unknown'}`,
          `Packages: ${summary}`,
          '',
          'No progress has been observed within the SLA. The reconciler will keep observing and fail',
          'the package once its stall budget is exhausted. A failed engineering run needs a human.',
        ].join('\n'),
      };
    }

    if (event === 'failed' && pkg) {
      return {
        subject: `Programme "${name}" — package ${pkg.id} failed`,
        text: [
          `Programme: ${name} (${programme.programmeId})`,
          `Package: ${pkg.id}${pkg.title ? ` — ${pkg.title}` : ''}`,
          `Reason: ${pkg.lastError || 'no reason recorded'}`,
          `Dispatch attempts: ${pkg.attempt ?? 0}; stall windows: ${pkg.stallCount ?? 0}`,
          `Pull request: ${pkg.prUrl || 'none'}`,
          `Packages: ${summary}`,
          '',
          'The rest of the programme keeps running; this package needs a person.',
        ].join('\n'),
      };
    }

    // ── programme terminal messages ───────────────────────────────────────────
    const verdict =
      event === 'completed'
        ? 'completed successfully'
        : event === 'aborted'
          ? 'was aborted'
          : 'stopped with failures';
    return {
      subject: `Programme "${name}" ${verdict}`,
      text: [
        `Programme: ${name} (${programme.programmeId})`,
        `State: ${event}`,
        `Packages: ${summary}`,
        programme.lastError ? `Last error: ${programme.lastError}` : null,
        '',
        'Details:',
        ...(programme.packages || []).map(
          (entry) =>
            `- ${entry.id}: ${entry.state}${entry.prUrl ? ` (${entry.prUrl})` : ''}${
              entry.lastError ? ` — ${entry.lastError}` : ''
            }`,
        ),
      ]
        .filter((line) => line !== null)
        .join('\n'),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private lastProgressAt(pkg: IProgrammePackage, programme: IWorkflowProgramme): Date {
    // The programme's own watermark is deliberately NOT a candidate: a sibling
    // package advancing must not make a silent package look alive. The SLA is a
    // statement about THIS package.
    const candidates = [pkg.lastProgressAt, pkg.dispatchedAt, programme.createdAt]
      .filter(Boolean)
      .map((value) => new Date(value as any).getTime())
      .filter((value) => Number.isFinite(value));
    return new Date(candidates.length ? Math.max(...candidates) : Date.now());
  }

  /** Rebuild the owner's context for a dispatch, falling back to the tick's own. */
  private async dispatchContext(programme: IWorkflowProgramme): Promise<Reactory.Server.IReactoryContext> {
    const ownerEmail = String(programme.ownerEmail || '').trim();
    if (!ownerEmail) return this.context;
    try {
      const rebuilt = await this.ownerContextBuilder({
        userEmail: ownerEmail,
        partnerKey: programme.partnerKey,
      });
      if (rebuilt) return rebuilt;
    } catch (error: any) {
      this.log('warn', 'could not rebuild the programme owner context; dispatching as the tick identity', {
        programmeId: programme.programmeId,
        error: error?.message,
      });
    }
    return this.context;
  }

  private authoriseRead(programme: IWorkflowProgramme): IAuthorisationResult {
    const user: any = (this.context as any)?.user;

    // Check the platform identity FIRST: a real system user carries an `_id`, so a
    // check placed after the `!user?._id` branch could never admit it.
    if (user && isSystemIdentity(user)) return { ok: true };

    // An ABSENT user is not the reconciler: an anonymous caller also has no user.
    // The reconciler never reads through this path (it works from the store
    // directly), so requiring identity closes the hole without weakening it.
    if (!user?._id) {
      return { ok: false, code: 'no_identity', error: 'A signed-in user is required to read a programme.' };
    }
    if (hasAdministrativeRole(this.context)) return { ok: true };
    if (String((programme as any).ownerUserId) === String(user._id)) return { ok: true };
    return { ok: false, code: 'not_authorised', error: 'This programme belongs to another user.' };
  }

  /**
   * Pause/resume/abort is the owner's or an admin's. The system account is refused
   * explicitly so the audit trail always names a person.
   */
  private authoriseControl(
    programme: IWorkflowProgramme,
  ): IAuthorisationResult {
    const user: any = (this.context as any)?.user;
    if (!user?._id) {
      return { ok: false, code: 'no_identity', error: 'A signed-in user is required to control a programme.' };
    }
    if (isSystemIdentity(user)) {
      return {
        ok: false,
        code: 'system_caller',
        error: 'The system account cannot pause or abort a programme: the audit trail must name a person.',
      };
    }
    if (String((programme as any).ownerUserId) === String(user._id)) return { ok: true, user };
    if (hasAdministrativeRole(this.context)) return { ok: true, user };
    return { ok: false, code: 'not_authorised', error: 'Only the programme owner or an administrator may do that.' };
  }

  private deriveProgrammeId(name: string): string {
    const slug = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return `${slug || 'programme'}-${randomBytes(4).toString('hex')}`;
  }

  private getWorkflowService(): any {
    return this.getService(WORKFLOW_SERVICE_ID);
  }

  /**
   * Cancel one child instance. Never throws: a cancel that fails is evidence to
   * record, not an exception that would abandon the remaining packages.
   */
  private async cancelChild(instanceId: string): Promise<{ cancelled: boolean; error?: string }> {
    const workflowService = this.getWorkflowService();
    if (!workflowService || typeof workflowService.cancelWorkflowInstance !== 'function') {
      return { cancelled: false, error: `${WORKFLOW_SERVICE_ID} is unavailable` };
    }
    try {
      const result: any = await workflowService.cancelWorkflowInstance(instanceId);
      if (result && result.success === false) {
        return { cancelled: false, error: String(result.message || 'cancel refused') };
      }
      return { cancelled: true };
    } catch (error: any) {
      return { cancelled: false, error: error?.message || String(error) };
    }
  }

  private getService(id: string): any {
    return this.getServiceFrom(this.context, id);
  }

  private getServiceFrom(context: any, id: string): any {
    const getService = context?.getService;
    if (typeof getService !== 'function') return null;
    try {
      return getService.call(context, id);
    } catch {
      return null;
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, any>): void {
    try {
      const contextLog = (this.context as any)?.log;
      if (typeof contextLog === 'function') {
        contextLog.call(this.context, message, data, level);
        return;
      }
    } catch {
      /* fall through */
    }
    // eslint-disable-next-line no-console
    if (level === 'error') console.error(message, data || '');
  }
}

export default WorkflowProgrammeService;
