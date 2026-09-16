/**
 * Mirror completeness: every Mongo `history` item must have a Postgres row.
 *
 * This is the assertion whose absence allowed the assistant-reply mirror bug to
 * survive a full phase of verification. The window/search parity harnesses both
 * skip recently-written conversations (`checkWindowParity` deliberately skips
 * anything written within 120 s), so a missing *append* site was invisible to
 * them: they only ever sampled settled, already-backfilled conversations.
 *
 * The check is deliberately wider than the others:
 *
 *  - it covers ALL conversations, including ones written seconds ago;
 *  - it compares per item, not per window, so it cannot be masked by the
 *    user-anchoring / capping behaviour of the windowed read;
 *  - it splits the gap by *when the message was written*, relative to a
 *    supplied deploy boundary, so "still broken" and "broken historically"
 *    are never confused. A missing message written before the fix shipped is a
 *    REPAIR target; one written after is a REGRESSION.
 *
 * Read-only. Nothing is written.
 *
 * Usage:
 *   TS_NODE_TRANSPILE_ONLY=true NODE_PATH=./ ./node_modules/.bin/env-cmd \
 *     --no-override -f ./.env node -r ts-node/register -r tsconfig-paths/register \
 *     src/modules/reactory-reactor/scripts/checkMirrorCompleteness.ts \
 *     [--since=<iso>] [--verbose]
 *
 * Options:
 *   --since=<iso>   ISO timestamp; missing messages written at/after it FAIL the
 *                   run. Omit for a pure report (always exit 0).
 *   --verbose       list each missing message (id, role, timestamp).
 */
import "reflect-metadata";
import mongoose from "mongoose";
import { DataSource } from "typeorm";
import ReactorConversationMessage from "../models/ReactorConversationMessage";
import { resolveMongoUri, resolvePgConfig, CONVERSATIONS_COLLECTION } from "./lib/instanceProbe";

const MONGODB_URI = resolveMongoUri();

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const SINCE_RAW = args.find((a) => a.startsWith("--since="))?.split("=")[1];
const SINCE = SINCE_RAW ? new Date(SINCE_RAW) : null;
if (SINCE_RAW && Number.isNaN(SINCE!.getTime())) {
  console.error(`--since must be an ISO timestamp, got: ${SINCE_RAW}`);
  process.exit(2);
}

const idOf = (item: any): string | null => {
  const raw = item?._id ?? item?.id;
  return raw ? String(raw) : null;
};

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

interface Missing {
  conversationId: string;
  mongoId: string;
  role: string;
  ts: Date | null;
}

const run = async () => {
  console.log("──────────────────────────────────────────────────────────");
  console.log(" Mirror completeness: Mongo history items vs Postgres rows");
  console.log(" READ ONLY — nothing is written");
  console.log(` Boundary (--since)  : ${SINCE ? SINCE.toISOString() : "(none — report only)"}`);
  console.log("──────────────────────────────────────────────────────────");

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const collection = mongoose.connection.db.collection("reactor_conversations");
  console.log("Connected to MongoDB.");

  const dataSource = createDataSource();
  await dataSource.initialize();
  console.log("Connected to PostgreSQL.\n");

  const docs = await collection
    .find({ "history.0": { $exists: true } })
    .project({ history: 1 })
    .toArray();

  const missingPre: Missing[] = [];
  const missingPost: Missing[] = [];
  let totalItems = 0;
  let conversationsWithGap = 0;

  for (const doc of docs) {
    const conversationId = String(doc._id);
    const history = (Array.isArray(doc.history) ? doc.history : []).filter((h: any) => idOf(h));
    if (history.length === 0) continue;
    totalItems += history.length;

    const rows: Array<{ mongo_id: string | null }> = await dataSource.query(
      "SELECT mongo_id FROM reactor_conversation_messages WHERE conversation_id = $1",
      [conversationId]
    );
    const present = new Set(
      rows.map((r) => String(r.mongo_id ?? "").trim()).filter(Boolean)
    );

    let gap = 0;
    for (const item of history) {
      const id = idOf(item)!;
      if (present.has(id)) continue;
      gap += 1;
      const ts = item?.timestamp ? new Date(item.timestamp) : null;
      const rec: Missing = { conversationId, mongoId: id, role: String(item?.role ?? "?"), ts };
      if (SINCE && ts && ts >= SINCE) missingPost.push(rec);
      else missingPre.push(rec);
    }
    if (gap > 0) conversationsWithGap += 1;
  }

  const byRole = (list: Missing[]) => {
    const out: Record<string, number> = {};
    for (const m of list) out[m.role] = (out[m.role] || 0) + 1;
    return out;
  };

  console.log(`Conversations scanned        : ${docs.length}`);
  console.log(`Mongo history items          : ${totalItems}`);
  console.log(`Conversations with a gap     : ${conversationsWithGap}`);
  console.log("");
  console.log(`Missing BEFORE the boundary  : ${missingPre.length}  ${JSON.stringify(byRole(missingPre))}`);
  console.log(`Missing AT/AFTER the boundary: ${missingPost.length}  ${JSON.stringify(byRole(missingPost))}`);

  if (VERBOSE) {
    for (const m of [...missingPost, ...missingPre].slice(0, 200)) {
      console.log(
        `   ${m.conversationId}  ${m.role.padEnd(9)} ${m.mongoId}  ${
          m.ts ? m.ts.toISOString() : "(no timestamp)"
        }${SINCE && m.ts && m.ts >= SINCE ? "   <-- AFTER BOUNDARY" : ""}`
      );
    }
  }

  // Group the historical gap by conversation so it is actionable.
  if (missingPre.length > 0) {
    const perConv: Record<string, number> = {};
    for (const m of missingPre) perConv[m.conversationId] = (perConv[m.conversationId] || 0) + 1;
    console.log("\nHistorical gap by conversation:");
    for (const [cid, n] of Object.entries(perConv).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${cid}  missing=${n}`);
    }
  }

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

  console.log("\n──────────────────────────────────────────────────────────");
  if (missingPost.length > 0) {
    console.log(
      `FAIL — ${missingPost.length} message(s) written at/after the boundary have no row. ` +
        "That is a live regression: an append site is not dual-writing."
    );
    process.exit(1);
  }
  if (missingPre.length > 0) {
    console.log(
      `PASS (no regression) — nothing after the boundary is missing. ${missingPre.length} ` +
        "historical item(s) still need a repair pass."
    );
    process.exit(0);
  }
  console.log("PASS — every Mongo history item has a Postgres row.");
  process.exit(0);
};

run().catch(async (error) => {
  console.error("Mirror completeness check failed to run:", error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
