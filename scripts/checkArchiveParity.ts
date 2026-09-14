#!/usr/bin/env node
/**
 * Archive-flag parity check (READ ONLY).
 *
 * The Phase 3 message store mirrors Mongo's `history` as active rows and Mongo's
 * `truncatedHistory` as `archived = true` rows. Compaction in Mongo moves a
 * message from `history` to `truncatedHistory`; if the matching Postgres row is
 * not flagged, Postgres keeps serving it as part of the active transcript and
 * the window contains messages Mongo considers displaced. That is a different
 * defect from a missing row, and the other harnesses do not separate it.
 *
 * Reports, per conversation:
 *   - rows Postgres serves as active that Mongo has in `truncatedHistory`
 *     (should be archived)      -> `should_archive`
 *   - rows Postgres serves as archived that Mongo still has in `history`
 *     (should be active)        -> `should_activate`
 *   - Mongo `history` items with no row at all   -> `missing`
 *   - Postgres rows Mongo owns in neither list   -> `orphan`
 *
 * Usage:
 *   ... checkArchiveParity.ts [--conversation=<id>] [--verbose]
 */

import mongoose from "mongoose";
import { Client } from "pg";
import { resolveMongoUri, resolvePgConfig } from "./lib/instanceProbe";

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const ONLY = args.find((a) => a.startsWith("--conversation="))?.split("=")[1];

const MONGODB_URI = resolveMongoUri();

const pgConfig = resolvePgConfig();

const readId = (item: any): string | null => {
  const raw = item?._id ?? item?.id;
  if (!raw) return null;
  const value = String(raw);
  return value || null;
};

const run = async () => {
  console.log("──────────────────────────────────────────────────────────");
  console.log(" Archive-flag parity: Mongo history models vs Postgres flags");
  console.log(" READ ONLY — nothing is written");
  console.log(` Scope : ${ONLY ? ONLY : "all conversations"}`);
  console.log("──────────────────────────────────────────────────────────");

  const client = new Client(pgConfig);
  await client.connect();
  await mongoose.connect(MONGODB_URI as string);
  console.log("Connected to MongoDB.");
  console.log("Connected to PostgreSQL.\n");

  const filter: Record<string, any> = ONLY
    ? { _id: new mongoose.Types.ObjectId(ONLY) }
    : { history: { $exists: true, $ne: [] } };

  const cursor = mongoose.connection
    .collection("reactor_conversations")
    .find(filter, { projection: { history: 1, truncatedHistory: 1 } });

  let scanned = 0;
  let drifted = 0;
  let totalShouldArchive = 0;
  let totalShouldActivate = 0;
  let totalMissing = 0;
  let totalOrphan = 0;
  const offenders: string[] = [];

  for await (const doc of cursor as any) {
    const conversationId = String(doc._id);
    const history: any[] = Array.isArray(doc.history) ? doc.history : [];
    const truncated: any[] = Array.isArray(doc.truncatedHistory) ? doc.truncatedHistory : [];
    scanned += 1;

    const historyIds = new Set(history.map(readId).filter(Boolean) as string[]);
    const truncatedIds = new Set(truncated.map(readId).filter(Boolean) as string[]);

    const { rows } = await client.query(
      `SELECT mongo_id AS "mongoId", archived
         FROM reactor_conversation_messages WHERE conversation_id = $1`,
      [conversationId]
    );

    let shouldArchive = 0;
    let shouldActivate = 0;
    let orphan = 0;

    for (const row of rows) {
      const id = String(row.mongoId ?? "").trim();
      if (!id) continue;
      if (row.archived) {
        if (historyIds.has(id)) shouldActivate += 1;
      } else if (truncatedIds.has(id)) {
        shouldArchive += 1;
      }
      if (!historyIds.has(id) && !truncatedIds.has(id)) orphan += 1;
    }

    const missing = [...historyIds].filter(
      (id) => !rows.some((row) => String(row.mongoId ?? "").trim() === id)
    ).length;

    if (shouldArchive || shouldActivate || missing || orphan) {
      drifted += 1;
      totalShouldArchive += shouldArchive;
      totalShouldActivate += shouldActivate;
      totalMissing += missing;
      totalOrphan += orphan;
      offenders.push(
        `   ${conversationId}  should_archive=${shouldArchive} should_activate=${shouldActivate} ` +
          `missing=${missing} orphan=${orphan}`
      );
    } else if (VERBOSE) {
      console.log(`   ✓ ${conversationId} aligned`);
    }
  }

  console.log(`Conversations scanned          : ${scanned}`);
  console.log(`Conversations with drift       : ${drifted}`);
  console.log(`  served active but archived in Mongo : ${totalShouldArchive}`);
  console.log(`  served archived but active in Mongo : ${totalShouldActivate}`);
  console.log(`  history items with no row           : ${totalMissing}`);
  console.log(`  rows Mongo owns in neither list     : ${totalOrphan}`);
  if (offenders.length) {
    console.log("\nConversations with drift:");
    offenders.slice(0, 40).forEach((line) => console.log(line));
  }

  console.log("\n" + "─".repeat(58));
  console.log(
    drifted === 0
      ? "PASS — every Postgres row's archived flag matches Mongo's list membership."
      : `DRIFT — ${drifted} conversation(s) have rows whose archived flag disagrees with Mongo.`
  );

  await client.end();
  await mongoose.disconnect();
};

run().catch((error: any) => {
  console.error(`Archive-flag parity check failed: ${error?.message ?? error}`);
  process.exit(1);
});
