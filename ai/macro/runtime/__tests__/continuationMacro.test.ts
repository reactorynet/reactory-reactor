import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

/**
 * continuationMacro.macro.ts — the agent-facing contract of the continuation
 * feature.
 *
 * This file is where "never make an unbacked promise" is actually enforced, so it
 * is tested at both ends:
 *
 *   - every refusal returns `success: false` with an `instructions` block that
 *     names the fix (so the model reports honestly instead of promising);
 *   - every success says what was parked and when it expires, and a trigger that
 *     nothing publishes says so explicitly rather than implying it is watched.
 *
 * The service is stubbed behind the chat context rather than module-mocked, and the
 * refusals come from the REAL `refusal()` helper imported from the service — so the
 * assertions cover the exact messages a model will see.
 */

import {
  ScheduleContinuationMacro,
  CancelContinuationMacro,
  ListContinuationsMacro,
  ContinuationMacroRegistry,
  buildTrigger,
  defaultTtlMs,
  isProducerless,
  CONTINUATION_SERVICE_ID,
} from '../continuationMacro.macro';
// Four levels up: __tests__ -> runtime -> macro -> ai -> <module root>.

import {
  refusal,
  registerConditionPredicate,
  clearConditionPredicates,
} from '../../../../services/reactor/AgentContinuationService';

const SESSION_ID = '507f1f77bcf86cd799439011';

const register = jest.fn();
const cancel = jest.fn();
const list = jest.fn();

/** Minimal ChatState shape; the macros only read `id`, `personaId` and `context`. */
const makeState = (overrides: Record<string, any> = {}) =>
  ({
    id: SESSION_ID,
    personaId: 'ReactorAIPersona',
    vars: {},
    history: [],
    context: {
      getService: jest.fn((id: string) =>
        id === CONTINUATION_SERVICE_ID ? { register, cancel, list } : null,
      ),
    },
    ...overrides,
  }) as any;

const HAPPY = {
  at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  reason: 'PR #482 merge',
  resumePrompt: 'Check whether PR #482 merged and report the result.',
  expirePrompt:
    'The wait for PR #482 expired without the merge being observed. Say plainly that it was not observed.',
};

beforeEach(() => {
  // The condition policy is module-level state, so it must not leak between tests.
  clearConditionPredicates();
  register.mockReset();
  cancel.mockReset();
  list.mockReset();
  register.mockResolvedValue({
    registered: true,
    continuationId: 'cont-1',
    fireAt: new Date(Date.now() + 3_600_000).toISOString(),
    state: 'pending',
  });
  cancel.mockResolvedValue({ cancelled: true });
  list.mockResolvedValue([]);
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('buildTrigger', () => {
  it('requires exactly one trigger form', () => {
    const { at: _at, ...noTrigger } = HAPPY as any;
    expect(buildTrigger(noTrigger).error).toMatch(/No trigger was supplied/);
    expect(
      buildTrigger({ ...HAPPY, at: HAPPY.at, eventName: 'pr.merged' } as any).error,
    ).toMatch(/More than one trigger/);
  });

  it('rejects an unparseable or past `at`', () => {
    expect(buildTrigger({ ...HAPPY, at: 'not-a-date' } as any).error).toMatch(/valid ISO date-time/);
    expect(
      buildTrigger({ ...HAPPY, at: new Date(Date.now() - 1000).toISOString() } as any).error,
    ).toMatch(/must be in the future/);
  });

  it('builds an `at` trigger as a Date', () => {
    const built = buildTrigger({ ...HAPPY } as any);
    expect(built.error).toBeUndefined();
    expect(built.trigger.kind).toBe('at');
    expect(built.trigger.at).toBeInstanceOf(Date);
  });

  it('builds `event`, `condition` and `task` triggers', () => {
    // The condition below must be a permitted predicate, or buildTrigger refuses it
    // before its shape can be asserted. See `scheduleContinuation — condition policy`.
    registerConditionPredicate({ serviceId: 'reactor.X@1.0.0', method: 'isMerged' });

    expect(buildTrigger({ ...HAPPY, at: undefined, eventName: 'pr.merged' } as any).trigger).toEqual({
      kind: 'event',
      eventName: 'pr.merged',
    });
    expect(
      buildTrigger({
        ...HAPPY,
        at: undefined,
        condition: { serviceId: 'reactor.X@1.0.0', method: 'isMerged', expectValue: true },
      } as any).trigger,
    ).toEqual({
      kind: 'condition',
      serviceId: 'reactor.X@1.0.0',
      method: 'isMerged',
      expectValue: true,
    });
    clearConditionPredicates();
    // A `condition` without its target is a refusal, not a silent no-op.
    expect(
      buildTrigger({ ...HAPPY, at: undefined, condition: { serviceId: '' } } as any).error,
    ).toMatch(/needs both serviceId and method/);
    expect(buildTrigger({ ...HAPPY, at: undefined, task: 'task-1' } as any).trigger).toEqual({
      kind: 'task',
      taskId: 'task-1',
    });
    expect(buildTrigger({ ...HAPPY, at: undefined, task: {} } as any).trigger).toEqual({ kind: 'task' });
  });
});

describe('defaultTtlMs', () => {
  it('honours an explicit ttlMs', () => {
    expect(defaultTtlMs({ ...HAPPY, ttlMs: 5000 } as any)).toBe(5000);
  });

  it('derives the deadline from `at` plus a grace window', () => {
    const now = Date.now();
    const at = new Date(now + 60_000).toISOString();
    expect(defaultTtlMs({ ...HAPPY, at } as any, now)).toBe(60_000 + 15 * 60 * 1000);
  });

  it('falls back to 24h and never returns a sub-minute deadline', () => {
    expect(defaultTtlMs({ ...HAPPY, at: undefined, eventName: 'x' } as any)).toBe(24 * 60 * 60 * 1000);
    const now = Date.now();
    // A deadline more than the grace window in the past would otherwise yield a
    // negative ttl, which the service rejects; clamp to the one-minute floor.
    expect(
      defaultTtlMs({ ...HAPPY, at: new Date(now - 60 * 60_000).toISOString() } as any, now),
    ).toBe(60_000);
  });
});

describe('isProducerless', () => {
  it('marks the triggers this delivery has no publisher for', () => {
    expect(isProducerless('event')).toBe(true);
    expect(isProducerless('task')).toBe(true);
    expect(isProducerless('webhook')).toBe(true);
    expect(isProducerless('at')).toBe(false);
    expect(isProducerless('condition')).toBe(false);
    expect(isProducerless(undefined)).toBe(false);
  });
});

// ── scheduleContinuation ─────────────────────────────────────────────────────

describe('scheduleContinuation — success', () => {
  it('registers and reports the deadline back to the model', async () => {
    const result: any = await ScheduleContinuationMacro(HAPPY as any, makeState());

    expect(result.success).toBe(true);
    expect(result.continuationId).toBe('cont-1');
    expect(result.fireAt).toEqual(expect.any(String));
    expect(result.producerAvailable).toBe(true);
    expect(result.instructions).toMatch(/Follow-up scheduled/);
    expect(result.instructions).toMatch(/report back/);

    // The built trigger and the derived deadline reach the service unchanged.
    expect(register).toHaveBeenCalledTimes(1);
    const passed = register.mock.calls[0][0] as any;
    expect(passed.chatSessionId).toBe(SESSION_ID);
    expect(passed.personaId).toBe('ReactorAIPersona');
    expect(passed.trigger.kind).toBe('at');
    expect(passed.ttlMs).toBeGreaterThan(0);
    expect(passed.resumePrompt).toBe(HAPPY.resumePrompt);
    expect(passed.expirePrompt).toBe(HAPPY.expirePrompt);
  });

  it('tells the model plainly when nothing can fire the trigger', async () => {
    // A `task` trigger has no producer in this delivery: the wait can only expire,
    // and the model must say that rather than imply it is being watched.
    const result: any = await ScheduleContinuationMacro(
      { ...HAPPY, at: undefined, task: 'task-1' } as any,
      makeState(),
    );

    expect(result.success).toBe(true);
    expect(result.producerAvailable).toBe(false);
    expect(result.instructions).toMatch(/can only expire/i);
    expect(result.instructions).toMatch(/WILL expire/);
  });

  it('uses an explicit chatSessionId / personaId when supplied', async () => {
    await ScheduleContinuationMacro(
      { ...HAPPY, chatSessionId: 'other-session', personaId: 'OtherPersona' } as any,
      makeState(),
    );

    const passed = register.mock.calls[0][0] as any;
    expect(passed.chatSessionId).toBe('other-session');
    expect(passed.personaId).toBe('OtherPersona');
  });

  it('prefers the explicit context argument over state.context', async () => {
    const explicit = {
      getService: jest.fn(() => ({ register, cancel, list })),
    } as any;

    await ScheduleContinuationMacro(HAPPY as any, makeState({ context: { getService: () => null } }), explicit);

    expect(register).toHaveBeenCalledTimes(1);
    expect(explicit.getService).toHaveBeenCalledWith(CONTINUATION_SERVICE_ID);
  });
});

describe('scheduleContinuation — refusals', () => {
  it('refuses when the continuation service is not available', async () => {
    const result: any = await ScheduleContinuationMacro(
      HAPPY as any,
      makeState({ context: { getService: () => null } }),
    );
    expect(result.success).toBe(false);
    expect(result.instructions).toMatch(/Do not promise the user a follow-up/);
    expect(register).not.toHaveBeenCalled();
  });

  it('refuses when the service lookup throws', async () => {
    const result: any = await ScheduleContinuationMacro(
      HAPPY as any,
      makeState({
        context: {
          getService: () => {
            throw new Error('service registry unavailable');
          },
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('refuses with no chat session', async () => {
    const result: any = await ScheduleContinuationMacro(HAPPY as any, makeState({ id: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No chat session/);
    expect(register).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous trigger before calling the service', async () => {
    const result: any = await ScheduleContinuationMacro(
      { ...HAPPY, eventName: 'pr.merged' } as any,
      makeState(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/More than one trigger/);
    expect(register).not.toHaveBeenCalled();
  });

  it('names every missing prompt and teaches the expirePrompt wording', async () => {
    const result: any = await ScheduleContinuationMacro(
      { at: HAPPY.at, reason: '', resumePrompt: '', expirePrompt: '' } as any,
      makeState(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reason/);
    expect(result.error).toMatch(/resumePrompt/);
    expect(result.error).toMatch(/expirePrompt/);
    // The instruction must show the wording that makes expiry honest.
    expect(result.instructions).toMatch(/not observed/);
    expect(result.instructions).toMatch(/Did not|did not|Do not report/);
    expect(register).not.toHaveBeenCalled();
  });

  // One case per refusal the service can return: the macro must surface the code
  // AND a message the model can act on, never a bare success.
  const refusals: Array<[string, () => any]> = [
    ['no_session', () => refusal('no_session')],
    ['no_identity', () => refusal('no_identity')],
    ['system_caller', () => refusal('system_caller')],
    ['session_not_owned', () => refusal('session_not_owned')],
    ['over_cap', () => refusal('over_cap', '3 active')],
    ['rate_limited', () => refusal('rate_limited', '42s remaining')],
    ['over_budget', () => refusal('over_budget', 'monthly limit')],
    ['invalid_ttl', () => refusal('invalid_ttl')],
    ['duplicate', () => refusal('duplicate')],
  ];

  it.each(refusals)('surfaces the %s refusal actionably', async (code, make) => {
    register.mockResolvedValue(make());

    const result: any = await ScheduleContinuationMacro(HAPPY as any, makeState());

    expect(result.success).toBe(false);
    expect(result.code).toBe(code);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(20);
    // Every refusal still carries the honesty rule and names the code.
    expect(result.instructions).toMatch(/Never tell the user you will follow up/);
    expect(result.instructions).toContain(code);
  });

  it('refuses an invalid ttl with the reason spelled out', async () => {
    register.mockResolvedValue(refusal('invalid_ttl'));

    const result: any = await ScheduleContinuationMacro(HAPPY as any, makeState());

    expect(result.code).toBe('invalid_ttl');
    expect(result.error).toMatch(/ttlMs is required/);
  });

  it('falls back to a generic message when the service refuses without one', async () => {
    register.mockResolvedValue({ registered: false });

    const result: any = await ScheduleContinuationMacro(HAPPY as any, makeState());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/was not registered/);
  });

  it('converts a register() throw into success:false — never success:true', async () => {
    // `register` throws only when the waiter could not be started, i.e. nothing is
    // waiting. Reporting success here would be the exact unbacked promise this
    // feature exists to remove.
    register.mockRejectedValue(new Error('Could not start the continuation waiter (host not started).'));

    const result: any = await ScheduleContinuationMacro(HAPPY as any, makeState());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/host not started/);
    expect(result.instructions).toMatch(/Nothing is waiting|Cannot schedule/);
  });

  it('does not throw when register rejects with a non-Error', async () => {
    register.mockRejectedValue('boom');
    const result: any = await ScheduleContinuationMacro(HAPPY as any, makeState());
    expect(result.success).toBe(false);
  });
});

// ── cancelContinuation ───────────────────────────────────────────────────────

describe('cancelContinuation', () => {
  it('cancels and tells the model not to report back', async () => {
    const result: any = await CancelContinuationMacro({ continuationId: 'cont-1', reason: 'done' }, makeState());

    expect(result.success).toBe(true);
    expect(cancel).toHaveBeenCalledWith({ continuationId: 'cont-1', reason: 'done' });
    expect(result.instructions).toMatch(/will not report back/);
  });

  it('refuses without a continuationId', async () => {
    const result: any = await CancelContinuationMacro({} as any, makeState());
    expect(result.success).toBe(false);
    expect(result.instructions).toMatch(/listContinuations/);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('refuses when the service is unavailable', async () => {
    const result: any = await CancelContinuationMacro(
      { continuationId: 'cont-1' },
      makeState({ context: { getService: () => null } }),
    );
    expect(result.success).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', /No continuation exists/],
    ['not_owner', /belongs to a different user/],
    ['already_fired', /already fired or expired/],
  ])('reports the %s reason with a recovery step', async (reason, pattern) => {
    cancel.mockResolvedValue({ cancelled: false, reason });

    const result: any = await CancelContinuationMacro({ continuationId: 'cont-1' }, makeState());

    expect(result.success).toBe(false);
    expect(result.error).toContain(reason);
    expect(result.instructions).toMatch(pattern);
  });

  it('reports an unknown refusal without throwing', async () => {
    cancel.mockResolvedValue({ cancelled: false });

    const result: any = await CancelContinuationMacro({ continuationId: 'cont-1' }, makeState());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown reason/);
  });

  it('does not throw when the service throws', async () => {
    cancel.mockRejectedValue(new Error('db down'));

    const result: any = await CancelContinuationMacro({ continuationId: 'cont-1' }, makeState());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/db down/);
  });
});

// ── listContinuations ────────────────────────────────────────────────────────

describe('listContinuations', () => {
  const view = {
    continuationId: 'cont-1',
    chatSessionId: SESSION_ID,
    personaId: 'ReactorAIPersona',
    reason: 'PR #482 merge',
    triggerKind: 'at',
    triggerSummary: 'at 2026-10-23T16:00:00.000Z',
    state: 'armed',
    fireAt: '2026-10-23T16:00:00.000Z',
    attempt: 0,
    maxAttempts: 2,
    createdAt: '2026-10-23T12:00:00.000Z',
    updatedAt: '2026-10-23T12:00:00.000Z',
  };

  it('lists the current session and renders a readable summary', async () => {
    list.mockResolvedValue([view]);

    const result: any = await ListContinuationsMacro({}, makeState());

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.instructions).toMatch(/waiting/);
    expect(result.instructions).toContain('PR #482 merge');
    // The session filter is passed through, so a model cannot read another session.
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ chatSessionId: SESSION_ID }));
  });

  it('never surfaces the correlation key', async () => {
    list.mockResolvedValue([view]);

    const result: any = await ListContinuationsMacro({}, makeState());

    expect(JSON.stringify(result)).not.toContain('correlationKey');
  });

  it('handles an empty list', async () => {
    const result: any = await ListContinuationsMacro({}, makeState());
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.instructions).toMatch(/Nothing is waiting/);
  });

  it('tolerates a null result from the service', async () => {
    list.mockResolvedValue(null as any);
    const result: any = await ListContinuationsMacro({}, makeState());
    expect(result.count).toBe(0);
  });

  it('passes the explicit filters through', async () => {
    await ListContinuationsMacro(
      { chatSessionId: 'other', state: 'expired', includeTerminal: true, limit: 5 },
      makeState(),
    );
    expect(list).toHaveBeenCalledWith({
      chatSessionId: 'other',
      state: 'expired',
      includeTerminal: true,
      limit: 5,
    });
  });

  it('refuses when the service is unavailable', async () => {
    const result: any = await ListContinuationsMacro(
      {},
      makeState({ context: { getService: () => null } }),
    );
    expect(result.success).toBe(false);
  });

  it('does not throw when the service throws', async () => {
    list.mockRejectedValue(new Error('db down'));
    const result: any = await ListContinuationsMacro({}, makeState());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/db down/);
  });
});

// ── registry ─────────────────────────────────────────────────────────────────

describe('registry', () => {
  it('exposes the three tools the model is told about', () => {
    const names = ContinuationMacroRegistry.map((m) => m.name);
    expect(names).toEqual(['scheduleContinuation', 'cancelContinuation', 'listContinuations']);
    for (const entry of ContinuationMacroRegistry) {
      expect(entry.roles).toEqual(['USER']);
      expect(entry.tools?.[0]?.function?.name).toBe(entry.name);
    }
  });

  it('requires only the prompts that carry the honesty invariant', () => {
    const schedule = ContinuationMacroRegistry[0];
    expect(schedule.tools?.[0]?.function?.parameters?.required).toEqual([
      'reason',
      'resumePrompt',
      'expirePrompt',
    ]);
  });
});

// ── condition triggers: refused unless the pair is permitted ─────────────────

/**
 * The reviewer's escalation: `scheduleContinuation` is exposed to role USER and a
 * `condition` is evaluated by the SWEEPER under the system identity. So an
 * arbitrary `serviceId`/`method` would let a user — or a prompt-injected model —
 * have any platform method called with SYSTEM privileges, repeatedly.
 *
 * The macro refuses it before the service is even asked, so the model gets an
 * actionable message naming the policy rather than a generic failure.
 */
describe('scheduleContinuation — condition policy', () => {
  const conditionProps = (serviceId: string, method: string, params?: any) => ({
    ...HAPPY,
    at: undefined,
    condition: { serviceId, method, expectPath: 'merged', expectValue: true, ...(params ? { params } : {}) },
  });

  afterEach(() => {
    clearConditionPredicates();
  });

  it("refuses the reviewer's reproduction at the macro layer", async () => {
    const result: any = await ScheduleContinuationMacro(
      conditionProps('core.UserService@1.0.0', 'createUser', { email: 'attacker@example.com' }),
      makeState(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a permitted condition predicate/);
    expect(result.error).toMatch(/core\.UserService@1\.0\.0\.createUser/);
    expect(result.instructions).toMatch(/No condition predicates are permitted/);
    expect(result.instructions).toMatch(/Use `at` instead/);
    // The service is never asked, so nothing is inserted and nothing is started.
    expect(register).not.toHaveBeenCalled();
  });

  it('names the permitted pairs when some are configured', async () => {
    registerConditionPredicate({ serviceId: 'reactor.X@1.0.0', method: 'isMerged' });

    const refused: any = await ScheduleContinuationMacro(
      conditionProps('core.UserService@1.0.0', 'createUser'),
      makeState(),
    );
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('reactor.X@1.0.0.isMerged');
    expect(refused.instructions).toContain('reactor.X@1.0.0.isMerged');

    const allowed: any = await ScheduleContinuationMacro(
      conditionProps('reactor.X@1.0.0', 'isMerged', { pr: 482 }),
      makeState(),
    );
    expect(allowed.success).toBe(true);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({
          kind: 'condition',
          serviceId: 'reactor.X@1.0.0',
          method: 'isMerged',
          params: { pr: 482 },
        }),
      }),
    );
  });

  it('still requires serviceId and method', async () => {
    const result: any = await ScheduleContinuationMacro(
      { ...HAPPY, at: undefined, condition: { serviceId: 'reactor.X@1.0.0' } } as any,
      makeState(),
    );
    expect(result.error).toMatch(/needs both serviceId and method/);
  });

  it('surfaces a service-side condition refusal as success:false', async () => {
    // Both layers refuse. This asserts the macro does not swallow the service's own
    // refusal when a pair passes the macro gate but the service disagrees — e.g. the
    // allowlist was narrowed between the two checks.
    registerConditionPredicate({ serviceId: 'reactor.X@1.0.0', method: 'isMerged' });
    register.mockResolvedValue(
      refusal('invalid_trigger', '`reactor.X@1.0.0.isMerged` is not a permitted condition predicate.'),
    );

    const result: any = await ScheduleContinuationMacro(
      conditionProps('reactor.X@1.0.0', 'isMerged'),
      makeState(),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe('invalid_trigger');
    expect(result.instructions).toMatch(/Never tell the user you will follow up/);
  });
});