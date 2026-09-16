#!/usr/bin/env node
/**
 * Orphan-conversation check (READ ONLY).
 *
 * Reports Postgres conversations that have **no Mongo document at all** — rows whose owning
 * conversation was deleted.
 *
 * Why this check exists, and why it is different from every other harness here:
 *
 *  - `checkMirrorCompleteness` / `checkWindowParity` / `checkArchiveParity` / `reconcile` all
 *    **iterate Mongo documents**. A conversation with no document is therefore never visited, so
 *    none of them can see these rows. That is precisely how four of them sat unnoticed.
 *  - It is the only integrity check that survives step 2 (`$unset`). Every array-based check
 *    (`mongo_id` membership) becomes meaningless once the arrays are gone; "does the owning
 *    conversation still exist?" does not.
 *
 * The failure it guards against is a **delete that does not delete**: `deleteChatSession` removed the
 * conversation document but left its messages, because the message service's `deleteForConversation`
 * was never wired into the app. Both delete paths are now wired; this is the gate that proves it.
 *
 * Usage:
 *   ... checkOrphanConversations.ts [--verbose] [--require-applicable]
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
  hasRequireApplicable,
  Reporter,
  CONVERSATIONS_COLLECTION,
  STORE_TABLE,
} from "./lib/instanceProbe";

const args = process.argv.slice(2);

const run = async () => {
  const reporter = new Reporter("Orphan conversations: store rows whose conversation no longer exists", {
    requireApplicable: hasRequireApplicable(args),
  });

  const pgConfig = resolvePgConfig();
  const probe = await probeInstance({ pgConfig, mongoUri: resolveMongoUri() });

  reporter.banner(` READ ONLY — nothing is written`);
  reporter.banner(` postgres : ${redactPg(pgConfig)}`);
  reporter.banner(` mongodb  : ${redactUri(resolveMongoUri())}`);

  if (!probe.mongo.reachable || !probe.mongo.collectionExists) {
    reporter.notApplicable("orphan detection", "the conversations collection is not reachable on this instance");
    process.exit(reporter.finish());
  }

  if (!(probe.store.reachable && probe.store.tableExists)) {
    // Without a store there are no rows, so there can be no orphans. Not a pass — an absence of the
    // subject. (On an un-migrated instance this is the normal state, hence N/A rather than FAIL.)
    reporter.notApplicable(
      "orphan detection",
      `no ${STORE_TABLE} on this instance (${probe.store.reason ?? "absent"})`
    );
    process.exit(reporter.finish());
  }

  const client = new Client(pgConfig);
  try {
    await client.connect();
  } catch (error: any) {
    reporter.notApplicable("orphan detection", `cannot connect to the store: ${error?.message ?? error}`);
    process.exit(reporter.finish());
  }

  // Authoritative set: every Mongo conversation id, as a string. A document with `_id: null` yields
  // the literal "null", which is how the one legacy row for it stays matched rather than flagged.
  const documents = await mongoose.connection
    .collection(CONVERSATIONS_COLLECTION)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  const mongoIds = new Set(documents.map((doc: any) => String(doc._id)));

  const { rows } = await client.query<{ cid: string; rows: number; archived: number; newest: Date | null }>(
    `SELECT btrim(conversation_id::text) AS cid,
            count(*)::int AS rows,
            count(*) FILTER (WHERE archived)::int AS archived,
            max(created_at) AS newest
       FROM ${STORE_TABLE}
      GROUP BY 1`
  );

  const orphans = rows.filter((row) => !mongoIds.has(row.cid));

  reporter.section(`Mongo conversations        : ${mongoIds.size}`);
  reporter.section(`Postgres conversations     : ${rows.length}`);
  reporter.section(`Orphaned conversations     : ${orphans.length}`);

  if (orphans.length === 0) {
    reporter.pass(
      "every store conversation has an owning Mongo document",
      `${rows.length} conversation(s) checked`
    );
  } else {
    // Bounded detail: an id, its row count and a content head, so each orphan can be attributed
    // without another query.
    for (const orphan of orphans) {
      const detail = await client.query<{ role: string; head: string | null }>(
        `SELECT role, left(content::text, 110) AS head
           FROM ${STORE_TABLE}
          WHERE btrim(conversation_id::text) = $1
          ORDER BY seq ASC
          LIMIT 1`,
        [orphan.cid]
      );
      const first = detail.rows[0];
      reporter.fail(
        `${orphan.cid}  rows=${orphan.rows} archived=${orphan.archived}`,
        `first role=${first?.role ?? "?"} at ${orphan.newest?.toISOString?.() ?? orphan.newest}; ` +
          `head=${JSON.stringify(first?.head ?? null)}`
      );
    }
    reporter.log(
      "These rows belong to conversations that no longer exist. They are invisible to every"
    );
    reporter.log(
      "Mongo-iterating harness — which is how they survived. Treat as a delete that did not delete."
    );
  }

  await client.end();
  await mongoose.disconnect();
  process.exit(reporter.finish());
};

run().catch(async (error: any) => {
  console.error(`Orphan-conversation check failed: ${error?.message ?? error}`);
  try {
    await mongoose.disconnect();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
