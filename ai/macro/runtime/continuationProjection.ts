import Reactory from '@reactorynet/reactory-core';

/**
 * Read-only projection of durable continuations into the `todo` surface.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The owner's mental model is "a todo that wakes me", so the waits have to appear
 * where they already look. But the todo model must NOT grow scheduler semantics:
 * todos live in `state.vars['reactor.todos']` and are the property of whoever can
 * edit them, while a continuation is a row in `reactor_continuations` with a
 * deadline, a state machine and an owner. Copying one into the other would make
 * "completed" and "fired" two competing truths.
 *
 * So the projection is a *rendering*, never an insertion:
 *
 *   - it is built on every `todo(list)` call from the continuation service;
 *   - its ids are namespaced (`continuation:<id>`) and are never written into the
 *     todo vars, so `update`/`assign`/`remove` cannot find them;
 *   - those three actions additionally REFUSE the prefix explicitly, so the caller
 *     gets a teaching error naming `cancelContinuation` instead of "item not found";
 *   - only the nine public fields are read, so `correlationKey` — the wake
 *     credential — has no path into model context even if the service's projection
 *     were widened by mistake.
 *
 * The projection is also best-effort: no service, no session, or a service error
 * degrades to an empty list. A todo listing must not fail because observability
 * is unavailable.
 */

export const CONTINUATION_SERVICE_ID = 'reactor.AgentContinuationService@1.0.0';

/** Id prefix that marks an entry as scheduler-backed rather than a todo item. */
export const CONTINUATION_ID_PREFIX = 'continuation:';

export interface IContinuationProjectionEntry {
  /** Namespaced id. Deliberately not a todo id and never persisted as one. */
  id: string;
  continuationId: string;
  reason: string;
  state: string;
  /** ISO-8601 deadline, as returned by the service. */
  fireAt: string;
  /** Human line, e.g. `⏳ waiting on PR 482 merge until 14:00 (continuation 6f3a…)`. */
  label: string;
  /** The four affordances below are the contract: this is a view, not a record. */
  readOnly: true;
  completable: false;
  editable: false;
  removable: false;
  /** Where to go to actually change it. */
  cancelWith: 'cancelContinuation';
}

interface IContinuationViewLike {
  continuationId?: string;
  reason?: string;
  state?: string;
  fireAt?: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Format a deadline the way a person reads a diary: `14:00` when it is today,
 * `2026-10-24 09:30` otherwise.
 *
 * Deliberately hand-rolled rather than `toLocaleString`: the string is part of a
 * model-facing tool result, and locale-dependent output makes both the label and
 * its tests drift between machines.
 */
export function formatContinuationDeadline(fireAt: string, now: Date = new Date()): string {
  const date = new Date(fireAt);
  if (Number.isNaN(date.getTime())) return 'an unknown time';

  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) return time;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** Short, non-secret handle for a continuation. The correlation key is never used. */
export function shortContinuationId(continuationId: string): string {
  const id = String(continuationId || '');
  if (!id) return '(unknown)';
  return id.length > 5 ? `${id.slice(0, 4)}…` : id;
}

/**
 * Project one service view into a read-only entry.
 *
 * Every field is read explicitly. Nothing is spread, so a future field on the
 * service view (a prompt, an owner email, a key) cannot ride along.
 */
export function projectContinuation(
  view: IContinuationViewLike,
  now: Date = new Date(),
): IContinuationProjectionEntry {
  const continuationId = String(view?.continuationId || '');
  const reason = String(view?.reason || 'a follow-up').slice(0, 160);
  const state = String(view?.state || 'pending');
  const fireAt = String(view?.fireAt || '');
  const handle = shortContinuationId(continuationId);

  const label =
    state === 'firing'
      ? `⏳ waking now for ${reason} (continuation ${handle})`
      : `⏳ waiting on ${reason} until ${formatContinuationDeadline(fireAt, now)} (continuation ${handle})`;

  return {
    id: `${CONTINUATION_ID_PREFIX}${continuationId}`,
    continuationId,
    reason,
    state,
    fireAt,
    label,
    readOnly: true,
    completable: false,
    editable: false,
    removable: false,
    cancelWith: 'cancelContinuation',
  };
}

/**
 * Load the current session's pending continuations.
 *
 * The service's `list()` is owner-scoped from the chat context (it filters on
 * `ownerUserId` itself) and defaults to active states, so this can only ever see
 * the caller's own waits for this session.
 */
export async function loadContinuationProjection(
  state: any,
  context?: Reactory.Server.IReactoryContext,
  now: Date = new Date(),
): Promise<IContinuationProjectionEntry[]> {
  const ctx: any = context || (state as any)?.context;
  if (!ctx || typeof ctx.getService !== 'function') return [];

  let service: any = null;
  try {
    service = ctx.getService(CONTINUATION_SERVICE_ID);
  } catch {
    return [];
  }
  if (!service || typeof service.list !== 'function') return [];

  const chatSessionId = String((state as any)?.id || '');
  if (!chatSessionId) return [];

  try {
    const views = await service.list({ chatSessionId });
    return (Array.isArray(views) ? views : []).map((view: IContinuationViewLike) =>
      projectContinuation(view, now),
    );
  } catch {
    // Observability is decoration on this surface: never fail a todo listing for it.
    return [];
  }
}

/** Whether an id names a projected continuation rather than a real todo item. */
export function isContinuationProjectionId(todoId: string | undefined | null): boolean {
  return String(todoId || '').startsWith(CONTINUATION_ID_PREFIX);
}

/**
 * The refusal for `update`/`assign`/`remove` aimed at a projected continuation.
 *
 * This is the teaching half of read-only: the error names the tool that CAN change
 * the wait, so a model does not fall back to "the item was not found" and then
 * promise the user it cancelled something.
 */
export function continuationMutationRefusal(todoId: string): {
  success: false;
  error: string;
  instructions: string;
} {
  const continuationId = String(todoId || '').slice(CONTINUATION_ID_PREFIX.length);
  return {
    success: false,
    error:
      `"${todoId}" is a scheduled continuation, not a todo item. It is read-only here: ` +
      'it cannot be completed, edited, assigned or removed through the todo surface. ' +
      `Use \`cancelContinuation\` with continuationId "${continuationId}" to stop the wait.`,
    instructions:
      '## Continuation entries are read-only\n\n' +
      `"${continuationId}" is a durable wait owned by the continuation service, shown in \`todo(list)\` so you can tell the user what is outstanding. ` +
      'Its state is derived from the scheduler, so marking it done here would be a claim nobody keeps.\n\n' +
      `- To stop the wait: \`cancelContinuation\` with continuationId "${continuationId}"\n` +
      '- To see it again: `listContinuations`\n' +
      '- To add ordinary work: `todo` with action="add" to a list you own',
  };
}
