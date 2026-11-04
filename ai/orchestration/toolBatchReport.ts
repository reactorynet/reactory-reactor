/**
 * Per-iteration accounting for the AUTO tool-execution loop.
 *
 * Background
 * ----------
 * The AUTO loop used to log `AUTO mode: executing N tool(s) server-side` *before*
 * classifying the batch, counting every call. It then skipped some of those same tools
 * as client-side and paused. Two consequences, both observed in a stalled delegation
 * (ticket REACTORY-302016408/20261006/2269478065):
 *
 *   - the same iteration claimed to execute a tool server-side and to forward it to a
 *     client — two classification paths that disagreed within one iteration; and
 *   - `delegationHealth` reads that line, so the transcript could not be trusted to
 *     tell an executed tool from a deferred one.
 *
 * This module is the single accounting point: the loop records what it actually did,
 * the summary line is derived from those records, and the analyser therefore reads a
 * truthful count. Kept pure so the invariant can be asserted without a provider, a
 * transport or a database.
 */

export interface IAutoToolBatch {
  /** Tools the server executed in this iteration. */
  executedServerTools: string[];
  /** Client-routed tools that were forwarded (interactive) or refused (headless). */
  deferredClientTools: string[];
  /** Tools refused because the conversation does not declare them. */
  refusedTools: string[];
}

export const createAutoToolBatch = (): IAutoToolBatch => ({
  executedServerTools: [],
  deferredClientTools: [],
  refusedTools: [],
});

/**
 * Render the iteration's session-log line.
 *
 * `tools` is exactly `executedServerTools` — never the raw call list — so a transcript
 * can no longer claim a client-side tool was executed server-side. The other two sets
 * are reported as separate fields for diagnosis.
 */
export const describeAutoToolBatch = (
  batch: IAutoToolBatch,
  iteration: number
): { message: string; meta: Record<string, unknown> } => ({
  message: `[sendMessage] AUTO mode: executing ${batch.executedServerTools.length} tool(s) server-side (iteration ${iteration})`,
  meta: {
    tools: [...batch.executedServerTools],
    clientTools: [...batch.deferredClientTools],
    refusedTools: [...batch.refusedTools],
  },
});

/**
 * Render the WARN line for a batch a user interrupt threw away.
 *
 * WHY THIS IS A LINE OF ITS OWN
 * -----------------------------
 * When the AUTO loop breaks on an interrupt its check is the *first* statement in
 * the loop body, ahead of `iteration++` and ahead of any classification — so the
 * batch the model just produced is never executed, never refused, never deferred,
 * and never given a result. Ticket REACTORY-302016408/20261104/2715764250 is that
 * exact event: two `listSupportTickets` calls persisted at 06:39:19.060 with
 * `status: "pending"`, an interrupt observed 146 ms later at 06:39:19.206, and then
 * nothing at all. The only line written said
 *
 *     AUTO mode: interrupted by user after 0 iteration(s)
 *
 * which is indistinguishable from "there was nothing to do". A reader cannot tell
 * that a batch of tool calls was discarded, which calls they were, or that their
 * `tool_call_id`s will never be answered.
 *
 * So the abandonment gets its own line, at WARN, naming every call in the batch by
 * tool name AND tool_call_id plus the iteration it happened at. Naming the ids is
 * the point: they are what a transcript query is keyed on when someone asks "was
 * this call ever answered?".
 *
 * Pure, like `describeAutoToolBatch`, so the line can be asserted without a
 * provider, a transport or a database.
 */
export const describeAbandonedToolCalls = (
  toolCalls: Array<{ id?: string; function?: { name?: string }; name?: string }> | null | undefined,
  iteration: number
): { message: string; meta: Record<string, unknown> } => {
  const abandoned = (toolCalls || []).map((call) => ({
    tool: call?.function?.name || call?.name || "unknown",
    toolCallId: call?.id || "unknown",
  }));

  const described = abandoned.map((c) => `${c.tool}(${c.toolCallId})`).join(", ");

  return {
    message:
      `[sendMessage] AUTO mode: user interrupt at iteration ${iteration} — ABANDONING ` +
      `${abandoned.length} tool call(s) that will have NO result: ${described || "(none recorded on the response)"}`,
    meta: {
      iteration,
      abandonedCount: abandoned.length,
      abandoned,
      abandonedToolCallIds: abandoned.map((c) => c.toolCallId),
    },
  };
};

export default createAutoToolBatch;
