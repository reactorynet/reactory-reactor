import mongoose, { Document, Schema } from 'mongoose';

/**
 * A *programme*: a dependency graph of work packages that must advance without an
 * agent babysitting it.
 *
 * ── Why this is one document with package subdocuments ────────────────────────
 *
 * The alternative, `cross_instance_variable`, is atomic PER DOCUMENT. If the whole
 * programme lived in one cross-instance-variable document, two ticks touching two
 * different packages would clobber each other's transitions — a lost update that
 * looks like a stall. Here the tick never writes the whole document: every package
 * transition is a single `findOneAndUpdate` whose FILTER is the transition's
 * precondition (`packages: { $elemMatch: { id, state, dispatchId absent } }`).
 *
 * The lease (`leaseOwner` / `leaseExpiresAt`) is single-flight, not correctness:
 * the package predicate is what makes a double dispatch impossible even if two
 * ticks run.
 *
 * ── Push, then verify ────────────────────────────────────────────────────────
 *
 * A child writes its own outcome into its package (`prUrl`, `mergedSha`,
 * `status`) through `WorkflowProgrammeService.reportPackageOutcome`. The tick reads
 * Mongo in the common case and only shells out to `gh` for a package that claims
 * success without a merge SHA, or has gone silent past its SLA. Eleven packages
 * over a day is ~2,800 ticks; an external call per tick per package would make a
 * transient `gh` failure look like a blocked wave.
 */

/** Programme lifecycle. `aborted` is terminal and is never re-entered. */
export type ProgrammeState = 'active' | 'paused' | 'aborted' | 'completed' | 'failed';

/**
 * Package lifecycle.
 *
 * `pending`     — dependencies are not all satisfied yet.
 * `ready`       — dependencies satisfied; the next tick may claim it.
 * `dispatching` — claimed under a `dispatchId`; the child start is in flight.
 * `running`     — child instance adopted (`childInstanceId` set).
 * `succeeded`   — terminal success (push-reported merge SHA, verified merge, or no
 *                 merge to wait for).
 * `failed`      — terminal failure; a human is required.
 * `cancelled`   — terminal after an abort.
 * `blocked`     — terminal: a dependency failed/cancelled, so this can never run.
 */
export type PackageState =
  | 'pending'
  | 'ready'
  | 'dispatching'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface IProgrammePackage {
  /** Stable id within the programme (`wp-1`, `api-schema`, …). */
  id: string;
  title: string;
  /** Package ids that must reach `succeeded` before this one may be dispatched. */
  dependsOn: string[];

  state: PackageState;

  /**
   * The dispatch identity for this attempt. Minted by the tick BEFORE the child is
   * started and passed INTO the child as input, so a crash between "start" and
   * "adopt the instance id" is recovered by looking the child up by this value —
   * never by re-dispatching heuristically.
   */
  dispatchId?: string;
  /** The adopted child workflow instance, once known. */
  childInstanceId?: string;
  /** The child workflow id this package was dispatched to (stored per package so a
   *  programme's target can change without orphaning older packages). */
  childWorkflowId?: string;

  /** Extra child-workflow input for this package (agentId, ticketId, …). */
  input?: Record<string, any>;

  /** Dispatch attempts consumed (incremented ONLY when a child is claimed). */
  attempt: number;
  /**
   * Stall escalations consumed. Kept SEPARATE from `attempt`: "three failed starts"
   * and "one start plus two silent windows" are different diagnoses, and a single
   * counter made the failure message unable to say which budget ran out.
   */
  stallCount: number;
  dispatchedAt?: Date;
  /** Last evidence of life: dispatch, child report, or a successful verification. */
  lastProgressAt?: Date;
  /** When the stall for the CURRENT progress window was notified (dedupe). */
  stalledNotifiedAt?: Date;
  /**
   * When this package's FAILURE was notified (dedupe).
   *
   * Deliberately per package and NOT the programme's `notifiedAt`/`notifiedEvent`:
   * a package-level escalation must never consume the programme's one terminal
   * notification, and two packages failing in one tick need one message each.
   */
  failedNotifiedAt?: Date;
  completedAt?: Date;

  /** Child-reported outcome (push). */
  prUrl?: string;
  mergedSha?: string;
  status?: string;
  /** Where the terminal verdict came from. `push` is cheapest and preferred. */
  outcomeSource?: 'push' | 'gh' | 'reconciler';
  verifiedAt?: Date;
  lastVerificationError?: string;

  lastError?: string;
  notes?: string;
}

export interface IWorkflowProgramme {
  /** Human-stable id; unique. The reconciler is addressed by it. */
  programmeId: string;
  name: string;
  description?: string;
  state: ProgrammeState;

  /** Who owns the programme. Pause/abort is authorised to this user or an admin. */
  ownerUserId: mongoose.Types.ObjectId;
  ownerEmail: string;
  partnerKey?: string;

  /** Child workflow every package is dispatched to, unless a package overrides it. */
  childWorkflowId: string;
  /** Default input merged into every child dispatch (agentId, taskType, …). */
  childInputDefaults?: Record<string, any>;

  /** A running package silent for this long is a stall (notify once per window). */
  slaMinutes: number;
  /** Dispatch attempts + stall escalations before a package is failed. */
  maxAttempts: number;

  packages: IProgrammePackage[];

  /** Single-flight lease. Only the holder reconciles this programme. */
  leaseOwner?: string;
  leaseExpiresAt?: Date;

  lastProgressAt?: Date;
  /**
   * The most recent thing that went wrong for the programme as a whole.
   *
   * The reconciler writes a per-programme tick failure here so a programme that
   * throws on every tick is diagnosable instead of merely "not advancing".
   */
  lastError?: string;

  pausedAt?: Date;
  pausedByUserId?: string;
  pausedByEmail?: string;
  pauseReason?: string;
  resumedAt?: Date;
  resumedByUserId?: string;

  abortedAt?: Date;
  abortedByUserId?: string;
  abortedByEmail?: string;
  abortReason?: string;

  completedAt?: Date;
  /** Programme-level notification evidence (completion / failure / abort). */
  notifiedAt?: Date;
  notifiedEvent?: 'completed' | 'failed' | 'aborted';
  notificationChannel?: 'communicator' | 'task' | 'communicator+task' | 'none';
  notificationError?: string;

  createdAt: Date;
  updatedAt: Date;
}

export interface IWorkflowProgrammeDocument extends IWorkflowProgramme, Document {
  _id: mongoose.Types.ObjectId;
  id: string;
}

const PackageSchema = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    dependsOn: { type: [String], default: [] },

    state: {
      type: String,
      enum: ['pending', 'ready', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'],
      required: true,
      default: 'pending',
    },

    dispatchId: String,
    childInstanceId: String,
    childWorkflowId: String,
    input: { type: Schema.Types.Mixed },

    attempt: { type: Number, default: 0 },
    stallCount: { type: Number, default: 0 },
    dispatchedAt: Date,
    lastProgressAt: Date,
    stalledNotifiedAt: Date,
    failedNotifiedAt: Date,
    completedAt: Date,

    prUrl: String,
    mergedSha: String,
    status: String,
    outcomeSource: { type: String, enum: ['push', 'gh', 'reconciler'] },
    verifiedAt: Date,
    lastVerificationError: String,

    lastError: String,
    notes: String,
  },
  { _id: false, strict: true },
);

const WorkflowProgrammeSchema = new Schema<IWorkflowProgrammeDocument>(
  {
    programmeId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: String,
    state: {
      type: String,
      enum: ['active', 'paused', 'aborted', 'completed', 'failed'],
      required: true,
      default: 'active',
      index: true,
    },

    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ownerEmail: { type: String, required: true },
    partnerKey: String,

    childWorkflowId: { type: String, required: true },
    childInputDefaults: { type: Schema.Types.Mixed },

    slaMinutes: { type: Number, default: 45 },
    maxAttempts: { type: Number, default: 3 },

    packages: { type: [PackageSchema], default: [] },

    leaseOwner: String,
    leaseExpiresAt: Date,

    lastProgressAt: Date,
    lastError: String,

    pausedAt: Date,
    pausedByUserId: String,
    pausedByEmail: String,
    pauseReason: String,
    resumedAt: Date,
    resumedByUserId: String,

    abortedAt: Date,
    abortedByUserId: String,
    abortedByEmail: String,
    abortReason: String,

    completedAt: Date,
    notifiedAt: Date,
    notifiedEvent: { type: String, enum: ['completed', 'failed', 'aborted'] },
    notificationChannel: { type: String, enum: ['communicator', 'task', 'communicator+task', 'none'] },
    notificationError: String,
  },
  {
    timestamps: true,
    collection: 'workflow_programmes',
  },
);

// The reconciler's working set: "which programmes may still advance".
WorkflowProgrammeSchema.index({ state: 1, createdAt: 1 });
// "Which programme owns this dispatch" — the child-report lookup path.
WorkflowProgrammeSchema.index({ 'packages.dispatchId': 1 });
// Owner-scoped list surfaces.
WorkflowProgrammeSchema.index({ ownerUserId: 1, state: 1 });

const WorkflowProgrammeModelName = 'WorkflowProgramme';
const WorkflowProgrammeModel = mongoose.model<IWorkflowProgrammeDocument>(
  WorkflowProgrammeModelName,
  WorkflowProgrammeSchema,
  'workflow_programmes',
);

export default WorkflowProgrammeModel;
