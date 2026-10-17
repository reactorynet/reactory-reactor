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

export default createAutoToolBatch;
