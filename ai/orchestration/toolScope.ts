import { ToolApprovalMode } from '../openai/types/chat';

/**
 * Tool scope — the one place that answers "does this tool run here, or in the browser?"
 *
 * Background
 * ----------
 * Every macro and tool may carry a `runat` flag:
 *
 *   - `runat: 'server'` (the default) — the Reactor can execute it in-process.
 *   - `runat: 'client'`             — it can only run in the user's browser
 *                                     (charts, image galleries, side-panel mounts, …).
 *
 * The flag is load-bearing. A turn that calls a client tool has to be *forwarded* to a browser
 * and paused until the browser reports a result. That is correct for an interactive session and
 * catastrophic for a headless one: a delegated sub-agent has no browser, so the pause never
 * resolves and the agent silently stops after a call or two.
 *
 * So the classification has to be exactly right, and it has to be applied consistently. This
 * module is the single source of truth for it, kept as pure functions so the policy can be
 * asserted without standing up a provider, a transport or a database.
 *
 * SCOPE IS INHERITED
 * ------------------
 * A tool's scope is its own `runat` if it declares one, otherwise the scope of the macro that
 * owns it. A tool advertised by a client macro is client-run by virtue of belonging to it, even
 * though the flattened tool entry itself is silent. `inheritToolScopes` materialises that so
 * downstream readers never have to guess.
 */

export type ToolScope = 'server' | 'client';

export const TOOL_SCOPE_SERVER: ToolScope = 'server';
export const TOOL_SCOPE_CLIENT: ToolScope = 'client';

/**
 * The name a macro or tool definition is addressed by.
 *
 * Macros may be aliased (`alias`), tools always hang off `function.name`, and a bare definition
 * may just be `name`. Callers check all three, in the order the runtime resolves them.
 */
export const toolNameOf = (def: any): string | undefined => {
  if (!def) return undefined;
  const name = def?.function?.name || def?.alias || def?.name;
  return name ? String(name) : undefined;
};

/**
 * Scope of a macro/tool definition.
 *
 * Anything that is not explicitly `client` is treated as server, matching every other read of
 * `runat` in this codebase (`ReactorTool.getToolRunAt` returns `tool.runat || "server"`). The
 * default matters: an entry that omits the flag is server-owned and must NOT be forwarded to a
 * browser, which could never answer it.
 */
export const getToolScope = (def: any): ToolScope =>
  def?.runat === TOOL_SCOPE_CLIENT ? TOOL_SCOPE_CLIENT : TOOL_SCOPE_SERVER;

export const isClientScoped = (def: any): boolean => getToolScope(def) === TOOL_SCOPE_CLIENT;

export const isServerScoped = (def: any): boolean => getToolScope(def) === TOOL_SCOPE_SERVER;

/**
 * True when the conversation is a delegated (headless) sub-agent session.
 *
 * A sub-agent conversation is created with `parentSessionId` pointing at the session that spawned
 * it and is never opened in a browser (the top-level session listings exclude it for exactly that
 * reason). Its presence is therefore a reliable, synchronous signal that there is no client.
 */
export const isHeadlessConversation = (conversation: any): boolean =>
  Boolean(conversation?.parentSessionId);

/**
 * True when the current turn has no browser that could execute a client-side tool.
 *
 * Two independent ways to be headless:
 *   - the conversation is a delegated sub-agent (see `isHeadlessConversation`), or
 *   - the turn is not being driven over an SSE stream, so there is no live channel to forward a
 *     tool call to (a CLI turn, an API turn, a background job, …).
 *
 * Either one is sufficient. The SSE check is deliberately about the *mode* rather than the live
 * transport: a client tool must only ever pause a turn that is actually streaming.
 */
export const isHeadlessTurn = (
  conversation: any,
  streamingMode?: string
): boolean => isHeadlessConversation(conversation) || streamingMode !== 'SSE';

/**
 * Tool-approval mode for a conversation that is about to be created.
 *
 * Only `AUTO` executes tool calls on the server. `PROMPT`, `PLAN` and `SAFE_AUTO` all
 * assume a browser is present to approve or run the call: the provider emits the
 * `tool_call` event and the turn ends there. A delegated sub-agent has no browser and
 * no human, so inheriting one of those modes turns a working delegation into a silent
 * no-op — the model's opening line is returned as the result and the caller is told the
 * delegation completed.
 *
 * Delegated (headless) sessions are therefore pinned to `AUTO`; interactive sessions
 * keep whatever was requested, falling back to the historical `PROMPT` default.
 */
export const resolveToolApprovalMode = (args: {
  parentSessionId?: string | null;
  requested?: ToolApprovalMode | string | null;
  interactiveDefault?: ToolApprovalMode;
}): ToolApprovalMode =>
  isHeadlessConversation({ parentSessionId: args.parentSessionId })
    ? ToolApprovalMode.AUTO
    : ((args.requested as ToolApprovalMode) || args.interactiveDefault || ToolApprovalMode.PROMPT);

/**
 * Split definitions into their server-runnable and browser-only halves, preserving order.
 */
export const partitionByScope = <T>(
  defs: T[] | undefined | null
): { server: T[]; client: T[] } => {
  const server: T[] = [];
  const client: T[] = [];
  for (const def of (defs || []) as T[]) {
    (isClientScoped(def) ? client : server).push(def);
  }
  return { server, client };
};

/**
 * The definitions a headless run is allowed to advertise: server-scoped only.
 *
 * Used when a delegated sub-agent session is created, so client tools are never offered to an
 * agent that has no way to run them.
 */
export const serverOnly = <T>(defs: T[] | undefined | null): T[] =>
  partitionByScope(defs).server;

/**
 * Return the tools with an explicit scope applied.
 *
 * A tool keeps its own `runat` when it declares one; otherwise it inherits the scope of the macro
 * that owns it. Tools not owned by any of the supplied macros are left untouched (they are
 * assumed to already carry the correct flag, or to be server-scoped by default).
 *
 * `macros` are matched to tools through the macro's own `tools` list, which is how the persona
 * registry declares them.
 */
export const inheritToolScopes = <T>(
  macros: any[] | undefined | null,
  tools: T[] | undefined | null
): T[] => {
  const scopeByToolName = new Map<string, ToolScope>();

  for (const macro of (macros || []) as any[]) {
    const scope = getToolScope(macro);
    for (const tool of (macro?.tools || []) as any[]) {
      const name = toolNameOf(tool);
      if (name && !scopeByToolName.has(name)) scopeByToolName.set(name, scope);
    }
  }

  return ((tools || []) as T[]).map((tool) => {
    if ((tool as any)?.runat) return tool; // explicit scope wins
    const name = toolNameOf(tool);
    const inherited = name ? scopeByToolName.get(name) : undefined;
    if (!inherited || inherited === TOOL_SCOPE_SERVER) return tool;
    return { ...(tool as any), runat: inherited } as unknown as T;
  });
};

export default getToolScope;
