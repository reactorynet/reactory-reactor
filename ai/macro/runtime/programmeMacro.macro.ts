import Reactory from '@reactorynet/reactory-core';
import { ChatState, Macro, MacroComponentDefinition } from '../../openai/types/chat';
import type {
  ICreateProgrammeInput,
  IProgrammeControlInput,
  IProgrammePackageInput,
  IReconcileInput,
  IReportPackageOutcomeInput,
} from '../../../services/reactor/WorkflowProgrammeService';

/**
 * `programme` — the agent-facing FRONT DOOR of
 * `reactor.WorkflowProgrammeService@1.0.0` (REACTORY-302016408).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The reconciler was merged, scheduled and green, and had zero programmes: the only
 * way to create one was to write TypeScript against the service. A reconciler that
 * cannot be given work is a reconciler that removes nothing from the loop. This
 * macro is the surface an agent (or a person, via GraphQL) uses to hand it work.
 *
 * ── The rule this file lives by ──────────────────────────────────────────────
 *
 * EVERY action delegates 1:1 to a service method that already exists and is already
 * tested. There is no validation, defaulting, package-state arithmetic or
 * authorisation in this file — not because it would be hard to write, but because a
 * second copy of those rules is exactly how the macro and the tick would come to
 * disagree about what a programme is. If a value is wrong, the service says so and
 * its `code` comes back unchanged.
 *
 * The single piece of behaviour here is dispatch: picking the method by `action`
 * and returning an actionable error for an action that is not one of the eight.
 *
 * ── Identity ─────────────────────────────────────────────────────────────────
 *
 * The service reads the caller from its own context, and `@service` registers
 * `lifeCycle: 'instance'`, so `context.getService(id)` builds an instance bound to
 * the context that resolved it. The macro therefore passes the TOOL-CALL context
 * straight through and never impersonates: `createProgramme` records that user's
 * `_id` as `ownerUserId`, and pause/abort are audited against them. (The service
 * refuses the system account for both, so passing the system context through would
 * be refused rather than honoured — see `identity.ts`.)
 *
 * ── `report` and children that cannot call it ────────────────────────────────
 *
 * `report` is the child → programme PUSH path (`reportPackageOutcome`). A child that
 * cannot call it is still OBSERVED: the tick reads the child instance's own status
 * through `childStatusLookup` once the package is overdue. What it cannot do is
 * claim success — a child that ends without pushing is recorded as
 * `child_completed_unreported` and failed, never as `succeeded`. Callers must not
 * describe an un-reported completion as a success. This is documented on the tool
 * description as well, because the model reads that, not this comment.
 */

export const PROGRAMME_SERVICE_ID = 'reactor.WorkflowProgrammeService@1.0.0';

/** The eight actions, in the order the ticket defines them. */
export const PROGRAMME_ACTIONS = [
  'create',
  'get',
  'list',
  'pause',
  'resume',
  'abort',
  'report',
  'tick',
] as const;

export type ProgrammeAction = (typeof PROGRAMME_ACTIONS)[number];

/**
 * The macro's arguments are the union of the service inputs, flat.
 *
 * Deliberately flat (one `programme` tool with an `action` discriminator) rather
 * than eight tools: the model picks one tool and one action, and the parameter
 * names are the service's own names so a caller who has read the service interface
 * does not have to translate.
 */
export interface IProgrammeMacroProps {
  /** One of `create | get | list | pause | resume | abort | report | tick`. */
  action: ProgrammeAction;

  // ── create (ICreateProgrammeInput) ────────────────────────────────────────
  /** Optional; the service mints one from `name` when omitted. */
  programmeId?: string;
  name?: string;
  description?: string;
  /** Defaults to `core.ProcessAITicket@<version>` in the service. */
  childWorkflowId?: string;
  /**
   * Defaults threaded into every child's input. May carry workflow inputs; never
   * echoed back by this macro or by an error message.
   */
  childInputDefaults?: Record<string, any>;
  slaMinutes?: number;
  maxAttempts?: number;
  packages?: IProgrammePackageInput[];

  // ── get / list / control ──────────────────────────────────────────────────
  /** `active | paused | aborted | completed | failed` for `list`. */
  state?: string;
  limit?: number;
  reason?: string;

  // ── report (IReportPackageOutcomeInput) ───────────────────────────────────
  dispatchId?: string;
  /** `completed | failed` — normalised by the service, not here. */
  status?: string;
  prUrl?: string;
  mergedSha?: string;
  error?: string;
  notes?: string;

  // ── tick (IReconcileInput) ────────────────────────────────────────────────
  staleMs?: number;
  leaseMs?: number;
  maxDispatchesPerTick?: number;
  maxVerificationsPerTick?: number;
  verificationIntervalMs?: number;
  /** ISO date-time or Date; pins the tick's clock (used by tests and replays). */
  now?: string | Date;
}

/** The `{ success: false, error }` envelope for a surface that could not run. */
function unavailable(error: string, instructions?: string) {
  return {
    success: false,
    error,
    ...(instructions ? { instructions } : {}),
  };
}

/**
 * Resolve the service the SAME way the reconciler workflow does: by FQN through
 * the context's registry (`service_invoke` in
 * `workflow/WorkflowProgrammeReconciler.yaml` resolves
 * `reactor.WorkflowProgrammeService@1.0.0` the same way). Nothing is constructed.
 *
 * The lookup sits inside the caller's `try`: it is a call into the registry and it
 * can throw, and a thrown lookup must reach the model as a tool result rather than
 * as a rejected turn.
 */
function resolveContext(state: ChatState, context?: Reactory.Server.IReactoryContext): any {
  return context || (state as any)?.context;
}

function getProgrammeService(ctx: any): any {
  if (!ctx || typeof ctx.getService !== 'function') return null;
  return ctx.getService(PROGRAMME_SERVICE_ID);
}

/**
 * The macro. One function, eight branches, each one call.
 *
 * The return value is the service's result VERBATIM. That is the contract: a
 * caller can read the same `code`/`error`/`created`/`found`/`paused`/`reported`
 * fields it would get from the service, and there is no second, macro-shaped
 * vocabulary to keep in sync.
 */
export const ProgrammeMacro: Macro<unknown, IProgrammeMacroProps> = async (
  props: IProgrammeMacroProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext,
): Promise<unknown> => {
  const action = String(props?.action || '').trim() as ProgrammeAction;

  try {
    const service = getProgrammeService(resolveContext(state, context));
    if (!service) {
      return unavailable(
        `The workflow programme service (${PROGRAMME_SERVICE_ID}) is not available in this context, ` +
          'so no programme can be created, read or controlled from here.',
        `## Programme service unavailable\n\n\`${PROGRAMME_SERVICE_ID}\` could not be resolved from this ` +
          'session context. Do not tell the user a programme was created, paused or aborted. ' +
          'Report that the service is not registered in this deployment.',
      );
    }

    switch (action) {
      // ── create ──────────────────────────────────────────────────────────────
      case 'create':
        // Every field is the caller's; no default is applied here. `name` and
        // `packages` are validated by `createProgramme`, which is where the error
        // codes (`invalid_name`, `invalid_packages`, `duplicate`, ...) live.
        return await service.createProgramme({
          programmeId: props.programmeId,
          name: props.name,
          description: props.description,
          childWorkflowId: props.childWorkflowId,
          childInputDefaults: props.childInputDefaults,
          slaMinutes: props.slaMinutes,
          maxAttempts: props.maxAttempts,
          packages: props.packages,
        } as ICreateProgrammeInput);

      // ── get ─────────────────────────────────────────────────────────────────
      case 'get':
        return await service.getProgramme({ programmeId: props.programmeId });

      // ── list ────────────────────────────────────────────────────────────────
      case 'list':
        return await service.listProgrammes({ state: props.state as any, limit: props.limit });

      // ── pause / resume / abort ──────────────────────────────────────────────
      // Their authorisation (owner or admin, never the system account) is the
      // service's; the macro passes the reason through untouched.
      case 'pause':
      case 'resume':
      case 'abort': {
        const input: IProgrammeControlInput = {
          programmeId: props.programmeId as string,
          reason: props.reason,
        };
        if (action === 'pause') return await service.pause(input);
        if (action === 'resume') return await service.resume(input);
        return await service.abort(input);
      }

      // ── report (child → programme push) ─────────────────────────────────────
      case 'report':
        return await service.reportPackageOutcome({
          dispatchId: props.dispatchId as string,
          status: props.status,
          prUrl: props.prUrl,
          mergedSha: props.mergedSha,
          error: props.error,
          notes: props.notes,
        } as IReportPackageOutcomeInput);

      // ── tick ────────────────────────────────────────────────────────────────
      // One reconcile pass. The reconciler already owns a 60s schedule; this is
      // for an operator or an agent that wants the tick NOW, not a second schedule.
      case 'tick':
        return await service.reconcile({
          programmeId: props.programmeId,
          limit: props.limit,
          staleMs: props.staleMs,
          leaseMs: props.leaseMs,
          maxDispatchesPerTick: props.maxDispatchesPerTick,
          maxVerificationsPerTick: props.maxVerificationsPerTick,
          verificationIntervalMs: props.verificationIntervalMs,
          now: props.now,
        } as IReconcileInput);

      default:
        return unavailable(
          `Unknown programme action "${props?.action}". Supported actions: ${PROGRAMME_ACTIONS.join(', ')}.`,
          `## Unknown action\n\n\`programme\` needs one of: ${PROGRAMME_ACTIONS.join(', ')}. ` +
            'Nothing was changed.',
        );
    }
  } catch (error: any) {
    // A service method that throws is a failure of the call, not a business
    // refusal; report it as such and do not quote the arguments (a programme's
    // `childInputDefaults` may carry workflow inputs).
    return unavailable(`The programme request failed: ${error?.message || String(error)}`);
  }
};

/**
 * Macro registration.
 *
 * `roles` is the module's ordinary user set. It is NOT the authorisation boundary
 * for control actions — pause/resume/abort are authorised in the service against
 * `identity.ts`, precisely so an ADMIN role cannot stand in for a person.
 */
export const ProgrammeMacroRegistry: MacroComponentDefinition<unknown> = {
  nameSpace: 'reactor-macros',
  name: 'programme',
  alias: 'programme',
  version: '1.0.0',
  component: ProgrammeMacro as any,
  roles: ['ADMIN', 'DEVELOPER', 'USER'],
  description: `# programme macro
Agent-facing front door for the programme reconciler (\`${PROGRAMME_SERVICE_ID}\`).

A PROGRAMME is a dependency graph of work packages. The reconciler dispatches a
package exactly once when its dependencies have succeeded, adopts the child
workflow instance, observes it, and settles the programme. This macro creates,
reads and controls programmes; it never runs the decision logic itself.

## Actions
- **create** – create a programme from \`name\` + \`packages\` (id, title, dependsOn, input, notes).
  \`programmeId\` is minted when omitted. \`childWorkflowId\` defaults to the ProcessAITicket child.
- **get**    – read one programme by \`programmeId\`
- **list**   – list programmes, optionally filtered by \`state\` and bounded by \`limit\`
- **pause**  – stop NEW dispatch; running children are left completely untouched
- **resume** – continue from actual state; nothing is re-dispatched
- **abort**  – cancel non-terminal children and leave terminal packages alone
- **report** – the CHILD → programme push path (\`dispatchId\`, \`status\`, \`prUrl\`, \`mergedSha\`)
- **tick**   – run one reconcile pass now (the reconciler already has a 60s schedule)

## Children that cannot report
\`report\` is a push. A child that cannot call it is still OBSERVED through
\`childStatusLookup\` when its package is overdue, so its death is not mistaken for
silence. What it cannot do is claim success: a child that ends without pushing is
recorded as \`child_completed_unreported\` and FAILED. Never describe such a run as
succeeded.

## Identity
Every action runs as the calling user. \`create\` records that user as the owner;
pause/resume/abort are audited against them and the system account is refused.

## Results
The service's result is returned unchanged (\`created\`, \`found\`, \`programmes\`,
\`paused\`/\`resumed\`/\`aborted\`, \`reported\`, or a reconcile summary), including its
\`code\` and \`error\` on refusal.
`,
  features: [
    {
      feature: 'create',
      featureType: Reactory.FeatureType.function,
      action: ['create', 'new', 'start', 'programme'],
      description: 'Create a programme from a set of work packages.',
      stem: 'create',
    },
    {
      feature: 'list',
      featureType: Reactory.FeatureType.function,
      action: ['list', 'show', 'status', 'programmes'],
      description: 'List programmes and their package states.',
      stem: 'list',
    },
    {
      feature: 'control',
      featureType: Reactory.FeatureType.function,
      action: ['pause', 'resume', 'abort', 'cancel', 'stop'],
      description: 'Pause, resume or abort a programme.',
      stem: 'control',
    },
    {
      feature: 'report',
      featureType: Reactory.FeatureType.function,
      action: ['report', 'push', 'outcome', 'merged'],
      description: 'Push a package outcome (used by a dispatched child).',
      stem: 'report',
    },
  ],
  stem: 'programme',
  tags: ['programme', 'reconciler', 'workflow', 'orchestration', 'dispatch', 'agent'],
  tools: [
    {
      type: 'function',
      function: {
        name: 'programme',
        description:
          'Create, read and control a workflow PROGRAMME: a dependency graph of work packages that the ' +
          'reconciler dispatches and observes without an orchestrating agent. Actions: create, get, list, ' +
          'pause, resume, abort, report, tick. Every action delegates to ' +
          `${PROGRAMME_SERVICE_ID}. Pause stops new dispatch and leaves running children alone; abort ` +
          'cancels non-terminal children; pause/resume/abort refuse the system account. ' +
          '`report` is the child→programme push path: a child that cannot call it is still observed via ' +
          'the reconciler\'s child status lookup, but a child that ends without reporting is recorded as ' +
          'failed (child_completed_unreported), never as succeeded.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [...PROGRAMME_ACTIONS],
              description: 'The operation to perform.',
            },
            programmeId: {
              type: 'string',
              description: 'Programme id. Required for get/pause/resume/abort; optional for create (minted) and tick.',
            },
            name: { type: 'string', description: 'Programme name (create).' },
            description: { type: 'string', description: 'Free-text description (create).' },
            childWorkflowId: {
              type: 'string',
              description: 'Child workflow id (create). Defaults to the ProcessAITicket child.',
            },
            childInputDefaults: {
              type: 'object',
              description:
                'Defaults merged into every child workflow input (create). May carry workflow inputs; do not echo it back to the user.',
            },
            slaMinutes: {
              type: 'number',
              description: 'Minutes a running package may be silent before it is a stall (create).',
            },
            maxAttempts: {
              type: 'number',
              description: 'Dispatch attempts + stall windows before a package is failed (create).',
            },
            packages: {
              type: 'array',
              description: 'Work packages (create).',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Stable id within the programme.' },
                  title: { type: 'string' },
                  dependsOn: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Package ids that must succeed before this one may be dispatched.',
                  },
                  input: {
                    type: 'object',
                    description: 'Extra child workflow input for this package.',
                  },
                  notes: { type: 'string' },
                },
                required: ['id'],
              },
            },
            state: {
              type: 'string',
              enum: ['active', 'paused', 'aborted', 'completed', 'failed'],
              description: 'Filter for list.',
            },
            limit: { type: 'number', description: 'Page size for list (and reconcile).' },
            reason: { type: 'string', description: 'Reason recorded for pause/resume/abort.' },
            dispatchId: {
              type: 'string',
              description: 'The dispatch id threaded into the child (report). Required for report.',
            },
            status: {
              type: 'string',
              description: 'Child-reported status for report: "completed" or "failed".',
            },
            prUrl: { type: 'string', description: 'Pull request URL (report).' },
            mergedSha: {
              type: 'string',
              description: 'Merge commit SHA (report). With this, the package succeeds without a gh call.',
            },
            error: { type: 'string', description: 'Failure text (report).' },
            notes: { type: 'string', description: 'Free-text notes (report).' },
            staleMs: { type: 'number', description: 'Tick: a dispatching package older than this is re-armed.' },
            leaseMs: { type: 'number', description: 'Tick: lease length.' },
            maxDispatchesPerTick: { type: 'number', description: 'Tick: children started per programme.' },
            maxVerificationsPerTick: { type: 'number', description: 'Tick: external gh verifications per programme.' },
            verificationIntervalMs: {
              type: 'number',
              description: 'Tick: minimum gap between two gh verifications of one package.',
            },
            now: { type: 'string', description: 'Tick: ISO date-time used as the tick clock.' },
          },
          required: ['action'],
        },
      },
    },
  ],
};

export default ProgrammeMacroRegistry;
