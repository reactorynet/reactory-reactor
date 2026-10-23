import mongoose, { Document, Schema } from 'mongoose';
import { randomBytes } from 'crypto';

/**
 * Durable agent continuation.
 *
 * A continuation is a *durable interest in a future time or signal*. The agent
 * registers one ("wake me when the PR merges, or at 14:00 at the latest"), the
 * record below is inserted, a `reactor.AgentContinuation@1.0.0` workflow instance
 * is started FROM THE LIVE SESSION CONTEXT, and that instance parks on a single
 * `wait_event`. Firing is an event publish; delivery is a conversation turn sent
 * by the workflow instance, so it runs as the session owner.
 *
 * Two invariants are encoded here and must not drift:
 *
 * 1. `correlationKey` is the security boundary. It is 32 random bytes, base64url,
 *    NEVER derived from a session / ticket / todo id, NEVER returned by any list
 *    surface and NEVER logged. It is the `eventKey` the waiting step subscribes to,
 *    so an attacker who cannot guess it cannot wake somebody's agent.
 *
 * 2. Every record is bounded. `fireAt` is mandatory and `expiresAt` is a TTL index,
 *    so a continuation cannot outlive its usefulness — and the deadline is enforced
 *    by the sweeper publishing a sentinel `{ outcome: 'not_observed' }` event on the
 *    same key, NOT by a `wait_event` timeout (which does not exist and which, if
 *    specified, would make the waiter deaf for the timeout duration).
 */

/** How the continuation will be fired. */
export type ContinuationTriggerKind = 'at' | 'event' | 'condition' | 'task' | 'webhook';

/**
 * `at`        — fire at a wall-clock time (the sweeper publishes the event).
 * `event`     — an external producer publishes `eventName` (see `fire`).
 * `condition` — the sweeper evaluates a service method until it reports satisfied.
 * `task`      — a user task completes and signals the same event key.
 * `webhook`   — an authenticated, token-bearing call to `fire`.
 */
export type ContinuationTrigger =
  | { kind: 'at'; at: Date }
  | { kind: 'event'; eventName: string }
  | {
      kind: 'condition';
      serviceId: string;
      method: string;
      params?: Record<string, any>;
      /** Dot-path into the service result, e.g. `result.merged`. */
      expectPath?: string;
      expectValue?: any;
    }
  | { kind: 'task'; taskId?: string }
  | { kind: 'webhook'; label?: string };

/**
 * `pending`   — record inserted, the waiter instance has not armed yet.
 * `armed`     — the instance is parked on `wait_event`.
 * `firing`    — the wake event arrived and delivery is in progress (atomic claim).
 * `fired`     — the observed-resume turn was delivered.
 * `expired`   — the deadline passed without the signal; `expirePrompt` was delivered.
 * `cancelled` — cancelled by the user or a caller.
 * `orphaned`  — the session or its ownership was gone; a visible task was raised.
 * `failed`    — delivery failed after its retry budget; a visible task was raised.
 *
 * Terminal states are never re-entered.
 */
export type ContinuationState =
  | 'pending'
  | 'armed'
  | 'firing'
  | 'fired'
  | 'expired'
  | 'cancelled'
  | 'orphaned'
  | 'failed';

/** What the waiter observed. Both values arrive as EVENT DATA, never as a race. */
export type ContinuationOutcome = 'observed' | 'not_observed';

/** What caused the wake. `expiry` is the sweeper's sentinel. */
export type ContinuationFiredBy =
  | 'signal'
  | 'condition'
  | 'expiry'
  | 'task'
  | 'webhook'
  | 'at';

/**
 * How the owner was told that a continuation ended without a confirmed result.
 *
 * `communicator` is preferred but optional (its public send path is still being
 * repaired), so the task surface is always written as well. `task` alone is the
 * expected value in the current deployment.
 */
export type ContinuationNotificationChannel =
  | 'communicator'
  | 'task'
  | 'communicator+task'
  | 'none';

export interface IAgentContinuation {
  /** The owning chat session. Conversation queries are keyed `{_id, user}`. */
  chatSessionId: string;
  /** The persona that should answer the wake turn. */
  personaId: string;

  /** `_id.toString()` — the id the workflow instance is started with. */
  continuationId: string;
  /** 32 random bytes, base64url. The `eventKey`. Never derived, never exposed. */
  correlationKey: string;

  /** Identity captured at registration and re-asserted at delivery. */
  ownerUserId: mongoose.Types.ObjectId;
  ownerEmail: string;
  partnerKey?: string;

  trigger: ContinuationTrigger;
  /** Human-readable "what am I waiting for" — shown to the user. */
  reason: string;
  /** Sent as the wake turn when the signal WAS observed. */
  resumePrompt: string;
  /** Sent as the wake turn when the deadline passed. Required. */
  expirePrompt: string;

  state: ContinuationState;
  /** The deadline. Mandatory: every continuation is bounded. */
  fireAt: Date;
  firedAt?: Date;
  firedBy?: ContinuationFiredBy;
  outcome?: ContinuationOutcome;

  /** The durable waiter (register-then-wait: started at registration). */
  workflowInstanceId?: string;

  /** Delivery attempts consumed (send retries + crash recovery). */
  attempt: number;
  maxAttempts: number;
  lastError?: string;

  /**
   * When the wake event was published. Kept separate from `firedAt` (which is set
   * by `deliver`) so the sweeper can be idempotent: it will not re-publish an event
   * it already sent, except after `republishAfterMs` when the record is still
   * parked (a publish that woke nothing, e.g. a crash before the step resumed).
   */
  eventPublishedAt?: Date;
  eventOutcome?: ContinuationOutcome;
  /**
   * Why the wake event said what it said (`time_reached`, `deadline_passed`,
   * `time_passed_unswept`, `wake_published_not_delivered`, `condition_satisfied`).
   *
   * Persisted because the distinction is user-facing: an `at` wait whose fire time
   * passed while the sweeper was down never saw its signal *at all*, whereas a
   * deadline with no signal is a different story. Recording it at publish time is
   * the only place that knowledge exists.
   */
  eventReason?: string;

  wakeMessageId?: string;

  /**
   * Evidence that the owner was told a wait ended without a confirmed result.
   * `notificationChannel` is the surface that actually accepted the message, so
   * "never silent" is checkable after the fact rather than a claim in a comment.
   */
  notifiedAt?: Date;
  notificationChannel?: ContinuationNotificationChannel;
  notificationError?: string;

  createdAt: Date;
  updatedAt: Date;
  /** TTL index — hard garbage collection of terminal records. */
  expiresAt: Date;
}

export interface IAgentContinuationDocument extends IAgentContinuation, Document {
  _id: mongoose.Types.ObjectId;
  id: string;
}

/**
 * Mint the correlation key.
 *
 * 32 bytes ⇒ 256 bits of entropy, base64url ⇒ 43 URL-safe characters, which is
 * long enough that guessing is not a threat model and short enough to travel as an
 * event key without escaping.
 */
export function generateCorrelationKey(): string {
  return randomBytes(32).toString('base64url');
}

const ContinuationTriggerSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ['at', 'event', 'condition', 'task', 'webhook'],
      required: true,
    },
    at: Date,
    eventName: String,
    serviceId: String,
    method: String,
    params: Schema.Types.Mixed,
    expectPath: String,
    expectValue: Schema.Types.Mixed,
    taskId: String,
    label: String,
  },
  { _id: false, strict: false },
);

const AgentContinuationSchema = new Schema<IAgentContinuationDocument>(
  {
    continuationId: { type: String, required: true, unique: true },
    // The credential. Unique so a collision (impossible in practice) can never
    // silently cross-wire two waits.
    correlationKey: { type: String, required: true, unique: true },

    chatSessionId: { type: String, required: true, index: true },
    personaId: { type: String, required: true },

    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ownerEmail: { type: String, required: true },
    partnerKey: { type: String },

    trigger: { type: ContinuationTriggerSchema, required: true },
    reason: { type: String, required: true },
    resumePrompt: { type: String, required: true },
    // Required, deliberately: the honesty of an expiry depends on the agent being
    // told, in data it cannot edit, that the thing did NOT happen.
    expirePrompt: { type: String, required: true },

    state: {
      type: String,
      enum: ['pending', 'armed', 'firing', 'fired', 'expired', 'cancelled', 'orphaned', 'failed'],
      required: true,
      default: 'pending',
    },

    fireAt: { type: Date, required: true },
    firedAt: Date,
    firedBy: {
      type: String,
      enum: ['signal', 'condition', 'expiry', 'task', 'webhook', 'at'],
    },
    outcome: { type: String, enum: ['observed', 'not_observed'] },

    workflowInstanceId: { type: String },

    attempt: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 2 },
    lastError: String,

    eventPublishedAt: Date,
    eventOutcome: { type: String, enum: ['observed', 'not_observed'] },
    eventReason: String,

    wakeMessageId: String,

    notifiedAt: Date,
    notificationChannel: {
      type: String,
      enum: ['communicator', 'task', 'communicator+task', 'none'],
    },
    notificationError: String,

    createdAt: { type: Date, required: true, default: Date.now },
    updatedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: false,
    collection: 'reactor_continuations',
  },
);

// The sweeper's working set: "which parked waits are due".
AgentContinuationSchema.index({ state: 1, fireAt: 1 });
// Per-session caps and serialisation of wake turns.
AgentContinuationSchema.index({ chatSessionId: 1, state: 1 });
// "What is this user waiting on" — owner-scoped list surfaces.
AgentContinuationSchema.index({ ownerUserId: 1, state: 1 });
// Hard garbage collection. `expireAfterSeconds: 0` means "delete at expiresAt".
AgentContinuationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

AgentContinuationSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

const AgentContinuationModelName = 'AgentContinuation';
const AgentContinuationModel = mongoose.model<IAgentContinuationDocument>(
  AgentContinuationModelName,
  AgentContinuationSchema,
  'reactor_continuations',
);

export default AgentContinuationModel;
