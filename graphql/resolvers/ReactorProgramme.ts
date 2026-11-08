import Reactory from '@reactorynet/reactory-core';
import {
  mutation,
  query,
} from '@reactory/server-core/models/graphql/decorators/resolver';
import { isSystemIdentity } from '../../services/reactor/identity';
import type { ICreateProgrammeInput } from '../../services/reactor/WorkflowProgrammeService';

/**
 * `ReactorProgramme` — the read + control surface of the programme reconciler
 * (REACTORY-302016408).
 *
 * Until this file existed, a programme could only be created and controlled by
 * writing TypeScript against `reactor.WorkflowProgrammeService@1.0.0`: there were
 * zero documents in `workflow_programmes`, and `createProgramme` was referenced by
 * exactly one file — itself. The reconciler therefore dispatched nothing, forever.
 *
 * ── Thin, on purpose ─────────────────────────────────────────────────────────
 *
 * Every resolver here is a delegation. The decision logic (dependency verdicts,
 * dispatch claims, adoption, verification, settlement) lives in the service and is
 * tested there; re-deriving any of it here would create a second, drifting truth.
 * What this file does add is the WIRE SHAPE (`toProgrammeShape` /
 * `toPackageShape`): an explicit pick of the fields the schema declares, so a field
 * added to the service view later cannot appear on the public surface by accident
 * — and so the two fields that must never be public (`childInputDefaults`, the
 * per-package `input`) have no path out even if the view were widened.
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 *
 * Two gates, deliberately independent:
 *
 *  1. `identity.ts` predicates here. A control call (pause/resume/abort) requires
 *     a signed-in PERSON: `isSystemIdentity` is refused explicitly, so a system
 *     account holding ADMIN is still refused. That is the whole point of the
 *     predicate — the audit trail must name a human — and it must not be possible
 *     for a role check somewhere else to stand in for it.
 *  2. The service itself (`authoriseRead` / `authoriseControl`), which decides
 *     owner-vs-admin. Its refusals come back as data (`code`, `reason`) rather than
 *     being swallowed into an empty list.
 *
 * There is no `@auth` directive on these fields: this module ships none
 * (`graphql/directives/index.ts` is empty), so a schema directive could not have
 * been the gate in the first place. The gate is code.
 *
 * ── `this` is not available ──────────────────────────────────────────────────
 *
 * The graph registry builds resolver classes with `Object.create(prototype)` and
 * merges the decorator map into one shared root object, so at execution time `this`
 * is that merged map. Everything below is a module-level function or a plain method
 * that touches no instance state. (Same reason and same shape as
 * `ReactorContinuation.ts` and `ReactorAIUsage.ts`.)
 */

/** Local on purpose; the test asserts this equals the macro + service FQN. */
export const PROGRAMME_SERVICE_ID = 'reactor.WorkflowProgrammeService@1.0.0';

export interface IProgrammesArgs {
  state?: string;
  limit?: number;
}

export interface IProgrammeControlArgs {
  programmeId: string;
  reason?: string;
}

/** Resolve the service from the request context; null when unavailable. */
function programmeService(context: any): any {
  if (!context || typeof context.getService !== 'function') return null;
  try {
    return context.getService(PROGRAMME_SERVICE_ID);
  } catch {
    return null;
  }
}

/** Resolve or fail loudly — "no programmes" and "no service" must not look alike. */
function requireProgrammeService(context: any): any {
  const service = programmeService(context);
  if (!service) {
    throw new Error(
      `${PROGRAMME_SERVICE_ID} is not available, so programmes cannot be read or controlled.`,
    );
  }
  return service;
}

/** A person is required for anything that mutates a programme. */
function requireUser(context: any): any {
  const user = context?.user;
  if (!user?._id && !user?.id) throw new Error('Authentication required.');
  return user;
}

/**
 * Refuse the platform's system account for control actions, BEFORE the service is
 * called. The service refuses it too (`code: 'system_caller'`); this is the second,
 * independent gate the ticket requires, so a future change to the service's
 * authorisation cannot quietly re-open pause/abort to the reconciler's own identity.
 */
function refuseSystemIdentity(context: any): any {
  const user = requireUser(context);
  if (isSystemIdentity(user)) {
    throw new Error(
      'Access denied: the system account cannot pause, resume or abort a programme. ' +
        'The audit trail must name a person.',
    );
  }
  return user;
}

/** ISO-8601 for a Date, or null. Dates are never rendered by `String(date)`. */
function iso(value: any): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The wire shape of one package. Explicit picks only: a field added to the service
 * projection is a deliberate act that has to be added here (and to the schema, and
 * to the test's closed field list) before anyone can read it.
 */
export function toPackageShape(pkg: Record<string, any>) {
  return {
    id: String(pkg?.id ?? ''),
    title: pkg?.title ?? null,
    dependsOn: Array.isArray(pkg?.dependsOn) ? pkg.dependsOn.map(String) : [],
    state: String(pkg?.state ?? ''),
    attempt: typeof pkg?.attempt === 'number' ? pkg.attempt : null,
    dispatchId: pkg?.dispatchId ?? null,
    childInstanceId: pkg?.childInstanceId ?? null,
    dispatchedAt: iso(pkg?.dispatchedAt),
    lastProgressAt: iso(pkg?.lastProgressAt),
    completedAt: iso(pkg?.completedAt),
    prUrl: pkg?.prUrl ?? null,
    mergedSha: pkg?.mergedSha ?? null,
    status: pkg?.status ?? null,
    outcomeSource: pkg?.outcomeSource ?? null,
    lastError: pkg?.lastError ?? null,
  };
}

/**
 * The wire shape of one programme. `counts` is a map on the service view and a
 * list on the wire (GraphQL has no map type); the values are copied, not recomputed.
 */
export function toProgrammeShape(view: Record<string, any>) {
  const counts = Object.entries(view?.counts || {}).map(([state, count]) => ({
    state,
    count: Number(count) || 0,
  }));

  return {
    programmeId: String(view?.programmeId ?? ''),
    name: String(view?.name ?? ''),
    description: view?.description ?? null,
    state: String(view?.state ?? ''),
    ownerEmail: view?.ownerEmail ?? null,
    childWorkflowId: view?.childWorkflowId ?? null,
    slaMinutes: typeof view?.slaMinutes === 'number' ? view.slaMinutes : null,
    maxAttempts: typeof view?.maxAttempts === 'number' ? view.maxAttempts : null,
    counts,
    packages: (Array.isArray(view?.packages) ? view.packages : []).map(toPackageShape),
    createdAt: iso(view?.createdAt),
    updatedAt: iso(view?.updatedAt),
    completedAt: iso(view?.completedAt),
    pausedAt: iso(view?.pausedAt),
    abortedAt: iso(view?.abortedAt),
    notificationChannel: view?.notificationChannel ?? null,
    notifiedEvent: view?.notifiedEvent ?? null,
  };
}

/**
 * The wire shape of a control result. `ok` is a projection of the three flags the
 * service sets (`paused`/`resumed`/`aborted`); nothing else is interpreted.
 */
export function toControlResult(result: Record<string, any>) {
  return {
    ok: result?.paused === true || result?.resumed === true || result?.aborted === true,
    state: result?.state ?? null,
    reason: result?.reason ?? null,
    code: result?.code ?? null,
    paused: typeof result?.paused === 'boolean' ? result.paused : null,
    resumed: typeof result?.resumed === 'boolean' ? result.resumed : null,
    aborted: typeof result?.aborted === 'boolean' ? result.aborted : null,
    runningPackages: typeof result?.runningPackages === 'number' ? result.runningPackages : null,
    cancelled: typeof result?.cancelled === 'number' ? result.cancelled : null,
    cancelFailures: typeof result?.cancelFailures === 'number' ? result.cancelFailures : null,
    pendingDispatch: typeof result?.pendingDispatch === 'number' ? result.pendingDispatch : null,
    notificationChannel: result?.notificationChannel ?? null,
  };
}

/** One control call: identity gate, then the service's own authorisation. */
async function control(
  context: Reactory.Server.IReactoryContext,
  args: IProgrammeControlArgs,
  method: 'pause' | 'resume' | 'abort',
) {
  const service = requireProgrammeService(context);
  refuseSystemIdentity(context);
  const result = await service[method]({
    programmeId: args?.programmeId,
    reason: args?.reason,
  });
  return toControlResult(result || {});
}

// NOTE — no `@resolver` marker on the class below.
//
// The marker is declared `export function resolver()` (it takes no arguments),
// so a bare `@resolver` is a type error (TS1329) and `@resolver()` is another
// (TS1238) — every sibling file in this folder carries the first one in the
// typecheck baseline. It is also inert at runtime: `mergeGraphResolver` detects a
// resolver class by `prototype.resolver` (populated by the @query/@mutation
// decorators), not by the marker. This module's ratchet must stay clean, so the
// class is exported and registered without the marker rather than inheriting a
// known-bad line.
class ReactorProgrammeResolver {
  resolver: any;

  // ── reads ──────────────────────────────────────────────────────────────────

  @query('programme')
  async programme(
    _: any,
    args: { programmeId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    const service = requireProgrammeService(context);
    const result = await service.getProgramme({ programmeId: args?.programmeId });

    if (result?.found) return toProgrammeShape(result.programme);

    // An unknown id is `null` — "nothing here", not an exception. Every other
    // refusal is raised: an operator must be able to tell "no such programme"
    // from "you may not read this one".
    if (result?.code === 'not_found') return null;
    if (result?.code === 'no_identity') throw new Error('Authentication required to read a programme.');
    throw new Error(result?.error || 'The programme could not be read.');
  }

  @query('programmes')
  async programmes(
    _: any,
    args: IProgrammesArgs,
    context: Reactory.Server.IReactoryContext,
  ) {
    const service = requireProgrammeService(context);
    const result = await service.listProgrammes({
      state: args?.state,
      limit: args?.limit,
    });

    if (result?.code === 'no_identity') {
      // An empty array would read as "you have no programmes" — a silent lie.
      throw new Error('Authentication required to list programmes.');
    }

    const programmes = Array.isArray(result?.programmes) ? result.programmes : [];
    return programmes.map(toProgrammeShape);
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  @mutation('createProgramme')
  async createProgramme(
    _: any,
    args: { input: ICreateProgrammeInput },
    context: Reactory.Server.IReactoryContext,
  ) {
    const service = requireProgrammeService(context);
    // The service records `ownerUserId` from its own context and refuses the
    // system account; nothing is defaulted or re-validated here.
    const result = await service.createProgramme(args?.input);

    if (!result?.created) {
      const code = result?.code ? ` (${result.code})` : '';
      // Never quote the input: `childInputDefaults` may carry workflow inputs.
      throw new Error(
        `The programme was not created${code}: ${result?.error || 'unknown reason'}`,
      );
    }

    return toProgrammeShape(result.programme);
  }

  @mutation('pauseProgramme')
  async pauseProgramme(
    _: any,
    args: IProgrammeControlArgs,
    context: Reactory.Server.IReactoryContext,
  ) {
    return control(context, args, 'pause');
  }

  @mutation('resumeProgramme')
  async resumeProgramme(
    _: any,
    args: IProgrammeControlArgs,
    context: Reactory.Server.IReactoryContext,
  ) {
    return control(context, args, 'resume');
  }

  @mutation('abortProgramme')
  async abortProgramme(
    _: any,
    args: IProgrammeControlArgs,
    context: Reactory.Server.IReactoryContext,
  ) {
    return control(context, args, 'abort');
  }
}

export default ReactorProgrammeResolver;
