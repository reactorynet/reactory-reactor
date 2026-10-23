import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';

/**
 * reactor.AgentContinuationService@1.0.0
 *
 * These tests pin the two properties the whole feature rests on:
 *
 *  1. **The wake turn is attributed to the session owner.** `deliver()` runs inside
 *     the continuation workflow instance, whose `__identity` was seeded from the
 *     REGISTRATION context. Here that instance context is simulated by giving the
 *     service a `context.user`; the assertions are that the conversation lookup is
 *     owner-scoped, that `sendMessage` targets the owner's session, and that an
 *     owner mismatch refuses instead of sending.
 *
 *  2. **A double fire is a no-op, and an expiry says `not_observed`.** The atomic
 *     conditional claim is the only hinge; a second `deliver` must not produce a
 *     second turn, and the expiry path must use `expirePrompt`, never
 *     `resumePrompt`.
 *
 * Also covered: `register` throws and leaves no record when the waiter cannot be
 * started (the model must never be told a follow-up is parked when nothing is
 * waiting), the caps refuse with actionable messages, `list()` never leaks the
 * correlation key, and `fire()` publishes under the waiting instance's tenant.
 */

// The dynamic import inside `raiseVisibilityTask` is mocked so the "visible, never
// silent" path can be asserted without a database.
const taskSave = jest.fn(async function (this: any) {
  return this;
});
const taskFindOne = jest.fn();
const taskDocuments: any[] = [];
const savedContinuations: any[] = [];

jest.mock('@reactory/server-modules/reactory-core/models/Task', () => {
  const Model: any = function (this: any, doc: any) {
    taskDocuments.push(doc);
    Object.assign(this, doc, { _id: new ObjectId() });
  };
  // Chainable, like a real mongoose query.
  Model.findOne = (...args: any[]) => ({ exec: async () => taskFindOne(...args) });
  Model.prototype.save = taskSave;
  return { __esModule: true, default: Model };
});

import AgentContinuationModel from '../../../models/AgentContinuation';
import ReactorConversationModel from '../../../models/ReactorChatState';
import AgentContinuationService, {
  planTriggerDecision,
  toPublicView,
  isSystemIdentity,
  parseOutcome,
  describeReceivedOutcome,
  describeTrigger,
  MAX_PENDING_PER_SESSION,  MIN_INTERVAL_MS,
  ACTIVE_STATES,
  CONTINUATION_EVENT_NAME,
} from '../AgentContinuationService';
/** Chainable mongoose query stub. All builders return itself; `exec` yields `fn()`. */
const queryFn = (fn: () => any) => {
  const q: any = {
    lean: () => q,
    select: () => q,
    sort: () => q,
    limit: () => q,
    skip: () => q,
    exec: async () => fn(),
  };
  return q;
};

const ownerId = new ObjectId();
const sessionId = new ObjectId();

const baseRecord = (overrides: Record<string, any> = {}) => ({
  _id: new ObjectId(),
  continuationId: 'cont-1',
  correlationKey: 'c2VjcmV0LWNvcnJlbGF0aW9uLWtleS0zMmJ5dGVzLWxvbmc',
  chatSessionId: sessionId.toString(),
  personaId: 'ReactorAIPersona',
  ownerUserId: ownerId,
  ownerEmail: 'owner@example.com',
  trigger: { kind: 'at', at: new Date(Date.now() + 60_000) },
  reason: 'PR #482 merge',
  resumePrompt: 'Check whether PR #482 merged and report the result.',
  expirePrompt:
    'The wait for PR #482 expired without the merge being observed. Say plainly that it was not observed.',
  state: 'armed',
  fireAt: new Date(Date.now() + 3_600_000),
  attempt: 0,
  maxAttempts: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
  workflowInstanceId: 'instance-1',
  ...overrides,
});

/**
 * A tiny in-memory stand-in for the continuation collection that honours the two
 * predicates that matter — `continuationId` and `state` (`'x'` / `$in` / `$nin`).
 *
 * This is deliberate: the double-fire test would pass trivially against a stub
 * that always returns a document, so the state gate has to be real.
 */
function installStore(initial: any) {
  let doc: any = { ...initial };

  const matches = (filter: any = {}) => {
    if (filter.continuationId && filter.continuationId !== doc.continuationId) return false;
    if (filter._id && String(filter._id) !== String(doc._id)) return false;
    if (filter.state !== undefined) {
      const s = filter.state;
      if (typeof s === 'string' && doc.state !== s) return false;
      if (s && Array.isArray(s.$in) && !s.$in.includes(doc.state)) return false;
      if (s && Array.isArray(s.$nin) && s.$nin.includes(doc.state)) return false;
    }
    return true;
  };

  const apply = (update: any = {}) => {
    if (update.$set) doc = { ...doc, ...update.$set };
    if (update.$inc) {
      for (const [key, delta] of Object.entries(update.$inc)) {
        doc[key] = Number(doc[key] || 0) + Number(delta);
      }
    }
    return { ...doc };
  };

  const findOne = jest
    .spyOn(AgentContinuationModel, 'findOne')
    .mockImplementation(((filter: any = {}) => queryFn(() => (doc && matches(filter) ? { ...doc } : null))) as any);

  const findOneAndUpdate = jest
    .spyOn(AgentContinuationModel, 'findOneAndUpdate')
    .mockImplementation(((filter: any, update: any) => queryFn(() => (matches(filter) ? apply(update) : null))) as any);

  const updateOne = jest
    .spyOn(AgentContinuationModel, 'updateOne')
    .mockImplementation(((filter: any, update: any) => queryFn(() => (matches(filter) ? apply(update) : null))) as any);

  return {
    findOne: findOne as any,
    findOneAndUpdate: findOneAndUpdate as any,
    updateOne: updateOne as any,
    get doc() {
      return doc;
    },
  };
}

let service: any;
const sendMessage = jest.fn();
const startWorkflow = jest.fn();
const cancelWorkflowInstance = jest.fn();
const publishWorkflowEvent = jest.fn();
const getWorkflowHistoryById = jest.fn();
const checkUserBudget = jest.fn();

function buildContext(user: any = { _id: ownerId, email: 'owner@example.com' }) {
  const services: Record<string, any> = {
    'core.ReactoryWorkflowService@1.0.0': {
      startWorkflow,
      cancelWorkflowInstance,
      publishWorkflowEvent,
      getWorkflowHistoryById,
    },
    'reactor.ReactorConversationService@1.0.0': { sendMessage },
    'reactor.ReactorAIUsageService@1.0.0': { checkUserBudget },
  };
  return {
    user,
    partner: { key: 'reactory' },
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    getService: jest.fn((id: string) => services[id] || null),
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
  taskSave.mockClear();
  taskFindOne.mockReset();
  taskFindOne.mockResolvedValue(null);
  taskDocuments.length = 0;
  savedContinuations.length = 0;

  sendMessage.mockReset();
  startWorkflow.mockReset();
  cancelWorkflowInstance.mockReset();
  publishWorkflowEvent.mockReset();
  getWorkflowHistoryById.mockReset();
  checkUserBudget.mockReset();

  sendMessage.mockResolvedValue({ __typename: 'ReactorChatMessage', id: 'msg-1' });
  startWorkflow.mockResolvedValue({ id: 'instance-1' });
  getWorkflowHistoryById.mockResolvedValue({ id: 'instance-1', tenantId: 'tenant-from-instance' });
  publishWorkflowEvent.mockResolvedValue({ success: true });
  checkUserBudget.mockResolvedValue({ allowed: true, status: 'ACTIVE', percentageUsed: 10 });

  service = Object.create(AgentContinuationService.prototype);
  service.context = buildContext();
  // No backoff in tests: the retry path is exercised, not waited on.
  service.deliveryRetryDelayMs = 0;

  jest.spyOn(AgentContinuationModel.prototype, 'save').mockImplementation(async function (this: any) {
    // Captured so the identity, the key's entropy and the deadline can be asserted.
    savedContinuations.push(this);
    return this;
  } as any);
});

// ── attribution ──────────────────────────────────────────────────────────────

describe('deliver — attribution to the session owner', () => {
  it('sends the wake turn into the owner-scoped session', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.delivered).toBe(true);
    // The conversation lookup is scoped to the instance's user. THIS is the query
    // that fails closed when a workflow holds the system context instead of the
    // owner — which is why the waiter is started at registration.
    expect((ReactorConversationModel.findOne as jest.Mock).mock.calls[0][0]).toEqual({
      _id: expect.anything(),
      user: ownerId,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSessionId: sessionId.toString(),
        personaId: 'ReactorAIPersona',
        role: 'user',
        // NONE, never SSE: with no transport attached, SSE returns an
        // initiate-response instead of replying.
        streamingMode: 'NONE',
        message: baseRecord().resumePrompt,
      }),
    );
    expect(store.doc.state).toBe('fired');
    expect(store.doc.outcome).toBe('observed');
  });

  it('orphans instead of sending when the wake identity is not the owner', async () => {
    const store = installStore(baseRecord());
    const conversationLookup = jest.spyOn(ReactorConversationModel, 'findOne');

    // A different authenticated user — e.g. the system account, which is exactly
    // what a fire-time `startWorkflow` would have produced.
    service.context = buildContext({ _id: new ObjectId(), email: 'system@reactory.net' });

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.delivered).toBe(false);
    expect(result.state).toBe('orphaned');
    expect(store.doc.state).toBe('orphaned');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(conversationLookup).not.toHaveBeenCalled();

    // Visible, never silent: a task was raised for the OWNER.
    expect(taskDocuments).toHaveLength(1);
    expect(String(taskDocuments[0].user)).toBe(ownerId.toString());
    expect(taskDocuments[0].category).toBe('agent-continuation');
  });

  it('orphans when there is no identity at all (never sends as the system account)', async () => {
    const store = installStore(baseRecord());
    // NOTE: `null`, not `undefined` — an explicit `undefined` argument would be
    // replaced by buildContext's default parameter, which is the owner.
    service.context = buildContext(null as any);

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.state).toBe('orphaned');
    expect(store.doc.state).toBe('orphaned');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// ── idempotency ──────────────────────────────────────────────────────────────

describe('deliver — idempotency', () => {
  it('is a no-op on a second fire (double-fire)', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);

    const first = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });
    const second = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(first.delivered).toBe(true);
    expect(second.delivered).toBe(false);
    expect(second.reason).toBe('terminal:fired');
    // The turn was produced exactly once.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(store.doc.state).toBe('fired');
  });

  it('is a no-op when another firer already claimed the record', async () => {
    // Primed in `firing`, as it would be between claim and send.
    installStore(baseRecord({ state: 'firing' }));
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('already_claimed');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('claims with an atomic conditional predicate, not a read-then-write', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);

    await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    const claimPredicate = (store.findOneAndUpdate as jest.Mock).mock.calls[0][0] as any;
    expect(claimPredicate.continuationId).toBe('cont-1');
    expect(claimPredicate.state).toEqual({ $in: ['pending', 'armed'] });
  });
});

// ── expiry ───────────────────────────────────────────────────────────────────

describe('deliver — expiry', () => {
  it('uses expirePrompt and records outcome=not_observed', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'not_observed' });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: baseRecord().expirePrompt }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: baseRecord().resumePrompt }),
    );
    expect(result.state).toBe('expired');
    expect(store.doc.state).toBe('expired');
    expect(store.doc.outcome).toBe('not_observed');
    expect(store.doc.firedBy).toBe('expiry');
  });

  it('never treats a missed deadline as observed', () => {
    const record = { trigger: { kind: 'condition' }, fireAt: new Date('2026-10-23T12:00:00Z') };
    const decision = planTriggerDecision(record as any, new Date('2026-10-23T12:00:01Z'), false);
    expect(decision).toEqual({
      outcome: 'not_observed',
      firedBy: 'expiry',
      reason: 'deadline_passed',
    });
  });
});

// ── refusal on a missing session ─────────────────────────────────────────────

describe('deliver — missing session', () => {
  it('orphans when the session is gone', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => null) as any);

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('session_missing');
    expect(result.state).toBe('orphaned');
    expect(store.doc.state).toBe('orphaned');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(taskSave).toHaveBeenCalled();
  });
});

// ── budget ───────────────────────────────────────────────────────────────────

describe('deliver — budget', () => {
  it('fails visibly, without claiming, when the budget is exhausted', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);
    checkUserBudget.mockResolvedValue({ allowed: false, reason: 'token limit', status: 'EXCEEDED', percentageUsed: 100 });

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('over_budget');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.doc.state).toBe('failed');
    expect(store.doc.lastError).toMatch(/budget_exhausted/);
  });
});

// ── register ─────────────────────────────────────────────────────────────────

describe('register', () => {
  const input = {
    chatSessionId: sessionId.toString(),
    personaId: 'ReactorAIPersona',
    reason: 'PR #482 merge',
    resumePrompt: 'Check whether PR #482 merged.',
    expirePrompt: 'The wait expired without the merge being observed. Say so plainly.',
    trigger: { kind: 'at' as const, at: new Date(Date.now() + 60_000) },
    ttlMs: 3_600_000,
  };

  const primeRegisterMocks = () => {
    jest
      .spyOn(ReactorConversationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ _id: sessionId, personaId: 'ReactorAIPersona' })) as any);
    jest.spyOn(AgentContinuationModel, 'countDocuments').mockReturnValue(queryFn(() => 0) as any);
    jest.spyOn(AgentContinuationModel, 'findOne').mockReturnValue(queryFn(() => null) as any);
    return jest.spyOn(AgentContinuationModel, 'updateOne').mockReturnValue(queryFn(() => ({})) as any);
  };

  it('starts the waiter and adopts its instance id', async () => {
    const updateOne = primeRegisterMocks();

    const result = await service.register(input);

    expect(result.registered).toBe(true);
    expect(startWorkflow).toHaveBeenCalledWith('reactor.AgentContinuation@1.0.0', {
      input: { continuationId: expect.any(String) },
    });
    expect(updateOne).toHaveBeenCalledWith(
      { continuationId: expect.any(String) },
      { $set: expect.objectContaining({ workflowInstanceId: 'instance-1' }) },
    );
    expect(result.fireAt).toEqual(expect.any(String));
  });

  it('persists the caller identity so the wake turn can be attributed later', async () => {
    primeRegisterMocks();

    await service.register(input);

    const saved = savedContinuations[0];
    expect(String(saved.ownerUserId)).toBe(ownerId.toString());
    expect(saved.ownerEmail).toBe('owner@example.com');
    // The key is random, never derived from the session / reason / ticket.
    expect(saved.correlationKey).not.toContain(sessionId.toString());
    expect(saved.correlationKey.length).toBeGreaterThanOrEqual(43);
  });

  it('throws and leaves no record when the waiter cannot be started', async () => {
    primeRegisterMocks();
    startWorkflow.mockRejectedValue(new Error('host not started'));
    const deleteOne = jest
      .spyOn(AgentContinuationModel, 'deleteOne')
      .mockReturnValue(queryFn(() => ({ deletedCount: 1 })) as any);

    await expect(service.register(input)).rejects.toThrow(/Nothing is waiting/);
    expect(deleteOne).toHaveBeenCalledWith({ _id: expect.anything() });
  });

  it('refuses without a chat session', async () => {
    const result = await service.register({ ...input, chatSessionId: '' });
    expect(result.registered).toBe(false);
    expect(result.code).toBe('no_session');
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a system caller', async () => {
    process.env.SYSTEM_USER_EMAIL = 'system@reactory.net';
    service.context = buildContext({ _id: new ObjectId(), email: 'system@reactory.net' });
    try {
      const result = await service.register(input);
      expect(result.registered).toBe(false);
      expect(result.code).toBe('system_caller');
      expect(startWorkflow).not.toHaveBeenCalled();
    } finally {
      delete process.env.SYSTEM_USER_EMAIL;
    }
  });

  it('refuses a session the caller does not own', async () => {
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => null) as any);
    const result = await service.register(input);
    expect(result.code).toBe('session_not_owned');
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('refuses when the session is over its pending cap — with an actionable message', async () => {
    jest
      .spyOn(ReactorConversationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ _id: sessionId, personaId: 'ReactorAIPersona' })) as any);
    jest
      .spyOn(AgentContinuationModel, 'countDocuments')
      .mockReturnValue(queryFn(() => MAX_PENDING_PER_SESSION) as any);

    const result = await service.register(input);

    expect(result.registered).toBe(false);
    expect(result.code).toBe('over_cap');
    expect(result.error).toMatch(/cancelContinuation/);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a second registration within the fire interval', async () => {
    jest
      .spyOn(ReactorConversationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ _id: sessionId, personaId: 'ReactorAIPersona' })) as any);
    jest.spyOn(AgentContinuationModel, 'countDocuments').mockReturnValue(queryFn(() => 0) as any);
    jest
      .spyOn(AgentContinuationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ firedAt: new Date(Date.now() - MIN_INTERVAL_MS / 2) })) as any);

    const result = await service.register(input);

    expect(result.code).toBe('rate_limited');
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('refuses when the budget is exhausted', async () => {
    jest
      .spyOn(ReactorConversationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ _id: sessionId, personaId: 'ReactorAIPersona' })) as any);
    jest.spyOn(AgentContinuationModel, 'countDocuments').mockReturnValue(queryFn(() => 0) as any);
    jest.spyOn(AgentContinuationModel, 'findOne').mockReturnValue(queryFn(() => null) as any);
    checkUserBudget.mockResolvedValue({
      allowed: false,
      reason: 'monthly token limit reached',
      status: 'EXCEEDED',
      percentageUsed: 100,
    });

    const result = await service.register(input);

    expect(result.code).toBe('over_budget');
    expect(result.error).toMatch(/budget/i);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('requires a deadline', async () => {
    const result = await service.register({ ...input, ttlMs: 0 });
    expect(result.code).toBe('invalid_ttl');
  });

  it('requires expirePrompt', async () => {
    const result = await service.register({ ...input, expirePrompt: '   ' });
    expect(result.registered).toBe(false);
  });

  it('rejects an ambiguous trigger', async () => {
    jest
      .spyOn(ReactorConversationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ _id: sessionId, personaId: 'ReactorAIPersona' })) as any);
    const result = await service.register({ ...input, trigger: { kind: 'event' } as any });
    expect(result.code).toBe('invalid_trigger');
  });
});

// ── projection and key hygiene ───────────────────────────────────────────────

describe('list() — the correlation key never leaks', () => {
  it('projects a view with no correlationKey anywhere in it', async () => {
    const record = baseRecord();
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [record]) as any);

    const listed = await service.list({ chatSessionId: sessionId.toString() });

    expect(listed).toHaveLength(1);
    const serialised = JSON.stringify(listed);
    expect(serialised).not.toContain(record.correlationKey);
    expect(Object.keys(listed[0])).not.toContain('correlationKey');
  });

  it('toPublicView drops the key even from a full document', () => {
    const view = toPublicView(baseRecord()) as any;
    expect(view.correlationKey).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('c2VjcmV0');
  });
});

// ── fire: tenant + token ─────────────────────────────────────────────────────

describe('fire', () => {
  it("publishes under the waiting instance's tenant", async () => {
    const store = installStore(baseRecord());

    const result = await service.fire({ continuationId: 'cont-1', outcome: 'observed', source: 'sweeper' });

    expect(result.fired).toBe(true);
    // The tenant comes from the INSTANCE, not from the sweeper's own context —
    // subscriptions are matched strictly by tenant, so the wrong one is silent.
    expect(publishWorkflowEvent).toHaveBeenCalledWith(
      CONTINUATION_EVENT_NAME,
      store.doc.correlationKey,
      expect.objectContaining({ continuationId: 'cont-1', outcome: 'observed' }),
      'tenant-from-instance',
    );
    // The key is the credential: it must not travel in the event payload.
    const payload = (publishWorkflowEvent as jest.Mock).mock.calls[0][2] as any;
    expect(payload.correlationKey).toBeUndefined();
  });

  it('rejects a webhook fire without the correlation token', async () => {
    installStore(baseRecord());

    const result = await service.fire({ continuationId: 'cont-1', source: 'webhook', token: 'wrong' });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe('invalid_token');
    expect(publishWorkflowEvent).not.toHaveBeenCalled();
  });

  it('accepts a webhook fire that presents the correlation token', async () => {
    const store = installStore(baseRecord());

    const result = await service.fire({
      continuationId: 'cont-1',
      source: 'webhook',
      token: store.doc.correlationKey,
    });

    expect(result.fired).toBe(true);
  });

  it('does not publish for a terminal record', async () => {
    installStore(baseRecord({ state: 'fired' }));

    const result = await service.fire({ continuationId: 'cont-1', source: 'sweeper' });

    expect(result.fired).toBe(false);
    expect(publishWorkflowEvent).not.toHaveBeenCalled();
  });
});

// ── the sweeper's decision function ──────────────────────────────────────────

describe('planTriggerDecision', () => {
  const fireAt = new Date('2026-10-23T14:00:00Z');

  it('fires an `at` trigger as observed once its time arrives', () => {
    const decision = planTriggerDecision(
      { trigger: { kind: 'at', at: new Date('2026-10-23T13:00:00Z') } as any, fireAt },
      new Date('2026-10-23T13:00:01Z'),
    );
    expect(decision).toEqual({ outcome: 'observed', firedBy: 'at', reason: 'time_reached' });
  });

  it('leaves a future `at` trigger parked', () => {
    const decision = planTriggerDecision(
      { trigger: { kind: 'at', at: new Date('2026-10-23T15:00:00Z') } as any, fireAt },
      new Date('2026-10-23T13:00:00Z'),
    );
    expect(decision).toBeNull();
  });

  it('fires the not_observed sentinel at the deadline', () => {
    const decision = planTriggerDecision(
      { trigger: { kind: 'event', eventName: 'pr.merged' } as any, fireAt },
      new Date('2026-10-23T14:00:00Z'),
    );
    expect(decision?.outcome).toBe('not_observed');
    expect(decision?.firedBy).toBe('expiry');
  });

  it('lets the deadline win over an unsatisfied condition', () => {
    const decision = planTriggerDecision(
      { trigger: { kind: 'condition', serviceId: 'x.Y@1.0.0', method: 'z' } as any, fireAt },
      new Date('2026-10-23T14:30:00Z'),
      false,
    );
    expect(decision?.outcome).toBe('not_observed');
  });

  it('fires a satisfied condition as observed before the deadline', () => {
    const decision = planTriggerDecision(
      { trigger: { kind: 'condition', serviceId: 'x.Y@1.0.0', method: 'z' } as any, fireAt },
      new Date('2026-10-23T13:00:00Z'),
      true,
    );
    expect(decision).toEqual({
      outcome: 'observed',
      firedBy: 'condition',
      reason: 'condition_satisfied',
    });
  });
});

// ── the sweeper's plan ───────────────────────────────────────────────────────

describe('claimDue — what the sweeper will fire', () => {
  const conditionService = { isMerged: jest.fn() };

  beforeEach(() => {
    conditionService.isMerged.mockReset();
    // The condition trigger's target service is resolved through the context.
    const previous = service.context.getService;
    service.context.getService = jest.fn((id: string) =>
      id === 'test.Conditions@1.0.0' ? conditionService : previous(id),
    );
  });

  const conditionRecord = (overrides: Record<string, any> = {}) =>
    baseRecord({
      trigger: {
        kind: 'condition',
        serviceId: 'test.Conditions@1.0.0',
        method: 'isMerged',
        expectPath: 'merged',
        expectValue: true,
      },
      // A deadline far in the future: the condition must still be evaluated now,
      // which is why the plan query has no upper bound on `fireAt`.
      fireAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    });

  it('evaluates a satisfied condition long before the deadline', async () => {
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [conditionRecord()]) as any);
    conditionService.isMerged.mockResolvedValue({ merged: true });

    const result = await service.claimDue({ now: new Date() });

    expect(result.due).toBe(1);
    expect(result.plan[0]).toEqual({
      continuationId: 'cont-1',
      outcome: 'observed',
      firedBy: 'condition',
      reason: 'condition_satisfied',
    });
  });

  it('leaves an unsatisfied condition parked', async () => {
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [conditionRecord()]) as any);
    conditionService.isMerged.mockResolvedValue({ merged: false });

    const result = await service.claimDue({ now: new Date() });

    expect(result.due).toBe(0);
    expect(result.plan).toEqual([]);
  });

  it('accepts an expectPath written in the YAML idiom', async () => {
    jest
      .spyOn(AgentContinuationModel, 'find')
      .mockReturnValue(queryFn(() => [conditionRecord({ trigger: { ...conditionRecord().trigger, expectPath: 'result.merged' } })]) as any);
    conditionService.isMerged.mockResolvedValue({ merged: true });

    const result = await service.claimDue({ now: new Date() });

    expect(result.due).toBe(1);
  });

  it('fires an `at` trigger whose time has arrived', async () => {
    const record = baseRecord({ trigger: { kind: 'at', at: new Date(Date.now() - 60_000) } });
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [record]) as any);

    const result = await service.claimDue({ now: new Date() });

    expect(result.plan[0].firedBy).toBe('at');
    expect(result.plan[0].outcome).toBe('observed');
  });

  it('sends the not_observed sentinel once the deadline passes, whatever the trigger', async () => {
    const record = baseRecord({
      trigger: { kind: 'event', eventName: 'pr.merged' },
      fireAt: new Date(Date.now() - 1000),
    });
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [record]) as any);

    const result = await service.claimDue({ now: new Date() });

    expect(result.plan[0]).toEqual({
      continuationId: 'cont-1',
      outcome: 'not_observed',
      firedBy: 'expiry',
      reason: 'deadline_passed',
    });
  });

  it('does not re-plan a record whose event was already published', async () => {
    // The predicate is on the query. The document is returned here regardless, so
    // this asserts the predicate itself carries the guard.
    const find = jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => []) as any);

    await service.claimDue({ now: new Date() });

    const filter = (find.mock.calls[0] as any)[0];
    expect(filter.state).toEqual({ $in: ['pending', 'armed'] });
    expect(filter.$or).toEqual([
      { eventPublishedAt: { $exists: false } },
      { eventPublishedAt: null },
      { eventPublishedAt: { $lt: expect.any(Date) } },
    ]);
    // No upper bound on fireAt — a condition may be satisfied at any time.
    expect(filter.fireAt).toBeUndefined();
  });
});

describe('isSystemIdentity', () => {
  it('matches the configured system email case-insensitively', () => {
    process.env.SYSTEM_USER_EMAIL = 'System@Reactory.net';
    try {
      expect(isSystemIdentity({ email: 'system@reactory.net' })).toBe(true);
      expect(isSystemIdentity({ email: 'owner@example.com' })).toBe(false);
    } finally {
      delete process.env.SYSTEM_USER_EMAIL;
    }
  });
});

// ── F1: the outcome must be DATA, and must be recognised ─────────────────────

describe('parseOutcome / describeReceivedOutcome', () => {
  it('accepts only the two sentinel values', () => {
    expect(parseOutcome('observed')).toBe('observed');
    expect(parseOutcome('not_observed')).toBe('not_observed');
  });

  it('rejects everything else, including the unresolved template token', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'Observed',
      'expired',
      'not-observed',
      '${variables.wake.outcome}',
      { outcome: 'observed' },
      0,
    ]) {
      expect(parseOutcome(bad)).toBeNull();
    }
  });

  it('describes a received value without throwing on odd input', () => {
    expect(describeReceivedOutcome(undefined)).toMatch(/no outcome in the wake payload/);
    expect(describeReceivedOutcome(null)).toBe('null');
    expect(describeReceivedOutcome('${variables.wake.outcome}')).toBe('${variables.wake.outcome}');
    const circular: any = {};
    circular.self = circular;
    expect(() => describeReceivedOutcome(circular)).not.toThrow();
    expect(describeReceivedOutcome('x'.repeat(500)).length).toBeLessThanOrEqual(121);
  });
});

describe('deliver — unrecognised outcome fails closed (never "observed")', () => {
  /**
   * The reachable fail-open the reviewer found: an ABSENT outcome used to be
   * coerced to 'observed'. It is reachable in production — `signalWorkflowInstance`
   * (GraphQL) and `workflow signal` (CLI) wake a parked instance with eventData
   * `{}`, and `resolveTemplate` leaves `${variables.wake.outcome}` as a literal.
   */
  const cases: Array<[string, any]> = [
    ['omitted entirely', undefined],
    ['null', null],
    ['the unresolved template token', '${variables.wake.outcome}'],
    ['an unexpected word', 'expired'],
    ['a non-string payload', { outcome: 'observed' }],
  ];

  it.each(cases)('%s ⇒ no turn is sent, the record fails visibly', async (_label, value) => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);

    const result = await service.deliver({ continuationId: 'cont-1', outcome: value } as any);

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('invalid_outcome');
    // Not a single turn, in either wording.
    expect(sendMessage).not.toHaveBeenCalled();
    // Terminal, visible, and NOT 'fired'.
    expect(store.doc.state).toBe('failed');
    expect(store.doc.state).not.toBe('fired');
    expect(store.doc.outcome).toBeUndefined();
    expect(store.doc.lastError).toMatch(/without a recognised outcome/);
    expect(result.error).toMatch(/Expected 'observed' or 'not_observed'/);
    // The owner is told through the task list.
    expect(taskDocuments).toHaveLength(1);
    expect(taskDocuments[0].category).toBe('agent-continuation');
  });

  it('does not claim the record before refusing, so no budget is spent', async () => {
    const store = installStore(baseRecord());

    await service.deliver({ continuationId: 'cont-1' } as any);

    // `attempt` is only incremented by the claim; a refusal must not consume it.
    expect(store.doc.attempt).toBe(0);
  });

  it('still delivers normally when the outcome IS recognised', async () => {
    // The control: without this, a guard that refused everything would pass.
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.delivered).toBe(true);
    expect(store.doc.state).toBe('fired');
  });
});

// ── F3: stall recovery ───────────────────────────────────────────────────────

describe('recoverStalledFiring', () => {
  it('re-arms a stale `firing` record with attempts left and increments the attempt', async () => {
    const stale = baseRecord({
      state: 'firing',
      attempt: 0,
      maxAttempts: 2,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [stale]) as any);
    const findOneAndUpdate = jest
      .spyOn(AgentContinuationModel, 'findOneAndUpdate')
      .mockReturnValue(queryFn(() => ({ ...stale, state: 'armed', attempt: 1 })) as any);

    const result = await service.recoverStalledFiring({ now: new Date(), staleMs: 120_000 });

    expect(result.recovered).toBe(1);
    const [filter, update] = findOneAndUpdate.mock.calls[0] as any[];
    // Conditional on `firing`, so a delivery that completed in the meantime is safe.
    expect(filter).toEqual({ continuationId: 'cont-1', state: 'firing' });
    expect(update.$set.state).toBe('armed');
    expect(update.$inc).toEqual({ attempt: 1 });
    expect(update.$set.lastError).toBe('delivery_stalled');
    // Re-arming is not a user-visible event: no task for a retry.
    expect(taskSave).not.toHaveBeenCalled();
  });

  it('fails a stale `firing` record whose retry budget is spent, and makes it visible', async () => {
    const stale = baseRecord({
      state: 'firing',
      attempt: 2,
      maxAttempts: 2,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [stale]) as any);
    const findOneAndUpdate = jest
      .spyOn(AgentContinuationModel, 'findOneAndUpdate')
      .mockReturnValue(queryFn(() => ({ ...stale, state: 'failed' })) as any);

    const result = await service.recoverStalledFiring({ now: new Date() });

    expect(result.recovered).toBe(0);
    const [filter, update] = findOneAndUpdate.mock.calls[0] as any[];
    expect(filter.state).toEqual({ $nin: ['fired', 'expired', 'cancelled', 'orphaned', 'failed'] });
    expect(update.$set.state).toBe('failed');
    expect(update.$set.lastError).toMatch(/retry budget is exhausted/);
    expect(taskSave).toHaveBeenCalledTimes(1);
  });

  it('scopes the scan to stale, non-terminal `firing` records', async () => {
    const find = jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => []) as any);

    const result = await service.recoverStalledFiring({ now: new Date('2026-10-23T12:00:00Z'), staleMs: 60_000 });

    expect(result.recovered).toBe(0);
    const filter = (find.mock.calls[0] as any)[0];
    expect(filter.state).toBe('firing');
    expect(filter.updatedAt).toEqual({ $lt: new Date('2026-10-23T11:59:00Z') });
  });

  it('does not recover when the conditional update matches nothing', async () => {
    const stale = baseRecord({ state: 'firing', attempt: 0, maxAttempts: 2 });
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [stale]) as any);
    jest.spyOn(AgentContinuationModel, 'findOneAndUpdate').mockReturnValue(queryFn(() => null) as any);

    const result = await service.recoverStalledFiring({ now: new Date() });

    expect(result.recovered).toBe(0);
  });
});

// ── F3: cancel ───────────────────────────────────────────────────────────────

describe('cancel', () => {
  it('cancels an armed record and stops its workflow instance', async () => {
    const store = installStore(baseRecord({ state: 'armed' }));

    const result = await service.cancel({ continuationId: 'cont-1', reason: 'user changed their mind' });

    expect(result.cancelled).toBe(true);
    expect(store.doc.state).toBe('cancelled');
    expect(store.doc.lastError).toBe('user changed their mind');
    expect(cancelWorkflowInstance).toHaveBeenCalledWith('instance-1');
  });

  it('still cancels the record when the instance cannot be cancelled', async () => {
    // Best effort: a workflow the runner no longer knows about must not block the
    // record from leaving the active set.
    const store = installStore(baseRecord({ state: 'armed' }));
    cancelWorkflowInstance.mockRejectedValue(new Error('instance not found'));

    const result = await service.cancel({ continuationId: 'cont-1' });

    expect(result.cancelled).toBe(true);
    expect(store.doc.state).toBe('cancelled');
  });

  it('refuses without a continuationId', async () => {
    expect(await service.cancel({ continuationId: '' })).toEqual({
      cancelled: false,
      reason: 'continuationId is required',
    });
  });

  it('reports not_found for an unknown id', async () => {
    installStore(baseRecord());
    const result = await service.cancel({ continuationId: 'nope' });
    expect(result).toEqual({ cancelled: false, reason: 'not_found' });
  });

  it('refuses a caller who does not own the continuation', async () => {
    const store = installStore(baseRecord({ state: 'armed' }));
    service.context = buildContext({ _id: new ObjectId(), email: 'someone@example.com' });

    const result = await service.cancel({ continuationId: 'cont-1' });

    expect(result).toEqual({ cancelled: false, reason: 'not_owner' });
    expect(store.doc.state).toBe('armed');
    expect(cancelWorkflowInstance).not.toHaveBeenCalled();
  });

  it('lets an internal (no-user) caller cancel', async () => {
    const store = installStore(baseRecord({ state: 'armed' }));
    service.context = buildContext(null as any);

    const result = await service.cancel({ continuationId: 'cont-1' });

    expect(result.cancelled).toBe(true);
    expect(store.doc.state).toBe('cancelled');
  });

  it('refuses to cancel a terminal record', async () => {
    const store = installStore(baseRecord({ state: 'fired' }));

    const result = await service.cancel({ continuationId: 'cont-1' });

    expect(result).toEqual({ cancelled: false, reason: 'already_fired' });
    expect(store.doc.state).toBe('fired');
  });

  it('does not cancel when the conditional active-state update matches nothing', async () => {
    const store = installStore(baseRecord({ state: 'armed' }));
    // A concurrent delivery moved the record to `firing` between the read and the
    // update: the `$in ACTIVE_STATES` predicate still matches, so this asserts the
    // predicate is what decides, not the earlier read.
    jest.spyOn(AgentContinuationModel, 'findOneAndUpdate').mockReturnValue(queryFn(() => null) as any);

    const result = await service.cancel({ continuationId: 'cont-1' });

    expect(result.cancelled).toBe(false);
    expect(store.doc.state).toBe('armed');
  });
});

// ── F3: delivery failure ─────────────────────────────────────────────────────

describe('deliver — delivery failure', () => {
  it('retries the send, then fails visibly without recording a wake', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);
    sendMessage.mockRejectedValue(new Error('transport closed'));

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('send_failed');
    // maxAttempts (2) attempts, no more.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(store.doc.state).toBe('failed');
    expect(store.doc.lastError).toMatch(/transport closed/);
    expect(taskSave).toHaveBeenCalledTimes(1);
  });

  it('treats a ReactorErrorResponse as a failure and retries it', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);
    sendMessage
      .mockResolvedValueOnce({
        __typename: 'ReactorErrorResponse',
        code: 'CONVERSATION_PROCESSING',
        message: 'Another turn is already running',
      })
      .mockResolvedValueOnce({ __typename: 'ReactorChatMessage', id: 'msg-2' });

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.delivered).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(store.doc.state).toBe('fired');
    expect(store.doc.wakeMessageId).toBe('msg-2');
  });

  it('fails when every attempt returns a ReactorErrorResponse', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);
    sendMessage.mockResolvedValue({
      __typename: 'ReactorErrorResponse',
      code: 'BUDGET_EXCEEDED',
      message: 'no budget',
    });

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.reason).toBe('send_failed');
    expect(result.error).toMatch(/BUDGET_EXCEEDED/);
    expect(store.doc.state).toBe('failed');
  });

  it('fails when the conversation service is not registered at all', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);
    const getService = service.context.getService;
    service.context.getService = jest.fn((id: string) =>
      id === 'reactor.ReactorConversationService@1.0.0' ? null : getService(id),
    );

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.reason).toBe('no_conversation_service');
    expect(store.doc.state).toBe('failed');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// ── F3/F4: get() — the waiter read is restricted ─────────────────────────────

describe('get', () => {
  it('returns the key to the OWNER while the record can still be woken', async () => {
    installStore(baseRecord({ state: 'pending' }));

    const view = await service.get({ continuationId: 'cont-1' });

    expect(view).toEqual({
      continuationId: 'cont-1',
      correlationKey: expect.any(String),
      state: 'pending',
      fireAt: expect.any(String),
    });
  });

  it('also serves an `armed` record', async () => {
    installStore(baseRecord({ state: 'armed' }));
    const view = await service.get({ continuationId: 'cont-1' });
    expect(view?.state).toBe('armed');
  });

  it('refuses a caller who is not the owner — no key, no state', async () => {
    // `list()` exposes continuationIds, so an unguarded get() would let any caller
    // that learned one mint a wake event for somebody else's session.
    installStore(baseRecord({ state: 'pending' }));
    service.context = buildContext({ _id: new ObjectId(), email: 'intruder@example.com' });

    const view = await service.get({ continuationId: 'cont-1' });

    expect(view).toBeNull();
  });

  it('serves an internal caller with no user on its context', async () => {
    installStore(baseRecord({ state: 'pending' }));
    service.context = buildContext(null as any);

    const view = await service.get({ continuationId: 'cont-1' });

    expect(view?.correlationKey).toEqual(expect.any(String));
  });

  it('refuses a terminal record (there is no waiter left to wake)', async () => {
    installStore(baseRecord({ state: 'fired' }));
    expect(await service.get({ continuationId: 'cont-1' })).toBeNull();
  });

  it('returns null for an unknown or empty id', async () => {
    installStore(baseRecord());
    expect(await service.get({ continuationId: 'nope' })).toBeNull();
    expect(await service.get({ continuationId: '' })).toBeNull();
  });
});

// ── F3: markArmed / complete ─────────────────────────────────────────────────

describe('markArmed and complete', () => {
  it('arms a pending record, and is idempotent on replay', async () => {
    const store = installStore(baseRecord({ state: 'pending' }));

    expect((await service.markArmed({ continuationId: 'cont-1' })).armed).toBe(true);
    expect(store.doc.state).toBe('armed');
    // A second call no longer matches `state: 'pending'`.
    expect((await service.markArmed({ continuationId: 'cont-1' })).armed).toBe(false);
  });

  it('does not arm without an id', async () => {
    expect(await service.markArmed({ continuationId: '' })).toEqual({ armed: false });
  });

  it('completes a firing record as fired or expired', async () => {
    const store = installStore(baseRecord({ state: 'firing' }));

    const completed = await service.complete({
      continuationId: 'cont-1',
      outcome: 'observed',
      firedBy: 'at',
      wakeMessageId: 'msg-9',
    });

    expect(completed).toEqual({ completed: true, state: 'fired' });
    expect(store.doc.firedBy).toBe('at');
    expect(store.doc.wakeMessageId).toBe('msg-9');
    expect(store.doc.firedAt).toBeInstanceOf(Date);
  });

  it('completes as expired, defaulting firedBy to expiry', async () => {
    const store = installStore(baseRecord({ state: 'firing' }));

    const completed = await service.complete({ continuationId: 'cont-1', outcome: 'not_observed' });

    expect(completed.state).toBe('expired');
    expect(store.doc.firedBy).toBe('expiry');
  });

  it('refuses to complete a record that is not firing', async () => {
    installStore(baseRecord({ state: 'cancelled' }));
    expect(await service.complete({ continuationId: 'cont-1', outcome: 'observed' })).toEqual({
      completed: false,
      state: undefined,
    });
  });
});

// ── F3: condition evaluation failure ─────────────────────────────────────────

describe('claimDue — condition evaluation failure', () => {
  it('treats an unavailable condition service as "not satisfied" and records why', async () => {
    const record = baseRecord({
      trigger: { kind: 'condition', serviceId: 'missing.Service@1.0.0', method: 'isMerged' },
      fireAt: new Date(Date.now() + 86_400_000),
    });
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [record]) as any);
    const updateOne = jest.spyOn(AgentContinuationModel, 'updateOne').mockReturnValue(queryFn(() => ({})) as any);

    const result = await service.claimDue({ now: new Date() });

    // Never "fire because the check broke".
    expect(result.due).toBe(0);
    expect(updateOne).toHaveBeenCalledTimes(1);
    const update = (updateOne.mock.calls[0] as any[])[1];
    expect(update.$set.lastError).toMatch(/condition evaluation failed/);
  });

  it('treats a throwing condition method as "not satisfied"', async () => {
    const record = baseRecord({
      trigger: { kind: 'condition', serviceId: 'test.Conditions@1.0.0', method: 'isMerged' },
      fireAt: new Date(Date.now() + 86_400_000),
    });
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [record]) as any);
    const updateOne = jest.spyOn(AgentContinuationModel, 'updateOne').mockReturnValue(queryFn(() => ({})) as any);
    const getService = service.context.getService;
    service.context.getService = jest.fn((id: string) =>
      id === 'test.Conditions@1.0.0'
        ? {
            isMerged: async () => {
              throw new Error('upstream 503');
            },
          }
        : getService(id),
    );

    const result = await service.claimDue({ now: new Date() });

    expect(result.due).toBe(0);
    expect((updateOne.mock.calls[0] as any[])[1].$set.lastError).toMatch(/upstream 503/);
  });

  it('reports "satisfied" for a truthy result when no expectPath is given', async () => {
    const record = baseRecord({
      trigger: { kind: 'condition', serviceId: 'test.Conditions@1.0.0', method: 'isMerged' },
      fireAt: new Date(Date.now() + 86_400_000),
    });
    jest.spyOn(AgentContinuationModel, 'find').mockReturnValue(queryFn(() => [record]) as any);
    const getService = service.context.getService;
    service.context.getService = jest.fn((id: string) =>
      id === 'test.Conditions@1.0.0' ? { isMerged: async () => true } : getService(id),
    );

    const result = await service.claimDue({ now: new Date() });

    expect(result.due).toBe(1);
  });
});

// ── F3: fire() edge paths ────────────────────────────────────────────────────

describe('fire — edge paths', () => {
  it('reports publish_failed when the workflow service returns failure', async () => {
    installStore(baseRecord());
    publishWorkflowEvent.mockResolvedValue({ success: false, message: 'runner offline' });

    const result = await service.fire({ continuationId: 'cont-1', source: 'sweeper' });

    expect(result).toEqual({ fired: false, reason: 'publish_failed', error: 'runner offline' });
  });

  it('reports publish_failed when publishing throws', async () => {
    installStore(baseRecord());
    publishWorkflowEvent.mockRejectedValue(new Error('bus down'));

    const result = await service.fire({ continuationId: 'cont-1', source: 'sweeper' });

    expect(result.reason).toBe('publish_failed');
    expect(result.error).toMatch(/bus down/);
  });

  it('reports workflow_service_unavailable when the service is missing', async () => {
    installStore(baseRecord());
    service.context = { user: { _id: ownerId }, getService: () => null, log: jest.fn() } as any;

    const result = await service.fire({ continuationId: 'cont-1' });

    expect(result.reason).toBe('workflow_service_unavailable');
  });

  it("falls back to the caller's tenant when the instance cannot be read", async () => {
    installStore(baseRecord());
    getWorkflowHistoryById.mockRejectedValue(new Error('instance pruned'));

    const result = await service.fire({ continuationId: 'cont-1', source: 'sweeper' });

    expect(result.fired).toBe(true);
    // The fourth argument is the tenant; with no instance, the sweeper's partner.
    expect((publishWorkflowEvent as jest.Mock).mock.calls[0][3]).toBe('reactory');
  });

  it('uses the context tenant when there is no instance id at all', async () => {
    installStore(baseRecord({ workflowInstanceId: undefined }));

    const result = await service.fire({ continuationId: 'cont-1', source: 'sweeper' });

    expect(result.fired).toBe(true);
    expect(getWorkflowHistoryById).not.toHaveBeenCalled();
    expect((publishWorkflowEvent as jest.Mock).mock.calls[0][3]).toBe('reactory');
  });

  it('does not fire without a continuationId, or for an unknown one', async () => {
    expect(await service.fire({ continuationId: '' })).toEqual({
      fired: false,
      reason: 'continuationId is required',
    });
    installStore(baseRecord());
    expect((await service.fire({ continuationId: 'nope' })).reason).toBe('not_found');
  });

  it('records when the event was published so the sweeper will not repeat it', async () => {
    const store = installStore(baseRecord());

    await service.fire({ continuationId: 'cont-1', outcome: 'not_observed', source: 'sweeper' });

    expect(store.doc.eventPublishedAt).toBeInstanceOf(Date);
    expect(store.doc.eventOutcome).toBe('not_observed');
  });
});

// ── F3: register adopt failure is non-fatal ─────────────────────────────────

describe('register — adopt failure', () => {
  it('stays registered when the instance id cannot be persisted', async () => {
    // The waiter IS running; losing the pointer only costs the tenant lookup a
    // fallback in fire(), so this must not fail the registration.
    jest
      .spyOn(ReactorConversationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ _id: sessionId, personaId: 'ReactorAIPersona' })) as any);
    jest.spyOn(AgentContinuationModel, 'countDocuments').mockReturnValue(queryFn(() => 0) as any);
    jest.spyOn(AgentContinuationModel, 'findOne').mockReturnValue(queryFn(() => null) as any);
    jest.spyOn(AgentContinuationModel, 'updateOne').mockImplementation((() => {
      const q: any = {
        lean: () => q,
        select: () => q,
        sort: () => q,
        limit: () => q,
        exec: async () => {
          throw new Error('write concern failed');
        },
      };
      return q;
    }) as any);

    const result = await service.register({
      chatSessionId: sessionId.toString(),
      personaId: 'ReactorAIPersona',
      reason: 'PR #482 merge',
      resumePrompt: 'Check whether PR #482 merged.',
      expirePrompt: 'It was not observed.',
      trigger: { kind: 'at', at: new Date(Date.now() + 60_000) },
      ttlMs: 3_600_000,
    });

    expect(result.registered).toBe(true);
    // The failure is logged rather than thrown: the waiter IS running.
    expect(service.context.log).toHaveBeenCalledWith(
      expect.stringMatching(/could not be persisted/),
      expect.objectContaining({ error: 'write concern failed' }),
      'warn',
    );
  });
});
// ── internals and edge branches ─────────────────────────────────────────────

/**
 * These cover the branches that decide *whether* something happens, rather than
 * the happy path: the trigger describer used by every list surface, the class's own
 * construction (the other suites build it with `Object.create` so the field
 * initialisers never run), the duplicate guard, the rollback when the cleanup
 * itself fails, and the two "last resort" logging/visibility paths.
 */
describe('describeTrigger — every trigger kind is rendered for the UI', () => {
  it('describes each kind, and degrades safely', () => {
    expect(describeTrigger(undefined)).toBe('unknown');
    expect(describeTrigger({ kind: 'at', at: new Date('2026-10-23T14:00:00Z') } as any)).toBe(
      'at 2026-10-23T14:00:00.000Z',
    );
    expect(describeTrigger({ kind: 'event', eventName: 'pr.merged' } as any)).toBe('on event pr.merged');
    expect(
      describeTrigger({ kind: 'condition', serviceId: 'reactor.X@1.0.0', method: 'isMerged' } as any),
    ).toMatch(/the predicate/);
    expect(
      describeTrigger({
        kind: 'condition',
        serviceId: 'reactor.X@1.0.0',
        method: 'isMerged',
        expectPath: 'result.merged',
      } as any),
    ).toMatch(/result\.merged/);
    expect(describeTrigger({ kind: 'task', taskId: 'task-1' } as any)).toBe('on task task-1');
    expect(describeTrigger({ kind: 'task' } as any)).toBe('on task completion');
    expect(describeTrigger({ kind: 'webhook', label: 'github' } as any)).toBe('on webhook github');
    expect(describeTrigger({ kind: 'webhook' } as any)).toBe('on webhook (unlabelled)');
    expect(describeTrigger({ kind: 'nonsense' } as any)).toBe('unknown');
  });
});

describe('class construction', () => {
  it('exposes the service identity the registry and logs rely on', () => {
    const instance: any = new (AgentContinuationService as any)(
      {} as any,
      buildContext(),
    );

    expect(instance.nameSpace).toBe('reactor');
    expect(instance.name).toBe('Agent Continuation Service');
    expect(instance.version).toBe('1.0.0');
    expect(instance.tags).toContain('continuation');
    expect(instance.deliveryRetryDelayMs).toBe(750);
    expect(instance.toString()).toBe('AgentContinuationService');
    expect(instance.toString(true)).toBe('AgentContinuationService@1.0.0');
    expect(instance.context).toBeDefined();
  });
});

describe('register — duplicate guard', () => {
  it('refuses a second identical active continuation', async () => {
    jest
      .spyOn(ReactorConversationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ _id: sessionId, personaId: 'ReactorAIPersona' })) as any);
    jest.spyOn(AgentContinuationModel, 'countDocuments').mockReturnValue(queryFn(() => 0) as any);
    jest
      .spyOn(AgentContinuationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ continuationId: 'cont-existing' })) as any);

    const result = await service.register({
      chatSessionId: sessionId.toString(),
      personaId: 'ReactorAIPersona',
      reason: 'PR #482 merge',
      resumePrompt: 'Check.',
      expirePrompt: 'It was not observed.',
      trigger: { kind: 'at', at: new Date(Date.now() + 60_000) },
      ttlMs: 3_600_000,
    });

    expect(result.registered).toBe(false);
    expect(result.code).toBe('duplicate');
    expect(result.error).toContain('cont-existing');
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});

describe('register — rollback when the cleanup itself fails', () => {
  it('still throws, and records that the record could not be removed', async () => {
    jest
      .spyOn(ReactorConversationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ _id: sessionId, personaId: 'ReactorAIPersona' })) as any);
    jest.spyOn(AgentContinuationModel, 'countDocuments').mockReturnValue(queryFn(() => 0) as any);
    jest.spyOn(AgentContinuationModel, 'findOne').mockReturnValue(queryFn(() => null) as any);
    startWorkflow.mockRejectedValue(new Error('host not started'));
    jest.spyOn(AgentContinuationModel, 'deleteOne').mockImplementation((() => {
      const q: any = {
        lean: () => q,
        exec: async () => {
          throw new Error('delete failed');
        },
      };
      return q;
    }) as any);

    await expect(
      service.register({
        chatSessionId: sessionId.toString(),
        personaId: 'ReactorAIPersona',
        reason: 'PR #482 merge',
        resumePrompt: 'Check.',
        expirePrompt: 'It was not observed.',
        trigger: { kind: 'at', at: new Date(Date.now() + 60_000) },
        ttlMs: 3_600_000,
      }),
    ).rejects.toThrow(/Nothing is waiting/);

    // Both the cleanup failure and the start failure are logged.
    expect(service.context.log).toHaveBeenCalledWith(
      expect.stringMatching(/could not be removed/),
      expect.objectContaining({ error: 'delete failed' }),
      'error',
    );
  });
});

describe('orphan', () => {
  it('orphans with the supplied reason and raises a task', async () => {
    const store = installStore(baseRecord({ state: 'armed' }));

    const result = await service.orphan({ continuationId: 'cont-1', reason: 'session revoked' });

    expect(result.orphaned).toBe(true);
    expect(store.doc.state).toBe('orphaned');
    expect(store.doc.lastError).toBe('session revoked');
    expect(taskSave).toHaveBeenCalled();
  });

  it('uses a default reason and refuses without an id', async () => {
    const store = installStore(baseRecord({ state: 'armed' }));
    await service.orphan({ continuationId: 'cont-1' });
    expect(store.doc.lastError).toMatch(/could not be attributed to the owner/);

    expect(await service.orphan({ continuationId: '' })).toEqual({ orphaned: false });
  });

  it('reports not-orphaned when the record is already terminal', async () => {
    installStore(baseRecord({ state: 'fired' }));
    expect(await service.orphan({ continuationId: 'cont-1' })).toEqual({ orphaned: false });
  });
});

describe('visibility task — idempotency and last resort', () => {
  it('does not raise a second task when one is already pending', async () => {
    installStore(baseRecord({ state: 'armed' }));
    taskFindOne.mockResolvedValue({ _id: new ObjectId() });

    await service.markTerminalWithVisibility('cont-1', 'failed', 'send failed');

    expect(taskSave).not.toHaveBeenCalled();
  });

  it('keeps the record terminal even when the task cannot be created', async () => {
    const store = installStore(baseRecord({ state: 'armed' }));
    taskSave.mockRejectedValueOnce(new Error('task collection unavailable'));

    const result = await service.markTerminalWithVisibility('cont-1', 'failed', 'send failed');

    expect(result.updated).toBe(true);
    expect(store.doc.state).toBe('failed');
    // Last resort: the reason is still on the record, so list() shows it.
    expect(service.context.log).toHaveBeenCalledWith(
      expect.stringMatching(/could not raise the visibility task/),
      expect.objectContaining({ error: 'task collection unavailable' }),
      'error',
    );
  });
});

describe('getService / log — defensive paths', () => {
  it('returns null when the context has no getService', async () => {
    installStore(baseRecord());
    service.context = { user: { _id: ownerId }, log: jest.fn() } as any;

    // No registry at all: the record is still readable (owner scope only).
    expect((await service.get({ continuationId: 'cont-1' }))?.state).toBe('armed');
  });

  it('treats a throwing getService as "no service"', async () => {
    installStore(baseRecord());
    service.context = {
      user: { _id: ownerId },
      log: jest.fn(),
      getService: () => {
        throw new Error('registry exploded');
      },
    } as any;

    const result = await service.fire({ continuationId: 'cont-1' });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe('workflow_service_unavailable');
  });

  it('falls back to the module logger when the context has no log()', async () => {
    installStore(baseRecord({ state: 'armed' }));
    service.context = { user: { _id: ownerId }, getService: () => null } as any;

    // Any of these paths logs; none may throw because log() is unavailable.
    await expect(service.orphan({ continuationId: 'cont-1', reason: 'x' })).resolves.toEqual({
      orphaned: true,
    });
  });

  it('swallows a throwing context.log()', async () => {
    installStore(baseRecord({ state: 'armed' }));
    service.context = {
      user: { _id: ownerId },
      getService: () => null,
      log: () => {
        throw new Error('logger down');
      },
    } as any;

    await expect(service.orphan({ continuationId: 'cont-1' })).resolves.toEqual({ orphaned: true });
  });
});

describe('checkBudget — degraded enforcement', () => {
  it('allows the continuation when the budget service throws', async () => {
    const store = installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);
    checkUserBudget.mockRejectedValue(new Error('usage db unreachable'));

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    // Degraded to allow, the same stance ReactorAIUsageService takes itself.
    expect(result.delivered).toBe(true);
    expect(store.doc.state).toBe('fired');
    expect(service.context.log).toHaveBeenCalledWith(
      expect.stringMatching(/budget check failed/),
      expect.anything(),
      'warn',
    );
  });

  it('refuses with a default reason when the budget verdict has none', async () => {
    installStore(baseRecord());
    jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue(queryFn(() => ({ _id: sessionId })) as any);
    checkUserBudget.mockResolvedValue({ allowed: false, status: 'EXCEEDED', percentageUsed: 101 });

    const result = await service.deliver({ continuationId: 'cont-1', outcome: 'observed' });

    expect(result.reason).toBe('over_budget');
    expect(result.error).toMatch(/AI usage budget reached/);
  });
});

describe('validateTrigger — the shapes register refuses', () => {
  const call = (trigger: any) =>
    service.register({
      chatSessionId: sessionId.toString(),
      personaId: 'ReactorAIPersona',
      reason: 'r',
      resumePrompt: 'p',
      expirePrompt: 'e',
      trigger,
      ttlMs: 60_000,
    });

  beforeEach(() => {
    jest
      .spyOn(ReactorConversationModel, 'findOne')
      .mockReturnValue(queryFn(() => ({ _id: sessionId, personaId: 'ReactorAIPersona' })) as any);
  });

  it('rejects a missing kind, a bad `at`, an empty eventName and an incomplete condition', async () => {
    expect((await call({ } as any)).error).toMatch(/trigger.kind is required/);
    expect((await call({ kind: 'at', at: 'nope' } as any)).error).toMatch(/valid ISO date-time/);
    expect((await call({ kind: 'event', eventName: '  ' } as any)).error).toMatch(/non-empty eventName/);
    expect((await call({ kind: 'condition', serviceId: 'x' } as any)).error).toMatch(
      /needs serviceId and method/,
    );
    expect((await call({ kind: 'bogus' } as any)).error).toMatch(/unknown trigger kind/);
  });

  it('accepts a well-formed trigger of every kind', async () => {
    // The complement of the refusals above: each kind's happy path must reach the
    // service, or the macro would be advertising triggers register() rejects.
    jest.spyOn(AgentContinuationModel, 'countDocuments').mockReturnValue(queryFn(() => 0) as any);
    jest.spyOn(AgentContinuationModel, 'findOne').mockReturnValue(queryFn(() => null) as any);
    jest.spyOn(AgentContinuationModel, 'updateOne').mockReturnValue(queryFn(() => ({})) as any);

    expect((await call({ kind: 'task' })).registered).toBe(true);
    expect((await call({ kind: 'task', taskId: 'task-1' })).registered).toBe(true);
    expect((await call({ kind: 'webhook', label: 'github' })).registered).toBe(true);
    expect((await call({ kind: 'event', eventName: 'pr.merged' })).registered).toBe(true);
    expect(
      (await call({ kind: 'condition', serviceId: 'reactor.X@1.0.0', method: 'isMerged' })).registered,
    ).toBe(true);
  });
});

describe('planTriggerDecision — an `at` trigger overtaken by its deadline', () => {
  it('reports not_observed when the sweeper was down past fireAt', () => {
    // Conservative by construction: it can never over-claim an observation.
    const decision = planTriggerDecision(
      {
        trigger: { kind: 'at', at: new Date('2026-10-23T12:00:00Z') } as any,
        fireAt: new Date('2026-10-23T13:00:00Z'),
      },
      new Date('2026-10-23T14:00:00Z'),
    );
    expect(decision).toEqual({
      outcome: 'not_observed',
      firedBy: 'expiry',
      reason: 'deadline_passed',
    });
  });
});