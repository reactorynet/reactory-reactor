#!/usr/bin/env node
/**
 * Write-path liveness check (READ ONLY).
 *
 * Phase 3c step 1 made the embedded Mongo `history` / `truncatedHistory` arrays stop being
 * **persisted** once the Postgres message store is authoritative. What that means depends on the
 * instance, so this script does not assume: it resolves the instance, derives what the write path
 * *should* be doing here, and asserts exactly that.
 *
 * | instance                                    | expectation for a turn            | asserted |
 * |---------------------------------------------|-----------------------------------|----------|
 * | un-migrated (no store table, or unreachable) | array grows, no rows              | nothing — NOT APPLICABLE |
 * | dual-write (`mongo`, store usable)           | rows appear **and** array grows   | both |
 * | cut over (`postgres`, store usable)          | rows appear, array does **not** grow | both |
 *
 * The array-growth signal is `history[].timestamp`, which the writer stamps at the moment of the
 * turn. So "the array grew since the boundary" is a statement about *writes*, not about contents —
 * which is what makes it usable against an instance whose array was never touched.
 *
 * Note what this does **not** do: compare the two stores for equality. That is what every other
 * harness in this directory does, and it is the wrong instrument here — once the array stops being
 * written, "the stores agree" is no longer a property the code preserves, so a parity check would
 * pass for the wrong reason (both sides stale) and could not fail on what this step changes.
 *
 * Usage:
 *   TS_NODE_TRANSPILE_ONLY=true NODE_PATH=./ ./node_modules/.bin/env-cmd --no-override -f ./.env \
 *     node -r ts-node/register -r tsconfig-paths/register \
 *     src/modules/reactory-reactor/scripts/checkWritePathLive.ts [--since=<iso>] [--limit=<n>]
 *
 * Options:
 *   --since=<iso>         deploy boundary (default: 15 minutes ago)
 *   --limit=<n>           how many recently-written conversations to inspect (default 15)
 *   --verbose             (accepted for symmetry; every inspected conversation is reported anyway)
 *   --require-applicable  fail if nothing on this instance was checkable
 */
import "reflect-metadata";
import mongoose from "mongoose";
import { Client } from "pg";
import {
  probeInstance,
  redactPg,
  redactUri,
  resolveMongoUri,
  resolvePgConfig,
  resolveSince,
  hasRequireApplicable,
  Reporter,
  CONVERSATIONS_COLLECTION,
} from "./lib/instanceProbe";

const args = process.argv.slice(2);
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || 15);

const run = async () => {
  const reporter = new Reporter("Write-path liveness: does the write path do what this instance expects?", {
    requireApplicable: hasRequireApplicable(args),
  });

  let since: Date;
  try {
    since = resolveSince(args, 15);
  } catch (error: any) {
    reporter.fail("parse arguments", error?.message ?? String(error));
    process.exit(reporter.finish());
  }

  const pgConfig = resolvePgConfig();
  const probe = await probeInstance({ pgConfig, mongoUri: resolveMongoUri() });

  // ── What is this instance? ───────────────────────────────────────────────────────────────────
  reporter.banner(` READ ONLY — nothing is written`);
  reporter.banner(` postgres : ${redactPg(pgConfig)}`);
  reporter.banner(` mongodb  : ${redactUri(resolveMongoUri())}`);
  reporter.banner(` boundary : ${since.toISOString()}`);
  reporter.banner("");
  reporter.banner(` source resolves to     : ${probe.messageSource}`);
  reporter.banner(
    ` message store          : ${
      probe.store.tableExists
        ? `present (${probe.store.rows} rows / ${probe.store.conversations} conversations)`
        : "absent"
    }`
  );
  reporter.banner(
    ` mongo                  : ${
      probe.mongo.collectionExists
        ? `${probe.mongo.documents} conversations (${probe.mongo.conversationsWithHistory} with an array)`
        : "unavailable"
    }`
  );
  reporter.banner(` expectation            : ${probe.expectations.describe}`);
  probe.notes.forEach((note) => reporter.banner(` note: ${note}`));

  // ── Can this check run at all here? ──────────────────────────────────────────────────────────
  if (!probe.mongo.reachable || !probe.mongo.collectionExists) {
    reporter.notApplicable(
      "write-path behaviour",
      "the conversations collection is not reachable on this instance"
    );
    process.exit(reporter.finish());
  }

  if (!probe.expectations.writesStore) {
    // Nothing is written to a store here, so there is no cross-store statement to make. The
    // array's growth is the *expected* behaviour and is not asserted at all — asserting it would be
    // asserting that this un-migrated instance looks migrated.
    reporter.notApplicable(
      "write-path behaviour",
      `${probe.expectations.describe} — no message store to correlate against`
    );
    process.exit(reporter.finish());
  }

  // ── Both stores are usable: correlate them ───────────────────────────────────────────────────
  const client = new Client(pgConfig);
  try {
    await client.connect();
  } catch (error: any) {
    reporter.notApplicable("write-path behaviour", `cannot connect to the store: ${error?.message ?? error}`);
    process.exit(reporter.finish());
  }

  const active = await client.query<{ conversation_id: string; rows_after: string; newest: Date }>(
    `SELECT btrim(conversation_id::text) AS conversation_id,
            count(*) AS rows_after,
            max(created_at) AS newest
       FROM reactor_conversation_messages
      WHERE created_at >= $1
      GROUP BY 1
      ORDER BY max(created_at) DESC
      LIMIT $2`,
    [since, LIMIT]
  );

  const ids = active.rows.map((row) => row.conversation_id);
  reporter.section(`Conversations with store rows since the boundary : ${ids.length}`);

  if (ids.length === 0) {
    reporter.notApplicable(
      "write-path behaviour",
      "no conversation has been written to the store since the boundary — send a message and re-run with the same --since"
    );
    await client.end();
    process.exit(reporter.finish());
  }

  const docs = await mongoose.connection
    .collection(CONVERSATIONS_COLLECTION)
    .aggregate([
      { $match: { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } } },
      {
        $project: {
          historyCount: { $size: { $ifNull: ["$history", []] } },
          truncatedCount: { $size: { $ifNull: ["$truncatedHistory", []] } },
          historyExists: { $gt: [{ $size: { $ifNull: ["$history", []] } }, 0] },
          grownSince: {
            $size: {
              $filter: {
                input: { $ifNull: ["$history", []] },
                as: "h",
                cond: { $gte: ["$$h.timestamp", since] },
              },
            },
          },
          grownSinceTruncated: {
            $size: {
              $filter: {
                input: { $ifNull: ["$truncatedHistory", []] },
                as: "h",
                cond: { $gte: ["$$h.timestamp", since] },
              },
            },
          },
          title: 1,
        },
      },
    ])
    .toArray();

  const byId = new Map(docs.map((doc: any) => [String(doc._id), doc]));

  for (const row of active.rows) {
    const doc: any = byId.get(row.conversation_id);
    const storeRows = Number(row.rows_after);

    if (!doc) {
      reporter.notApplicable(
        `conversation ${row.conversation_id}`,
        `store holds ${storeRows} row(s) but there is no Mongo conversation document`
      );
      continue;
    }

    const grew = Number(doc.grownSince || 0) + Number(doc.grownSinceTruncated || 0);
    const label = `${row.conversation_id}  store+${storeRows}  array+${grew}`;
    const detail = `history=${doc.historyCount}, truncated=${doc.truncatedCount}${
      doc.title ? `, "${doc.title}"` : ""
    }`;

    if (probe.expectations.writesArray) {
      // Dual-write era: the mirror runs at every append site whatever the source, so a turn must
      // land in BOTH stores. An array that did not grow here is the §24/§26 class of defect.
      reporter.check(
        `${label}  — dual-write: the turn reached BOTH stores`,
        grew > 0,
        grew > 0 ? detail : `${detail} — store rows appeared but the array did not grow`
      );
    } else {
      // Cut over: the array is retired. This is the §43.4 symptom, stated as an assertion.
      reporter.check(
        `${label}  — cut over: the array did NOT grow`,
        grew === 0,
        grew === 0 ? detail : `${detail} — the array is still being written`
      );
    }
  }

  await client.end();
  await mongoose.disconnect();
  process.exit(reporter.finish());
};

run().catch(async (error: any) => {
  console.error(`Write-path liveness check failed: ${error?.message ?? error}`);
  try {
    await mongoose.disconnect();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
