import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * The `todo` projection of durable continuations.
 *
 * The owner's mental model is "a todo that wakes me", so pending continuations are
 * rendered inside `todo(action="list")`. The ticket's constraint is the interesting
 * one: the todo model must not grow scheduler semantics. These tests therefore
 * assert the *negative* space as hard as the positive one:
 *
 *   - a continuation appears in `continuations`, and only there;
 *   - it is not written into `state.vars['reactor.todos']`, so a later `get` or
 *     `update` cannot find it;
 *   - `update` / `assign` / `remove` refuse the `continuation:` prefix by name,
 *     naming `cancelContinuation`, and leave the stored lists untouched;
 *   - `todo(dueAt=…)` is refused, naming `scheduleContinuation`. That refusal is
 *     the teaching moment the ticket calls out: the failure mode being removed is
 *     a model saying "I'll follow up at 14:00" with nothing behind it.
 */

import { TodoMacro } from '../todoMacro.macro';
import {
  CONTINUATION_ID_PREFIX,
  CONTINUATION_SERVICE_ID,
  projectContinuation,
  formatContinuationDeadline,
  isContinuationProjectionId,
} from '../continuationProjection';

const SESSION_ID = '507f1f77bcf86cd799439011';
const LIST_ID = 'list-1';
const TODO_ID = 'todo-1';

const continuationView = (overrides: Record<string, any> = {}) => ({
  continuationId: '6f3a1b2c-0000-4000-8000-000000000001',
  reason: 'PR 482 merge',
  state: 'armed',
  // Deliberately far enough out that the label is a date+time, not a bare time:
  // that keeps the assertion independent of the hour the suite runs at.
  fireAt: '2026-12-31T14:00:00.000Z',
  ...overrides,
});

const list = jest.fn(async () => [continuationView()]);

/**
 * A state with one ordinary todo item, so every refusal can assert that the stored
 * list is byte-for-byte unchanged rather than merely "the call returned false".
 */
const makeState = (overrides: Record<string, any> = {}) =>
  ({
    id: SESSION_ID,
    personaId: 'ReactorAIPersona',
    vars: {
      'reactor.todos': {
        [LIST_ID]: {
          id: LIST_ID,
          name: 'Release work',
          executionMode: 'series',
          createdAt: '2026-10-23T09:00:00.000Z',
          updatedAt: '2026-10-23T09:00:00.000Z',
          items: [
            {
              id: TODO_ID,
              title: 'Write the release note',
              status: 'pending',
              createdAt: '2026-10-23T09:00:00.000Z',
              updatedAt: '2026-10-23T09:00:00.000Z',
            },
          ],
        },
      },
    },
    history: [],
    ...overrides,
  }) as any;

const makeContext = (service: any = { list }) =>
  ({
    getService: jest.fn((id: string) => (id === CONTINUATION_SERVICE_ID ? service : null)),
  }) as any;

/** Snapshot of the todo vars, used to prove a refusal mutated nothing. */
const snapshot = (state: any) => JSON.stringify(state.vars['reactor.todos']);

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue([continuationView()]);
});

describe('todo(list) — pending continuations are rendered read-only', () => {
  it('includes the continuation with a human label and namespaced id', async () => {
    const state = makeState();

    const result: any = await TodoMacro({ action: 'list' }, state, makeContext());

    expect(result.success).toBe(true);
    expect(result.operation).toBe('list');
    expect(result.continuations).toHaveLength(1);

    const [entry] = result.continuations;
    expect(entry.continuationId).toBe('6f3a1b2c-0000-4000-8000-000000000001');
    expect(entry.id).toBe(`${CONTINUATION_ID_PREFIX}6f3a1b2c-0000-4000-8000-000000000001`);
    expect(entry.label).toMatch(/^⏳ waiting on PR 482 merge until /);
    expect(entry.label).toContain('(continuation 6f3a…)');
  });

  it('declares every affordance read-only', async () => {
    const result: any = await TodoMacro({ action: 'list' }, makeState(), makeContext());

    expect(result.continuations[0]).toMatchObject({
      readOnly: true,
      completable: false,
      editable: false,
      removable: false,
      cancelWith: 'cancelContinuation',
    });
  });

  it('renders the waits in the model-facing instructions as well as the data', async () => {
    const result: any = await TodoMacro({ action: 'list' }, makeState(), makeContext());

    expect(result.instructions).toContain('Waiting (read-only — 1)');
    expect(result.instructions).toContain('⏳ waiting on PR 482 merge');
    expect(result.instructions).toContain('cancelContinuation');
  });

  it('does NOT insert the continuation into the todo vars', async () => {
    const state = makeState();
    const before = snapshot(state);

    await TodoMacro({ action: 'list' }, state, makeContext());

    // The projection is a rendering, not an insertion. If this ever changes, the
    // entry becomes completable and "done" competes with "fired" as a truth.
    expect(snapshot(state)).toBe(before);
    expect(state.vars['reactor.todos'][LIST_ID].items).toHaveLength(1);
    expect(state.vars['reactor.todos'][LIST_ID].items[0].id).toBe(TODO_ID);
    expect(isContinuationProjectionId(state.vars['reactor.todos'][LIST_ID].items[0].id)).toBe(
      false,
    );
  });

  it('scopes the read to the current chat session', async () => {
    await TodoMacro({ action: 'list' }, makeState(), makeContext());
    expect(list).toHaveBeenCalledWith({ chatSessionId: SESSION_ID });
  });

  it('never serialises correlationKey, even if the service leaks it', async () => {
    list.mockResolvedValueOnce([continuationView({ correlationKey: 'k'.repeat(64) })]);

    const result: any = await TodoMacro({ action: 'list' }, makeState(), makeContext());

    expect(result.continuations[0]).not.toHaveProperty('correlationKey');
    expect(JSON.stringify(result)).not.toContain('k'.repeat(64));
    expect(JSON.stringify(result)).not.toMatch(/correlationKey/);
  });

  it('still lists todos when the continuation service throws', async () => {
    list.mockRejectedValueOnce(new Error('mongo unavailable'));

    const result: any = await TodoMacro({ action: 'list' }, makeState(), makeContext());

    // Observability is decoration here: losing it must not break the todo surface.
    expect(result.success).toBe(true);
    expect(result.continuations).toEqual([]);
    expect(result.lists[0].id).toBe(LIST_ID);
  });

  it('still lists todos when the service is not registered', async () => {
    const result: any = await TodoMacro({ action: 'list' }, makeState(), {
      getService: () => null,
    } as any);

    expect(result.success).toBe(true);
    expect(result.continuations).toEqual([]);
  });

  it('lists todos when there is no context at all', async () => {
    const result: any = await TodoMacro({ action: 'list' }, makeState());

    expect(result.success).toBe(true);
    expect(result.continuations).toEqual([]);
  });

  it('describes a firing continuation as waking now, not as waiting until', async () => {
    list.mockResolvedValueOnce([continuationView({ state: 'firing' })]);

    const result: any = await TodoMacro({ action: 'list' }, makeState(), makeContext());

    expect(result.continuations[0].label).toMatch(/^⏳ waking now for PR 482 merge/);
  });
});

describe('todo — continuations cannot be completed, edited, assigned or removed', () => {
  const protectedId = `${CONTINUATION_ID_PREFIX}6f3a1b2c-0000-4000-8000-000000000001`;

  it.each([
    ['update', { action: 'update', listId: LIST_ID, todoId: protectedId, status: 'completed' }],
    ['assign', { action: 'assign', listId: LIST_ID, todoId: protectedId, assignee: 'Someone' }],
    ['remove', { action: 'remove', listId: LIST_ID, todoId: protectedId }],
  ])('%s refuses and names cancelContinuation', async (_action, props) => {
    const state = makeState();
    const before = snapshot(state);

    const result: any = await TodoMacro(props as any, state, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/read-only/);
    expect(result.error).toContain('cancelContinuation');
    expect(result.instructions).toContain('cancelContinuation');
    // The refusal must be a teaching error, not a mutation that reported failure.
    expect(snapshot(state)).toBe(before);
  });

  it('refuses with the bare continuation id in the recovery instruction', async () => {
    const result: any = await TodoMacro(
      { action: 'update', listId: LIST_ID, todoId: protectedId, status: 'completed' },
      makeState(),
      makeContext(),
    );

    expect(result.error).toContain('6f3a1b2c-0000-4000-8000-000000000001');
    expect(result.instructions).toContain('6f3a1b2c-0000-4000-8000-000000000001');
  });

  it('still updates ordinary todos normally', async () => {
    const state = makeState();

    // Guard against the refusal being implemented as "reject everything".
    const result: any = await TodoMacro(
      { action: 'update', listId: LIST_ID, todoId: TODO_ID, status: 'completed' },
      state,
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(state.vars['reactor.todos'][LIST_ID].items[0].status).toBe('completed');
  });
});

describe('todo — a due date is refused, and the refusal teaches scheduleContinuation', () => {
  it.each([
    ['dueAt', '2026-10-23T14:00:00.000Z'],
    ['due_at', '2026-10-23T14:00:00.000Z'],
    ['dueDate', '2026-10-23'],
    ['due', 'tomorrow'],
    ['at', '2026-10-23T14:00:00.000Z'],
    ['remindAt', '2026-10-23T14:00:00.000Z'],
    ['remind_at', '2026-10-23T14:00:00.000Z'],
    ['wakeAt', '2026-10-23T14:00:00.000Z'],
    ['wake_at', '2026-10-23T14:00:00.000Z'],
    ['scheduledFor', '2026-10-23T14:00:00.000Z'],
    ['scheduled_for', '2026-10-23T14:00:00.000Z'],
    ['trigger', 'pr.merged'],
    ['schedule', '0 14 * * *'],
  ])('rejects %s', async (argument, value) => {
    const state = makeState();
    const before = snapshot(state);

    const result: any = await TodoMacro(
      { action: 'list', [argument]: value } as any,
      state,
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.operation).toBe('rejected');
    expect(result.error).toContain('scheduleContinuation');
    expect(result.error).toContain(argument);
    expect(result.instructions).toContain('scheduleContinuation');
    // Rejected means rejected: no todo list was created or touched.
    expect(snapshot(state)).toBe(before);
  });

  it('rejects a due date on `add` before adding anything', async () => {
    const state = makeState();
    const before = snapshot(state);

    const result: any = await TodoMacro(
      { action: 'add', listId: LIST_ID, title: 'Follow up on the PR', dueAt: '2026-10-23T14:00:00Z' },
      state,
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('scheduleContinuation');
    expect(snapshot(state)).toBe(before);
  });

  it('points at the durable mechanism rather than a note that never fires', async () => {
    const result: any = await TodoMacro(
      { action: 'list', dueAt: '2026-10-23T14:00:00Z' },
      makeState(),
      makeContext(),
    );

    expect(result.error).toMatch(/nothing will fire/i);
    expect(result.instructions).toContain('expirePrompt');
    expect(result.instructions).toMatch(/NOT observed/);
  });

  it('does not treat empty or null scheduling arguments as a request', async () => {
    // A model that serialises optional fields must not be blocked from using todo.
    for (const empty of ['', null, undefined]) {
      const result: any = await TodoMacro(
        { action: 'list', dueAt: empty } as any,
        makeState(),
        makeContext(),
      );
      expect(result.success).toBe(true);
    }
  });
});

describe('projection helpers', () => {
  it('formats a same-day deadline as a time and another day as a date', () => {
    const now = new Date(2026, 9, 23, 9, 0, 0); // 23 Oct 2026, local

    expect(formatContinuationDeadline(new Date(2026, 9, 23, 14, 0, 0).toISOString(), now)).toBe(
      '14:00',
    );
    expect(formatContinuationDeadline(new Date(2026, 9, 24, 9, 30, 0).toISOString(), now)).toBe(
      '2026-10-24 09:30',
    );
    expect(formatContinuationDeadline('not-a-date', now)).toBe('an unknown time');
  });

  it('produces the exact documented label shape', () => {
    const now = new Date(2026, 9, 23, 9, 0, 0);
    const entry = projectContinuation(
      {
        continuationId: '6f3a1b2c-0000-4000-8000-000000000001',
        reason: 'PR 482 merge',
        state: 'armed',
        fireAt: new Date(2026, 9, 23, 14, 0, 0).toISOString(),
      },
      now,
    );

    expect(entry.label).toBe('⏳ waiting on PR 482 merge until 14:00 (continuation 6f3a…)');
  });

  it('truncates a runaway reason so the label cannot flood context', () => {
    const entry = projectContinuation({
      continuationId: 'abc123',
      reason: 'x'.repeat(500),
      state: 'armed',
      fireAt: new Date().toISOString(),
    });

    expect(entry.reason).toHaveLength(160);
  });

  it('recognises only the continuation prefix', () => {
    expect(isContinuationProjectionId(`${CONTINUATION_ID_PREFIX}abc`)).toBe(true);
    expect(isContinuationProjectionId('abc')).toBe(false);
    expect(isContinuationProjectionId(undefined)).toBe(false);
  });
});
