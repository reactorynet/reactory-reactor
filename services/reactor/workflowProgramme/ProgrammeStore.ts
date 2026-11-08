import WorkflowProgrammeModel, {
  IWorkflowProgramme,
  IWorkflowProgrammeDocument,
  PackageState,
  ProgrammeState,
} from '../../../models/WorkflowProgramme';

/**
 * The persistence vocabulary the reconciler needs — and deliberately nothing more.
 *
 * Every method that changes a package takes the transition's PRECONDITION, and the
 * implementation performs the check and the write in ONE atomic operation. That is
 * the whole design: idempotency is a predicate, not a lock.
 *
 * Keeping the store behind this interface means the decision logic is unit-testable
 * without a Mongo connection or a workflow engine — the acceptance criteria are
 * about state transitions, not about mongoose.
 */

/** What a package must still look like for a transition to be allowed. */
export interface IPackageExpectation {
  /** Exact expected state. */
  state?: PackageState;
  /** Any of these states. */
  states?: PackageState[];
  /** Expected dispatch id (adopt / report / abort paths). */
  dispatchId?: string;
  /** Require that no dispatch id has ever been set (the FIRST dispatch claim). */
  dispatchIdAbsent?: boolean;
  /**
   * Require that this package field has never been written.
   *
   * Used to CLAIM the single permitted notification of a package-level event
   * (`failedNotifiedAt`): two ticks, or two packages, can therefore never emit two
   * identical messages, while each package still gets its own.
   */
  fieldAbsent?: string;
}
export interface ITransitionPackageInput {
  programmeId: string;
  packageId: string;
  expect: IPackageExpectation;
  /**
   * The programme states the transition is allowed to find.
   *
   * This is what makes a package transition contend with programme-level control on
   * the SAME document. Without it, dispatch's claim is a package-only predicate: an
   * abort or pause landing between the tick's snapshot and the claim would let one
   * more child start after a human said stop.
   */
  expectProgrammeStates?: ProgrammeState[];
  set?: Record<string, any>;
  unset?: string[];
  inc?: Record<string, number>;
}

export interface ITransitionProgrammeInput {
  programmeId: string;
  expectStates?: ProgrammeState[];
  set?: Record<string, any>;
  unset?: string[];
}

export interface IProgrammeQuery {
  programmeId?: string;
  state?: ProgrammeState | ProgrammeState[];
  /** Find the programme that owns this dispatch id. */
  dispatchId?: string;
  /**
   * Owner scope for list surfaces. Filtering in the QUERY (rather than slicing a
   * global page and then filtering) is what stops one user's programmes being
   * hidden behind everyone else's.
   */
  ownerUserId?: string;
}

export interface IProgrammeStore {
  create(doc: Partial<IWorkflowProgramme>): Promise<IWorkflowProgrammeDocument>;
  findByProgrammeId(programmeId: string): Promise<IWorkflowProgrammeDocument | null>;
  findMany(query: IProgrammeQuery, limit: number): Promise<IWorkflowProgrammeDocument[]>;
  transitionPackage(input: ITransitionPackageInput): Promise<IWorkflowProgrammeDocument | null>;
  /** Non-atomic write for evidence fields (lastError, verification errors). */
  updatePackage(
    programmeId: string,
    packageId: string,
    set: Record<string, any>,
    unset?: string[],
  ): Promise<void>;
  transitionProgramme(input: ITransitionProgrammeInput): Promise<IWorkflowProgrammeDocument | null>;
  updateProgramme(programmeId: string, set: Record<string, any>, unset?: string[]): Promise<void>;
  claimLease(
    programmeId: string,
    owner: string,
    now: Date,
    leaseMs: number,
  ): Promise<IWorkflowProgrammeDocument | null>;
  releaseLease(programmeId: string, owner: string): Promise<void>;
}

const packagePrefix = (input: Record<string, any> = {}): Record<string, any> => {
  const out: Record<string, any> = {};
  Object.keys(input).forEach((key) => {
    if (input[key] !== undefined) out[`packages.$.${key}`] = input[key];
  });
  return out;
};

const unsetPrefix = (keys: string[] = []): Record<string, 1> => {
  const out: Record<string, 1> = {};
  keys.forEach((key) => {
    out[`packages.$.${key}`] = 1;
  });
  return out;
};

/** The mongoose-backed store used in production. */
export class MongoProgrammeStore implements IProgrammeStore {
  async create(doc: Partial<IWorkflowProgramme>): Promise<IWorkflowProgrammeDocument> {
    return new WorkflowProgrammeModel(doc as any).save() as unknown as IWorkflowProgrammeDocument;
  }

  async findByProgrammeId(programmeId: string): Promise<IWorkflowProgrammeDocument | null> {
    return WorkflowProgrammeModel.findOne({ programmeId } as any).exec() as any;
  }

  async findMany(query: IProgrammeQuery, limit: number): Promise<IWorkflowProgrammeDocument[]> {
    const filter: Record<string, any> = {};
    if (query.programmeId) filter.programmeId = query.programmeId;
    if (query.state) {
      filter.state = Array.isArray(query.state) ? { $in: query.state } : query.state;
    }
    if (query.dispatchId) filter['packages.dispatchId'] = query.dispatchId;
    if (query.ownerUserId) filter.ownerUserId = query.ownerUserId;
    return WorkflowProgrammeModel.find(filter as any)
      .sort({ createdAt: 1 })
      .limit(Math.max(1, limit))
      .exec() as any;
  }

  /**
   * One atomic, conditional package transition.
   *
   * Two guards travel together: the `$elemMatch` carries the package precondition
   * (including
   * `dispatchId: { $exists: false }` for a first dispatch. Putting the
   * dispatch-id check at `packages.dispatchId` (document level) instead would be
   * wrong: once ANY package had a dispatch id the whole programme would fail the
   * predicate and no other package could ever be dispatched.
   */
  async transitionPackage(input: ITransitionPackageInput): Promise<IWorkflowProgrammeDocument | null> {
    const elem: Record<string, any> = { id: input.packageId };
    if (input.expect.state) elem.state = input.expect.state;
    if (input.expect.states) elem.state = { $in: input.expect.states };
    if (input.expect.dispatchIdAbsent) elem.dispatchId = { $exists: false };
    if (input.expect.fieldAbsent) elem[input.expect.fieldAbsent] = { $exists: false };
    if (input.expect.dispatchId) elem.dispatchId = input.expect.dispatchId;

    const update: Record<string, any> = {};
    const set = packagePrefix(input.set as Record<string, any>);
    if (Object.keys(set).length > 0) update.$set = set;
    const unset = unsetPrefix(input.unset);
    if (Object.keys(unset).length > 0) update.$unset = unset;
    const inc = packagePrefix(input.inc);
    if (Object.keys(inc).length > 0) update.$inc = inc;
    if (Object.keys(update).length === 0) return this.findByProgrammeId(input.programmeId);

    // The document filter carries the programme state when the caller asked for
    // one, so a package transition and a programme-level control write contend for
    // the same document: whichever lands first wins, and the loser gets `null`.
    const documentFilter: Record<string, any> = { programmeId: input.programmeId };
    if (input.expectProgrammeStates && input.expectProgrammeStates.length > 0) {
      documentFilter.state = { $in: input.expectProgrammeStates };
    }

    return WorkflowProgrammeModel.findOneAndUpdate(
      { ...documentFilter, packages: { $elemMatch: elem } } as any,
      update as any,
      { new: true },
    ).exec() as any;
  }

  async updatePackage(
    programmeId: string,
    packageId: string,
    set: Record<string, any>,
    unset: string[] = [],
  ): Promise<void> {
    const update: Record<string, any> = {};
    const prefixed = packagePrefix(set);
    if (Object.keys(prefixed).length > 0) update.$set = prefixed;
    const unsetKeys = unsetPrefix(unset);
    if (Object.keys(unsetKeys).length > 0) update.$unset = unsetKeys;
    if (Object.keys(update).length === 0) return;
    await WorkflowProgrammeModel.updateOne(
      { programmeId, packages: { $elemMatch: { id: packageId } } } as any,
      update as any,
    ).exec();
  }

  async transitionProgramme(input: ITransitionProgrammeInput): Promise<IWorkflowProgrammeDocument | null> {
    const filter: Record<string, any> = { programmeId: input.programmeId };
    if (input.expectStates) filter.state = { $in: input.expectStates };
    const update: Record<string, any> = {};
    if (input.set && Object.keys(input.set).length > 0) update.$set = input.set;
    if (input.unset && input.unset.length > 0) {
      update.$unset = input.unset.reduce((acc, key) => ({ ...acc, [key]: 1 }), {});
    }
    if (Object.keys(update).length === 0) return this.findByProgrammeId(input.programmeId);
    return WorkflowProgrammeModel.findOneAndUpdate(filter as any, update as any, { new: true }).exec() as any;
  }

  async updateProgramme(programmeId: string, set: Record<string, any>, unset: string[] = []): Promise<void> {
    const update: Record<string, any> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (unset.length > 0) update.$unset = unset.reduce((acc, key) => ({ ...acc, [key]: 1 }), {});
    if (Object.keys(update).length === 0) return;
    await WorkflowProgrammeModel.updateOne({ programmeId } as any, update as any).exec();
  }

  /**
   * Single-flight lease.
   *
   * `null` means another tick holds it. That is SUCCESS, not a failure: the other
   * tick is doing this programme's work right now.
   */
  async claimLease(
    programmeId: string,
    owner: string,
    now: Date,
    leaseMs: number,
  ): Promise<IWorkflowProgrammeDocument | null> {
    return WorkflowProgrammeModel.findOneAndUpdate(
      {
        programmeId,
        state: { $in: ['active', 'paused'] },
        $or: [
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $lte: now } },
        ],
      } as any,
      { $set: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + leaseMs) } } as any,
      { new: true },
    ).exec() as any;
  }

  async releaseLease(programmeId: string, owner: string): Promise<void> {
    await WorkflowProgrammeModel.updateOne(
      { programmeId, leaseOwner: owner } as any,
      { $unset: { leaseOwner: 1, leaseExpiresAt: 1 } } as any,
    ).exec();
  }
}

export const defaultProgrammeStore: IProgrammeStore = new MongoProgrammeStore();
