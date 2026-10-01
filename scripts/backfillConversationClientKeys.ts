#!/usr/bin/env node
/**
 * Backfill the owning ReactoryClient (`clientKey`) onto `reactor_conversations` (WP-B2).
 *
 * WHY THIS EXISTS
 *
 * Conversation *messages* became tenant-scoped in Postgres
 * (`reactor_conversation_messages.client_key`) at the message-store cutover, but the
 * *session documents* in Mongo were left unscoped (`user`/`personaId`/`use_case` only).
 * "Is this conversation blank?" is decided against the client-scoped message store, so
 * a conversation with content on client A reads as an unused blank on client B — and
 * "New chat" on B adopted A's session (showing none of its messages). Listing and
 * resuming were likewise unscoped.
 *
 * The service now stamps and filters on `clientKey`. This script stamps the conversations
 * that already exist so the new scoping has something to match:
 *
 *   - a conversation that HAS message rows is stamped with the `client_key` of those
 *     rows (the message log is authoritative, and `assertConversationTenant` guarantees a
 *     conversation's rows all carry one client key);
 *   - a conversation with NO message rows anywhere cannot be attributed from data. It is
 *     stamped with `--blank-key` (default `reactory`) unless `--leave-blanks` is given, in
 *     which case it is left unstamped. Either way the fix is fail-closed for reuse: an
 *     unstamped conversation is never selected as another client's verified blank.
 *
 * SAFE BY CONSTRUCTION
 *   - Dry run by default. Pass `--apply` to write.
 *   - Idempotent: only documents whose `clientKey` differs from the derived value are
 *     written, so re-running converges and does no work.
 *   - Read-only against Postgres; writes only `clientKey` on Mongo documents.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/backfillConversationClientKeys.ts
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/backfillConversationClientKeys.ts --apply
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/backfillConversationClientKeys.ts --apply --blank-key=acme
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/backfillConversationClientKeys.ts --apply --leave-blanks
 */
import "reflect-metadata";
import mongoose from "mongoose";
import { DataSource } from "typeorm";
import ReactorConversationMessage from "../models/ReactorConversationMessage";
import {
  CONVERSATIONS_COLLECTION,
  resolveMongoUri,
  resolvePgConfig,
  redactPg,
  redactUri,
  STORE_TABLE,
  Reporter,
} from "./lib/instanceProbe";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LEAVE_BLANKS = args.includes("--leave-blanks");
const BLANK_KEY =
  args.find((arg) => arg.startsWith("--blank-key="))?.split("=")[1] ||
  process.env.REACTOR_SCRIPT_CLIENT_KEY ||
  "reactory";

const createDataSource = (): DataSource => {
  const pg = resolvePgConfig();
  return new DataSource({
    type: "postgres",
    host: pg.host,
    port: pg.port,
    username: pg.user,
    password: pg.password,
    database: pg.database,
    ssl: pg.ssl,
    synchronize: false,
    entities: [ReactorConversationMessage],
  });
};

const run = async () => {
  const reporter = new Reporter("Backfill conversation clientKey (WP-B2)");

  const pg = resolvePgConfig();
  const mongoUri = resolveMongoUri();
  reporter.banner(` mode        : ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  reporter.banner(` postgres    : ${redactPg(pg)}`);
  reporter.banner(` mongo       : ${redactUri(mongoUri)}`);
  reporter.banner(` blank-key   : ${LEAVE_BLANKS ? "(leave blanks unstamped)" : BLANK_KEY}`);

  const dataSource = createDataSource();
  try {
    await dataSource.initialize();
  } catch (error: any) {
    reporter.notApplicable("clientKey backfill", `message store unreachable: ${error?.message ?? error}`);
    if (APPLY) {
      console.log("  REFUSING TO WRITE: asked to apply against a store it cannot reach.");
      process.exit(2);
    }
    process.exit(reporter.finish());
  }

  // Fail fast if the table is missing: with no rows, every conversation would fall into
  // the "blank" bucket for the wrong reason.
  try {
    await dataSource.query(`SELECT 1 FROM ${STORE_TABLE} LIMIT 1`);
  } catch (error: any) {
    reporter.notApplicable("clientKey backfill", `${STORE_TABLE} does not exist: ${error?.message ?? error}`);
    await dataSource.destroy();
    if (APPLY) {
      console.log("  REFUSING TO WRITE: the message table is not ready.");
      process.exit(2);
    }
    process.exit(reporter.finish());
  }

  // conversation_id -> the distinct client keys its message rows carry.
  const rows: Array<{ conversation_id: string; client_key: string | null }> = await dataSource.query(
    `SELECT DISTINCT conversation_id, client_key FROM ${STORE_TABLE}`
  );
  const keysByConversation = new Map<string, Set<string>>();
  for (const row of rows ?? []) {
    const id = String(row.conversation_id ?? "").trim();
    if (!id) continue;
    const key = row.client_key != null ? String(row.client_key).trim() : "";
    const set = keysByConversation.get(id) ?? new Set<string>();
    if (key) set.add(key);
    keysByConversation.set(id, set);
  }

  await mongoose.connect(mongoUri);
  const collection = mongoose.connection.collection(CONVERSATIONS_COLLECTION);

  const cursor = collection.find({}, { projection: { _id: 1, clientKey: 1 } });

  let total = 0;
  let alreadyCorrect = 0;
  let stampFromMessages = 0;
  let stampBlank = 0;
  let leftBlank = 0;
  let conflicts = 0;
  const writes: Array<{ _id: any; clientKey: string }> = [];
  /** How many conversations would land on each client key — the distribution to sanity-check first. */
  const keyDistribution = new Map<string, number>();

  for await (const doc of cursor as any) {
    total += 1;
    const id = String(doc._id);
    const current = doc.clientKey != null ? String(doc.clientKey).trim() : null;
    const keys = keysByConversation.get(id);

    let desired: string | null = null;
    if (keys && keys.size === 1) {
      desired = [...keys][0];
    } else if (keys && keys.size > 1) {
      // A conversation may belong to exactly one tenant (assertConversationTenant). More
      // than one key here means the invariant was already broken; report it and touch
      // nothing rather than pick a winner arbitrarily.
      conflicts += 1;
      reporter.log(`conflict ${id}: message rows carry ${[...keys].join(", ")} — left as-is`);
      continue;
    } else {
      // No message rows: cannot attribute from data.
      if (LEAVE_BLANKS) {
        leftBlank += 1;
        continue;
      }
      desired = BLANK_KEY;
    }

    if (current === desired) {
      alreadyCorrect += 1;
      continue;
    }

    if (keys && keys.size === 1) stampFromMessages += 1;
    else stampBlank += 1;

    keyDistribution.set(desired, (keyDistribution.get(desired) ?? 0) + 1);
    writes.push({ _id: doc._id, clientKey: desired });
  }

  reporter.section("Result");
  reporter.log(`conversations scanned       : ${total}`);
  reporter.log(`already correct             : ${alreadyCorrect}`);
  reporter.log(`stamp from message rows     : ${stampFromMessages}`);
  reporter.log(`stamp blank (no rows)       : ${stampBlank}`);
  reporter.log(`left blank (--leave-blanks) : ${leftBlank}`);
  reporter.log(`conflicts (skipped)         : ${conflicts}`);

  if (keyDistribution.size > 0) {
    reporter.section("Distribution by owning client (what the writes would apply)");
    [...keyDistribution.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([key, count]) => reporter.log(`${count.toString().padStart(6)}  ${key}`));
  }

  if (!APPLY) {
    reporter.banner("\nDRY RUN — no writes. Re-run with --apply to stamp the values above.");
  } else if (writes.length > 0) {
    const operations = writes.map((write) => ({
      updateOne: {
        filter: { _id: write._id },
        update: { $set: { clientKey: write.clientKey } },
      },
    }));
    // Chunked so a large instance does not build one unbounded command.
    const CHUNK = 1000;
    let applied = 0;
    for (let i = 0; i < operations.length; i += CHUNK) {
      const result = await collection.bulkWrite(operations.slice(i, i + CHUNK), { ordered: false });
      applied += result.modifiedCount ?? 0;
    }
    reporter.banner(`\nAPPLIED — ${applied} conversation(s) stamped.`);
  } else {
    reporter.banner("\nAPPLIED — nothing to change.");
  }

  await mongoose.disconnect();
  await dataSource.destroy();
  process.exit(reporter.finish());
};

run().catch(async (error: any) => {
  console.error(`clientKey backfill failed: ${error?.message ?? error}`);
  try {
    await mongoose.disconnect();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
