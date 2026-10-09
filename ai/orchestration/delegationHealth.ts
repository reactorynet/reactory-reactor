/**
 * Delegation health analysis.
 *
 * Background
 * ----------
 * A delegated (headless) sub-agent turn can silently STALL: in AUTO tool-approval
 * mode the reactor may classify a tool as *client-side*, forward it to a client
 * and PAUSE the turn awaiting `ReactorCompleteClientToolCalls`. A delegated
 * session has no client, so the turn never resumes and the caller receives only
 * the assistant's opening line while the delegation reports `complete`.
 *
 * This module turns a delegation session transcript into a deterministic health
 * verdict so the condition can be asserted in CI (and by operational tooling)
 * without needing a live server or LLM.
 *
 * Log signatures (a session.log under
 * `REACTORY_DATA/profiles/<user>/chats/<personaId>/<conversationId>/session.log`):
 *
 *   healthy:  `AUTO mode: executing N tool(s) server-side`   (and no `pausing`)
 *   stalled:  `AUTO mode: skipping client-side tool "<name>" — will be forwarded to client`
 *             followed by `AUTO mode: pausing — client-side tool(s) pending`
 */

export interface IDelegationHealth {
  /** True when the transcript shows no stall (safe to treat the result as real). */
  healthy: boolean;
  /** True when the turn paused awaiting client-side tool results. */
  stalled: boolean;
  /** Human-readable explanation when `stalled`. */
  reason?: string;
  /** Tool names the server executed server-side (AUTO mode). */
  serverSideTools: string[];
  /** Tool names that were deferred to a client (the stall trigger). */
  pendingClientTools: string[];
  /** Highest AUTO-mode iteration observed, or 0 if none. */
  lastIteration: number;
}

const RE_EXECUTING = /AUTO mode: executing\s+(\d+)\s+tool\(s\)\s+server-side/i;
const RE_TOOLS_JSON = /"tools"\s*:\s*\[([^\]]*)\]/i;
const RE_ITERATION = /\(iteration\s+(\d+)\)/i;
const RE_SKIPPING = /AUTO mode:\s*skipping client-side tool\s+"([^"]+)"/i;
const RE_PAUSING = /AUTO mode:\s*pausing\b/i;

const parseToolsJson = (raw: string): string[] => {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
};

/**
 * Analyse a delegation transcript (raw session.log text) for the stall signature.
 *
 * A transcript is STALLED when the turn paused AND at least one tool was deferred
 * to a client. Pausing without a deferred tool is not treated as a stall.
 */
export const analyzeDelegationTranscript = (logText: string): IDelegationHealth => {
  const text = String(logText || '');
  const lines = text.split(/\r?\n/);

  const serverSideTools: string[] = [];
  const pendingClientTools: string[] = [];
  let paused = false;
  let lastIteration = 0;

  for (const line of lines) {
    const executing = line.match(RE_EXECUTING);
    if (executing) {
      const iteration = line.match(RE_ITERATION);
      if (iteration) lastIteration = Math.max(lastIteration, Number(iteration[1]) || 0);
      const toolsMatch = line.match(RE_TOOLS_JSON);
      if (toolsMatch) serverSideTools.push(...parseToolsJson(toolsMatch[1]));
    }

    const skipping = line.match(RE_SKIPPING);
    if (skipping) pendingClientTools.push(skipping[1]);

    if (RE_PAUSING.test(line)) paused = true;
  }

  const stalled = paused && pendingClientTools.length > 0;

  return {
    healthy: !stalled,
    stalled,
    reason: stalled
      ? `Turn paused awaiting client-side tool(s): ${Array.from(new Set(pendingClientTools)).join(', ')}`
      : undefined,
    serverSideTools,
    pendingClientTools,
    lastIteration,
  };
};

/** Convenience predicate for assertions / guards. */
export const isDelegationHealthy = (logText: string): boolean =>
  analyzeDelegationTranscript(logText).healthy;

export default analyzeDelegationTranscript;
