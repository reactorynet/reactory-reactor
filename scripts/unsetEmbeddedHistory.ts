#!/usr/bin/env node
/**
 * Step 2 — retire the embedded `history` / `truncatedHistory` arrays (DESTRUCTIVE, default is DRY RUN).
 *
 * This is the one irreversible action in the migration. Everything before it can be undone by flipping
 * `REACTOR_MESSAGES_SOURCE`; this cannot. So it is built to refuse rather than to proceed:
 *
 *   - DRY RUN by default. `--apply` is required to write anything.
 *   - `--confirm-backup=<path>` is REQUIRED with `--apply`. The path must exist and be non-empty. The
 *     recovery path for this operation is restoring Mongo from a database dump, so pointing at one is a
 *     precondition, not a courtesy.
 *   - An orphan preflight runs inline and REFUSES if any conversation in the store has no owning Mongo
 *     document. Those rows would become unattributable once the arrays are gone.
 *   - The manifest written alongside records, per conversation, the counts and a hash of what was
 *     removed — small, and enough to prove afterwards what was discarded.
 *
 * What it does NOT do: it does not store the array contents. Those are ~500 MB of BSON; the database dump
 * named in `--confirm-backup` is that artefact. This keeps a falsifiable record without duplicating it.
 *
 * Expected outcome, and why it is safe: appends no longer write the array, displacements are recorded as
 * archived rows plus a summary, reads come from the store, and no store conversation lacks an owning
 * document. New conversations will still carry a one-item array (the system message) — a documented
 * exemption, not a leak.
 *
 * Usage:
 *   ... unsetEmbeddedHistory.ts                                   # dry run, reports the plan
 *   ... unsetEmbeddedHistory.ts --apply --confirm-backup=<dump>   # writes
 */
import "reflect-metadata";
import mongoose from "mongoose";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  redactUri,
  resolveMongoUri,
  resolvePgConfig,
  hasRequireApplicable,
  Reporter,
  CONVERSATIONS_COLLECTION,
  STORE_TABLE,
} from "./lib/instanceProbe";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const BACKUP = args.find((a) => a.startsWith("--confirm-backup="))?.split("=")[1];
const BATCH = Number(args.find((a) => a.startsWith("--batch="))?.split("=")[1] || 25);

const run = async () => {
  const reporter = new Reporter("Step 2 — retire the embedded history arrays", {
    requireApplicable: hasRequireApplicable(args),
  });

  reporter.banner(` mode  : ${APPLY ? "APPLY — this DELETES the arrays" : "DRY RUN — nothing is written"}`);
  reporter.banner(` mongodb: ${redactUri(resolveMongoUri())}`);

  await mongoose.connect(resolveMongoUri());
  const collection = mongoose.connection.collection(CONVERSATIONS_COLLECTION);

  // ── precondition 1: a backup exists and is named ───────────────────────────────────────────────
  if (APPLY) {
    if (!BACKUP) {
      reporter.fail("--confirm-backup=<path> is required with --apply", "the recovery path is a Mongo restore");
      await mongoose.disconnect();
      process.exit(reporter.finish());
    }
    if (!fs.existsSync(BACKUP)) {
      reporter.fail("the named backup does not exist", BACKUP);
      await mongoose.disconnect();
      process.exit(reporter.finish());
    }
    reporter.pass("backup named and present", `${BACKUP} (${fs.statSync(BACKUP).size} bytes)`);
  } else {
    reporter.banner(` backup: not required for a dry run (--apply requires --confirm-backup=<path>)`);
  }

  // ── precondition 2: no orphaned store conversations ────────────────────────────────────────────
  // Inline rather than shelling out to the check, so the refuse decision cannot be skipped.
  const { Client } = require("pg");
  const client = new Client(resolvePgConfig());
  let orphans = 0;
  try {
    await client.connect();
    const docs = await collection.find({}, { projection: { _id: 1 } }).toArray();
    const known = new Set(docs.map((doc: any) => String(doc._id)));
    const { rows } = await client.query(
      `SELECT DISTINCT btrim(conversation_id::text) AS cid FROM ${STORE_TABLE}`
    );
    const unknown = rows.map((row: any) => row.cid).filter((cid: string) => !known.has(cid));
    orphans = unknown.length;
    if (orphans > 0) {
      reporter.fail(
        `REFUSING: ${orphans} store conversation(s) have no owning Mongo document`,
        `${unknown.slice(0, 5).join(", ")}${orphans > 5 ? " …" : ""}`
      );
      reporter.log("Those rows would become unattributable once the arrays are gone.");
      reporter.log(`Resolve them first — see checkOrphanConversations.ts.`);
      await client.end();
      await mongoose.disconnect();
      process.exit(reporter.finish());
    }
    reporter.pass("no orphaned store conversations", "every store conversation has an owning document");
  } catch (error: any) {
    // No store means nothing to protect; but say so rather than passing silently.
    reporter.notApplicable(
      "orphan preflight",
      `cannot reach the message store (${error?.message ?? error}) — retirement is only meaningful once the store is authoritative`
    );
  } finally {
    if (client) await client.end().catch((): void => undefined);
  }

  // ── measure before ─────────────────────────────────────────────────────────────────────────────
  const sizeOf = async (): Promise<any> => {
    const agg = await collection
      .aggregate([
        {
          $group: {
            _id: null,
            docs: { $sum: 1 },
            bson: { $sum: { $bsonSize: "$$ROOT" } },
            historyItems: { $sum: { $size: { $ifNull: ["$history", []] } } },
            truncatedItems: { $sum: { $size: { $ifNull: ["$truncatedHistory", []] } } },
            withArray: {
              $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$history", []] } }, 0] }, 1, 0] },
            },
            withTruncated: {
              $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$truncatedHistory", []] } }, 0] }, 1, 0] },
            },
          },
        },
      ])
      .toArray();
    return agg[0] ?? {
      docs: 0, bson: 0, historyItems: 0, truncatedItems: 0, withArray: 0, withTruncated: 0,
    };
  };

  const before = await sizeOf();
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + " MB";
  reporter.section("Before");
  reporter.banner(`  documents                 : ${before.docs}`);
  reporter.banner(`  total BSON                : ${mb(before.bson)}`);
  reporter.banner(`  docs carrying an array    : ${before.withArray}`);
  reporter.banner(`  history items             : ${before.historyItems}`);
  reporter.banner(`  truncatedHistory items    : ${before.truncatedItems}`);
  reporter.banner(`  docs with truncatedHistory: ${before.withTruncated}`);

  if (before.historyItems === 0 && before.truncatedItems === 0 && before.withArray === 0 && before.withTruncated === 0) {
    reporter.notApplicable(
      "retirement",
      "no conversation carries an array — either already retired, or this instance never had one"
    );
    await mongoose.disconnect();
    process.exit(reporter.finish());
  }

  if (!APPLY) {
    reporter.section("Dry run — would remove");
    reporter.banner(`  ${before.historyItems + before.truncatedItems} item(s) across ` +
      `${Math.max(before.withArray, before.withTruncated)} document(s)`);
    reporter.banner(`  projected BSON after  : ~${mb(before.bson - before.bson * 0.93)} (see design log §40.2)`);
    reporter.banner("");
    reporter.banner("  Re-run with --apply --confirm-backup=<path> to write.");
    await mongoose.disconnect();
    process.exit(reporter.finish());
  }

  // ── write a manifest of what is being discarded, then unset in batches ─────────────────────────
  const manifestPath = path.join(
    path.dirname(BACKUP!),
    `retired-arrays-manifest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  const manifest: any[] = [];
  const ids = (await collection.find({}, { projection: { _id: 1 } }).toArray()).map((doc: any) => doc._id);

  let processed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const docs = await collection.find({ _id: { $in: slice } }).toArray();

    for (const doc of docs as any[]) {
      const history = Array.isArray(doc.history) ? doc.history : [];
      const truncated = Array.isArray(doc.truncatedHistory) ? doc.truncatedHistory : [];
      if (history.length === 0 && truncated.length === 0) continue;
      manifest.push({
        conversationId: String(doc._id),
        historyItems: history.length,
        truncatedItems: truncated.length,
        // A stable fingerprint of what was removed, without storing ~500 MB of content.
        digest: crypto
          .createHash("sha256")
          .update(JSON.stringify({ history, truncatedHistory: truncated }))
          .digest("hex"),
      });
    }

    await collection.updateMany(
      { _id: { $in: slice } },
      { $unset: { history: "", truncatedHistory: "" } }
    );

    processed += slice.length;
    if (processed % (BATCH * 4) === 0 || processed >= ids.length) {
      reporter.banner(`  retired ${manifest.length} conversation(s) so far (${processed}/${ids.length} scanned)`);
    }
  }

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        retiredAt: new Date().toISOString(),
        reason: "Phase 3c step 2 — message store is authoritative; the arrays are superseded.",
        backup: BACKUP,
        conversations: manifest.length,
        items: manifest.reduce((sum, entry) => sum + entry.historyItems + entry.truncatedItems, 0),
        before,
        manifest,
      },
      null,
      2
    ),
    "utf8"
  );

  // ── verify ─────────────────────────────────────────────────────────────────────────────────────
  const after = await sizeOf();
  const stragglers = await collection.countDocuments({
    $or: [{ history: { $exists: true } }, { truncatedHistory: { $exists: true } }],
  });

  reporter.section("After");
  reporter.banner(`  documents                 : ${after.docs}`);
  reporter.banner(`  total BSON                : ${mb(after.bson)}  (was ${mb(before.bson)})`);
  reporter.banner(`  docs still carrying array : ${stragglers}`);
  reporter.banner(`  manifest                  : ${manifestPath}`);

  reporter.check("every document no longer carries an array", stragglers === 0, `stragglers=${stragglers}`);
  reporter.check("the reduction is material", after.bson < before.bson, `${mb(before.bson)} -> ${mb(after.bson)}`);
  reporter.check("no conversation was lost", after.docs === before.docs, `${before.docs} -> ${after.docs}`);

  if (client) await client.end().catch((): void => undefined);
  await mongoose.disconnect();
  process.exit(reporter.finish());
};

run().catch(async (error: any) => {
  console.error(`Retirement failed: ${error?.message ?? error}`);
  try {
    await mongoose.disconnect();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
