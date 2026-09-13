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

const MONGODB_URI =
  process.env.MONGOOSE ||
  "mongodb://reactory:reactorycore@localhost:27017/reactory-reactory?authSource=admin";

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

const createDataSource = (): DataSource =>
  new DataSource({
    type: "postgres",
    host: process.env.REACTORY_POSTGRES_HOST || process.env.POSTGRES_DB_HOST || "localhost",
    port: parseInt(process.env.REACTORY_POSTGRES_PORT || process.env.POSTGRES_DB_PORT || "5432", 10),
    username: process.env.REACTORY_POSTGRES_USER || process.env.POSTGRES_USER || "reactory",
    password: process.env.REACTORY_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || "reactory",
    database: process.env.REACTORY_POSTGRES_DB || process.env.POSTGRES_DB || "reactory",
    synchronize: false,
    entities: [ReactorConversationMessage],
  });

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
  await dataSource.initialize();
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

  let repaired = 0;
  let insertedTotal = 0;
  let skippedActive = 0;
  const skippedOrder: string[] = [];
  const failures: string[] = [];

  for (const doc of docs) {
    const conversationId = String(doc._id);
    const history = (Array.isArray(doc.history) ? doc.history : []).filter((h: any) => idOf(h));
    if (history.length === 0) continue;

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
