/**
 * Read-only window parity check: Mongo `buildHistoryWindow` vs the Postgres
 * `ReactorConversationMessageService.getHistoryWindow`.
 *
 * Phase 3 step 3b. Cutting reads over to Postgres is only safe if, for a real
 * session, the two implementations return the same `{ items, window }`. This
 * script proves (or falsifies) that before any read path is repointed.
 *
 * It is deliberately falsifiable: it compares *both* implementations against the
 * same conversation and reports any divergence in the window metadata, the item
 * sequence, or the per-item identity — rather than asserting a property that
 * either implementation could satisfy on its own (e.g. "the newest row is
 * recent").
 *
 * It reports two distinct classes, because they have different owners:
 *
 *   window    — the two implementations disagree about which messages a window
 *               contains. This is a step-3b code defect and blocks the cutover.
 *   archived  — Mongo holds `truncatedHistory` items with no `archived` row in
 *               Postgres. This is a *backfill completeness* gap
 *               (`up --include-truncated`), not a window-selection defect.
 *
 * Read-only. Nothing is written to either database.
 *
 * Usage:
 *   TS_NODE_TRANSPILE_ONLY=true NODE_PATH=./ ./node_modules/.bin/env-cmd \
 *     --no-override -f ./.env node -r ts-node/register -r tsconfig-paths/register \
 *     src/modules/reactory-reactor/scripts/checkWindowParity.ts [options]
 *
 * Options:
 *   --conversation=<id>   check a specific conversation (repeatable)
 *   --scan=<n>            conversations to auto-select, oldest first (default 3)
 *   --verbose             print every option-set result, not just divergences
 *   --window-only         ignore the archived-completeness class
 */
import "reflect-metadata";
import mongoose from "mongoose";
import { DataSource } from "typeorm";
import ReactorConversationMessage from "../models/ReactorConversationMessage";
import ReactorConversationMessageService from "../services/reactor/ReactorConversationMessageService";
import ReactorConversationService from "../services/reactor/ReactorConversationService";
import { resolveMongoUri, resolvePgConfig, CONVERSATIONS_COLLECTION } from "./lib/instanceProbe";

const MONGODB_URI = resolveMongoUri();

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const WINDOW_ONLY = args.includes("--window-only");
const SCAN = Number(
  args.find((a) => a.startsWith("--scan="))?.split("=")[1] || 3
);
const EXPLICIT = args
  .filter((a) => a.startsWith("--conversation="))
  .map((a) => a.split("=")[1])
  .filter(Boolean);

/** The live session is written to continuously; skip it like `reconcile` does. */
const ACTIVE_WINDOW_MS = 120_000;

const createDataSource = (): DataSource => {
  const pg = resolvePgConfig();
  return new DataSource({
    type: "postgres",
    host: pg.host,
    port: pg.port,
    username: pg.user,
    password: pg.password,
    database: pg.database,
    synchronize: false,
    entities: [ReactorConversationMessage],
  });
};

const proto: any = (ReactorConversationService as any).prototype;

/** Run the Mongo implementation over an in-memory history array. */
const mongoWindow = (
  history: any[],
  options: { historyLimit?: number; before?: string; includeSystem?: boolean }
) =>
  proto.buildHistoryWindow.call(
    { historyItemId: proto.historyItemId },
    history,
    options
  ) as {
    items: any[];
    window: {
      total: number;
      returned: number;
      hasMoreBefore: boolean;
      oldestId: string | null;
      newestId: string | null;
    };
  };

const idOf = (item: any): string | null => {
  const raw = item?._id ?? item?.id;
  return raw ? String(raw) : null;
};

const identity = (items: any[]): string =>
  items.map((i) => `${i?.role ?? "?"}:${idOf(i) ?? "-"}`).join("|");

type DivergenceKind = "window" | "archived";

interface Divergence {
  kind: DivergenceKind;
  option: string;
  detail: string;
}

const compareWindows = (
  label: string,
  history: any[],
  sql: { items: any[]; window: any },
  options: { historyLimit?: number; before?: string; includeSystem?: boolean }
): Divergence[] => {
  const mongo = mongoWindow(history, options);
  const out: Divergence[] = [];

  const mw = mongo.window;
  const sw = sql.window;

  // Guard against a comparison that exercised nothing: both sides empty on a
  // cursor-less read of a conversation that has history. Scoped to cursor-less
  // reads deliberately — a `before` cursor pointing at the oldest item yields an
  // empty page on both sides by design, and both agreeing on that IS the result.
  // Only a conversation with at least one NON-SYSTEM item can prove anything:
  // a session holding only its system prompt legitimately yields an empty window
  // when `includeSystem` is false, and that agreement IS the result.
  const nonSystemCount = history.filter(
    (h: any) => h?.role && h.role !== "system"
  ).length;
  if (
    !options.before &&
    nonSystemCount > 0 &&
    mongo.items.length === 0 &&
    sql.items.length === 0
  ) {
    out.push({
      kind: "window",
      option: label,
      detail: `TRIVIAL: both windows empty for a conversation with ${nonSystemCount} non-system item(s) of ${history.length}`,
    });
    return out;
  }

  const windowKeys = [
    "total",
    "returned",
    "hasMoreBefore",
    "oldestId",
    "newestId",
  ] as const;
  for (const key of windowKeys) {
    if (mw[key] !== sw[key]) {
      out.push({
        kind: "window",
        option: label,
        detail: `window.${key}: mongo=${JSON.stringify(mw[key])} sql=${JSON.stringify(sw[key])}`,
      });
    }
  }

  if (mongo.items.length !== sql.items.length) {
    out.push({
      kind: "window",
      option: label,
      detail: `item count: mongo=${mongo.items.length} sql=${sql.items.length}`,
    });
  }

  const mIdent = identity(mongo.items);
  const sIdent = identity(sql.items);
  if (mIdent !== sIdent) {
    const m = mIdent.split("|");
    const s = sIdent.split("|");
    let firstDiff = -1;
    for (let i = 0; i < Math.max(m.length, s.length); i += 1) {
      if (m[i] !== s[i]) {
        firstDiff = i;
        break;
      }
    }
    out.push({
      kind: "window",
      option: label,
      detail: `item sequence differs at index ${firstDiff}: mongo="${m[firstDiff]}" sql="${s[firstDiff]}"`,
    });
  }

  if (VERBOSE && out.length === 0) {
    console.log(
      `      ✓ ${label.padEnd(46)} returned=${mw.returned} total=${mw.total} hasMoreBefore=${mw.hasMoreBefore}`
    );
  }

  return out;
};

const checkConversation = async (
  dataSource: DataSource,
  messageService: ReactorConversationMessageService,
  convo: any
): Promise<{ divergences: Divergence[]; checks: number }> => {
  const id = String(convo._id);
  const history: any[] = Array.isArray(convo.history) ? convo.history : [];
  const divergences: Divergence[] = [];
  let checks = 0;

  const run = async (
    label: string,
    sqlOptions: { limit?: number; before?: string; includeSystem?: boolean },
    mongoOptions: {
      historyLimit?: number;
      before?: string;
      includeSystem?: boolean;
    }
  ) => {
    const sql = await messageService.getHistoryWindow(id, sqlOptions);
    checks += 1;
    divergences.push(...compareWindows(label, history, sql, mongoOptions));
  };

  await run(
    "default (system + 100)",
    { includeSystem: true },
    { includeSystem: true }
  );
  await run("no system, 100", { includeSystem: false }, { includeSystem: false });
  await run(
    "system, limit 10",
    { includeSystem: true, limit: 10 },
    { includeSystem: true, historyLimit: 10 }
  );
  await run(
    "no system, limit 2",
    { includeSystem: false, limit: 2 },
    { includeSystem: false, historyLimit: 2 }
  );
  await run(
    "no system, limit 500",
    { includeSystem: false, limit: 500 },
    { includeSystem: false, historyLimit: 500 }
  );
  await run(
    "bad limit 0 -> default",
    { includeSystem: false, limit: 0 },
    { includeSystem: false, historyLimit: 0 }
  );
  await run(
    "bad limit -5 -> default",
    { includeSystem: false, limit: -5 },
    { includeSystem: false, historyLimit: -5 }
  );
  await run(
    "unknown cursor ignored",
    { includeSystem: false, before: "ffffffffffffffffffffffff" },
    { includeSystem: false, before: "ffffffffffffffffffffffff" }
  );

  // Paging parity: take the oldest id of the default window and page from it.
  const base = mongoWindow(history, { includeSystem: true });
  const cursor = base.window.oldestId;
  if (cursor) {
    await run(
      `page before oldestId, limit 10`,
      { includeSystem: false, before: cursor, limit: 10 },
      { includeSystem: false, before: cursor, historyLimit: 10 }
    );
    await run(
      `page before oldestId, default`,
      { includeSystem: false, before: cursor },
      { includeSystem: false, before: cursor }
    );
  }

  // Archived completeness: Mongo keeps displaced items in `truncatedHistory`.
  // Missing rows here are a backfill gap, not a window-selection defect.
  if (!WINDOW_ONLY) {
    const truncated: any[] = Array.isArray(convo.truncatedHistory)
      ? convo.truncatedHistory
      : [];
    if (truncated.length > 0) {
      // Read the full archived set directly rather than through
      // `getArchivedMessages`, which is deliberately capped at
      // MESSAGE_WINDOW.MAX_LIMIT (500) and would report a false shortfall on
      // larger transcripts. This check is about data completeness, so it must
      // not inherit a presentation bound.
      const rows: Array<{ mongo_id: string | null }> = await dataSource.query(
        "SELECT mongo_id FROM reactor_conversation_messages WHERE conversation_id = $1 AND archived = true",
        [id]
      );
      checks += 1;
      const mongoIds = truncated
        .map((t: any) => String(t._id ?? t.id ?? ""))
        .filter(Boolean)
        .sort();
      const sqlIds = rows
        .map((r) => (r.mongo_id ? String(r.mongo_id) : ""))
        .filter(Boolean)
        .sort();
      if (JSON.stringify(mongoIds) !== JSON.stringify(sqlIds)) {
        divergences.push({
          kind: "archived",
          option: "archived rows",
          detail: `mongo truncatedHistory=${mongoIds.length} sql archived=${sqlIds.length}`,
        });
      } else if (VERBOSE) {
        console.log(
          `      ✓ archived rows${" ".repeat(31)} matched=${sqlIds.length}`
        );
      }
    }
  }

  return { divergences, checks };
};

const run = async () => {
  console.log("──────────────────────────────────────────────────────────");
  console.log(" Window parity: Mongo buildHistoryWindow vs Postgres rows");
  console.log(" Phase 3 step 3b — READ ONLY (nothing is written)");
  console.log("──────────────────────────────────────────────────────────");

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const collection = mongoose.connection.db.collection("reactor_conversations");
  console.log("Connected to MongoDB.");

  const dataSource = createDataSource();
  await dataSource.initialize();
  const messageService = new ReactorConversationMessageService(dataSource);
  console.log("Connected to PostgreSQL.");
  console.log("");

  let candidates: any[] = [];
  if (EXPLICIT.length > 0) {
    for (const raw of EXPLICIT) {
      const doc = await collection.findOne({
        _id: new mongoose.Types.ObjectId(raw),
      });
      if (!doc) {
        console.log(`  ! conversation ${raw} not found`);
        continue;
      }
      candidates.push(doc);
    }
  } else {
    candidates = await collection
      .find({
        "history.0": { $exists: true },
        parentSessionId: { $in: [null, undefined] },
      })
      .sort({ updated: 1 })
      .limit(SCAN)
      .toArray();
  }

  const settled = candidates.filter((doc: any) => {
    const updated = doc.updated ? new Date(doc.updated).getTime() : 0;
    return Date.now() - updated > ACTIVE_WINDOW_MS;
  });

  if (settled.length === 0) {
    console.log(
      "No settled conversations selected (all candidates written within 120s)."
    );
  }

  let totalChecks = 0;
  let windowDivergences = 0;
  let archivedDivergences = 0;

  for (const doc of settled) {
    const id = String(doc._id);
    const historyLength = Array.isArray(doc.history) ? doc.history.length : 0;
    const truncatedLength = Array.isArray(doc.truncatedHistory)
      ? doc.truncatedHistory.length
      : 0;
    console.log(
      `▶ ${id}  history=${historyLength}  truncated=${truncatedLength}`
    );

    const { divergences, checks } = await checkConversation(
      dataSource,
      messageService,
      doc
    );
    totalChecks += checks;

    const w = divergences.filter((d) => d.kind === "window");
    const a = divergences.filter((d) => d.kind === "archived");
    windowDivergences += w.length;
    archivedDivergences += a.length;

    if (w.length === 0) {
      console.log(`  ✓ window parity across ${checks} option sets`);
    } else {
      for (const d of w) console.log(`  ✗ [window] [${d.option}] ${d.detail}`);
    }
    for (const d of a) {
      console.log(`  ⚠ [archived-data] [${d.option}] ${d.detail}`);
    }
    console.log("");
  }

  console.log("──────────────────────────────────────────────────────────");
  console.log(`Conversations checked     : ${settled.length}`);
  console.log(`Option sets compared      : ${totalChecks}`);
  console.log(`Window divergences        : ${windowDivergences}`);
  console.log(`Archived-data gaps        : ${archivedDivergences}`);
  console.log("──────────────────────────────────────────────────────────");

  // After step 2 the embedded arrays are retired, so an array-based comparison has no subject.
  // Without this the harness reports PASS while examining nothing. It must run BEFORE the teardown,
  // because the teardown is what makes the query impossible.
  {
    const docsWithArrays = await mongoose.connection
      .collection(CONVERSATIONS_COLLECTION)
      .countDocuments({ "history.0": { $exists: true } });
    if (docsWithArrays === 0) {
      console.log("");
      console.log("NOT APPLICABLE — no conversation carries an embedded history array.");
      console.log("  This harness compares the Mongo array against the message store, so with the");
      console.log("  arrays retired it has nothing to compare. Expected after step 2.");
      console.log("  This run is NOT evidence that the migration is correct.");
      await dataSource.destroy();
      await mongoose.disconnect();
      process.exit(0);
    }
  }

  await dataSource.destroy();
  await mongoose.disconnect();

  if (windowDivergences > 0) {
    console.log("❌ Window parity FAILED — do not cut reads over.");
    process.exit(1);
  }
  if (archivedDivergences > 0) {
    console.log(
      "⚠️  Window parity holds. Archived rows are incomplete in Postgres — run" +
        " `up --include-truncated` before surfacing archived messages."
    );
    process.exit(4);
  }
  console.log("✅ Window parity holds: Mongo and Postgres windows are identical.");
  process.exit(0);
};

run().catch(async (error) => {
  console.error("Parity check failed to run:", error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
