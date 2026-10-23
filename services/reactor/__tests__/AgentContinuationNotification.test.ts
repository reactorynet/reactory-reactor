import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ObjectId } from 'mongodb';

/**
 * "Never silent" — the notification contract for a continuation that ended without
 * a confirmed result.
 *
 * Acceptance criterion: `expired`, `orphaned` and `failed` must EACH produce a
 * visible notification. Three things are asserted per state:
 *
 *   1. a task is written to the owner (`reactory_tasks`, the surface `userTasks`
 *      and `user_activity` already use) — the guaranteed channel;
 *   2. the text names the `reason` and states plainly that **the signal was not
 *      observed**, so the message cannot be read as a result;
 *   3. the record ends up carrying `notifiedAt` / `notificationChannel`, so "the
 *      owner was told" is a fact in the data rather than an inference from a log.
 *
 * The communicator is deliberately optional and un-wired elsewhere in the
 * programme, so the tests cover both directions: accepted (channel is
 * `communicator+task`) and throwing/declining (channel stays `task`, and the task
 * is still written). A single channel failure must never suppress the other.
 */

const taskSave = jest.fn(async function (this: any) {
  return this;
});
const taskFindOne = jest.fn();
const taskDocuments: any[] = [];

jest.mock('@reactory/server-modules/reactory-core/models/Task', () => {
  const Model: any = function (this: any, doc: any) {
    taskDocuments.push(doc);
    Object.assign(this, doc, { _id: new ObjectId() });
  };
  Model.findOne = (...args: any[]) => ({ exec: async () => taskFindOne(...args) });
  Model.prototype.save = taskSave;
  return { __esModule: true, default: Model };
});

import AgentContinuationModel from '../../../models/AgentContinuation';
import AgentContinuationService, {
  buildNonDeliveryNotification,
  COMMUNICATOR_SERVICE_ID,
  CONTINUATION_WORKFLOW_ID,
} from '../AgentContinuationService';

const ownerId = new ObjectId();

const record = (overrides: Record<string, any> = {}) => ({
  continuationId: 'cont-1',
  chatSessionId: '507f1f77bcf86cd799439011',
  personaId: 'ReactorAIPersona',
  ownerUserId: ownerId,
  ownerEmail: 'owner@example.com',
  reason: 'PR #482 merge',
  state: 'expired',
  workflowInstanceId: 'instance-1',
  ...overrides,
});

/** The service with only the state the notification path touches. */
const buildService = (communicator: any = null) => {
  const service: any = Object.create(AgentContinuationService.prototype);
  service.context = {
    user: { _id: ownerId },
    log: jest.fn(),
    getService: jest.fn((id: string) => (id === COMMUNICATOR_SERVICE_ID ? communicator : null)),
  };
  return service;
};

let updated: any[] = [];

beforeEach(() => {
  taskSave.mockClear();
  taskFindOne.mockReset();
  taskFindOne.mockResolvedValue(null);
  taskDocuments.length = 0;
  updated = [];

  jest.spyOn(AgentContinuationModel, 'updateOne').mockImplementation(((_filter: any, update: any) => ({
    exec: async () => {
      updated.push(update);
      return { acknowledged: true };
    },
  })) as any);
});

describe.each([
  ['expired', /deadline passed before the outcome could be confirmed/i],
  ['orphaned', /no longer available/i],
  ['failed', /could not be delivered/i],
] as const)('a %s continuation notifies the owner', (state, stateWording) => {
  it('writes a task on the owner with the reason and the not-observed fact', async () => {
    const service = buildService();

    await service.notifyNonDelivery(record(), { state, reason: 'test_reason' });

    expect(taskDocuments).toHaveLength(1);
    const task = taskDocuments[0];

    expect(task.user).toBe(ownerId);
    expect(task.category).toBe('agent-continuation');
    expect(task.status).toBe('pending');
    expect(task.workflowStatus).toBe('attention_required');
    expect(task.workflowId).toBe(CONTINUATION_WORKFLOW_ID);

    // The two facts the ticket requires: what was awaited, and that it was NOT observed.
    expect(task.title).toContain('PR #482 merge');
    expect(task.description).toContain('PR #482 merge');
    expect(task.description).toMatch(/The signal was not observed/i);
    expect(task.description).toMatch(stateWording);
    expect(task.description).toContain('test_reason');

    expect(task.componentProps).toMatchObject({
      continuationId: 'cont-1',
      chatSessionId: '507f1f77bcf86cd799439011',
      state,
      outcome: 'not_observed',
      notificationChannel: 'task',
    });
  });

  it('records the notification evidence on the continuation', async () => {
    const service = buildService();

    await service.notifyNonDelivery(record(), { state, reason: 'test_reason' });

    expect(updated).toHaveLength(1);
    expect(updated[0].$set).toMatchObject({
      notificationChannel: 'task',
    });
    expect(updated[0].$set.notifiedAt).toBeInstanceOf(Date);
  });
});

describe('notification wording', () => {
  it('distinguishes a sweeper outage from a signal that never came (F6)', () => {
    const outage = buildNonDeliveryNotification(
      { continuationId: 'c', chatSessionId: 's', reason: 'PR 482', eventReason: 'time_passed_unswept' },
      { state: 'expired', reason: 'time_passed_unswept' },
    );

    expect(outage.text).toMatch(/sweeper was not running/i);
    expect(outage.text).toMatch(/not a verdict/i);
    // Still conservative: the outcome is unknown, not "it did not happen".
    expect(outage.text).toMatch(/The signal was not observed/i);
  });

  it('says the wake was published but not delivered when that is what happened', () => {
    const message = buildNonDeliveryNotification(
      {
        continuationId: 'c',
        chatSessionId: 's',
        reason: 'PR 482',
        eventReason: 'wake_published_not_delivered',
      },
      { state: 'expired', reason: 'wake_published_not_delivered' },
    );

    expect(message.text).toMatch(/never delivered to your session/i);
  });

  it('does not claim an outage for an ordinary deadline pass', () => {
    const message = buildNonDeliveryNotification(
      { continuationId: 'c', chatSessionId: 's', reason: 'PR 482', eventReason: 'deadline_passed' },
      { state: 'expired', reason: 'deadline_passed' },
    );

    expect(message.text).not.toMatch(/sweeper was not running/i);
    expect(message.text).toMatch(/deadline passed/i);
  });

  it('truncates a runaway reason in both subject and body', () => {
    const message = buildNonDeliveryNotification(
      { continuationId: 'c', chatSessionId: 's', reason: 'x'.repeat(500) },
      { state: 'failed', reason: 'send_failed' },
    );

    expect(message.subject.length).toBeLessThanOrEqual('Agent follow-up not observed: '.length + 80);
    // The body keeps its 200-char budget but must not carry the whole flood.
    expect(message.text.length).toBeLessThan(1000);
  });
});

describe('channel selection', () => {
  it('uses communicator+task when the communicator accepts', async () => {
    const send = jest.fn(async () => ({ success: true }));
    const service = buildService({ send });

    const channel = await service.notifyNonDelivery(record(), {
      state: 'expired',
      reason: 'deadline_passed',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const payload = (send.mock.calls[0] as any[])[0];
    expect(payload).toMatchObject({
      channel: 'email',
      to: 'owner@example.com',
      metadata: { continuationId: 'cont-1', state: 'expired' },
    });
    expect(payload.content.text).toMatch(/The signal was not observed/i);

    expect(channel).toBe('communicator+task');
    // The task is still raised: the optional channel never replaces the durable one.
    expect(taskDocuments).toHaveLength(1);
  });

  it.each([
    ['throws', jest.fn(async () => { throw new Error('provider down'); })],
    ['declines', jest.fn(async () => ({ success: false, error: 'no provider' }))],
  ])('still raises the task when the communicator %s', async (_label, send) => {
    const service = buildService({ send });

    const channel = await service.notifyNonDelivery(record(), {
      state: 'expired',
      reason: 'deadline_passed',
    });

    expect(channel).toBe('task');
    expect(taskDocuments).toHaveLength(1);
    // The reason the optional channel failed is kept for diagnosis.
    expect(updated[0].$set.notificationError).toBeTruthy();
  });

  it('does not attempt the communicator without an owner email', async () => {
    const send = jest.fn(async () => ({ success: true }));
    const service = buildService({ send });

    const channel = await service.notifyNonDelivery(record({ ownerEmail: '' }), {
      state: 'failed',
      reason: 'send_failed',
    });

    expect(send).not.toHaveBeenCalled();
    expect(channel).toBe('task');
  });

  it('reports none, loudly, when both channels fail', async () => {
    const service = buildService(null);
    taskSave.mockRejectedValueOnce(new Error('task collection unavailable'));

    const channel = await service.notifyNonDelivery(record(), {
      state: 'orphaned',
      reason: 'owner_mismatch',
    });

    expect(channel).toBe('none');
    expect(service.context.log).toHaveBeenCalledWith(
      expect.stringMatching(/ended without delivery; owner notified/),
      expect.objectContaining({ channel: 'none', state: 'orphaned' }),
      'error',
    );
  });
});

describe('idempotency', () => {
  it('does not raise a second task, and does not re-send, when one exists', async () => {
    const send = jest.fn(async () => ({ success: true }));
    const service = buildService({ send });
    taskFindOne.mockResolvedValue({
      _id: new ObjectId(),
      componentProps: { notificationChannel: 'communicator+task' },
    });

    const channel = await service.notifyNonDelivery(record(), {
      state: 'expired',
      reason: 'deadline_passed',
    });

    expect(channel).toBe('communicator+task');
    expect(send).not.toHaveBeenCalled();
    expect(taskDocuments).toHaveLength(0);
  });

  it('defaults to the task channel when the existing task has no channel recorded', async () => {
    const service = buildService();
    taskFindOne.mockResolvedValue({ _id: new ObjectId(), componentProps: {} });

    const channel = await service.notifyNonDelivery(record(), {
      state: 'failed',
      reason: 'send_failed',
    });

    expect(channel).toBe('task');
    expect(taskDocuments).toHaveLength(0);
  });
});
