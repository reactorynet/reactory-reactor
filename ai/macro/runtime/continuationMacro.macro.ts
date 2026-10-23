import Reactory from '@reactorynet/reactory-core';
import { ChatState, Macro, MacroComponentDefinition } from '../../openai/types/chat';
// Three levels up: runtime -> macro -> ai -> <module root>. The policy helpers are
// imported (not duplicated) so the macro and the service can never disagree about
// which predicates are permitted.
import { isConditionPredicateAllowed, describeConditionPolicy } from '../../../services/reactor/AgentContinuationService';

/**
 * Durable agent continuation macros (REACTORY-302016408).
 *
 * These are the agent-facing surface of `reactor.AgentContinuationService@1.0.0`.
 * They exist so the model has ONE obvious call instead of learning the service,
 * and — more importantly — so every refusal path returns an actionable message.
 *
 * The failure this feature removes is an *unbacked promise*: "I'll monitor the PR
 * and report back" from an agent whose turn then ends and nothing resumes. A model
 * that gets a clear, honest refusal ("no session", "over cap", "budget exhausted")
 * will say so; a model that gets a silent no-op or a vague error will promise
 * anyway. So `instructions` is part of the contract of every return value here.
 */

export const CONTINUATION_SERVICE_ID = 'reactor.AgentContinuationService@1.0.0';

const HONESTY_RULE =
  'Never tell the user you will follow up unless this call returned success: true. ' +
  'If it did not, say plainly that you cannot schedule a follow-up and why.';

export interface IScheduleContinuationProps {
  /** Defaults to the current chat session. */
  chatSessionId?: string;
  /** Defaults to the session's persona. */
  personaId?: string;
  /** ISO date-time or epoch ms. Exactly one trigger form must be supplied. */
  at?: string | number | Date;
  /** Fire when an external producer publishes this event name. */
  eventName?: string;
  /** Fire when a service method reports a satisfying value. */
  condition?: {
    serviceId: string;
    method: string;
    params?: Record<string, any>;
    /** Dot-path into the result, e.g. `result.merged`. */
    expectPath?: string;
    expectValue?: any;
  };
  /** Fire when a user task completes. */
  task?: string | { taskId?: string };
  /** What you are waiting for, in the user's words. */
  reason: string;
  /** The turn to send when the signal WAS observed. */
  resumePrompt: string;
  /**
   * The turn to send when the deadline passed WITHOUT the signal. Required, and
   * required to be explicit that the thing did not happen — this string is the
   * reason an unobserved signal can never be reported as fact.
   */
  expirePrompt: string;
  /** Deadline in ms from now. Defaults to the `at` time plus 15 minutes, or 24h. */
  ttlMs?: number;
}

export interface ICancelContinuationProps {
  continuationId: string;
  reason?: string;
}

export interface IListContinuationsProps {
  chatSessionId?: string;
  state?: string;
  includeTerminal?: boolean;
  limit?: number;
}

function getContinuationService(state: ChatState, context?: Reactory.Server.IReactoryContext): any {
  const ctx: any = context || (state as any)?.context;
  if (!ctx || typeof ctx.getService !== 'function') return null;
  try {
    return ctx.getService(CONTINUATION_SERVICE_ID);
  } catch {
    return null;
  }
}

function resolveSessionId(props: IScheduleContinuationProps, state: ChatState): string | undefined {
  return props.chatSessionId || state?.id;
}

/**
 * Translate the flat macro arguments into the record's discriminated trigger.
 * Returns an error string when the caller's intent is ambiguous — guessing which
 * of four trigger kinds was meant would arm the wrong wait silently.
 */
export function buildTrigger(props: IScheduleContinuationProps):
  | { trigger: any; error?: undefined }
  | { trigger?: undefined; error: string } {
  const supplied: string[] = [];
  if (props.at !== undefined && props.at !== null && props.at !== '') supplied.push('at');
  if (props.eventName) supplied.push('eventName');
  if (props.condition) supplied.push('condition');
  if (props.task !== undefined && props.task !== null) supplied.push('task');

  if (supplied.length === 0) {
    return {
      error:
        'No trigger was supplied. Pass exactly one of: `at` (future ISO date-time), `eventName`, `condition`, or `task`.',
    };
  }
  if (supplied.length > 1) {
    return {
      error: `More than one trigger was supplied (${supplied.join(', ')}). Pass exactly one — a continuation waits for one thing.`,
    };
  }

  if (supplied[0] === 'at') {
    const at = new Date(props.at as any);
    if (Number.isNaN(at.getTime())) {
      return { error: `\`at\` must be a valid ISO date-time or epoch milliseconds (received "${props.at}").` };
    }
    if (at.getTime() <= Date.now()) {
      return { error: '`at` must be in the future. A deadline in the past can never be observed.' };
    }
    return { trigger: { kind: 'at', at } };
  }

  if (supplied[0] === 'eventName') {
    return { trigger: { kind: 'event', eventName: String(props.eventName) } };
  }

  if (supplied[0] === 'condition') {
    if (!props.condition?.serviceId || !props.condition?.method) {
      return { error: '`condition` needs both serviceId and method.' };
    }
    // A condition is evaluated later, unattended, in a context rebuilt from the
    // registrant — so an arbitrary service method would be a confused-deputy path.
    // Refused here as well as at the service boundary, so the model gets the
    // actionable message instead of a generic registration failure.
    if (!isConditionPredicateAllowed(props.condition.serviceId, props.condition.method)) {
      return {
        error:
          `\`${props.condition.serviceId}.${props.condition.method}\` is not a permitted condition predicate. ` +
          describeConditionPolicy(),
      };
    }
    return { trigger: { kind: 'condition', ...props.condition } };
  }

  const task = typeof props.task === 'string' ? { taskId: props.task } : props.task || {};
  return { trigger: { kind: 'task', ...(task as any) } };
}

/**
 * Trigger kinds that something in THIS delivery actually fires.
 *
 * `at` and `condition` are evaluated by `reactor.AgentContinuationSweeper`, which
 * ships with this change. `event`, `task` and `webhook` are supported end to end by
 * the record, the waiter and `fire()` — but nothing in this ticket publishes them:
 * wiring those producers is the follow-up ticket. A continuation registered on one
 * of them can therefore only ever expire.
 *
 * That is honest at expiry (the wake carries `not_observed` and `expirePrompt`), but
 * it is NOT what the user asked for, so the success message says so explicitly
 * rather than implying the condition will be watched. This is the difference
 * between a bounded, disclosed wait and a promise the platform cannot keep.
 */
export const PRODUCERLESS_TRIGGER_KINDS: ReadonlyArray<string> = ['event', 'task', 'webhook'];

export function isProducerless(kind: string | undefined): boolean {
  return !!kind && PRODUCERLESS_TRIGGER_KINDS.includes(kind);
}
/**
 * Default deadline. A continuation must be bounded, but making the model compute
 * an absolute deadline invites off-by-an-hour mistakes, so derive a sensible one:
 * the `at` moment plus a 15-minute grace, otherwise 24 hours.
 */
export function defaultTtlMs(props: IScheduleContinuationProps, now: number = Date.now()): number {  if (props.ttlMs && Number.isFinite(Number(props.ttlMs))) return Number(props.ttlMs);
  if (props.at !== undefined && props.at !== null && props.at !== '') {
    const at = new Date(props.at as any).getTime();
    if (!Number.isNaN(at)) return Math.max(at - now + 15 * 60 * 1000, 60 * 1000);
  }
  return 24 * 60 * 60 * 1000;
}

// ── scheduleContinuation ─────────────────────────────────────────────────────

export const ScheduleContinuationMacro: Macro<unknown, IScheduleContinuationProps> = async (
  props: IScheduleContinuationProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext,
): Promise<unknown> => {
  try {
    const service = getContinuationService(state, context);
    if (!service) {
      return {
        success: false,
        error: `The continuation service (${CONTINUATION_SERVICE_ID}) is not available in this context.`,
        instructions: `## Cannot schedule a follow-up\n\nThe continuation service is not registered. Do not promise the user a follow-up.\n\n${HONESTY_RULE}`,
      };
    }

    const chatSessionId = resolveSessionId(props, state);
    if (!chatSessionId) {
      return {
        success: false,
        error: 'No chat session id is available, so there is nothing that could be woken later.',
        instructions: `## Cannot schedule a follow-up\n\nThis call has no attached chat session. Tell the user a follow-up cannot be scheduled from here and offer to continue in an active chat session.\n\n${HONESTY_RULE}`,
      };
    }

    const built = buildTrigger(props);
    if (built.error) {
      return {
        success: false,
        error: built.error,
        instructions: `## Cannot schedule a follow-up\n\n${built.error}\n\n${HONESTY_RULE}`,
      };
    }

    if (!props.reason || !props.resumePrompt || !props.expirePrompt) {
      const missing = [
        !props.reason ? 'reason' : null,
        !props.resumePrompt ? 'resumePrompt' : null,
        !props.expirePrompt ? 'expirePrompt' : null,
      ].filter(Boolean);
      return {
        success: false,
        error: `Missing required argument(s): ${missing.join(', ')}.`,
        instructions:
          `## Cannot schedule a follow-up\n\nMissing: **${missing.join(', ')}**.\n\n` +
          '`expirePrompt` is deliberately mandatory: it is the instruction you will receive if the deadline passes **without** the signal, and it is what stops you reporting something that never happened as fact. Write it explicitly, e.g.\n\n' +
          `> "The wait for '<reason>' expired without the signal being observed. Tell the user plainly that it was not observed and what you can check now. Do not report it as having happened."\n\n` +
          `${HONESTY_RULE}`,
      };
    }

    const ttlMs = defaultTtlMs(props);
    const result = await service.register({
      chatSessionId,
      personaId: props.personaId || (state as any)?.personaId,
      trigger: built.trigger,
      reason: props.reason,
      resumePrompt: props.resumePrompt,
      expirePrompt: props.expirePrompt,
      ttlMs,
    });

    if (!result?.registered) {
      const code = result?.code ? ` (${result.code})` : '';
      return {
        success: false,
        code: result?.code,
        error: result?.error || 'The continuation was not registered.',
        instructions:
          `## Cannot schedule a follow-up${code}\n\n${result?.error || 'The continuation was not registered.'}\n\n` +
          `${HONESTY_RULE}`,
      };
    }

    const triggerKind = built.trigger?.kind as string | undefined;
    const producerless = isProducerless(triggerKind);

    return {
      success: true,
      continuationId: result.continuationId,
      fireAt: result.fireAt,
      state: result.state,
      reason: props.reason,
      triggerKind,
      /** False for event/task/webhook: nothing in this deployment publishes them yet. */
      producerAvailable: !producerless,
      instructions:
        `## Follow-up scheduled\n\n` +
        `- **Waiting on**: ${props.reason}\n` +
        `- **Wakes at the latest**: ${result.fireAt}\n` +
        `- **continuationId**: ${result.continuationId}\n\n` +
        'Tell the user what you are waiting for and when the wait expires. ' +
        'You may say you will report back, because a durable waiter is now parked. ' +
        'If it expires without the signal you will be woken with an instruction to say it was NOT observed.' +
        (producerless
          ? `\n\n### Important — this wait can only expire\n\n` +
            `Nothing currently publishes a \`${triggerKind}\` signal, so this continuation ` +
            `WILL expire at ${result.fireAt} unless a producer is wired up. Say that to the user: ` +
            `you are watching until ${result.fireAt}, not until their condition happens. ` +
            'Do not describe it as a guarantee that they will be told the moment it happens.'
          : ''),
    };
  } catch (error: any) {
    // `register` throws only when the waiter could not be started — nothing is
    // waiting, so the model must NOT be allowed to report success.
    return {
      success: false,
      error: error?.message || 'The continuation waiter could not be started.',
      instructions:
        `## Cannot schedule a follow-up\n\n${error?.message || 'The continuation waiter could not be started.'}\n\n` +
        `${HONESTY_RULE}`,
    };
  }
};

// ── cancelContinuation ───────────────────────────────────────────────────────

export const CancelContinuationMacro: Macro<unknown, ICancelContinuationProps> = async (
  props: ICancelContinuationProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext,
): Promise<unknown> => {
  try {
    const service = getContinuationService(state, context);
    if (!service) {
      return { success: false, error: `The continuation service (${CONTINUATION_SERVICE_ID}) is not available.` };
    }
    if (!props?.continuationId) {
      return {
        success: false,
        error: 'continuationId is required.',
        instructions: 'Use `listContinuations` to find the id of the wait you want to cancel.',
      };
    }

    const result = await service.cancel({
      continuationId: String(props.continuationId),
      reason: props.reason,
    });

    if (!result?.cancelled) {
      return {
        success: false,
        error: `The continuation was not cancelled: ${result?.reason || 'unknown reason'}.`,
        instructions:
          '## Not cancelled\n\n' +
          (result?.reason === 'not_owner'
            ? 'That continuation belongs to a different user, so it cannot be cancelled from this session.'
            : result?.reason === 'not_found'
              ? 'No continuation exists with that id. Use `listContinuations` to see the current ones.'
              : `Nothing was cancelled (${result?.reason}). It has probably already fired or expired.`),
      };
    }

    return {
      success: true,
      continuationId: props.continuationId,
      instructions:
        '## Follow-up cancelled\n\nThe waiter has been cancelled and the workflow instance stopped. ' +
        'Tell the user you will not report back on it.',
    };
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to cancel the continuation.' };
  }
};

// ── listContinuations ────────────────────────────────────────────────────────

export const ListContinuationsMacro: Macro<unknown, IListContinuationsProps> = async (
  props: IListContinuationsProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext,
): Promise<unknown> => {
  try {
    const service = getContinuationService(state, context);
    if (!service) {
      return { success: false, error: `The continuation service (${CONTINUATION_SERVICE_ID}) is not available.` };
    }

    // The service projects a sanitised view: the correlation key is the credential
    // that authorises a wake, so it is never returned to a model or a user.
    const continuations = await service.list({
      chatSessionId: props?.chatSessionId || state?.id,
      state: props?.state as any,
      includeTerminal: Boolean(props?.includeTerminal),
      limit: props?.limit,
    });

    const items = Array.isArray(continuations) ? continuations : [];
    const summary = items.length === 0
      ? 'Nothing is waiting.'
      : items
          .map(
            (c: any) =>
              `- ${c.state === 'pending' || c.state === 'armed' ? '⏳ waiting' : c.state}: **${c.reason}** ` +
              `(${c.triggerSummary}), deadline ${c.fireAt} — id ${c.continuationId}`,
          )
          .join('\n');

    return {
      success: true,
      continuations: items,
      count: items.length,
      instructions: `## Continuations (${items.length})\n\n${summary}`,
    };
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to list continuations.' };
  }
};

// ── registration ─────────────────────────────────────────────────────────────

export const ContinuationMacroRegistry: MacroComponentDefinition<unknown>[] = [
  {
    nameSpace: 'reactor-macros',
    name: 'scheduleContinuation',
    version: '1.0.0',
    alias: 'continuation',
    component: ScheduleContinuationMacro as any,
    description: `# scheduleContinuation macro
Use this to register a DURABLE interest in a future time or signal, so you can be
woken and can honestly say "I will report back".

Exactly one trigger:
  - \`at\`        — a future ISO date-time (or epoch ms)
  - \`eventName\` — an external producer publishes this event
  - \`condition\` — a service method returns a satisfying value
  - \`task\`      — a user task completes

\`expirePrompt\` is required. It is the turn you will receive if the deadline passes
WITHOUT the signal, and it must instruct you to say the signal was not observed.
That single string is what stops an unobserved signal being reported as fact.

## Example
@scheduleContinuation({
  at: "2026-10-23T16:00:00Z",
  reason: "PR #482 merge",
  resumePrompt: "Check whether PR #482 merged and report the result.",
  expirePrompt: "The wait for PR #482 expired without the merge being observed. Say plainly that it was not observed and what you can check now. Do not report it as merged."
})
`,
    features: [
      {
        feature: 'schedule',
        featureType: Reactory.FeatureType.function,
        action: ['schedule', 'wait', 'wake', 'remind', 'follow up', 'monitor'],
        description: 'Register a durable wait and be woken at a deadline or on a signal.',
        stem: 'schedule',
      },
    ],
    roles: ['USER'],
    stem: 'scheduleContinuation',
    tags: ['continuation', 'wait', 'durable', 'agent', 'follow-up', 'schedule'],
    tools: [
      {
        type: 'function',
        function: {
          name: 'scheduleContinuation',
          description:
            'Register a durable continuation: you are woken later (at a time, or when a condition is true) and can then report back to the user. eventName and task are accepted for compatibility, but nothing in this deployment publishes those signals yet, so such a wait can only expire — say so to the user. expirePrompt is required so an expired wait is never reported as a completed one.',          parameters: {
            type: 'object',
            properties: {
              at: {
                type: 'string',
                description: 'Trigger: fire at this future ISO date-time (or epoch milliseconds). Do not combine with eventName/condition/task.',
              },
              eventName: {
                type: 'string',
                description: 'Trigger: fire when this workflow event name is published.',
              },
              condition: {
                type: 'object',
                description:
                  'Trigger: fire when a service method satisfies a value. Only an explicit allowlist of read-only predicates is permitted, and the check runs as you, not as the system. An unlisted pair is refused — use `at` instead.',
                properties: {
                  serviceId: { type: 'string', description: 'e.g. reactor.ReactorProjectService@1.0.0' },
                  method: { type: 'string' },
                  params: { type: 'object' },
                  expectPath: { type: 'string', description: 'Dot-path into the result, e.g. result.merged' },
                  expectValue: { description: 'Value that satisfies the condition' },
                },
                required: ['serviceId', 'method'],
              },
              task: {
                type: 'string',
                description: 'Trigger: fire when this user task id completes.',
              },
              reason: {
                type: 'string',
                description: 'What you are waiting for, in the user\'s words (shown in the UI).',
              },
              resumePrompt: {
                type: 'string',
                description: 'The instruction you will receive when the signal WAS observed.',
              },
              expirePrompt: {
                type: 'string',
                description:
                  'The instruction you will receive if the deadline passes WITHOUT the signal. Must tell you to state plainly that it was not observed.',
              },
              ttlMs: {
                type: 'number',
                description: 'Deadline in ms from now. Defaults to the `at` time + 15 minutes, otherwise 24h.',
              },
              chatSessionId: {
                type: 'string',
                description: 'Defaults to the current chat session.',
              },
              personaId: {
                type: 'string',
                description: 'Defaults to the current persona.',
              },
            },
            required: ['reason', 'resumePrompt', 'expirePrompt'],
          },
        },
      },
    ],
  },
  {
    nameSpace: 'reactor-macros',
    name: 'cancelContinuation',
    version: '1.0.0',
    alias: 'cancelContinuation',
    component: CancelContinuationMacro as any,
    description: `# cancelContinuation macro
Cancel a waiting continuation so the agent will not be woken for it.

## Example
@cancelContinuation({ continuationId: "66f1c0..." })
`,
    features: [
      {
        feature: 'cancel',
        featureType: Reactory.FeatureType.function,
        action: ['cancel', 'stop', 'abort', 'forget'],
        description: 'Cancel a waiting continuation.',
        stem: 'cancel',
      },
    ],
    roles: ['USER'],
    stem: 'cancelContinuation',
    tags: ['continuation', 'cancel', 'wait', 'agent'],
    tools: [
      {
        type: 'function',
        function: {
          name: 'cancelContinuation',
          description: 'Cancel a durable continuation so you will not be woken for it.',
          parameters: {
            type: 'object',
            properties: {
              continuationId: { type: 'string', description: 'Id returned by scheduleContinuation.' },
              reason: { type: 'string', description: 'Why it is being cancelled.' },
            },
            required: ['continuationId'],
          },
        },
      },
    ],
  },
  {
    nameSpace: 'reactor-macros',
    name: 'listContinuations',
    version: '1.0.0',
    alias: 'listContinuations',
    component: ListContinuationsMacro as any,
    description: `# listContinuations macro
List the continuations waiting for this session (or user), so you can tell the user
exactly what you are waiting for and until when.

## Example
@listContinuations({ includeTerminal: false })
`,
    features: [
      {
        feature: 'list',
        featureType: Reactory.FeatureType.function,
        action: ['list', 'show', 'waiting', 'pending'],
        description: 'List pending continuations.',
        stem: 'list',
      },
    ],
    roles: ['USER'],
    stem: 'listContinuations',
    tags: ['continuation', 'list', 'wait', 'agent'],
    tools: [
      {
        type: 'function',
        function: {
          name: 'listContinuations',
          description: 'List durable continuations (what you are waiting for and until when).',
          parameters: {
            type: 'object',
            properties: {
              chatSessionId: { type: 'string', description: 'Defaults to the current session.' },
              state: {
                type: 'string',
                enum: ['pending', 'armed', 'firing', 'fired', 'expired', 'cancelled', 'orphaned', 'failed'],
                description: 'Filter to one state.',
              },
              includeTerminal: {
                type: 'boolean',
                description: 'Include fired/expired/cancelled/orphaned/failed records.',
              },
              limit: { type: 'number', description: 'Maximum records (default 20, max 100).' },
            },
            required: [],
          },
        },
      },
    ],
  },
];

export default ContinuationMacroRegistry;
