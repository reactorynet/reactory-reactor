/**
 * Session `vars` persistence — delta computation.
 *
 * WHY THIS EXISTS
 * ---------------
 * `executeMacro` persists a conversation's `vars` after every tool call, because macros
 * mutate them in memory: the macro receives the conversation document AS its `ChatState`,
 * so `state.vars` and `conversation.vars` are the same object (todo lists, the `var`
 * macro, and so on all write into it).
 *
 * That persistence used to write the WHOLE object back:
 *
 *     $set: { vars: <in-memory snapshot> }
 *
 * The snapshot is taken when the conversation is loaded at the start of the tool call.
 * Anything written to `vars` by someone ELSE — between that load and this write — is
 * therefore silently destroyed.
 *
 * The async sub-agent delegation is precisely that case. `chats` action `speakto` with
 * `async=true` writes `vars.subagent_delegations.<id>` directly to the database (it does
 * not touch the in-memory document). The very next whole-`vars` write from the same turn
 * wiped it, and the background runner's leaf-level `$set`s
 * (`...status`, `...response`, `...completedAt`) then recreated the sub-document with
 * only those three fields. The record lost `personaId`, `agentName`, `subagentSessionId`,
 * `parentSessionId`, `message` and `startedAt` — which is why `followup` by delegationId
 * had nothing to resolve against.
 *
 * THE FIX
 * -------
 * Write only the DELTA — the keys this call actually changed — so unrelated keys are
 * never touched. Deletion still works, because a key present before and absent now is
 * exactly a deletion, and becomes an `$unset` (the `var` macro supports
 * `value: "del"`, so this is load-bearing).
 *
 * THE DOTTED-KEY PROBLEM
 * ----------------------
 * A key containing `.` cannot be addressed as a leaf path: `$set: { 'vars.reactor.todos': X }`
 * creates NESTED `vars.reactor.todos`, not the literal top-level key `vars['reactor.todos']`
 * that `todoMacro` (`TODOS_VAR_PREFIX = 'reactor.todos'`) and the `var` macro actually use.
 * Such a key therefore needs a whole-object write — but a whole-object write is exactly the
 * clobber this module exists to prevent, so it is used only when genuinely unavoidable:
 * when a dotted key *actually changed*.
 *
 * That distinction is the whole point, and an early version got it wrong. It fell back to a
 * whole-object write whenever a dotted key was merely PRESENT, which fired on every
 * conversation that had ever used the todo tool and silently reinstated the original bug.
 * Presence is not change.
 *
 * When a dotted key changes, the caller performs a read-merge-write: re-read the current
 * `vars` from the database and apply only the changed keys on top (`applyChangedKeys`), so
 * any out-of-band write that landed before the merge is preserved.
 *
 * Kept pure so the policy can be asserted without a database.
 */

/** How to persist a `vars` change. */
export interface IVarsUpdate {
  /** Dotted-key `$set` (e.g. `{ 'vars.myKey': value }`). */
  $set?: Record<string, unknown>;
  /** Dotted-key `$unset` (e.g. `{ 'vars.myKey': '' }`). */
  $unset?: Record<string, unknown>;
  /**
   * Names of the top-level `vars` keys this call changed (added, removed or modified).
   * Only populated on the merge path; used to apply the change onto a fresh document.
   */
  changedKeys: string[];
  /**
   * True when the change cannot be expressed as dotted `$set`/`$unset` — because a changed
   * key contains a `.` — so the caller must read the current `vars` and merge.
   */
  requiresMerge: boolean;
}

/**
 * Deep clone a `vars` object into a plain POJO.
 *
 * A JSON round-trip strips any Mongoose Mixed-type internal wrappers and yields something
 * that BSON serialises correctly, including nested arrays such as `TodoList.items[]`.
 * Anything non-serialisable (or a cycle) degrades to `{}` rather than throwing.
 */
export const snapshotVars = (vars: unknown): Record<string, any> => {
  if (vars === null || vars === undefined) return {};
  if (typeof vars !== 'object') return {};
  try {
    const cloned = JSON.parse(JSON.stringify(vars));
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : {};
  } catch {
    return {};
  }
};

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const hasOwn = (obj: any, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj || {}, key);

/**
 * The keys whose value (or presence) differs between `before` and `after`.
 * A key absent from both is never reported, so another writer's keys are never touched.
 */
export const changedVarsKeys = (before: unknown, after: unknown): string[] => {
  const b = snapshotVars(before);
  const a = snapshotVars(after);
  const keys = new Set<string>([...Object.keys(b), ...Object.keys(a)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (hasOwn(b, key) !== hasOwn(a, key) || !sameValue(b[key], a[key])) changed.push(key);
  }
  return changed;
};

/**
 * Compute how to move `vars` from `before` to `after`.
 *
 * - no changed key              -> empty delta
 * - changed keys, none dotted   -> dotted `$set`/`$unset` (no unrelated key is touched)
 * - a CHANGED key is dotted     -> `requiresMerge`; `$set`/`$unset` are left unset and the
 *                                  caller applies `changedKeys` on top of a fresh read
 *
 * A dotted key that is merely present (unchanged) never forces a merge — see the module
 * docblock for why that distinction caused a production regression.
 */
export const buildVarsUpdate = (before: unknown, after: unknown): IVarsUpdate => {
  const changedKeys = changedVarsKeys(before, after);

  if (changedKeys.some((key) => key.includes('.'))) {
    return { changedKeys, requiresMerge: true };
  }

  const a = snapshotVars(after);
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, unknown> = {};

  for (const key of changedKeys) {
    if (hasOwn(a, key)) {
      $set[`vars.${key}`] = a[key];
    } else {
      $unset[`vars.${key}`] = '';
    }
  }

  const update: IVarsUpdate = { changedKeys, requiresMerge: false };
  if (Object.keys($set).length > 0) update.$set = $set;
  if (Object.keys($unset).length > 0) update.$unset = $unset;
  return update;
};

/**
 * Apply `changedKeys` from `desired` on top of `current`, preserving everything else in
 * `current`. Used on the merge path: `current` is re-read from the database at write time,
 * so an out-of-band write made during the tool call survives.
 */
export const applyChangedKeys = (
  current: unknown,
  desired: unknown,
  changedKeys: string[]
): Record<string, any> => {
  const merged = snapshotVars(current);
  const want = snapshotVars(desired);
  for (const key of changedKeys) {
    if (hasOwn(want, key)) merged[key] = want[key];
    else delete merged[key];
  }
  return merged;
};

/** True when the update would change anything. */
export const hasVarsChanges = (update: IVarsUpdate): boolean =>
  update.requiresMerge
    ? update.changedKeys.length > 0
    : Boolean(
        (update.$set && Object.keys(update.$set).length > 0) ||
          (update.$unset && Object.keys(update.$unset).length > 0)
      );

export default buildVarsUpdate;
