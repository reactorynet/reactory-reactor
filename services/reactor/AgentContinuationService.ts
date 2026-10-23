import Reactory from '@reactorynet/reactory-core';
import mongoose from 'mongoose';
import { service } from '@reactory/server-core/application/decorators/service';
import logger from '@reactory/server-core/logging';
import AgentContinuationModel, {
  IAgentContinuation,
  ContinuationTrigger,
  ContinuationState,
  ContinuationOutcome,
  ContinuationFiredBy,
  generateCorrelationKey,
} from '../../models/AgentContinuation';
import ReactorConversationModel from '../../models/ReactorChatState';
import { StreamingMode } from './types/streaming.types';

/**
 * reactor.AgentContinuationService@1.0.0
 *
 * The only component in the platform that knows how to park an agent and wake it
 * again. See `models/AgentContinuation.ts` for the invariants and
 * `workflow/AgentContinuation.yaml` for the durable waiter.
 *
 * ── The one architecturally important decision: register-then-wait ────────────
 *
 * `register()` starts the `reactor.AgentContinuation@1.0.0` workflow FROM THE
 * CALLER'S LIVE SESSION CONTEXT. That single choice is what makes attribution
 * correct: `WorkflowRunner.buildYamlWorkflowData` seeds `data.__identity` from the
 * *start* context, and `YamlFlowRuntime.createWorkflowContext` rebuilds each step's
 * Reactory context from it. So `deliver()` — which runs inside that instance hours
 * later — holds the OWNER's context, and
 * `ReactorConversationService.sendMessage` (whose queries are all
 * `{ _id: chatSessionId, user: this.context.user }`) attributes the wake turn to
 * the owner with no impersonation API.
 *
 * The alternative (start the workflow at fire time from the sweeper) would hold
 * the SYSTEM context: `createWorkflowContext` silently falls back to
 * `state.systemContext` when identity is absent, so the owner-scoped conversation
 * query would fail closed hours later, per fire, unwatched.
 *
 * ── The other decision: expiry is data, never a timeout ──────────────────────
 *
 * `wait_event` has no timer, and specifying `timeout` makes the subscription
 * *deaf* for that duration (`effectiveDate` is a watermark on event time, not a
 * deadline). So the waiter carries no `timeout` key at all; the sweeper publishes
 * `{ outcome: 'not_observed' }` on the same correlation key at `fireAt`. Observed
 * and expired therefore arrive as data on the same path, never as a race between a
 * signal and a clock.
 *
 * ── `correlationKey` ─────────────────────────────────────────────────────────
 *
 * 32 random bytes, base64url. It is the event key — the credential that authorises
 * a wake. It is never derived from a session / ticket / todo id, never returned by
 * `list()` (see `toPublicView`), and never written to a log line by this file.
 */

/** The single event name every continuation waits on. */
export const CONTINUATION_EVENT_NAME = 'agent.continuation.wake';

/** The YAML workflow that parks, and is woken by, one continuation. */
export const CONTINUATION_WORKFLOW_ID = 'reactor.AgentContinuation@1.0.0';

/** How many non-terminal continuations one chat session may hold. */
export const MAX_PENDING_PER_SESSION = 3;

/** Minimum gap between two wake turns on one session. */
export const MIN_INTERVAL_MS = 60_000;

/** Bounds on the deadline. A continuation is never open-ended. */
export const MIN_TTL_MS = 5_000;
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A `firing` record older than this is assumed to have crashed mid-delivery. */
export const DEFAULT_STALE_FIRING_MS = 120_000;

/**
 * How long an already-published wake event is trusted. After this the sweeper may
 * publish again, because a publish that woke nothing (crash, restart, a lost
 * event) must be retried or the record would sit parked forever.
 */
export const DEFAULT_REPUBLISH_AFTER_MS = 180_000;

/** States that still have a waiter (or are about to). */
export const ACTIVE_STATES: ContinuationState[] = ['pending', 'armed', 'firing'];

/** States that can never be re-entered. */
export const TERMINAL_STATES: ContinuationState[] = [
  'fired',
  'expired',
  'cancelled',
  'orphaned',
  'failed',
];

export type ContinuationRefusalCode =
  | 'no_session'
  | 'no_identity'
  | 'system_caller'
  | 'session_not_owned'
  | 'over_cap'
  | 'rate_limited'
  | 'over_budget'
  | 'invalid_trigger'
  | 'invalid_ttl'
  | 'duplicate';

export interface IRegisterContinuationInput {
  chatSessionId: string;
  personaId?: string;
  reason: string;
  resumePrompt: string;
  expirePrompt: string;
  trigger: ContinuationTrigger;
  ttlMs: number;
}

export interface IRegisterContinuationResult {
  registered: boolean;
  continuationId?: string;
  fireAt?: string;
  state?: ContinuationState;
  code?: ContinuationRefusalCode;
  /** Actionable, model-facing explanation. Never contains the correlation key. */
  error?: string;
}

export interface IContinuationPublicView {
  continuationId: string;
  chatSessionId: string;
  personaId: string;
  reason: string;
  triggerKind: string;
  triggerSummary: string;
  state: ContinuationState;
  fireAt: string;
  firedAt?: string;
  firedBy?: ContinuationFiredBy;
  outcome?: ContinuationOutcome;
  attempt: number;
  maxAttempts: number;
  lastError?: string;
  workflowInstanceId?: string;
  createdAt: string;
  updatedAt: string;
}

/** What the waiter workflow is allowed to see. No prompts, no owner email. */
export interface IContinuationWaiterView {
  continuationId: string;
  /** The event key. Workflow-internal only — see the module note above. */
  correlationKey: string;
  state: ContinuationState;
  fireAt: string;
}

export interface IContinuationFirePlanEntry {
  continuationId: string;
  outcome: ContinuationOutcome;
  firedBy: ContinuationFiredBy;
  reason: string;
}

export interface IDeliverResult {
  delivered: boolean;
  state?: ContinuationState;
  outcome?: ContinuationOutcome;
  wakeMessageId?: string;
  reason?: string;
  error?: string;
}

const REFUSAL_HINTS: Record<ContinuationRefusalCode, string> = {
  no_session:
    'No chat session is attached to this call, so there is nothing to wake later. Tell the user you cannot schedule a follow-up from here and ask them to continue in an active chat session.',
  no_identity:
    'This call has no authenticated user, so a wake turn could not be attributed to anyone. Tell the user you cannot register a follow-up.',
  system_caller:
    'Continuations cannot be registered by the system account: the wake turn must belong to a real user. Tell the user you cannot register a follow-up on their behalf from here.',
  session_not_owned:
    'That chat session does not belong to the current user, so waking it would deliver a turn to somebody else. Ask the user to continue in their own session.',
  over_cap:
    `This session already holds ${MAX_PENDING_PER_SESSION} pending continuations. Wait for one to fire or cancel one with cancelContinuation before registering another.`,
  rate_limited:
    'A continuation fired on this session in the last minute. Wait for the current turn to settle before registering another and do not promise a new wait yet.',
  over_budget:
    'The AI usage budget for this user is exhausted, so a future wake turn could not be answered. Tell the user the wait cannot be scheduled until the budget is raised.',
  invalid_trigger:
    'The wait was not described in a form this system can honour. Supply exactly one of: a future ISO date-time (at), an eventName, a condition, or a task id.',
  invalid_ttl:
    `ttlMs is required and must be between ${MIN_TTL_MS} and ${MAX_TTL_MS} milliseconds — every continuation must have a deadline.`,
  duplicate:
    'An identical continuation is already pending for this session and reason. Use listContinuations to see it instead of registering a second one.',
};

/**
 * Format a refusal so a model can report honestly instead of promising.
 * Deliberately a plain object, not a thrown error: a refusal is a normal outcome,
 * and the macro surfaces `error` verbatim.
 */
export function refusal(code: ContinuationRefusalCode, detail?: string): IRegisterContinuationResult {
  return {
    registered: false,
    code,
    error: detail ? `${REFUSAL_HINTS[code]} (${detail})` : REFUSAL_HINTS[code],
  };
}

/** True when the given user document is the platform's system account. */
export function isSystemIdentity(user: any): boolean {
  if (!user) return false;
  const systemEmail = String(process.env.SYSTEM_USER_EMAIL || '').trim().toLowerCase();
  const systemId = String(process.env.SYSTEM_USER_ID || '').trim();
  const email = String(user.email || '').trim().toLowerCase();
  const id = String(user._id || user.id || '').trim();
  if (systemEmail && email && email === systemEmail) return true;
  if (systemId && id && id === systemId) return true;
  return false;
}

/**
 * Strict outcome parsing.
 *
 * Returns `null` for anything that is not EXACTLY one of the two sentinel values —
 * including `undefined`, `null`, `''` and an unresolved template token.
 *
 * This exists because the two values choose which prompt is sent, so a lenient
 * `=== 'not_observed' ? 'not_observed' : 'observed'` would make every unrecognised
 * input mean "the signal arrived". That is precisely the failure this feature
 * exists to remove, and it is reachable: `signalWorkflowInstance(instanceId)`
 * (GraphQL) and `workflow signal` (CLI) both wake a parked instance with eventData
 * `{}`, and `BaseYamlStep.resolveTemplate` leaves an unresolvable `${...}` as the
 * original token, so a payload without `outcome` reaches the step as the literal
 * string `"${variables.wake.outcome}"`.
 */
export function parseOutcome(raw: any): ContinuationOutcome | null {
  return raw === 'observed' || raw === 'not_observed' ? raw : null;
}

/** Safe, truncated rendering of a received value for `lastError` and logs. */
export function describeReceivedOutcome(raw: any): string {
  if (raw === undefined) return 'undefined (no outcome in the wake payload)';
  if (raw === null) return 'null';
  let text: string;
  try {
    text = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? String(raw);
  } catch {
    text = String(raw);
  }
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** Human-readable one-liner for the trigger, for lists and UI. */
export function describeTrigger(trigger: ContinuationTrigger | undefined): string {
  if (!trigger) return 'unknown';
  switch (trigger.kind) {
    case 'at':
      return `at ${new Date(trigger.at).toISOString()}`;
    case 'event':
      return `on event ${trigger.eventName}`;
    case 'condition':
      return `when ${trigger.serviceId}.${trigger.method} satisfies ${trigger.expectPath || 'the predicate'}`;
    case 'task':
      return trigger.taskId ? `on task ${trigger.taskId}` : 'on task completion';
    case 'webhook':
      return `on webhook ${trigger.label || '(unlabelled)'}`;
    default:
      return 'unknown';
  }
}

/**
 * The public projection. **Never** include `correlationKey` here — this is the
 * only shape any list/GraphQL surface is allowed to expose.
 */
export function toPublicView(doc: any): IContinuationPublicView {
  return {
    continuationId: String(doc.continuationId),
    chatSessionId: String(doc.chatSessionId),
    personaId: String(doc.personaId),
    reason: String(doc.reason),
    triggerKind: String(doc.trigger?.kind || 'unknown'),
    triggerSummary: describeTrigger(doc.trigger),
    state: doc.state,
    fireAt: new Date(doc.fireAt).toISOString(),
    firedAt: doc.firedAt ? new Date(doc.firedAt).toISOString() : undefined,
    firedBy: doc.firedBy,
    outcome: doc.outcome,
    attempt: Number(doc.attempt || 0),
    maxAttempts: Number(doc.maxAttempts || 0),
    lastError: doc.lastError,
    workflowInstanceId: doc.workflowInstanceId,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

/**
 * Decide whether a parked record should be fired by the sweeper.
 *
 * Pure on purpose: the ordering rules that make expiry deterministic are the part
 * most worth testing without a database or an engine.
 *
 * Order of precedence:
 *  1. an `at` trigger whose time has arrived and whose deadline has not passed
 *     fires as OBSERVED (the thing the agent waited for really happened);
 *  2. otherwise, a reached deadline fires as NOT OBSERVED;
 *  3. a satisfied `condition` before the deadline fires as OBSERVED.
 *
 * Deadlines win over unsatisfied conditions, always — that is what makes
 * "it did not happen" impossible to report as "it happened".
 */
export function planTriggerDecision(
  record: Pick<IAgentContinuation, 'trigger' | 'fireAt'>,
  now: Date,
  conditionSatisfied: boolean = false,
): { outcome: ContinuationOutcome; firedBy: ContinuationFiredBy; reason: string } | null {
  const nowMs = now.getTime();
  const fireAtMs = new Date(record.fireAt).getTime();
  const trigger: any = record.trigger;

  if (trigger?.kind === 'at' && trigger.at) {
    const atMs = new Date(trigger.at).getTime();
    if (nowMs >= atMs && nowMs < fireAtMs) {
      return { outcome: 'observed', firedBy: 'at', reason: 'time_reached' };
    }
  }

  if (nowMs >= fireAtMs) {
    return { outcome: 'not_observed', firedBy: 'expiry', reason: 'deadline_passed' };
  }

  if (trigger?.kind === 'condition' && conditionSatisfied) {
    return { outcome: 'observed', firedBy: 'condition', reason: 'condition_satisfied' };
  }

  return null;
}

/**
 * `lifeCycle` is left at the decorator default (`instance`): the service is built
 * with whatever context resolves it, which is exactly what makes `deliver()` run
 * as the instance's identity rather than as a shared singleton's last caller.
 */
@service({
  id: 'reactor.AgentContinuationService@1.0.0',
  name: 'Agent Continuation Service',
  nameSpace: 'reactor',
  version: '1.0.0',
  description:
    'Durable agent continuation: parks an agent until a future time or signal, then wakes it as the session owner.',
  serviceType: 'ai',
})
class AgentContinuationService {
  context: Reactory.Server.IReactoryContext;

  description = 'Durable agent continuation: parks an agent until a future time or signal, then wakes it as the session owner.';

  /**
   * Backoff between delivery attempts, in ms. A field rather than a constant so a
   * test can drive the retry path without sleeping; production keeps the 750ms.
   */
  deliveryRetryDelayMs = 750;
  nameSpace = 'reactor';
  name = 'Agent Continuation Service';
  version = '1.0.0';
  tags: string[] = ['reactor', 'ai', 'agent', 'continuation', 'durable', 'workflow'];

  constructor(_props: Reactory.Service.IReactoryServiceProps, context: Reactory.Server.IReactoryContext) {
    this.context = context;
  }

  toString(includeVersion?: boolean): string {
    return `AgentContinuationService${includeVersion ? '@1.0.0' : ''}`;
  }

  // ── registration ───────────────────────────────────────────────────────────

  /**
   * Register a durable interest and start its waiter.
   *
   * Order is load-bearing:
   *   1. assert a real, non-system caller and a session the caller owns;
   *   2. enforce the caps (pending count, fire rate, budget, ttl);
   *   3. insert `{ state: 'pending' }`;
   *   4. AWAIT `startWorkflow(...)` and persist the instance id;
   *   5. on start failure delete the record and THROW.
   *
   * Step 5 is the honesty gate: the model must never be told "registered" when
   * nothing is actually waiting.
   */
  async register(input: IRegisterContinuationInput): Promise<IRegisterContinuationResult> {
    const user: any = (this.context as any)?.user;
    if (!user || !user._id) return refusal('no_identity');
    if (isSystemIdentity(user)) return refusal('system_caller');

    const chatSessionId = String(input?.chatSessionId || '').trim();
    if (!chatSessionId || !mongoose.Types.ObjectId.isValid(chatSessionId)) return refusal('no_session');

    const trigger = input?.trigger;
    const triggerError = this.validateTrigger(trigger);
    if (triggerError) return refusal('invalid_trigger', triggerError);

    const ttlMs = Number(input?.ttlMs);
    if (!Number.isFinite(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
      return refusal('invalid_ttl');
    }

    const reason = String(input?.reason || '').trim();
    const resumePrompt = String(input?.resumePrompt || '').trim();
    const expirePrompt = String(input?.expirePrompt || '').trim();
    if (!reason || !resumePrompt || !expirePrompt) {
      return refusal(
        'invalid_trigger',
        'reason, resumePrompt and expirePrompt are all required — expirePrompt is what stops the agent reporting an unobserved signal as fact',
      );
    }

    // 1. Ownership. A continuation is delivered under the owner's identity, so the
    // session must actually be theirs; otherwise the wake turn would either fail
    // closed later or (worse) be attributed to the wrong person.
    const session = await ReactorConversationModel.findOne({
      _id: new mongoose.Types.ObjectId(chatSessionId),
      user: user._id,
    } as any)
      .select('_id personaId')
      .lean()
      .exec() as any;

    if (!session) return refusal('session_not_owned', `session ${chatSessionId}`);

    const personaId = String(input?.personaId || session.personaId || '').trim();
    if (!personaId) return refusal('invalid_trigger', 'no personaId could be resolved for the session');

    const now = new Date();

    // 2a. Per-session concurrency cap.
    const activeCount = await AgentContinuationModel.countDocuments({
      chatSessionId,
      state: { $in: ACTIVE_STATES },
    } as any).exec();
    if (activeCount >= MAX_PENDING_PER_SESSION) {
      return refusal('over_cap', `${activeCount} active on session ${chatSessionId}`);
    }

    // 2b. Fire-rate cap: at most one wake turn per session per minute.
    const lastFired = await AgentContinuationModel.findOne({
      chatSessionId,
      firedAt: { $exists: true },
    } as any)
      .sort({ firedAt: -1 })
      .select('firedAt')
      .lean()
      .exec() as any;
    if (lastFired?.firedAt) {
      const sinceLast = now.getTime() - new Date(lastFired.firedAt).getTime();
      if (sinceLast < MIN_INTERVAL_MS) {
        return refusal('rate_limited', `${Math.round((MIN_INTERVAL_MS - sinceLast) / 1000)}s remaining`);
      }
    }

    // 2c. Budget. A wake turn is a billable turn; refusing here is the difference
    // between "I will check back" and "I will check back and then discover I cannot".
    const budgetRefusal = await this.checkBudget(String(user._id));
    if (budgetRefusal) return refusal('over_budget', budgetRefusal);

    // 2d. Duplicate guard (same session, same reason, still active).
    const duplicate = await AgentContinuationModel.findOne({
      chatSessionId,
      reason,
      state: { $in: ACTIVE_STATES },
    } as any).exec();
    if (duplicate) {
      return refusal('duplicate', `continuationId ${duplicate.continuationId} already covers it`);
    }

    const fireAt = new Date(now.getTime() + ttlMs);
    // The TTL outlives the deadline so `list()` can still show an expired record
    // for a while after it fires; the deadline itself is enforced by `fireAt`.
    const expiresAt = new Date(fireAt.getTime() + 7 * 24 * 60 * 60 * 1000);

    const continuationId = new mongoose.Types.ObjectId();
    const correlationKey = generateCorrelationKey();

    // 3. Insert the record BEFORE starting the waiter, so the instance's first
    // step (`get`) has something to read.
    const record = new AgentContinuationModel({
      _id: continuationId,
      continuationId: continuationId.toString(),
      correlationKey,
      chatSessionId,
      personaId,
      ownerUserId: user._id,
      ownerEmail: String(user.email || ''),
      partnerKey: (this.context as any)?.partner?.key,
      trigger,
      reason,
      resumePrompt,
      expirePrompt,
      state: 'pending',
      fireAt,
      attempt: 0,
      maxAttempts: 2,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });
    await record.save();

    // 4. Start the waiter from THIS context. `startWorkflow` threads `this.context`
    // into `buildYamlWorkflowData`, which is what makes `__identity` the owner.
    try {
      const workflowService = this.getWorkflowService();
      if (!workflowService) throw new Error('core.ReactoryWorkflowService@1.0.0 is not available');
      const instance: any = await workflowService.startWorkflow(CONTINUATION_WORKFLOW_ID, {
        input: { continuationId: continuationId.toString() },
      });
      const instanceId = instance?.id || instance?._id;
      if (!instanceId) throw new Error('startWorkflow returned no instance id');

      // 5. Adopt the instance id. Non-fatal on failure: the waiter is running and
      // the sweeper can still fire by correlation key; we just lose the pointer.
      try {
        await AgentContinuationModel.updateOne(
          { continuationId: continuationId.toString() } as any,
          { $set: { workflowInstanceId: String(instanceId), updatedAt: new Date() } } as any,
        ).exec();
      } catch (adoptError: any) {
        this.log('warn', 'continuation registered but the instance id could not be persisted', {
          continuationId: continuationId.toString(),
          error: adoptError?.message,
        });
      }

      this.log('info', 'continuation registered', {
        continuationId: continuationId.toString(),
        chatSessionId,
        trigger: trigger.kind,
        fireAt: fireAt.toISOString(),
      });

      return {
        registered: true,
        continuationId: continuationId.toString(),
        fireAt: fireAt.toISOString(),
        state: 'pending',
      };
    } catch (error: any) {
      // 6. Nothing is waiting ⇒ no record may survive and the caller MUST learn it.
      try {
        await AgentContinuationModel.deleteOne({ _id: continuationId } as any).exec();
      } catch (cleanupError: any) {
        this.log('error', 'continuation start failed AND the record could not be removed', {
          continuationId: continuationId.toString(),
          error: cleanupError?.message,
        });
      }
      this.log('error', 'continuation start failed; record removed', {
        continuationId: continuationId.toString(),
        error: error?.message,
      });
      throw new Error(
        `Could not start the continuation waiter (${error?.message || 'unknown error'}). ` +
          'Nothing is waiting, so do not tell the user a follow-up has been scheduled.',
      );
    }
  }

  /** Cancel a waiting continuation. Owner-only; an internal (no-user) caller may too. */
  async cancel(input: { continuationId: string; reason?: string }): Promise<{ cancelled: boolean; reason?: string }> {
    const continuationId = String(input?.continuationId || '').trim();
    if (!continuationId) return { cancelled: false, reason: 'continuationId is required' };

    const record = await AgentContinuationModel.findOne({ continuationId } as any).exec();
    if (!record) return { cancelled: false, reason: 'not_found' };

    const user: any = (this.context as any)?.user;
    if (user?._id && !isSystemIdentity(user) && String(record.ownerUserId) !== String(user._id)) {
      return { cancelled: false, reason: 'not_owner' };
    }
    if (TERMINAL_STATES.includes(record.state)) {
      return { cancelled: false, reason: `already_${record.state}` };
    }

    const updated = await AgentContinuationModel.findOneAndUpdate(
      { continuationId, state: { $in: ACTIVE_STATES } } as any,
      {
        $set: {
          state: 'cancelled',
          lastError: input?.reason ? String(input.reason) : undefined,
          updatedAt: new Date(),
        },
      } as any,
      { new: true },
    ).exec();

    if (updated?.workflowInstanceId) {
      try {
        await this.getWorkflowService()?.cancelWorkflowInstance(updated.workflowInstanceId);
      } catch (error: any) {
        this.log('warn', 'continuation cancelled but its instance could not be cancelled', {
          continuationId,
          error: error?.message,
        });
      }
    }

    return { cancelled: Boolean(updated) };
  }

  /**
   * Sanitised list for the owner. **Never** returns `correlationKey` — see
   * `toPublicView`. GraphQL/list surfaces must use this, never `get`.
   */
  async list(input?: {
    chatSessionId?: string;
    state?: ContinuationState;
    includeTerminal?: boolean;
    limit?: number;
  }): Promise<IContinuationPublicView[]> {
    const user: any = (this.context as any)?.user;
    if (!user?._id) return [];

    const filter: any = { ownerUserId: user._id };
    if (input?.chatSessionId) filter.chatSessionId = String(input.chatSessionId);
    if (input?.state) filter.state = input.state;
    else if (!input?.includeTerminal) filter.state = { $in: ACTIVE_STATES };

    const limit = Math.min(Math.max(Number(input?.limit) || 20, 1), 100);
    const docs = await AgentContinuationModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    return (docs as any[]).map(toPublicView);
  }

  /**
   * Waiter-internal read. Returns the correlation key because the waiting step
   * needs it as its `eventKey` — which makes this the one method that hands out the
   * wake credential. It is therefore gated to the two callers that legitimately
   * hold it:
   *
   *   - **the waiter**, whose Reactory context is rebuilt from `data.__identity`
   *     and is therefore the OWNER. A different authenticated user is refused;
   *     because `list()` exposes `continuationId`s, an unguarded `get()` would let
   *     any caller that learned one mint a wake event for somebody else's session.
   *   - **an internal caller with no user on its context** (the sweeper, platform
   *     tooling). There is nothing to attribute, and such a caller already has
   *     database access.
   *
   * The state gate matters as much as the caller gate: a terminal record has no
   * waiter left, so its key can only be used to publish a wake nobody will
   * receive. `list()` stays the surface for everything else, and never carries the
   * key.
   */
  async get(input: { continuationId: string }): Promise<IContinuationWaiterView | null> {
    const continuationId = String(input?.continuationId || '').trim();
    if (!continuationId) return null;
    const doc: any = await AgentContinuationModel.findOne({ continuationId } as any).lean().exec();
    if (!doc) return null;

    const user: any = (this.context as any)?.user;
    if (user?._id && String(doc.ownerUserId) !== String(user._id)) {
      this.log('warn', 'continuation get() refused — caller is not the owner', { continuationId });
      return null;
    }

    if (!['pending', 'armed'].includes(doc.state)) return null;

    return {
      continuationId: String(doc.continuationId),
      correlationKey: String(doc.correlationKey),
      state: doc.state,
      fireAt: new Date(doc.fireAt).toISOString(),
    };
  }

  /** Step 1 of the waiter: `pending` → `armed`. Conditional, so it is idempotent. */
  async markArmed(input: { continuationId: string }): Promise<{ armed: boolean; state?: ContinuationState }> {
    const continuationId = String(input?.continuationId || '').trim();
    if (!continuationId) return { armed: false };
    const updated: any = await AgentContinuationModel.findOneAndUpdate(
      { continuationId, state: 'pending' } as any,
      { $set: { state: 'armed', updatedAt: new Date() } } as any,
      { new: true },
    ).exec();
    return { armed: Boolean(updated), state: updated?.state };
  }

  /**
   * The idempotency hinge. Claiming is an atomic conditional transition, so two
   * firers cannot both win and a duplicate wake event cannot become a duplicate
   * turn.
   *
   * The predicate accepts `pending` as well as `armed` on purpose: the waiter
   * inserts the record as `pending` and arms a few milliseconds later, so a sweep
   * that lands in that window must still be able to deliver. Anything already
   * `firing` or terminal does not match, which is what makes a double fire a no-op.
   */
  async claim(input: { continuationId: string }): Promise<{ claimed: boolean; record?: any }> {
    const continuationId = String(input?.continuationId || '').trim();
    if (!continuationId) return { claimed: false };
    const updated: any = await AgentContinuationModel.findOneAndUpdate(
      { continuationId, state: { $in: ['pending', 'armed'] } } as any,
      { $set: { state: 'firing', updatedAt: new Date() }, $inc: { attempt: 1 } } as any,
      { new: true },
    )
      .lean()
      .exec();
    return { claimed: Boolean(updated), record: updated || undefined };
  }

  /**
   * Close a claimed record with its outcome. Conditional on `firing`, so it can
   * never overwrite a cancellation or an orphan that raced the delivery.
   */
  async complete(input: {
    continuationId: string;
    outcome: ContinuationOutcome;
    firedBy?: ContinuationFiredBy;
    wakeMessageId?: string;
  }): Promise<{ completed: boolean; state?: ContinuationState }> {
    const continuationId = String(input?.continuationId || '').trim();
    if (!continuationId) return { completed: false };
    const state: ContinuationState = input?.outcome === 'not_observed' ? 'expired' : 'fired';
    const updated: any = await AgentContinuationModel.findOneAndUpdate(
      { continuationId, state: 'firing' } as any,
      {
        $set: {
          state,
          outcome: input.outcome,
          firedAt: new Date(),
          firedBy: input?.firedBy || (input.outcome === 'not_observed' ? 'expiry' : 'signal'),
          wakeMessageId: input?.wakeMessageId,
          updatedAt: new Date(),
        },
      } as any,
      { new: true },
    ).exec();
    return { completed: Boolean(updated), state: updated?.state };
  }

  /**
   * The session (or its ownership) is gone. Visible, never silent: the record goes
   * `orphaned` and the owner gets a non-blocking task in the task list.
   */
  async orphan(input: { continuationId: string; reason: string }): Promise<{ orphaned: boolean }> {
    const continuationId = String(input?.continuationId || '').trim();
    if (!continuationId) return { orphaned: false };
    const result = await this.markTerminalWithVisibility(
      continuationId,
      'orphaned',
      String(input?.reason || 'the wake could not be attributed to the owner'),
    );
    return { orphaned: result.updated };
  }

  // ── sweeping ───────────────────────────────────────────────────────────────
  /**
   * The sweeper's plan: which records are due, and what the event should say.
   *
   * Reads only — publishing is `fire()`, one record at a time, so a failure to
   * publish one continuation cannot lose the rest of the plan.
   */
  async claimDue(input?: {
    now?: string | Date;
    limit?: number;
    republishAfterMs?: number;
  }): Promise<{ due: number; plan: IContinuationFirePlanEntry[] }> {
    const now = input?.now ? new Date(input.now) : new Date();
    const limit = Math.min(Math.max(Number(input?.limit) || 50, 1), 200);
    const republishAfterMs = Number(input?.republishAfterMs) || DEFAULT_REPUBLISH_AFTER_MS;
    const republishBefore = new Date(now.getTime() - republishAfterMs);

    // No upper bound on `fireAt`: a `condition` trigger can become satisfied long
    // before its deadline, and a wait that is due but whose event was already
    // published is filtered by `eventPublishedAt` below. The scan is bounded by the
    // `{ state, fireAt }` index and by `limit`.
    const candidates: any[] = await AgentContinuationModel.find({
      state: { $in: ['pending', 'armed'] },
      expiresAt: { $gt: now },
      $or: [
        { eventPublishedAt: { $exists: false } },
        { eventPublishedAt: null },
        { eventPublishedAt: { $lt: republishBefore } },
      ],
    } as any)
      .sort({ fireAt: 1 })
      .limit(limit)
      .lean()
      .exec();

    const plan: IContinuationFirePlanEntry[] = [];
    for (const record of candidates as any[]) {
      let conditionSatisfied = false;
      if (record.trigger?.kind === 'condition') {
        conditionSatisfied = await this.evaluateCondition(record);
      }

      const decision = planTriggerDecision(record, now, conditionSatisfied);
      if (!decision) continue;

      plan.push({
        continuationId: String(record.continuationId),
        outcome: decision.outcome,
        firedBy: decision.firedBy,
        reason: decision.reason,
      });
    }

    return { due: plan.length, plan };
  }

  /**
   * Publish the wake event for one continuation.
   *
   * `source: 'webhook'` requires the caller to present the correlation key as
   * `token` — that is the only externally reachable path, and the key is the
   * credential. The sweeper passes `source: 'sweeper'` from inside the platform.
   *
   * The tenant comes from the WAITING INSTANCE, exactly as
   * `ReactoryWorkflowService.signalWorkflowInstance` does: event subscriptions are
   * matched strictly by tenant, so publishing from the sweeper's own context would
   * silently wake nothing whenever the instance runs under a different tenant.
   */
  async fire(input: {
    continuationId: string;
    outcome?: ContinuationOutcome;
    firedBy?: ContinuationFiredBy;
    reason?: string;
    source?: string;
    token?: string;
  }): Promise<{ fired: boolean; reason?: string; error?: string }> {
    const continuationId = String(input?.continuationId || '').trim();
    if (!continuationId) return { fired: false, reason: 'continuationId is required' };

    const record: any = await AgentContinuationModel.findOne({ continuationId } as any).lean().exec();
    if (!record) return { fired: false, reason: 'not_found' };
    if (TERMINAL_STATES.includes(record.state)) return { fired: false, reason: `already_${record.state}` };

    const source = String(input?.source || 'service');
    if (source === 'webhook') {
      if (!input?.token || String(input.token) !== String(record.correlationKey)) {
        return { fired: false, reason: 'invalid_token' };
      }
    }

    const outcome: ContinuationOutcome = input?.outcome === 'not_observed' ? 'not_observed' : 'observed';
    const firedBy: ContinuationFiredBy =
      input?.firedBy || (outcome === 'not_observed' ? 'expiry' : 'signal');

    const workflowService = this.getWorkflowService();
    if (!workflowService) return { fired: false, reason: 'workflow_service_unavailable' };

    let tenantId: string | undefined;
    if (record.workflowInstanceId) {
      try {
        const instance: any = await workflowService.getWorkflowHistoryById(record.workflowInstanceId);
        tenantId = instance?.tenantId || undefined;
      } catch (error: any) {
        this.log('warn', 'could not read the waiting instance; falling back to the caller tenant', {
          continuationId,
          error: error?.message,
        });
      }
    }

    // Fall back to the caller's tenant when the instance is unreadable or its id was
    // never persisted. This is reachable: `register` logs and continues when the
    // adopt write fails, and an instance can be pruned. `publishWorkflowEvent`
    // would resolve `undefined` the same way, but doing it explicitly keeps the
    // behaviour visible here. Residual: for a tenant user the sweeper's partner may
    // differ from the instance's tenant, and the engine would then drop the event
    // silently — the adopt failure is always logged at `register` time.
    if (!tenantId) tenantId = (this.context as any)?.partner?.key;

    // Deliberately no correlationKey in the payload: the key is the credential and
    // workflow data is persisted.
    const eventData = {
      continuationId,
      outcome,
      firedBy,
      reason: input?.reason || (outcome === 'not_observed' ? 'deadline_passed' : 'signal'),
      fireAt: new Date(record.fireAt).toISOString(),
    };

    try {
      const result: any = await workflowService.publishWorkflowEvent(
        CONTINUATION_EVENT_NAME,
        String(record.correlationKey),
        eventData,
        tenantId,
      );
      if (!result || result.success === false) {
        return { fired: false, reason: 'publish_failed', error: result?.message };
      }
    } catch (error: any) {
      return { fired: false, reason: 'publish_failed', error: error?.message };
    }

    await AgentContinuationModel.updateOne(
      { continuationId } as any,
      {
        $set: {
          eventPublishedAt: new Date(),
          eventOutcome: outcome,
          updatedAt: new Date(),
        },
      } as any,
    ).exec();

    this.log('info', 'continuation wake event published', { continuationId, outcome, firedBy, source });
    return { fired: true };
  }

  /**
   * Crash recovery: a `firing` record older than two ticks with attempts left goes
   * back to `armed`, so the next publish can retry the delivery. This is the only
   * transition into `armed` after the initial arm.
   *
   * Residual (accepted rather than silently ignored): the waiting instance is
   * single-use, so if the instance itself is gone the re-armed record has nothing
   * left to wake. Detecting that would need a per-record instance lookup on the
   * recovery path; the `expiresAt` TTL bounds the damage and the record stays
   * visible through the owner's `list()` the whole time.
   */
  async recoverStalledFiring(input?: {
    now?: string | Date;
    staleMs?: number;
    limit?: number;
  }): Promise<{ recovered: number }> {
    const now = input?.now ? new Date(input.now) : new Date();
    const staleMs = Number(input?.staleMs) || DEFAULT_STALE_FIRING_MS;
    const limit = Math.min(Math.max(Number(input?.limit) || 50, 1), 200);
    const cutoff = new Date(now.getTime() - staleMs);

    const stale: any[] = await AgentContinuationModel.find({
      state: 'firing',
      updatedAt: { $lt: cutoff },
    } as any)
      .limit(limit)
      .lean()
      .exec();

    let recovered = 0;
    for (const record of stale as any[]) {
      if (Number(record.attempt || 0) >= Number(record.maxAttempts || 2)) {
        // Out of attempts: make it visible rather than leaving it silently stuck.
        await this.markTerminalWithVisibility(
          record.continuationId,
          'failed',
          'delivery stalled and the retry budget is exhausted',
        );
        continue;
      }
      const updated: any = await AgentContinuationModel.findOneAndUpdate(
        { continuationId: record.continuationId, state: 'firing' } as any,
        {
          $set: { state: 'armed', updatedAt: new Date(), lastError: 'delivery_stalled' },
          $inc: { attempt: 1 },
        } as any,
        { new: true },
      ).exec();
      if (updated) recovered += 1;
    }

    return { recovered };
  }

  // ── delivery: the only code path that touches a session ────────────────────

  /**
   * Deliver the wake turn. Runs INSIDE the continuation workflow instance, so
   * `this.context.user` is the session owner (rebuilt from `data.__identity`).
   *
   * Order:
   *   1. identity + owner assertion (mismatch ⇒ orphan, never a system-context send);
   *   2. **strict outcome validation** — an absent or unrecognised outcome is a
   *      failure, never 'observed' (see `parseOutcome`);
   *   3. load the session scoped to the owner (missing ⇒ orphan);
   *   4. budget pre-check BEFORE the irreversible claim;
   *   5. atomic claim `{pending|armed} → firing` (null ⇒ already fired ⇒ no-op);
   *   6. send with `StreamingMode.NONE` (SSE would return an initiate-response
   *      instead of replying when no transport is attached);
   *   7. persist `fired|expired`, outcome, firedAt, wakeMessageId.
   */
  async deliver(input: {
    continuationId: string;
    outcome?: ContinuationOutcome;
    /** Carried through from the wake event so the record names what fired it. */
    firedBy?: ContinuationFiredBy;
  }): Promise<IDeliverResult> {
    const continuationId = String(input?.continuationId || '').trim();
    if (!continuationId) return { delivered: false, reason: 'continuationId is required' };

    const record: any = await AgentContinuationModel.findOne({ continuationId } as any).lean().exec();
    if (!record) return { delivered: false, reason: 'not_found' };
    if (TERMINAL_STATES.includes(record.state)) {
      return { delivered: false, reason: `terminal:${record.state}`, state: record.state };
    }

    const user: any = (this.context as any)?.user;
    if (!user?._id) {
      await this.markTerminalWithVisibility(
        continuationId,
        'orphaned',
        'no authenticated identity at wake time — refusing to deliver as the system account',
      );
      return { delivered: false, reason: 'no_identity', state: 'orphaned' };
    }

    if (String(record.ownerUserId) !== String(user._id)) {
      await this.markTerminalWithVisibility(
        continuationId,
        'orphaned',
        'wake identity does not match the continuation owner',
      );
      return { delivered: false, reason: 'owner_mismatch', state: 'orphaned' };
    }

    // ── The honesty invariant: observed vs not-observed must arrive as DATA ────
    //
    // Never coerce. An unrecognised value means we do not know what happened, and
    // "we do not know" must not be reported to the user as "it happened". Fail
    // closed, and make the failure visible in the owner's task list.
    const outcome = parseOutcome(input?.outcome);
    if (!outcome) {
      const received = describeReceivedOutcome(input?.outcome);
      await this.markTerminalWithVisibility(
        continuationId,
        'failed',
        `wake arrived without a recognised outcome (received ${received}); no turn was sent`,
      );
      return {
        delivered: false,
        reason: 'invalid_outcome',
        state: 'failed',
        error:
          `Unrecognised wake outcome ${received}. Expected 'observed' or 'not_observed' — ` +
          'the wake event must carry the outcome, and no turn was sent.',
      };
    }

    const session: any = await ReactorConversationModel.findOne({
      _id: new mongoose.Types.ObjectId(String(record.chatSessionId)),
      user: user._id,
    } as any)
      .select('_id personaId')
      .lean()
      .exec();

    if (!session) {
      await this.markTerminalWithVisibility(
        continuationId,
        'orphaned',
        'the chat session no longer exists for its owner',
      );
      return { delivered: false, reason: 'session_missing', state: 'orphaned' };
    }

    // Budget BEFORE the irreversible claim: a refused turn must not burn the one
    // wake this record has.
    const budgetRefusal = await this.checkBudget(String(user._id));
    if (budgetRefusal) {
      await this.markTerminalWithVisibility(continuationId, 'failed', `budget_exhausted: ${budgetRefusal}`);
      return { delivered: false, reason: 'over_budget', state: 'failed', error: budgetRefusal };
    }

    // Atomic claim — the single idempotency hinge. `null` means another firer won,
    // or this record is already terminal, and a double event is NOT a double turn.
    const claimResult = await this.claim({ continuationId });
    if (!claimResult.claimed) {
      return { delivered: false, reason: 'already_claimed' };
    }

    const message = outcome === 'observed' ? record.resumePrompt : record.expirePrompt;
    const conversationService: any = this.getService('reactor.ReactorConversationService@1.0.0');
    if (!conversationService) {
      await this.markTerminalWithVisibility(
        continuationId,
        'failed',
        'reactor.ReactorConversationService@1.0.0 is not available',
      );
      return { delivered: false, reason: 'no_conversation_service', state: 'failed' };
    }

    const maxAttempts = Math.max(resolveMaxAttempts(record), 1);
    let lastError: any = null;
    let response: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await conversationService.sendMessage({
          personaId: record.personaId,
          chatSessionId: record.chatSessionId,
          role: 'user',
          // NONE, never SSE: with no transport attached, SSE returns an
          // initiate-response instead of replying.
          streamingMode: StreamingMode.NONE,
          message,
        });

        if (response?.__typename === 'ReactorErrorResponse') {
          lastError = new Error(`${response.code || 'error'}: ${response.message || 'turn refused'}`);
        } else {
          lastError = null;
          break;
        }
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, this.deliveryRetryDelayMs));
      }
    }

    if (lastError) {
      await this.markTerminalWithVisibility(
        continuationId,
        'failed',
        `wake turn could not be delivered: ${lastError.message}`,
      );
      return { delivered: false, reason: 'send_failed', state: 'failed', error: lastError.message };
    }

    const wakeMessageId =
      response?.id || response?._id || response?.messageId || response?.message?._id || undefined;

    const completed = await this.complete({
      continuationId,
      outcome,
      firedBy: input?.firedBy,
      wakeMessageId: wakeMessageId ? String(wakeMessageId) : undefined,
    });
    const finalState: ContinuationState = completed.state || (outcome === 'observed' ? 'fired' : 'expired');

    this.log('info', 'continuation delivered', {
      continuationId,
      outcome,
      state: finalState,
      chatSessionId: record.chatSessionId,
    });

    return {
      delivered: true,
      state: finalState,
      outcome,
      wakeMessageId: wakeMessageId ? String(wakeMessageId) : undefined,
    };
  }

  /**
   * Mark a record terminal without delivering, and make sure the owner can see it.
   * `orphaned` and `failed` are never silent: a user task is raised in the task
   * list (the platform's existing non-blocking surface — the same
   * `reactory_tasks` collection `userTasks` reads and `user_activity` writes).
   */
  async markTerminalWithVisibility(
    continuationId: string,
    state: 'orphaned' | 'failed',
    reason: string,
  ): Promise<{ updated: boolean }> {
    const updated: any = await AgentContinuationModel.findOneAndUpdate(
      { continuationId, state: { $nin: TERMINAL_STATES } } as any,
      { $set: { state, lastError: reason, updatedAt: new Date() } } as any,
      { new: true },
    ).exec();

    if (updated) {
      await this.raiseVisibilityTask(updated, reason);
    }
    return { updated: Boolean(updated) };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private validateTrigger(trigger: any): string | undefined {
    if (!trigger || typeof trigger !== 'object' || !trigger.kind) {
      return 'trigger.kind is required';
    }
    switch (trigger.kind) {
      case 'at':
        if (!trigger.at || Number.isNaN(new Date(trigger.at).getTime())) {
          return 'an `at` trigger needs a valid ISO date-time in `at`';
        }
        return undefined;
      case 'event':
        if (!String(trigger.eventName || '').trim()) {
          return 'an `event` trigger needs a non-empty eventName';
        }
        return undefined;
      case 'condition':
        if (!String(trigger.serviceId || '').trim() || !String(trigger.method || '').trim()) {
          return 'a `condition` trigger needs serviceId and method';
        }
        return undefined;
      case 'task':
      case 'webhook':
        return undefined;
      default:
        return `unknown trigger kind "${trigger.kind}"`;
    }
  }

  /** Evaluate a `condition` trigger. Any failure means "not satisfied", never "fire". */
  private async evaluateCondition(record: any): Promise<boolean> {
    const trigger: any = record?.trigger;
    if (!trigger || trigger.kind !== 'condition') return false;
    try {
      const service: any = this.getService(String(trigger.serviceId));
      if (!service || typeof service[trigger.method] !== 'function') {
        throw new Error(`condition service ${trigger.serviceId}.${trigger.method} is unavailable`);
      }
      const result = await service[trigger.method](trigger.params || {});
      if (!trigger.expectPath) return Boolean(result);
      const read = (path: string) =>
        path
          .split('.')
          .reduce((acc: any, key: string) => (acc == null ? acc : acc[key]), result);
      const expectPath = String(trigger.expectPath);
      let actual = read(expectPath);
      // The macro documents `expectPath` in the YAML idiom (`result.merged`,
      // matching a `service_invoke` output), but here the method is called directly
      // so the value is already the raw return. Accept both spellings rather than
      // silently never matching.
      if (actual === undefined && expectPath.startsWith('result.')) {
        actual = read(expectPath.slice('result.'.length));
      }
      return actual === trigger.expectValue;
    } catch (error: any) {
      await AgentContinuationModel.updateOne(
        { continuationId: record.continuationId } as any,
        {
          $set: {
            lastError: `condition evaluation failed: ${error?.message || String(error)}`,
            updatedAt: new Date(),
          },
        } as any,
      ).exec();
      return false;
    }
  }

  /** `checkUserBudget` → a refusal string, or null when the turn may proceed. */
  private async checkBudget(userId: string): Promise<string | null> {
    const usageService: any = this.getService('reactor.ReactorAIUsageService@1.0.0');
    if (!usageService || typeof usageService.checkUserBudget !== 'function') return null;
    try {
      const status = await usageService.checkUserBudget(userId);
      if (status && status.allowed === false) {
        return status.reason || 'AI usage budget reached';
      }
      return null;
    } catch (error: any) {
      // Degraded enforcement, same stance as ReactorAIUsageService itself.
      this.log('warn', 'budget check failed; allowing the continuation', { error: error?.message });
      return null;
    }
  }

  /**
   * Raise a user task so an orphaned/failed continuation is visible in the task
   * list. Idempotent per continuation, so a retried delivery cannot spam the list.
   */
  private async raiseVisibilityTask(record: any, reason: string): Promise<void> {
    try {
      const TaskModel = (await import('@reactory/server-modules/reactory-core/models/Task')).default as any;
      const existing = await TaskModel.findOne({
        user: record.ownerUserId,
        status: 'pending',
        'componentProps.continuationId': String(record.continuationId),
      }).exec();
      if (existing) return;

      await new TaskModel({
        title: `Agent follow-up could not be delivered: ${String(record.reason).slice(0, 80)}`,
        description:
          `You asked the agent to follow up on "${record.reason}". ` +
          `The follow-up could not be delivered (${reason}). ` +
          'Nothing was reported back, so treat the outcome as unknown.',
        category: 'agent-continuation',
        workflowStatus: 'attention_required',
        status: 'pending',
        workflowId: CONTINUATION_WORKFLOW_ID,
        instanceId: record.workflowInstanceId,
        stepId: 'deliverWake',
        componentProps: {
          continuationId: String(record.continuationId),
          chatSessionId: String(record.chatSessionId),
          outcome: record.outcome,
        },
        user: record.ownerUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).save();

      this.log('warn', 'continuation could not be delivered; a task was raised for the owner', {
        continuationId: record.continuationId,
        reason,
      });
    } catch (error: any) {
      // Last resort: the record still carries `lastError`, so `list()` shows it.
      this.log('error', 'could not raise the visibility task for a non-delivered continuation', {
        continuationId: record.continuationId,
        reason,
        error: error?.message,
      });
    }
  }

  private getService(id: string): any {
    const getService = (this.context as any)?.getService;
    if (typeof getService !== 'function') return null;
    try {
      return getService.call(this.context, id);
    } catch {
      return null;
    }
  }

  private getWorkflowService(): any {
    return this.getService('core.ReactoryWorkflowService@1.0.0');
  }

  /**
   * Logging helper. Every call site is checked: `correlationKey` must never appear
   * in a log line, so this method deliberately takes a fixed-shape payload.
   */
  private log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, any>): void {
    const safe = data ? { ...data } : undefined;
    if (safe) {
      delete (safe as any).correlationKey;
      delete (safe as any).eventKey;
    }
    try {
      const contextLog = (this.context as any)?.log;
      if (typeof contextLog === 'function') {
        contextLog.call(this.context, message, safe || {}, level);
        return;
      }
    } catch {
      /* fall through to the module logger */
    }
    const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info;
    fn.call(logger, `[AgentContinuationService] ${message}`, safe || {});
  }
}

/** Kept separate so the delivery loop reads clearly and the default is explicit. */
function resolveMaxAttempts(record: any): number {
  const value = Number(record?.maxAttempts);
  return Number.isFinite(value) && value > 0 ? value : 2;
}

export default AgentContinuationService;
