/**
 * Single source of truth for the agent tool-execution budget.
 *
 * `maxToolIterations` is enforced by TWO independent loops that share the name,
 * and the lower of the two silently wins:
 *
 *   A. the tool *execution* loop in `ReactorConversationService.sendMessage`
 *      (`for (... iteration < MAX_TOOL_ITERATIONS)`) — one iteration per batch of
 *      tool calls the server executes, then feeds back to the model.
 *
 *   B. the provider-internal model round-trip loop in
 *      `AnthropicService.runToolLoop` — one iteration per request/response
 *      exchange with the model, executing the tools each round.
 *
 * A workflow step (`agent_conversation`) writes the requested budget onto the
 * conversation document (`ReactorChatState.maxToolIterations`) through
 * `setChatMaxToolIterations`; both loops must resolve the budget the same way or
 * the configured value is inert. That is exactly what happened before this
 * module existed: loop B was hardcoded to 25, so a workflow asking for 60 (or
 * 200) was truncated at 25 on the Anthropic provider — and reported as a normal
 * completion. Ticket REACTORY-302016408/20261017/3478149265.
 *
 * Resolution order (first usable value wins):
 *
 *   1. the value the caller passed explicitly (per-call / per-conversation),
 *   2. `REACTOR_MAX_TOOL_ITERATIONS` from the environment,
 *   3. {@link DEFAULT_MAX_TOOL_ITERATIONS}.
 *
 * There is deliberately NO upward clamp. A floor (e.g. "never below 25") would
 * override a smaller deliberately-configured value — someone testing with
 * `maxToolIterations: 5` would silently get 25 calls — which is its own bug.
 * Absent means "use the default"; present means "use it".
 */

/** Budget used when neither the conversation nor the environment requests one. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 200;

/** Environment override for sessions that carry no explicit budget. */
export const MAX_TOOL_ITERATIONS_ENV = 'REACTOR_MAX_TOOL_ITERATIONS';

/** Finish reason a provider returns when its own tool loop ran out of budget. */
export const TOOL_LOOP_TRUNCATED_FINISH_REASON = 'max_tool_iterations';

/**
 * Coerce a candidate budget to a positive integer, or `undefined` when it cannot
 * be used. Accepts numeric strings because the environment path yields strings;
 * a fractional value is floored (an iteration count is not a continuum).
 */
export function normalizeMaxToolIterations(candidate: unknown): number | undefined {
  const value =
    typeof candidate === 'string' && candidate.trim() !== ''
      ? Number(candidate)
      : candidate;

  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 1) return undefined;

  return Math.floor(value);
}

/**
 * Resolve the effective tool-iteration budget.
 *
 * Never clamps upward: an explicit `5` stays `5`. Only a missing/unusable value
 * falls through to the next source.
 */
export function resolveMaxToolIterations(
  requested?: unknown,
  envValue: unknown = process.env[MAX_TOOL_ITERATIONS_ENV],
): number {
  return (
    normalizeMaxToolIterations(requested) ??
    normalizeMaxToolIterations(envValue) ??
    DEFAULT_MAX_TOOL_ITERATIONS
  );
}

/**
 * What a truncated tool loop reports about itself.
 *
 * `null` fields mean the provider did not say, and callers must fall back to
 * their own counters rather than inventing a number.
 */
export interface ToolLoopTruncation {
  iterationsCompleted: number | null;
  maxToolIterations: number | null;
}

function firstFiniteNumber(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    const value = normalizeMaxToolIterations(candidate);
    if (value !== undefined) return value;
  }
  return null;
}

/**
 * Detect a provider-reported tool-loop truncation on any of the response shapes
 * that circulate inside the conversation service:
 *
 *   - the raw provider completion `{ choices: [{ finish_reason, message }] }`,
 *   - a provider completion that also carries the flags at the top level,
 *   - the flat `ReactorChatMessage` shape `processAIResponse` normalises to.
 *
 * A capped turn and a finished turn are otherwise indistinguishable: both return
 * content and no pending tool calls. Detecting it is what lets the caller mark
 * the turn as truncated instead of reporting it as complete — the failure mode
 * this ticket exists to remove.
 */
export function readToolLoopTruncation(response: any): ToolLoopTruncation | null {
  if (!response || typeof response !== 'object') return null;

  const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
  const message = choice?.message;

  const flagged =
    response.toolIterationLimitReached === true ||
    message?.toolIterationLimitReached === true;

  const finishReasons = [
    response.finish_reason,
    response.finishReason,
    choice?.finish_reason,
    choice?.finishReason,
    message?.finish_reason,
    message?.finishReason,
  ];

  if (!flagged && !finishReasons.includes(TOOL_LOOP_TRUNCATED_FINISH_REASON)) {
    return null;
  }

  return {
    iterationsCompleted: firstFiniteNumber(
      response.iterationsCompleted,
      message?.iterationsCompleted,
    ),
    maxToolIterations: firstFiniteNumber(
      response.maxToolIterations,
      message?.maxToolIterations,
    ),
  };
}

/**
 * The fields a truncated turn carries so no consumer has to re-derive them.
 * Spread onto the response object; keeps `null` rather than guessing.
 */
export function toolLoopTruncationFields(
  truncation: ToolLoopTruncation,
): Record<string, unknown> {
  return {
    toolIterationLimitReached: true,
    finishReason: TOOL_LOOP_TRUNCATED_FINISH_REASON,
    iterationsCompleted: truncation.iterationsCompleted,
    maxToolIterations: truncation.maxToolIterations,
  };
}
