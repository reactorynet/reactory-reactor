#!/usr/bin/env node
/**
 * Provider-context parity check (READ ONLY).
 *
 * Phase 3c repointed the AI provider context path (`AIProviderBase.loadChatState`
 * and the other consumers) from the embedded Mongo `history` array to the
 * message store. The property that matters is: **the model must receive the same
 * transcript either way**. This asserts that directly.
 *
 * For each sampled conversation it compares:
 *   - `loadHistoryForContext(id, mongoHistory)` — the new source-aware read
 *   - the embedded Mongo `history` array           — the old source
 * on item count, role sequence and id sequence.
 *
 * It also asserts the fail-open contract: when the store holds nothing for a
 * conversation Mongo does have, the helper must return `null` so callers keep
 * using the array rather than feeding the model an empty context.
 *
 * Usage:
 *   ... checkProviderContextParity.ts [--conversation=<id>] [--limit=<n>]
 */

import mongoose from "mongoose";
import { Client } from "pg";
import ReactorConversationMessageService from "../services/reactor/ReactorConversationMessageService";
import { loadHistoryForContext } from "../services/reactor/conversationHistoryLoader";
import { resolveMongoUri, resolvePgConfig, CONVERSATIONS_COLLECTION } from "./lib/instanceProbe";
const args = process.argv.slice(2);
const ONLY = args.find((a) => a.startsWith("--conversation="))?.split("=")[1];
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || 25);

const MONGODB_URI = resolveMongoUri();

const pgConfig = resolvePgConfig();

// Key on `_id` first: Mongo history subdocuments carry BOTH a provisional `id`
// (set in the $push payload) and Mongoose's persisted `_id`. The mirror and
// every paging cursor key on `_id`, so comparing `id` against the store's
// `mongo_id` compares two different identifiers and reports a false divergence.
const fingerprint = (items: any[]): string =>
  items.map((m) => `${String(m?.role ?? "?")}:${String(m?._id ?? m?.id ?? "")}`).join(",");

const run = async () => {
  console.log("──────────────────────────────────────────────────────────");
  console.log(" Provider-context parity: Postgres read vs Mongo array");
  console.log(" READ ONLY — nothing is written");
  console.log("──────────────────────────────────────────────────────────");

  // The helper resolves the store lazily from the module barrel, which needs an
  // initialised DataSource; initialise it the same way the server does.
  const { ReactorPostgresDataSource } = require("../models");
  if (!ReactorPostgresDataSource.isInitialized) {
    await ReactorPostgresDataSource.initialize();
  }
  console.log("Connected to PostgreSQL.");

  await mongoose.connect(MONGODB_URI as string);
  console.log("Connected to MongoDB.\n");

  const filter: Record<string, any> = ONLY
    ? { _id: new mongoose.Types.ObjectId(ONLY) }
    : { history: { $exists: true, $ne: [] } };

  const docs = await mongoose.connection
    .collection("reactor_conversations")
    .find(filter)
    .limit(ONLY ? 1 : LIMIT)
    .toArray();

  const client = new Client(pgConfig);
  await client.connect();

  let compared = 0;
  let divergences = 0;
  let nulls = 0;
  let emptyBothSides = 0;
  const details: string[] = [];

  for (const doc of docs as any[]) {
    const id = String(doc._id);
    const mongoHistory: any[] = Array.isArray(doc.history) ? doc.history : [];

    const fromStore = await loadHistoryForContext(id, mongoHistory, {
      warn: (message: string, data?: any) =>
        console.log(`   ⚠ ${message} ${JSON.stringify(data ?? {})}`),
    });

    if (fromStore === null) {
      nulls += 1;
      details.push(`   ${id}: helper returned null (fell back to Mongo) — mongo=${mongoHistory.length}`);
      continue;
    }

    compared += 1;

    if (mongoHistory.length === 0 && fromStore.length === 0) {
      emptyBothSides += 1;
      continue;
    }

    const mongoFp = fingerprint(mongoHistory);
    const storeFp = fingerprint(fromStore);

    if (mongoFp !== storeFp) {
      divergences += 1;
      details.push(
        `   ✗ ${id}: mongo=${mongoHistory.length} store=${fromStore.length}\n` +
          `       mongo: ${mongoFp.slice(0, 160)}\n` +
          `       store: ${storeFp.slice(0, 160)}`
      );
    }
  }

  console.log(`Conversations sampled          : ${docs.length}`);
  console.log(`Compared (store answered)      : ${compared}`);
  console.log(`  aligned                      : ${compared - divergences}`);
  console.log(`  divergent                    : ${divergences}`);
  console.log(`Helper fell back to Mongo      : ${nulls}`);
  console.log(`  (both sides empty)           : ${emptyBothSides}`);
  if (details.length) {
    console.log("\nDetails:");
    details.slice(0, 20).forEach((line) => console.log(line));
  }

  // Fail-open contract: an unknown conversation must return null so callers keep
  // the embedded array rather than handing the model an empty context.
  const probe = await loadHistoryForContext(
    new mongoose.Types.ObjectId().toString(),
    [{ role: "user", content: "probe" }]
  );
  const failOpenOk = probe === null;
  console.log(
    `Fail-open probe (unknown id, non-empty Mongo array): ${failOpenOk ? "null ✓" : "NON-NULL ✗"}`
  );

  // After step 2 the embedded arrays are retired, so an array-based comparison has no subject.
  // Without this every harness in this directory reports PASS while examining nothing. This run is
  // NOT evidence that the migration is correct; it is reported as NOT APPLICABLE for that reason.
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
      process.exit(0);
    }
  }
  console.log("\n" + "─".repeat(58));
  console.log(
    divergences === 0 && failOpenOk
      ? "PASS — the provider receives an identical transcript from either source, and falls open to Mongo."
      : `FAIL — divergences=${divergences}, failOpen=${failOpenOk}`
  );

  await client.end();
  await mongoose.disconnect();
};

run().catch((error: any) => {
  console.error(`Provider-context parity check failed: ${error?.message ?? error}`);
  process.exit(1);
});
