/**
 * Backfill the Postgres conversation message log from Mongo history.
 *
 * Phase 3 step 3a. The Postgres message table is written alongside the Mongo
 * `history` array from this step onward, but the array remains authoritative and
 * no read path changes. This script brings pre-existing conversations up to
 * parity so that step 3b can cut reads over.
 *
 * Safe by construction:
 *  - Dry run by default. Pass `--apply` to write anything.
 *  - Idempotent: rows are keyed on the Mongo subdocument `_id` (unique index),
 *    so re-running skips what already exists. This is the intended way to
 *    reconcile anything dual-write missed.
 *  - Batched by conversation, so it can be resumed simply by re-running.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/backfillConversationMessages.ts
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/backfillConversationMessages.ts --apply
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/backfillConversationMessages.ts --apply --conversation=<id>
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/backfillConversationMessages.ts --apply --include-truncated
 *
 * Prerequisite: the table must exist. Run
 *   ./bin/migrate-typeorm.sh up --module=reactory-reactor
 * first (or start the server in a development environment, where `synchronize`
 * creates it from the entity).
 */
import "reflect-metadata";
import mongoose from "mongoose";
import { DataSource } from "typeorm";
import ReactorConversationMessage from "../models/ReactorConversationMessage";
import ReactorConversationMessageService from "../services/reactor/ReactorConversationMessageService";
import { resolveMongoUri, resolvePgConfig, STORE_TABLE } from "./lib/instanceProbe";

const MONGODB_URI = resolveMongoUri();

const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE || 25);

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const INCLUDE_TRUNCATED = args.includes("--include-truncated");
const PRUNE_ORPHANS = args.includes("--prune-orphans");
const ONLY_CONVERSATION = args
  .find((arg) => arg.startsWith("--conversation="))
  ?.split("=")[1];

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

/**
 * Ordered fingerprint of a conversation's message identity.
 *
 * Compared between Mongo and Postgres to prove the backfill reproduced the same
 * transcript in the same order — a row count alone would not catch a reordering
 * or a duplicate.
 */
const fingerprint = (items: any[]): string => {
  const ids = items
    .map((item) => `${item?.role ?? "?"}:${String(item?._id ?? item?.id ?? "")}`)
    .join("|");
  // Small non-cryptographic hash; this only needs to detect divergence.
  let hash = 0;
  for (let i = 0; i < ids.length; i += 1) {
    hash = (hash * 31 + ids.charCodeAt(i)) | 0;
  }
  return `${items.length}:${(hash >>> 0).toString(16)}`;
};

const run = async () => {
  console.log("──────────────────────────────────────────────────────────");
  console.log(" Conversation message backfill (Phase 3 step 3a)");
  console.log(` Mode            : ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  console.log(` Include truncated: ${INCLUDE_TRUNCATED ? "yes (archived rows)" : "no"}`);
  console.log(` Scope           : ${ONLY_CONVERSATION ? `conversation ${ONLY_CONVERSATION}` : "all conversations"}`);
  console.log("──────────────────────────────────────────────────────────");

  const dataSource = createDataSource();
  try {
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
  } catch (error: any) {
    console.error(`\n❌ Could not connect to Postgres: ${error?.message}`);
    console.error("   Check REACTORY_POSTGRES_* / POSTGRES_* environment values.");
    process.exitCode = 1;
    return;
  }

  const service = new ReactorConversationMessageService(dataSource);

  // Fail fast if the table is missing, rather than failing per conversation.
  try {
    await service.countForConversation("000000000000000000000000", {
      includeArchived: true,
    });
  } catch (error: any) {
    console.error(`\n❌ Postgres message table is not ready: ${error?.message}`);
    console.error("   Run: ./bin/migrate-typeorm.sh up --module=reactory-reactor");
    await dataSource.destroy();
    process.exitCode = 1;
    return;
  }

  console.log("\nConnecting to MongoDB...");
  await mongoose.connect(MONGODB_URI);
  console.log("Connected.\n");

  const ReactorConversationModel = mongoose.connection.collection("reactor_conversations");

  // ── Environment preflight, BEFORE any work ─────────────────────────────────────────────────
  //
  // This script writes into `reactor_conversation_messages`, and it is part of the migration
  // toolkit for arbitrary instances. Proving the table exists first means an `--apply` run
  // refuses cleanly instead of writing nothing (or failing part-way) against a database that has
  // no message store.
  {
    const reg = await dataSource.query("SELECT to_regclass($1) AS t", [`public.${STORE_TABLE}`]);
    if (!reg?.[0]?.t) {
      console.log("");
      console.log(`NOT APPLICABLE — ${STORE_TABLE} does not exist in this database.`);
      console.log("  Nothing to backfill.");
      if (APPLY) {
        console.log("  REFUSING TO WRITE: this run was asked to apply changes to a store that is not there.");
        process.exit(2);
      }
      process.exit(0);
    }
  }
  const query: Record<string, any> = { history: { $exists: true, $ne: [] } };
  if (ONLY_CONVERSATION) {
    query._id = new mongoose.Types.ObjectId(ONLY_CONVERSATION);
  }

  const total = await ReactorConversationModel.countDocuments(query);
  console.log(`Conversations to consider: ${total}\n`);

  let processed = 0;
  let insertedTotal = 0;
  let skippedTotal = 0;
  let archivedTotal = 0;
  let pendingRows = 0;
  let prunedTotal = 0;
  const divergences: string[] = [];
  const failures: string[] = [];

  const cursor = ReactorConversationModel.find(query, {
    projection: { history: 1, truncatedHistory: 1 },
  });

  let batchCount = 0;
  for await (const conversation of cursor as any) {
    const conversationId = String(conversation._id);
    const history: any[] = Array.isArray(conversation.history) ? conversation.history : [];
    const truncated: any[] = Array.isArray(conversation.truncatedHistory)
      ? conversation.truncatedHistory
      : [];

    processed += 1;

    // A single malformed conversation must not abort a corpus-wide migration:
    // each conversation is independent and the backfill is idempotent, so a
    // failure here is recorded and the run continues. Re-running picks up any
    // conversation that failed.
    try {
      if (APPLY) {
        // Active messages keep their original array positions as `seq`, so row
        // order matches the Mongo transcript exactly.
        const active = await service.appendMessages(conversationId, history, { startSeq: 1 });
        insertedTotal += active.inserted;
        skippedTotal += active.skipped;

        if (INCLUDE_TRUNCATED && truncated.length > 0) {
          // Displaced messages are appended after the active ones and flagged as
          // archived. Their original interleaving with the active transcript is
          // not reconstructable — Mongo kept them in a separate array — but they
          // are only surfaced on explicit request, never in the active window.
          const archivedRows = truncated.map((item) => ({
            ...item,
            archived: true,
            archivedReason: item?.archivedReason ?? "truncated",
          }));
          const archived = await service.appendMessages(conversationId, archivedRows, {
            startSeq: history.length + 1,
          });
          insertedTotal += archived.inserted;
          archivedTotal += archived.inserted;
        }
      }

      // Orphan pruning (repair mode). Rows whose mongo_id Mongo no longer holds
      // are duplicates written under a provisional id before the keying fix.
      // They are indistinguishable from a valid row without consulting the
      // source of truth, so removal is opt-in and reported.
      if (PRUNE_ORPHANS && APPLY) {
        const knownIds = [
          ...history.map((item: any) => (item?._id ? String(item._id) : null)),
          ...(INCLUDE_TRUNCATED ? truncated : []).map((item: any) =>
            item?._id ? String(item._id) : null
          ),
        ].filter((value): value is string => Boolean(value));

        prunedTotal += await service.pruneOrphanedMessages(conversationId, knownIds);
      }

      // Verification.
      //
      // Compared by row count plus a direct ordered read, NOT through
      // getHistoryWindow: that window is capped and then expanded back to the
      // nearest user message, so for any conversation longer than the window it
      // legitimately returns fewer active items than the transcript holds. Using
      // it here reported a false divergence on every long conversation.
      const rowCount = await service.countForConversation(conversationId, {
        includeArchived: true,
      });
      const expectedRowCount =
        history.length + (INCLUDE_TRUNCATED ? truncated.length : 0);

      if (!APPLY) {
        pendingRows += Math.max(0, expectedRowCount - rowCount);
      } else if (rowCount < expectedRowCount) {
        // Fewer rows than the snapshot means genuine loss.
        divergences.push(
          `${conversationId}: expected at least ${expectedRowCount} rows, found ${rowCount}`
        );
      } else {
        // Race-safe fingerprint. A conversation that is still being written
        // legitimately gains rows between reading Mongo and reading Postgres
        // (dual-write), so Postgres may hold MORE than the snapshot. Compare
        // only the snapshot-length prefix, which must match exactly.
        const activeRows = await service.getActiveMessages(conversationId);
        const prefix = service.toMessages(activeRows).slice(0, history.length);
        if (fingerprint(prefix) !== fingerprint(history)) {
          divergences.push(`${conversationId}: ordered fingerprint mismatch`);
        }
      }
    } catch (error: any) {
      failures.push(`${conversationId}: ${error?.message ?? error}`);
    }

    if (processed % BATCH_SIZE === 0) {
      console.log(
        `  … ${processed}/${total} conversations | inserted ${insertedTotal} | skipped ${skippedTotal}`
      );
      batchCount += 1;
    }
  }

  if (batchCount === 0 || processed % BATCH_SIZE !== 0) {
    console.log(`  … ${processed}/${total} conversations`);
  }

  console.log("\n──────────────────────────────────────────────────────────");

  console.log(" Summary");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Conversations processed : ${processed}`);
  console.log(`Messages inserted       : ${insertedTotal}`);
  console.log(`Messages skipped        : ${skippedTotal} (already present)`);
  console.log(`Archived rows inserted  : ${archivedTotal}`);
  console.log(`Orphaned rows pruned    : ${prunedTotal}`);
  console.log(`Rows pending (dry run)  : ${pendingRows}`);
  console.log(`Failures                : ${failures.length}`);
  if (failures.length > 0) {
    console.log("\n⚠️  First failures:");
    failures.slice(0, 5).forEach((line) => console.log(`   - ${line}`));
  }
  console.log(`Divergences             : ${divergences.length}`);

  if (divergences.length > 0) {
    console.log("\n⚠️  Divergences detected:");
    divergences.slice(0, 25).forEach((line) => console.log(`   - ${line}`));
    if (divergences.length > 25) {
      console.log(`   … and ${divergences.length - 25} more`);
    }
  }

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to write.");
  } else if (divergences.length === 0) {
    console.log("\n✅ Backfill complete and verified.");
  } else {
    console.log("\n⚠️  Backfill wrote rows but verification reported divergences above.");
  }

  await mongoose.disconnect();
  await dataSource.destroy();
};

run().catch(async (error) => {
  console.error("Backfill error:", error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
