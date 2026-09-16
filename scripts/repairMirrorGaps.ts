/**
 * Repair mirror gaps: insert every Mongo `history` item that has no Postgres row,
 * then re-derive `seq` from `mongo_id` order.
 *
 * Why this exists rather than `reconcile`: the reconcile tool is not
 * archived-aware (it never loads `truncatedHistory`, so every archived row reads
 * as an orphan and the conversation is pushed into a delete-and-reinsert path —
 * see PHASE3-MIGRATION-DESIGN.md §21). This script is deliberately narrow:
 *
 *   - it only ever INSERTS missing rows, never deletes;
 *   - it reuses `ReactorConversationMessageService.appendMessage`, so the row
 *     mapping (sanitisation, search_text, archived metadata, required columns) is
 *     the same code the live writer uses;
 *   - it then renumbers by `mongo_id` order, which places recovered messages at
 *     their true chronological positions.
 *
 * Ordering note: `mongo_id` is an ObjectId (time-ordered), so renumbering by it is
 * only correct when Mongo's array order equals its `_id` order. That is verified
 * per conversation and the conversation is SKIPPED if it does not hold, rather
 * than guessing.
 *
 * Safe by construction:
 *   - dry run by default; `--apply` writes;
 *   - idempotent: inserts are keyed on the unique `mongo_id`, and renumbering is
 *     derived, so re-running converges;
 *   - skips conversations written within 120 s (the live writer computes
 *     MAX(seq)+1 while this renumbers, and they collide), overridable.
 *
 * Usage:
 *   ... repairMirrorGaps.ts [--apply] [--conversation=<id>] [--include-active]
 */
import "reflect-metadata";
import mongoose from "mongoose";
import { DataSource } from "typeorm";
import ReactorConversationMessage from "../models/ReactorConversationMessage";
import ReactorConversationMessageService from "../services/reactor/ReactorConversationMessageService";
import { resolveMongoUri, resolvePgConfig, STORE_TABLE } from "./lib/instanceProbe";

const MONGODB_URI = resolveMongoUri();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const INCLUDE_ACTIVE = args.includes("--include-active");
const ONLY = args.find((a) => a.startsWith("--conversation="))?.split("=")[1];
const ACTIVE_WINDOW_MS = 120_000;

const idOf = (item: any): string | null => {
  const raw = item?._id ?? item?.id;
  return raw ? String(raw) : null;
};

/** Does the array order equal `_id` order? Only then is renumbering derivable. */
const arrayOrderMatchesIdOrder = (ids: string[]): boolean => {
  const sorted = [...ids].sort();
  return ids.every((id, i) => id === sorted[i]);
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

const run = async () => {
  console.log("──────────────────────────────────────────────────────────");
  console.log(" Repair mirror gaps (insert-only + renumber by mongo_id)");
  console.log(` Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  console.log(` Scope: ${ONLY ? `conversation ${ONLY}` : "all conversations"}`);
  console.log(` Active window: ${INCLUDE_ACTIVE ? "ignored (--include-active)" : "skip < 120s"}`);
  console.log("──────────────────────────────────────────────────────────");

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const collection = mongoose.connection.db.collection("reactor_conversations");

  const dataSource = createDataSource();
  try {
    await dataSource.initialize();
  } catch (error: any) {
    console.log("");
    console.log(`NOT APPLICABLE — cannot reach the message store: ${error?.message ?? error}`);
    if (APPLY) {
      console.log("  REFUSING TO WRITE: this run was asked to apply changes to a store it cannot reach.");
      process.exit(2);
    }
    process.exit(0);
  }

  // ── Environment preflight, BEFORE any work ─────────────────────────────────────────────────
  //
  // Same reasoning as `reconcile`: this repairs the message store, so it must establish that the
  // store exists before it begins, and refuse a write run if it does not.
  {
    const reg = await dataSource.query("SELECT to_regclass($1) AS t", [`public.${STORE_TABLE}`]);
    if (!reg?.[0]?.t) {
      console.log("");
      console.log(`NOT APPLICABLE — ${STORE_TABLE} does not exist in this database.`);
      console.log("  Nothing to repair.");
      if (APPLY) {
        console.log("  REFUSING TO WRITE: this run was asked to apply changes to a store that is not there.");
        process.exit(2);
      }
      process.exit(0);
    }
  }
  const service = new ReactorConversationMessageService(dataSource);

  if (!service.isAvailable()) {
    console.error("Postgres is not available; aborting.");
    process.exit(2);
  }

  const filter: any = ONLY
    ? { _id: new mongoose.Types.ObjectId(ONLY) }
    : { "history.0": { $exists: true } };

  const docs = await collection
    .find(filter)
    .project({ history: 1, updated: 1 })
    .toArray();
  console.log(`Conversations to consider: ${docs.length}\n`);
  // Same reasoning as in reconcile: the filter selects documents BY their history array, so a
  // fully-retired corpus yields zero candidates and a summary that looks like success.
  if (!ONLY && docs.length === 0) {
    const corpusDocs = await collection.countDocuments();
    if (corpusDocs > 0) {
      console.log(
        `  ⚠ NOTHING WAS EXAMINED: none of the ${corpusDocs} document(s) has a history array, ` +
          `so there is nothing to derive the expected set from.`
      );
      console.log(
        "    This is expected once the array has been retired. This run is NOT evidence that " +
          "the mirror is complete."
      );
    }
  }

  let repaired = 0;
  let insertedTotal = 0;
  let skippedActive = 0;
  // Counted for the same reason as in `reconcile`: an absent array is a legitimate skip, but a
  // silent one turns "0 rows inserted" into apparent evidence that the mirror is complete.
  let noArraySkipped = 0;
  const skippedOrder: string[] = [];
  const failures: string[] = [];

  for (const doc of docs) {
    const conversationId = String(doc._id);
    const history = (Array.isArray(doc.history) ? doc.history : []).filter((h: any) => idOf(h));
    if (history.length === 0) {
      noArraySkipped += 1;
      continue;
    }

    try {
      const rows: Array<{ mongo_id: string | null }> = await dataSource.query(
        "SELECT mongo_id FROM reactor_conversation_messages WHERE conversation_id = $1",
        [conversationId]
      );
      const present = new Set(
        rows.map((r) => String(r.mongo_id ?? "").trim()).filter(Boolean)
      );

      const missing = history.filter((h: any) => !present.has(idOf(h)!));
      if (missing.length === 0) continue;

      // Renumbering an actively-written conversation races MAX(seq)+1.
      const updatedAt = doc.updated ? new Date(doc.updated).getTime() : 0;
      const ageMs = Date.now() - updatedAt;
      if (!INCLUDE_ACTIVE && updatedAt > 0 && ageMs < ACTIVE_WINDOW_MS) {
        skippedActive += 1;
        console.log(
          `  ~ ${conversationId}: ${missing.length} missing, written ${Math.round(ageMs / 1000)}s ago ` +
            "— skipped as active (re-run when idle, or pass --include-active)"
        );
        continue;
      }

      // Order must be derivable for renumbering to be correct.
      const ids = history.map((h: any) => idOf(h)!);
      if (!arrayOrderMatchesIdOrder(ids)) {
        skippedOrder.push(conversationId);
        console.log(
          `  ~ ${conversationId}: ${missing.length} missing, but Mongo array order != mongo_id order ` +
            "— skipped rather than guessing"
        );
        continue;
      }

      if (!APPLY) {
        console.log(`  > would repair ${conversationId}: insert ${missing.length} row(s), then renumber`);
        continue;
      }

      // 1. insert the missing rows (appendMessage assigns MAX(seq)+1; order is
      //    fixed by the renumber below).
      let inserted = 0;
      for (const item of missing) {
        // eslint-disable-next-line no-await-in-loop
        const res = await service.appendMessage(conversationId, item);
        if (res) inserted += 1;
      }

      // 2. renumber ALL rows by mongo_id order. Shift clear of the live range
      //    first so the unique (conversation_id, seq) guard cannot trip mid-update.
      const range: Array<{ lo: string | null; hi: string | null }> = await dataSource.query(
        "SELECT MIN(seq)::bigint AS lo, MAX(seq)::bigint AS hi FROM reactor_conversation_messages WHERE conversation_id = $1",
        [conversationId]
      );
      const lo = Number(range[0]?.lo ?? 0);
      const hi = Number(range[0]?.hi ?? 0);
      const span = hi - lo + 1;

      await dataSource.query(
        "UPDATE reactor_conversation_messages SET seq = seq + $2, updated_at = now() WHERE conversation_id = $1",
        [conversationId, span]
      );
      await dataSource.query(
        `WITH ordered AS (
           SELECT id, row_number() OVER (ORDER BY mongo_id ASC) AS rn
             FROM reactor_conversation_messages
            WHERE conversation_id = $1
         )
         UPDATE reactor_conversation_messages m
            SET seq = o.rn, updated_at = now()
           FROM ordered o
          WHERE m.id = o.id`,
        [conversationId]
      );

      insertedTotal += inserted;
      repaired += 1;
      console.log(`  ✓ ${conversationId}: inserted ${inserted}, renumbered ${span} rows`);
    } catch (error: any) {
      failures.push(`${conversationId}: ${error?.message ?? error}`);
      console.log(`  ✗ ${conversationId}: ${error?.message ?? error}`);
    }
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`Conversations repaired     : ${repaired}`);
  console.log(`Rows inserted              : ${insertedTotal}`);
  console.log(`Skipped (active)           : ${skippedActive}`);
  console.log(`Skipped (order not derivable): ${skippedOrder.length}${skippedOrder.length ? " — " + skippedOrder.join(", ") : ""}`);
  if (noArraySkipped > 0) {
    console.log(
      `Skipped (no Mongo array)    : ${noArraySkipped}` +
        `  — nothing to derive the expected set from; expected once \`history\` has been retired`
    );
  }
  console.log(`Failures                   : ${failures.length}`);
  for (const f of failures.slice(0, 10)) console.log(`   - ${f}`);
  console.log("──────────────────────────────────────────────────────────");
  if (!APPLY) console.log("Dry run complete. Re-run with --apply to write.");

  await dataSource.destroy();
  await mongoose.disconnect();
  process.exit(failures.length > 0 ? 1 : 0);
};

run().catch(async (error) => {
  console.error("Repair failed to run:", error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
