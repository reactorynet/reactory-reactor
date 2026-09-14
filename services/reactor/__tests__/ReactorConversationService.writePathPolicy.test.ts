import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import ReactorConversationModel, {
  stripEmbeddedHistoryAppends,
  normaliseStrippedUpdate,
  stripEmbeddedHistoryFromSave,
  isMessageStoreAuthoritative,
} from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";

/**
 * Phase 3c step 1 — the written-down half of the write-path policy.
 *
 * The policy exists because `$unset history` is not durable while the array is still appended to
 * (§43.4): the pilot removed the field and the next turn's `$push` put it back. What is asserted
 * here is therefore narrow and deliberate:
 *
 *  - **appends** to `history` / `truncatedHistory` are removed from the update;
 *  - `$push: { "history.$.tool_results": … }` is **not** removed — it backfills a sub-array of an
 *    existing message and is never a new row, so a subtree-wise rule would silently break the two
 *    tool-result backfill sites;
 *  - whole-array rewrites are *reported*, not stripped, because truncate/compact have no
 *    message-store counterpart yet (§46 step 1b);
 *  - an update left empty by stripping is still a valid update;
 *  - the `save()` policy clears the arrays from the modified set, and exempts new documents (the
 *    ephemeral compaction-summary conversation is read back through its Mongo array);
 *  - and the hooks are **actually attached to the schema**, which is the one failure that would
 *    leave every assertion above passing while the write path quietly kept writing Mongo.
 */

const ENV_KEYS = ["REACTOR_MESSAGES_SOURCE", "REACTOR_MESSAGE_SOURCE"] as const;
const ORIGINAL: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ORIGINAL[key] = process.env[key];

const clearSourceEnv = () => {
  for (const key of ENV_KEYS) delete process.env[key];
};

// bin/jest.sh copies config/<client>/.env.<env> into ./.env, so the deployment's
// REACTOR_MESSAGE_SOURCE=postgres is present in the test process. Start from a clean slate.
beforeEach(clearSourceEnv);

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

const noReplacements = () => {
  const seen: string[] = [];
  return { seen, report: (path: string) => seen.push(path) };
};

describe("write-path policy — appends are stripped", () => {
  it("removes $push.history", () => {
    const update: any = {
      $push: { history: { id: "a", role: "user" } },
      $set: { updated: new Date() },
    };
    const report = noReplacements();

    const removed = stripEmbeddedHistoryAppends(update, report.report);

    expect(removed).toEqual(["$push.history"]);
    expect(update.$push.history).toBeUndefined();
    expect(update.$set.updated).toBeInstanceOf(Date);
    expect(report.seen).toEqual([]);
  });

  it("removes $push.truncatedHistory", () => {
    const update: any = { $push: { truncatedHistory: { role: "user" } } };
    const report = noReplacements();

    expect(stripEmbeddedHistoryAppends(update, report.report)).toEqual(["$push.truncatedHistory"]);
    expect(update.$push.truncatedHistory).toBeUndefined();
  });

  it("removes $addToSet.history", () => {
    const update: any = { $addToSet: { history: { role: "user" } } };
    const report = noReplacements();

    expect(stripEmbeddedHistoryAppends(update, report.report)).toEqual(["$addToSet.history"]);
    expect((update.$addToSet as any).history).toBeUndefined();
  });

  it("leaves the sibling `files` push alone when a file message is appended", () => {
    // The real payload: $push: { history: fileMessage, files: { $each: fileIds } }
    const update: any = {
      $push: { history: { role: "user" }, files: { $each: ["file-1"] } },
      $set: { updated: new Date() },
    };
    const report = noReplacements();

    expect(stripEmbeddedHistoryAppends(update, report.report)).toEqual(["$push.history"]);
    expect(update.$push.files).toEqual({ $each: ["file-1"] });
  });

  it("does NOT remove a positional sub-array backfill (history.$.tool_results)", () => {
    // This is the regression guard for the §45.3 finding: the key is not named `history`, so it
    // must survive. Removing it would silently stop tool results being backfilled onto the
    // assistant message that requested them.
    const update: any = {
      $push: { "history.$.tool_results": { id: "call-1", content: "ok" } },
    };
    const report = noReplacements();

    const removed = stripEmbeddedHistoryAppends(update, report.report);

    expect(removed).toEqual([]);
    expect(update.$push["history.$.tool_results"]).toEqual({ id: "call-1", content: "ok" });
    expect(report.seen).toEqual([]);
  });
});

describe("write-path policy — whole-array rewrites are reported, not stripped", () => {
  it("reports a bare array replacement and keeps it", () => {
    const update: any = { history: [{ role: "system" }], tokenCount: 12 };
    const report = noReplacements();

    const removed = stripEmbeddedHistoryAppends(update, report.report);

    expect(removed).toEqual([]);
    expect(report.seen).toEqual(["history"]);
    expect(update.history).toEqual([{ role: "system" }]);
    expect(update.tokenCount).toBe(12);
  });

  it("reports $set.truncatedHistory and keeps it", () => {
    const update: any = { $set: { truncatedHistory: [{ role: "user" }] } };
    const report = noReplacements();

    const removed = stripEmbeddedHistoryAppends(update, report.report);

    expect(removed).toEqual([]);
    expect(report.seen).toEqual(["$set.truncatedHistory"]);
    expect(update.$set.truncatedHistory).toEqual([{ role: "user" }]);
  });
});

describe("write-path policy — empty updates stay valid", () => {
  it("turns a stripped-to-nothing update into a harmless $set", () => {
    // A site whose update was only a history push would otherwise throw: MongoDB rejects both an
    // empty update document and an empty `$set`.
    const update: any = { $push: { history: { role: "assistant" } } };
    const report = noReplacements();

    stripEmbeddedHistoryAppends(update, report.report);
    normaliseStrippedUpdate(update);

    expect(update.$push).toBeUndefined();
    expect(Object.keys(update)).toEqual(["$set"]);
    expect(update.$set.updated).toBeInstanceOf(Date);
  });

  it("does not touch an update that still has content", () => {
    const update: any = { $push: { history: {} }, $set: { updated: new Date() } };
    const report = noReplacements();

    stripEmbeddedHistoryAppends(update, report.report);
    normaliseStrippedUpdate(update);

    expect(update.$set).toBeDefined();
    expect(update.$set.updated).toBeInstanceOf(Date);
  });
});

describe("write-path policy — save() strips the arrays from the modified set", () => {
  const fakeDoc = (isNew: boolean, modified: string[]) => {
    const unmarked: string[] = [];
    return {
      doc: {
        isNew,
        modifiedPaths: () => modified,
        unmarkModified: (path: string) => unmarked.push(path),
      },
      unmarked,
    };
  };

  it("unmarks the arrays (and their prefixes) on an existing document", () => {
    const { doc, unmarked } = fakeDoc(false, ["history", "truncatedHistory", "updated"]);

    const cleared = stripEmbeddedHistoryFromSave(doc);

    expect(cleared).toEqual(["history", "truncatedHistory"]);
    expect(unmarked).toContain("history");
    expect(unmarked).toContain("truncatedHistory");
    expect(unmarked).not.toContain("updated");
  });

  it("clears a sub-path mutation of an existing document", () => {
    const { doc, unmarked } = fakeDoc(false, ["history.0.tool_calls"]);

    expect(stripEmbeddedHistoryFromSave(doc)).toEqual(["history.0.tool_calls"]);
    expect(unmarked).toContain("history.0.tool_calls");
  });

  it("exempts a NEW document", () => {
    // A brand-new conversation is created with its system prompt deliberately, and the ephemeral
    // compaction-summary conversation is read back through its Mongo array (it has no rows in the
    // store). Stripping a new document would empty the model's context for that call.
    const { doc, unmarked } = fakeDoc(true, ["history"]);

    expect(stripEmbeddedHistoryFromSave(doc)).toEqual([]);
    expect(unmarked).toEqual([]);
  });

  it("does nothing when neither array is modified", () => {
    const { doc, unmarked } = fakeDoc(false, ["updated", "tokenCount"]);

    expect(stripEmbeddedHistoryFromSave(doc)).toEqual([]);
    expect(unmarked).toEqual([]);
  });
});

describe("write-path policy — source resolution", () => {
  it("is inactive when no flag is set (the pre-cutover default)", () => {
    expect(isMessageStoreAuthoritative()).toBe(false);
  });

  it("is inactive for any value other than postgres", () => {
    process.env.REACTOR_MESSAGE_SOURCE = "mongo";
    expect(isMessageStoreAuthoritative()).toBe(false);
  });

  it("is active when the flag resolves to postgres", () => {
    process.env.REACTOR_MESSAGE_SOURCE = "postgres";
    expect(isMessageStoreAuthoritative()).toBe(true);
  });
});

describe("write-path policy — the hooks are really attached", () => {
  // Without this, every assertion above could pass while the write path kept writing Mongo: a
  // hook that is never registered fails by doing nothing. This is the falsifiable control.
  const pres = (ReactorConversationModel as any)?.schema?.s?.hooks?._pres;

  it("registers the findOneAndUpdate pre hook", () => {
    expect(pres).toBeDefined();
    expect(Array.from(pres.keys())).toContain("findOneAndUpdate");
    expect(pres.get("findOneAndUpdate").length).toBeGreaterThan(0);
  });

  it("registers the save pre hook", () => {
    expect(Array.from(pres.keys())).toContain("save");
    expect(pres.get("save").length).toBeGreaterThan(0);
  });
});
