import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

/**
 * Adapter-level tests for `MongoProgrammeStore`.
 *
 * The idempotency guarantee of this feature lives in ONE place: the conditional
 * `findOneAndUpdate` that claims a package. The service-level suite asserts the
 * behaviour against an in-memory double, which would stay green even if this file
 * built the wrong filter — e.g. a document-level `dispatchId` check (which would
 * freeze a programme after its first dispatch) or a positional `$` path that
 * silently no-ops.
 *
 * So these tests do not stand up a database: they spy on the model and assert the
 * EXACT filter and update documents the store constructs. That is the contract
 * Mongo executes.
 */

import WorkflowProgrammeModel from '../../../models/WorkflowProgramme';
import { MongoProgrammeStore } from '../workflowProgramme/ProgrammeStore';

/** A chainable stub for `Model.find(...).sort(...).limit(...).exec()`. */
const queryStub = (result: any) => {
  const query: any = {
    sort: () => query,
    limit: () => query,
    select: () => query,
    lean: () => query,
    exec: async () => result,
  };
  return query;
};

/** A thenable-free stub for `Model.findOneAndUpdate(...).exec()`. */
const execStub = (result: any) => ({ exec: async () => result });

let written: any;
let store: MongoProgrammeStore;

const findOneAndUpdateSpy = () => jest.spyOn(WorkflowProgrammeModel, 'findOneAndUpdate') as any;
const updateOneSpy = () => jest.spyOn(WorkflowProgrammeModel, 'updateOne') as any;
const findOneSpy = () => jest.spyOn(WorkflowProgrammeModel, 'findOne') as any;
const findSpy = () => jest.spyOn(WorkflowProgrammeModel, 'find') as any;

beforeEach(() => {
  store = new MongoProgrammeStore();
  written = { doc: { programmeId: 'p1' } };
  jest.restoreAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── transitionPackage: the predicate the whole design rests on ───────────────

describe('MongoProgrammeStore.transitionPackage', () => {
  it('puts "never dispatched" INSIDE $elemMatch, and writes through the positional $', async () => {
    findOneAndUpdateSpy().mockReturnValue(execStub(written));

    const result = await store.transitionPackage({
      programmeId: 'p1',
      packageId: 'pkg-1',
      expect: { state: 'ready', dispatchIdAbsent: true },
      set: { state: 'dispatching', dispatchId: 'dispatch-1', dispatchedAt: new Date(0) },
      unset: ['childInstanceId', 'lastError'],
      inc: { attempt: 1 },
    });

    expect(result).toBe(written);

    const [filter, update, options] = findOneAndUpdateSpy().mock.calls[0];
    // THE assertion: the dispatch-id precondition is per element, because a
    // document-level `packages.dispatchId: { $exists: false }` would permanently
    // block every other package once the first one dispatched.
    expect(filter).toEqual({
      programmeId: 'p1',
      packages: { $elemMatch: { id: 'pkg-1', state: 'ready', dispatchId: { $exists: false } } },
    });
    expect(filter).not.toHaveProperty('packages.dispatchId');
    expect((filter as any).packages.$elemMatch.dispatchId).toEqual({ $exists: false });

    expect((update as any).$set['packages.$.state']).toBe('dispatching');
    expect((update as any).$set['packages.$.dispatchId']).toBe('dispatch-1');
    expect((update as any).$set['packages.$.dispatchedAt']).toEqual(new Date(0));
    // Never write a positional path for a field that is not part of a package.
    expect((update as any).$set).not.toHaveProperty('state');
    expect((update as any).$unset).toEqual({
      'packages.$.childInstanceId': 1,
      'packages.$.lastError': 1,
    });
    expect((update as any).$inc).toEqual({ 'packages.$.attempt': 1 });
    expect(options).toEqual({ new: true });
  });

  it('puts the expected PROGRAMME state in the document filter (the abort/pause guard)', async () => {
    findOneAndUpdateSpy().mockReturnValue(execStub(null));

    const result = await store.transitionPackage({
      programmeId: 'p1',
      packageId: 'pkg-1',
      expect: { state: 'ready', dispatchIdAbsent: true },
      expectProgrammeStates: ['active'],
      set: { state: 'dispatching' },
    });

    expect(result).toBeNull();
    const [filter] = findOneAndUpdateSpy().mock.calls[0];
    // BOTH guards travel together: the package predicate AND the programme state, in
    // ONE findOneAndUpdate, so a claim and an abort contend for the same document.
    expect(filter).toEqual({
      programmeId: 'p1',
      state: { $in: ['active'] },
      packages: { $elemMatch: { id: 'pkg-1', state: 'ready', dispatchId: { $exists: false } } },
    });
  });

  it('omits the programme-state clause when the caller does not ask for it', async () => {
    findOneAndUpdateSpy().mockReturnValue(execStub(written));

    await store.transitionPackage({
      programmeId: 'p1',
      packageId: 'pkg-1',
      expect: { state: 'dispatching', dispatchId: 'd-1' },
      set: { state: 'running' },
    });

    const [filter] = findOneAndUpdateSpy().mock.calls[0];
    expect(filter).not.toHaveProperty('state');
  });

  it('filters list queries by owner in the query, not after the fact', async () => {
    const find = findSpy().mockReturnValue(queryStub([]));

    await store.findMany({ ownerUserId: 'owner-1', state: 'active' }, 25);

    expect(find.mock.calls[0][0]).toEqual({ ownerUserId: 'owner-1', state: 'active' });
  });

  it('adopts by dispatch id, so only the child that belongs to this attempt matches', async () => {
    findOneAndUpdateSpy().mockReturnValue(execStub(null));

    const result = await store.transitionPackage({
      programmeId: 'p1',
      packageId: 'pkg-1',
      expect: { state: 'dispatching', dispatchId: 'dispatch-42' },
      set: { state: 'running', childInstanceId: 'instance-9' },
    });

    // `null` means another caller won the predicate. That is SUCCESS, not an error.
    expect(result).toBeNull();

    const [filter, update] = findOneAndUpdateSpy().mock.calls[0];
    expect((filter as any).packages.$elemMatch).toEqual({
      id: 'pkg-1',
      state: 'dispatching',
      dispatchId: 'dispatch-42',
    });
    expect((update as any).$set['packages.$.childInstanceId']).toBe('instance-9');
  });

  it('supports a multi-state precondition (abort / report), as $in', async () => {
    findOneAndUpdateSpy().mockReturnValue(execStub(written));

    await store.transitionPackage({
      programmeId: 'p1',
      packageId: 'pkg-1',
      expect: { states: ['pending', 'ready', 'dispatching', 'running'] },
      set: { state: 'cancelled' },
    });

    const [filter] = findOneAndUpdateSpy().mock.calls[0];
    expect((filter as any).packages.$elemMatch).toEqual({
      id: 'pkg-1',
      state: { $in: ['pending', 'ready', 'dispatching', 'running'] },
    });
  });

  it('requires a field to be absent when claiming a one-shot notification', async () => {
    findOneAndUpdateSpy().mockReturnValue(execStub(written));

    await store.transitionPackage({
      programmeId: 'p1',
      packageId: 'pkg-1',
      expect: { states: ['failed'], fieldAbsent: 'failedNotifiedAt' },
      set: { failedNotifiedAt: new Date(0) },
    });

    const [filter] = findOneAndUpdateSpy().mock.calls[0];
    expect((filter as any).packages.$elemMatch).toEqual({
      id: 'pkg-1',
      state: { $in: ['failed'] },
      failedNotifiedAt: { $exists: false },
    });
  });

  it('skips the write entirely when there is nothing to change', async () => {
    const findOne = findOneSpy().mockReturnValue(execStub(written));

    const result = await store.transitionPackage({
      programmeId: 'p1',
      packageId: 'pkg-1',
      expect: { state: 'ready' },
    });

    expect(result).toBe(written);
    expect(findOneAndUpdateSpy().mock.calls.length).toBe(0);
    expect(findOne.mock.calls[0][0]).toEqual({ programmeId: 'p1' });
  });
});

// ── updatePackage / programme transitions ───────────────────────────────────

describe('MongoProgrammeStore writes', () => {
  it('updatePackage scopes the match to the package and prefixes every field', async () => {
    const updateOne = updateOneSpy().mockReturnValue(execStub({ acknowledged: true }));

    await store.updatePackage('p1', 'pkg-1', { verifiedAt: new Date(0) }, ['lastVerificationError']);

    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ programmeId: 'p1', packages: { $elemMatch: { id: 'pkg-1' } } });
    expect(update).toEqual({
      $set: { 'packages.$.verifiedAt': new Date(0) },
      $unset: { 'packages.$.lastVerificationError': 1 },
    });
  });

  it('updatePackage issues no write when everything it was given is empty', async () => {
    const updateOne = updateOneSpy().mockReturnValue(execStub({ acknowledged: true }));
    await store.updatePackage('p1', 'pkg-1', {}, []);
    expect(updateOne.mock.calls.length).toBe(0);
  });

  it('transitionProgramme conditions on the states the caller expects to find', async () => {
    const findOneAndUpdate = findOneAndUpdateSpy().mockReturnValue(execStub(written));

    await store.transitionProgramme({
      programmeId: 'p1',
      expectStates: ['active', 'paused'],
      set: { state: 'failed' },
      unset: ['leaseOwner'],
    });

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ programmeId: 'p1', state: { $in: ['active', 'paused'] } });
    expect(update).toEqual({ $set: { state: 'failed' }, $unset: { leaseOwner: 1 } });
  });

  it('updateProgramme writes plain programme fields (the tick-failure diagnosis)', async () => {
    const updateOne = updateOneSpy().mockReturnValue(execStub({ acknowledged: true }));

    await store.updateProgramme('p1', { lastError: 'history unavailable' }, ['leaseOwner']);

    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ programmeId: 'p1' });
    expect(update).toEqual({
      $set: { lastError: 'history unavailable' },
      $unset: { leaseOwner: 1 },
    });
  });

  it('updateProgramme issues no write when there is nothing to change', async () => {
    const updateOne = updateOneSpy().mockReturnValue(execStub({ acknowledged: true }));
    await store.updateProgramme('p1', {}, []);
    expect(updateOne.mock.calls.length).toBe(0);
  });
});

// ── lease ───────────────────────────────────────────────────────────────────

describe('MongoProgrammeStore lease', () => {
  it('claims a free OR expired lease and sets the expiry from the tick clock', async () => {
    const findOneAndUpdate = findOneAndUpdateSpy().mockReturnValue(execStub(written));
    const now = new Date('2026-01-01T00:00:00.000Z');

    const result = await store.claimLease('p1', 'reconciler:1', now, 55_000);

    expect(result).toBe(written);
    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect((filter as any).programmeId).toBe('p1');
    // A terminal programme is never leased: there is nothing to reconcile.
    expect((filter as any).state).toEqual({ $in: ['active', 'paused'] });
    expect((filter as any).$or).toEqual([
      { leaseExpiresAt: { $exists: false } },
      { leaseExpiresAt: null },
      { leaseExpiresAt: { $lte: now } },
    ]);
    expect((update as any).$set.leaseOwner).toBe('reconciler:1');
    expect((update as any).$set.leaseExpiresAt).toEqual(new Date(now.getTime() + 55_000));
  });

  it('reports a lost lease as null, which the tick treats as another tick working', async () => {
    findOneAndUpdateSpy().mockReturnValue(execStub(null));
    expect(await store.claimLease('p1', 'reconciler:1', new Date(), 55_000)).toBeNull();
  });

  it('releases only its own lease', async () => {
    const updateOne = updateOneSpy().mockReturnValue(execStub({ acknowledged: true }));
    await store.releaseLease('p1', 'reconciler:1');

    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ programmeId: 'p1', leaseOwner: 'reconciler:1' });
    expect(update).toEqual({ $unset: { leaseOwner: 1, leaseExpiresAt: 1 } });
  });
});

// ── reads ───────────────────────────────────────────────────────────────────

describe('MongoProgrammeStore reads', () => {
  it('findMany filters on programme id and scalar state', async () => {
    const find = findSpy().mockReturnValue(queryStub([written]));

    const rows = await store.findMany({ programmeId: 'p1', state: 'active' }, 7);

    expect(rows).toEqual([written]);
    expect(find.mock.calls[0][0]).toEqual({ programmeId: 'p1', state: 'active' });
  });

  it('findMany turns a state list into $in', async () => {
    const find = findSpy().mockReturnValue(queryStub([]));
    await store.findMany({ state: ['active', 'paused'] }, 25);
    expect(find.mock.calls[0][0]).toEqual({ state: { $in: ['active', 'paused'] } });
  });

  it('findMany looks a dispatch id up at document level (the report path)', async () => {
    const find = findSpy().mockReturnValue(queryStub([written]));
    const rows = await store.findMany({ dispatchId: 'dispatch-1' }, 1);
    expect(rows).toEqual([written]);
    // Here a document-level check is CORRECT: it asks "which programme owns this
    // dispatch id", not "may this package be claimed".
    expect(find.mock.calls[0][0]).toEqual({ 'packages.dispatchId': 'dispatch-1' });
  });

  it('findMany never asks for fewer than one row', async () => {
    const find = findSpy().mockReturnValue(queryStub([]));
    await store.findMany({}, 0);
    expect(find.mock.calls.length).toBe(1);
  });

  it('findByProgrammeId is a plain lookup', async () => {
    const findOne = findOneSpy().mockReturnValue(execStub(written));
    expect(await store.findByProgrammeId('p1')).toBe(written);
    expect(findOne.mock.calls[0][0]).toEqual({ programmeId: 'p1' });
  });

  it('create persists through the model so schema defaults and indexes apply', async () => {
    const save = jest
      .spyOn(WorkflowProgrammeModel.prototype, 'save')
      .mockImplementation(async function (this: any) {
        return this;
      } as any);

    const created: any = await store.create({ programmeId: 'p1', name: 'P1' } as any);

    expect(save).toHaveBeenCalledTimes(1);
    expect(created.programmeId).toBe('p1');
  });
});
