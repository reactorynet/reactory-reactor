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
  MAX_PENDING_PER_SESSION,
  MIN_INTERVAL_MS,
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
    .mockImplementation((() => queryFn(() => (doc ? { ...doc } : null))) as any);

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
