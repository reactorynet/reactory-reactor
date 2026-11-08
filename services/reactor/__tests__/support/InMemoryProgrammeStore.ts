import {
  IProgrammeQuery,
  IProgrammeStore,
  ITransitionPackageInput,
  ITransitionProgrammeInput,
} from '../../workflowProgramme/ProgrammeStore';
import { IProgrammePackage, IWorkflowProgramme } from '../../../../models/WorkflowProgramme';

/**
 * An in-memory `IProgrammeStore` that honours the SAME predicate semantics as the
 * mongoose implementation.
 *
 * This is deliberately not a permissive stub: a double-dispatch test would pass
 * trivially against a store that always returned a document. `transitionPackage`
 * checks the expectation and applies the write in one synchronous step (the JS
 * event loop is the transaction), which is exactly the guarantee Mongo gives with
 * a single `findOneAndUpdate`.
 */
export class InMemoryProgrammeStore implements IProgrammeStore {
  private readonly docs = new Map<string, IWorkflowProgramme>();
  private sequence = 0;

  /** Every state a package was moved to, in order — handy for assertions. */
  readonly packageTransitions: Array<{ programmeId: string; packageId: string; state?: string }> = [];
  /** Every `transitionPackage` call whose predicate did NOT match. */
  readonly rejectedTransitions: Array<{ programmeId: string; packageId: string; expect: any }> = [];

  constructor(seed: Array<Partial<IWorkflowProgramme>> = []) {
    seed.forEach((doc) => this.insert(doc));
  }

  /** Direct access for arranging a scenario (not part of `IProgrammeStore`). */
  snapshot(programmeId: string): IWorkflowProgramme | undefined {
    const doc = this.docs.get(programmeId);
    return doc ? this.clone(doc) : undefined;
  }

  seed(doc: Partial<IWorkflowProgramme>): IWorkflowProgramme {
    return this.clone(this.insert(doc));
  }

  private insert(doc: Partial<IWorkflowProgramme>): IWorkflowProgramme {
    const now = new Date();
    this.sequence += 1;
    const record: IWorkflowProgramme = {
      programmeId: doc.programmeId as string,
      name: doc.name || String(doc.programmeId),
      description: doc.description,
      state: doc.state || 'active',
      ownerUserId: String(doc.ownerUserId) as any,
      ownerEmail: doc.ownerEmail || 'owner@example.com',
      partnerKey: doc.partnerKey,
      childWorkflowId: doc.childWorkflowId || 'core.ProcessAITicket@1.4.8',
      childInputDefaults: doc.childInputDefaults,
      slaMinutes: doc.slaMinutes ?? 45,
      maxAttempts: doc.maxAttempts ?? 3,
      packages: (doc.packages || []).map((pkg) => ({
        attempt: 0,
        stallCount: 0,
        dependsOn: [],
        ...pkg,
      })) as IProgrammePackage[],
      lastProgressAt: doc.lastProgressAt || now,
      createdAt: doc.createdAt || now,
      updatedAt: doc.updatedAt || now,
      ...doc,
    } as IWorkflowProgramme;

    // `...doc` above may have replaced the normalised fields; restore the two that
    // matter for predicate semantics and owner authorisation.
    if (doc.packages) record.packages = doc.packages.map((pkg) => ({ attempt: 0, dependsOn: [], ...pkg }));
    record.ownerUserId = String(doc.ownerUserId) as any;
    this.docs.set(record.programmeId, record);
    return record;
  }

  private clone<T>(value: T): T {
    if (value instanceof Date) return new Date(value.getTime()) as any;
    if (Array.isArray(value)) return value.map((entry) => this.clone(entry)) as any;
    if (value && typeof value === 'object') {
      const out: Record<string, any> = {};
      Object.keys(value as any).forEach((key) => {
        out[key] = this.clone((value as any)[key]);
      });
      return out as T;
    }
    return value;
  }

  private matches(pkg: IProgrammePackage, expect: ITransitionPackageInput['expect']): boolean {
    if (!expect) return true;
    if (expect.state && pkg.state !== expect.state) return false;
    if (expect.states && !expect.states.includes(pkg.state)) return false;
    if (expect.dispatchId && pkg.dispatchId !== expect.dispatchId) return false;
    if (expect.dispatchIdAbsent && pkg.dispatchId !== undefined) return false;
    if (expect.fieldAbsent && (pkg as any)[expect.fieldAbsent] !== undefined) return false;
    return true;
  }

  async create(doc: Partial<IWorkflowProgramme>): Promise<any> {
    const inserted = this.insert(doc);
    return this.clone(inserted);
  }

  async findByProgrammeId(programmeId: string): Promise<any> {
    const doc = this.docs.get(programmeId);
    return doc ? this.clone(doc) : null;
  }

  async findMany(query: IProgrammeQuery, limit: number): Promise<any[]> {
    let list = Array.from(this.docs.values());
    if (query.programmeId) list = list.filter((doc) => doc.programmeId === query.programmeId);
    if (query.state) {
      const states = Array.isArray(query.state) ? query.state : [query.state];
      list = list.filter((doc) => states.includes(doc.state));
    }
    if (query.dispatchId) {
      list = list.filter((doc) => doc.packages.some((pkg) => pkg.dispatchId === query.dispatchId));
    }
    if (query.ownerUserId) {
      list = list.filter((doc) => String(doc.ownerUserId) === String(query.ownerUserId));
    }
    return list.slice(0, Math.max(1, limit)).map((doc) => this.clone(doc));
  }

  async transitionPackage(input: ITransitionPackageInput): Promise<any> {
    const doc = this.docs.get(input.programmeId);
    if (!doc) return null;
    // The production filter carries the programme state; the double must too, or a
    // concurrency test would prove nothing.
    if (input.expectProgrammeStates && !input.expectProgrammeStates.includes(doc.state)) {
      this.rejectedTransitions.push({
        programmeId: input.programmeId,
        packageId: input.packageId,
        expect: { ...input.expect, programmeState: { $in: input.expectProgrammeStates } },
      });
      return null;
    }
    const pkg = doc.packages.find((entry) => entry.id === input.packageId);
    if (!pkg || !this.matches(pkg, input.expect)) {
      this.rejectedTransitions.push({
        programmeId: input.programmeId,
        packageId: input.packageId,
        expect: input.expect,
      });
      return null;
    }

    Object.keys(input.set || {}).forEach((key) => {
      if (input.set && (input.set as any)[key] !== undefined) {
        (pkg as any)[key] = (input.set as any)[key];
      }
    });
    (input.unset || []).forEach((key) => {
      delete (pkg as any)[key];
    });
    Object.keys(input.inc || {}).forEach((key) => {
      (pkg as any)[key] = Number((pkg as any)[key] || 0) + Number((input.inc as any)[key] || 0);
    });
    doc.updatedAt = new Date();
    this.packageTransitions.push({
      programmeId: input.programmeId,
      packageId: input.packageId,
      state: pkg.state,
    });
    return this.clone(doc);
  }

  async updatePackage(
    programmeId: string,
    packageId: string,
    set: Record<string, any>,
    unset: string[] = [],
  ): Promise<void> {
    const doc = this.docs.get(programmeId);
    if (!doc) return;
    const pkg = doc.packages.find((entry) => entry.id === packageId);
    if (!pkg) return;
    Object.keys(set || {}).forEach((key) => {
      if (set[key] !== undefined) (pkg as any)[key] = set[key];
    });
    (unset || []).forEach((key) => {
      delete (pkg as any)[key];
    });
    doc.updatedAt = new Date();
  }

  async transitionProgramme(input: ITransitionProgrammeInput): Promise<any> {
    const doc = this.docs.get(input.programmeId);
    if (!doc) return null;
    if (input.expectStates && !input.expectStates.includes(doc.state)) return null;
    Object.keys(input.set || {}).forEach((key) => {
      if (input.set && (input.set as any)[key] !== undefined) {
        (doc as any)[key] = (input.set as any)[key];
      }
    });
    (input.unset || []).forEach((key) => {
      delete (doc as any)[key];
    });
    doc.updatedAt = new Date();
    return this.clone(doc);
  }

  async updateProgramme(programmeId: string, set: Record<string, any>, unset: string[] = []): Promise<void> {
    const doc = this.docs.get(programmeId);
    if (!doc) return;
    Object.keys(set || {}).forEach((key) => {
      if (set[key] !== undefined) (doc as any)[key] = set[key];
    });
    (unset || []).forEach((key) => {
      delete (doc as any)[key];
    });
    doc.updatedAt = new Date();
  }

  async claimLease(programmeId: string, owner: string, now: Date, leaseMs: number): Promise<any> {
    const doc = this.docs.get(programmeId);
    if (!doc) return null;
    if (!['active', 'paused'].includes(doc.state)) return null;
    const expiresAt = doc.leaseExpiresAt ? new Date(doc.leaseExpiresAt).getTime() : 0;
    if (expiresAt && expiresAt > now.getTime()) return null;
    doc.leaseOwner = owner;
    doc.leaseExpiresAt = new Date(now.getTime() + leaseMs);
    return this.clone(doc);
  }

  async releaseLease(programmeId: string, owner: string): Promise<void> {
    const doc = this.docs.get(programmeId);
    if (!doc || doc.leaseOwner !== owner) return;
    delete doc.leaseOwner;
    delete doc.leaseExpiresAt;
  }
}
