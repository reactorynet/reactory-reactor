import { describe, it, expect } from "@jest/globals";
import {
  buildVarsUpdate,
  snapshotVars,
  hasVarsChanges,
  changedVarsKeys,
  applyChangedKeys,
} from "../sessionVars";

/**
 * The `vars` delta policy.
 *
 * `executeMacro` used to `$set` the WHOLE `vars` object from a snapshot taken before the
 * tool ran. Anything written to `vars` by another writer during the call was destroyed —
 * which is how the async delegation record lost its identifying fields and `followup` by
 * delegationId broke. These tests pin the replacement: write only what changed, never
 * touch keys the call never saw, and still support deletion.
 */
describe("sessionVars / buildVarsUpdate", () => {
  describe("snapshotVars", () => {
    it("deep-clones so later mutation of the source cannot affect the snapshot", () => {
      const source: any = { a: 1, nested: { list: [1, 2] } };
      const snap = snapshotVars(source);
      source.nested.list.push(3);
      source.a = 99;
      expect(snap).toEqual({ a: 1, nested: { list: [1, 2] } });
    });

    it("coerces null/undefined/non-objects to an empty object", () => {
      expect(snapshotVars(undefined)).toEqual({});
      expect(snapshotVars(null)).toEqual({});
      expect(snapshotVars("nope")).toEqual({});
      expect(snapshotVars(42)).toEqual({});
    });

    it("does not accept an array as vars", () => {
      expect(snapshotVars([1, 2, 3])).toEqual({});
    });
  });

  describe("the reported bug", () => {
    it("does NOT touch a key written out-of-band during the call (delegation record)", () => {
      // The turn loaded `vars` WITHOUT the delegation record; the record was written
      // directly to the DB by the `speakto` macro; the macro then mutated an unrelated
      // key. The delta must not reference `subagent_delegations` at all.
      const before = { myVar: "a" };
      const after = { myVar: "b" };

      const update = buildVarsUpdate(before, after);

      expect(update.$set).toEqual({ "vars.myVar": "b" });
      expect(update.$unset).toBeUndefined();
      expect(JSON.stringify(update)).not.toContain("subagent_delegations");
    });

    it("produces an empty update when nothing changed, so no vars write happens", () => {
      const update = buildVarsUpdate({ a: 1 }, { a: 1 });
      expect(hasVarsChanges(update)).toBe(false);
      expect(update.$set).toBeUndefined();
      expect(update.$unset).toBeUndefined();
    });
  });

  describe("additions, changes and deletions", () => {
    it("$sets a newly added key", () => {
      const update = buildVarsUpdate({}, { todo: { items: [] } });
      expect(update.$set).toEqual({ "vars.todo": { items: [] } });
    });

    it("$sets a changed key", () => {
      const update = buildVarsUpdate({ n: 1 }, { n: 2 });
      expect(update.$set).toEqual({ "vars.n": 2 });
    });

    it("$unsets a removed key (so `var` delete still works)", () => {
      const update = buildVarsUpdate({ keep: 1, dropMe: "x" }, { keep: 1 });
      expect(update.$unset).toEqual({ "vars.dropMe": "" });
      expect(update.$set).toBeUndefined();
    });

    it("handles add + change + delete in one pass, with disjoint operators", () => {
      const update = buildVarsUpdate(
        { keep: 1, change: "old", drop: true },
        { keep: 1, change: "new", added: 5 }
      );

      expect(update.$set).toEqual({ "vars.change": "new", "vars.added": 5 });
      expect(update.$unset).toEqual({ "vars.drop": "" });

      // Mongo rejects a path in both operators — guard against that regression.
      const setPaths = Object.keys(update.$set || {});
      const unsetPaths = Object.keys(update.$unset || {});
      expect(setPaths.some((p) => unsetPaths.includes(p))).toBe(false);
    });

    it("detects nested changes (todo list mutation)", () => {
      const before = { TodoList: { items: [{ id: "1", done: false }] } };
      const after = { TodoList: { items: [{ id: "1", done: true }] } };
      const update = buildVarsUpdate(before, after);
      expect(update.$set).toEqual({ "vars.TodoList": after.TodoList });
    });
  });

  describe("dotted keys (todo / namespaced vars)", () => {
    it("requests a merge only when a dotted key actually CHANGED", () => {
      const update = buildVarsUpdate({ "reactor.todos": { a: 1 } }, { "reactor.todos": { a: 2 } });

      expect(update.requiresMerge).toBe(true);
      expect(update.changedKeys).toEqual(["reactor.todos"]);
      // No operators: `$set vars.reactor.todos` would create NESTED fields, not the
      // literal top-level key the todo macro uses.
      expect(update.$set).toBeUndefined();
      expect(update.$unset).toBeUndefined();
      expect(hasVarsChanges(update)).toBe(true);
    });

    it("does NOT request a merge for an unchanged dotted key (regression)", () => {
      // `reactor.todos` is present on nearly every conversation that has used the todo
      // tool. An earlier version treated mere PRESENCE as a reason to whole-replace, which
      // reinstated the clobber bug on almost every conversation. Presence is not change.
      const before = { "reactor.todos": { a: 1 }, subagent_chat_x: "old" };
      const after = { "reactor.todos": { a: 1 }, subagent_chat_x: "new" };

      const update = buildVarsUpdate(before, after);

      expect(update.requiresMerge).toBe(false);
      expect(update.changedKeys).toEqual(["subagent_chat_x"]);
      expect(update.$set).toEqual({ "vars.subagent_chat_x": "new" });
    });
  });

  describe("changedVarsKeys", () => {
    it("reports only added/removed/modified keys", () => {
      expect(changedVarsKeys({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }).sort()).toEqual(["b", "c"]);
      expect(changedVarsKeys({ a: 1, b: 2 }, { a: 1 })).toEqual(["b"]);
      expect(changedVarsKeys({}, {})).toEqual([]);
    });
  });

  describe("applyChangedKeys (the merge path)", () => {
    it("preserves keys in `current` that the call never changed", () => {
      // The out-of-band delegation record lives in `current` only — the in-memory doc has
      // no idea it exists. The merge must keep it.
      const current = {
        "reactor.todos": { a: 1 },
        subagent_delegations: { "del-1": { status: "dispatched", personaId: "daan" } },
        keep: "x",
      };
      const desired = { "reactor.todos": { a: 2 }, keep: "x" };

      const merged = applyChangedKeys(current, desired, ["reactor.todos"]);

      expect(merged["reactor.todos"]).toEqual({ a: 2 });
      expect(merged.subagent_delegations).toEqual({ "del-1": { status: "dispatched", personaId: "daan" } });
      expect(merged.keep).toBe("x");
    });

    it("applies a deletion for keys the call actually removed, and does not resurrect them", () => {
      const merged = applyChangedKeys({ a: 1, b: 2 }, { b: 2 }, ["a"]);
      expect(merged).toEqual({ b: 2 });
      expect(Object.prototype.hasOwnProperty.call(merged, "a")).toBe(false);
    });
  });
});
