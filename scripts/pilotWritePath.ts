#!/usr/bin/env node
/**
 * Phase 3c step 1 — controlled write-path pilot (WRITES a throwaway, then deletes it).
 *
 * This is the §43.3 pilot run again with the assertion REVERSED. That earlier run proved the *read*
 * path by removing the array and showing the model still answered; it then discovered that the array
 * **came back** (its own `$push` had re-created it). Here the pass condition is that it does not.
 *
 * Portable by construction. The script **sets the source itself** for each phase, so the phases mean
 * the same thing on every instance; what the instance decides is only whether the store-dependent
 * phases apply. Run it on an un-migrated deployment and you still get the policy's core guarantees
 * verified, with the store checks reported as NOT APPLICABLE rather than guessed at.
 *
 * The control is the point of the whole thing: the identical append is fired first with the source
 * set to `mongo`, where it MUST grow the array. If the control does not grow it, the instrument is
 * broken and the later "it did not grow" result proves nothing. A test that cannot fail is not
 * evidence — a lesson this migration has paid for repeatedly.
 *
 * Usage:
 *   TS_NODE_TRANSPILE_ONLY=true NODE_PATH=./ ./node_modules/.bin/env-cmd --no-override -f ./.env \
 *     node -r ts-node/register -r tsconfig-paths/register \
 *     src/modules/reactory-reactor/scripts/pilotWritePath.ts [--keep] [--require-applicable]
 *
 *   --keep                do not delete the throwaway conversation (default is to delete and verify)
 *   --require-applicable  fail if nothing on this instance was checkable
 */
import "reflect-metadata";
import mongoose from "mongoose";
import ReactorConversationModel from "../models/ReactorChatState";
import ReactorConversationService from "../services/reactor/ReactorConversationService";
import ReactorConversationMessageService from "../services/reactor/ReactorConversationMessageService";
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
import { Client } from "pg";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");

/** Set the source for BOTH accepted keys, so a conflicting-config warning cannot muddy the run. */
const setSource = (value: "mongo" | "postgres") => {
  process.env.REACTOR_MESSAGES_SOURCE = value;
  process.env.REACTOR_MESSAGE_SOURCE = value;
};

/**
 * Fire the exact append a chat turn fires, and hand back the query too — the policy records what it
 * stripped on the query, which is how the hook is proven to have run in the real middleware chain
 * rather than assumed to have.
 */
const appendHistoryItem = async (conversationId: string, item: Record<string, unknown>) => {
  const query: any = ReactorConversationModel.findOneAndUpdate(
    { _id: conversationId },
    { $push: { history: item }, $set: { updated: new Date() } },
    { new: true }
  );
  const updated = await query.exec();
  return { updated, query };
};

const run = async () => {
  const reporter = new Reporter("Phase 3c step 1 — write-path pilot", {
    requireApplicable: hasRequireApplicable(args),
  });

  const pgConfig = resolvePgConfig();
  const probe = await probeInstance({ pgConfig, mongoUri: resolveMongoUri() });

  reporter.banner(` WRITES a throwaway conversation, then deletes it`);
  reporter.banner(` postgres : ${redactPg(pgConfig)}`);
  reporter.banner(` mongodb  : ${redactUri(resolveMongoUri())}`);
  reporter.banner(` instance : ${probe.expectations.describe}`);
  probe.notes.forEach((note) => reporter.banner(` note: ${note}`));
  reporter.banner(
    ` the phases below SET the source themselves, so they run the same way here; ` +
      `only the store-dependent checks depend on this instance.`
  );

  if (!probe.mongo.reachable || !probe.mongo.collectionExists) {
    reporter.notApplicable("write-path pilot", "the conversations collection is not reachable here");
    process.exit(reporter.finish());
  }

  // The probe above uses a raw client; the store service needs the ORM DataSource initialised
  // before `isAvailable()` can be true. Skipping this made every store check report NOT
  // APPLICABLE while the table held 41k rows — a silent pass hiding an untested path.
  if (probe.store.tableExists) {
    const { ReactorPostgresDataSource } = require("../models");
    if (!ReactorPostgresDataSource.isInitialized) await ReactorPostgresDataSource.initialize();
  }
  const store = new ReactorConversationMessageService();
  const storeAvailable = probe.store.tableExists && store.isAvailable();

  const collection = mongoose.connection.collection(CONVERSATIONS_COLLECTION);
  const rawDoc = (conversationId: string) =>
    collection.findOne({ _id: new mongoose.Types.ObjectId(conversationId) });

  let client: Client | null = null;
  if (storeAvailable) {
    client = new Client(pgConfig);
    await client.connect();
  }

  const conversationId = new mongoose.Types.ObjectId().toString();
  const userId = new mongoose.Types.ObjectId();

  // ══ Phase 1 — create the throwaway ═══════════════════════════════════════════════════════════
  reporter.section("Phase 1 — create throwaway (a new document; the policy exempts new documents)");
  setSource("postgres");

  const systemItem: Record<string, unknown> = {
    id: new mongoose.Types.ObjectId(),
    role: "system",
    content: `Phase3c write-path pilot ${conversationId}`,
    timestamp: new Date(),
    tool_results: [],
  };

  await new ReactorConversationModel({
    _id: new mongoose.Types.ObjectId(conversationId),
    personaId: `PilotPersona-${conversationId.slice(-6)}`,
    user: userId,
    modelId: "pilot-model",
    providerId: "pilot-provider",
    started: new Date(),
    history: [systemItem],
    vars: {},
    meta: { title: "Phase3c write-path pilot" },
    macros: [],
    tools: [],
    toolApprovalMode: "prompt",
  }).save();

  const created = await rawDoc(conversationId);
  reporter.check(
    "new document's history was persisted (the documented creation exemption holds)",
    Array.isArray((created as any)?.history) && (created as any).history.length === 1,
    `history=${(created as any)?.history?.length ?? "absent"}`
  );

  const unsetArrays = async () =>
    collection.updateOne(
      { _id: new mongoose.Types.ObjectId(conversationId) },
      { $unset: { history: "", truncatedHistory: "" } }
    );

  await unsetArrays();
  const cleared: any = await rawDoc(conversationId);
  reporter.check(
    "setup — arrays removed via the native driver (bypasses middleware)",
    !("history" in (cleared ?? {})) && !("truncatedHistory" in (cleared ?? {}))
  );

  // ══ Phase 2 — CONTROL: the instrument must be able to detect growth ══════════════════════════
  reporter.section("Phase 2 — CONTROL: source=mongo, the same append MUST grow the array");
  setSource("mongo");

  const controlItem: Record<string, unknown> = {
    id: new mongoose.Types.ObjectId(),
    role: "user",
    content: "control turn — source is mongo",
    timestamp: new Date(),
    tool_results: [],
  };
  const control = await appendHistoryItem(conversationId, controlItem);
  const afterControl: any = await rawDoc(conversationId);

  reporter.check(
    "control append grew the array (the instrument can detect growth)",
    Array.isArray(afterControl?.history) && afterControl.history.length === 1,
    `history=${afterControl?.history?.length ?? "absent"}`
  );
  reporter.check(
    "control append was NOT stripped (the policy is inactive under mongo)",
    !control.query.__embeddedHistoryAppendsStripped
  );

  // ══ Phase 3 — TEST: the array must not come back ═════════════════════════════════════════════
  await unsetArrays();
  reporter.section("Phase 3 — TEST: source=postgres, the same append must NOT re-create the array");
  setSource("postgres");

  const userItem: Record<string, unknown> = {
    id: new mongoose.Types.ObjectId(),
    role: "user",
    content: "pilot turn — remember codeword ZAMBEZI-7734",
    timestamp: new Date(),
    tool_results: [],
  };
  const userAppend = await appendHistoryItem(conversationId, userItem);
  const afterUser: any = await rawDoc(conversationId);

  reporter.check(
    "the hook recorded the strip on the query (it ran in the real middleware chain)",
    Array.isArray(userAppend.query.__embeddedHistoryAppendsStripped) &&
      userAppend.query.__embeddedHistoryAppendsStripped.includes("$push.history"),
    JSON.stringify(userAppend.query.__embeddedHistoryAppendsStripped ?? null)
  );
  reporter.check(
    "the returned document did not gain the item",
    !Array.isArray((userAppend.updated as any)?.history) ||
      (userAppend.updated as any).history.length === 0,
    `returned history=${(userAppend.updated as any)?.history?.length ?? "absent"}`
  );
  reporter.check(
    "the stored document still has NO history — the array did not come back",
    !("history" in (afterUser ?? {})),
    `stored history=${afterUser?.history?.length ?? "absent"}`
  );

  const assistantItem: Record<string, unknown> = {
    id: new mongoose.Types.ObjectId(),
    role: "assistant",
    content: "OK",
    timestamp: new Date(),
    tool_results: [],
  };
  const assistantAppend = await appendHistoryItem(conversationId, assistantItem);
  const afterAssistant: any = await rawDoc(conversationId);

  reporter.check(
    "the second append (assistant) was also stripped",
    Array.isArray(assistantAppend.query.__embeddedHistoryAppendsStripped) &&
      assistantAppend.query.__embeddedHistoryAppendsStripped.includes("$push.history")
  );
  reporter.check(
    "the stored document still has NO history after a full turn's appends",
    !("history" in (afterAssistant ?? {})),
    `stored history=${afterAssistant?.history?.length ?? "absent"}`
  );

  // ══ Phase 4 — the mirror: the real method, so selection and minting are the shipped logic ════
  reporter.section("Phase 4 — mirror the two appends via the real mirrorPersistedAppend");

  if (!storeAvailable) {
    reporter.notApplicable(
      "two rows mirrored for the two appends",
      `no usable ${STORE_TABLE} on this instance (${probe.store.reason ?? "absent"})`
    );
    reporter.notApplicable("rows keyed on the provisional ids", "no message store on this instance");
    reporter.notApplicable("provisional id written back as _id", "no message store on this instance");
  } else {
    const svc: any = Object.create(ReactorConversationService.prototype);
    const noop = (): void => undefined;
    svc.context = { user: { _id: userId }, error: noop, warn: noop };
    svc.sessionLog = (level: string, message: string, data?: any) =>
      reporter.log(`[${level}] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);

    await svc.mirrorPersistedAppend(conversationId, userAppend.updated, userItem);
    await svc.mirrorPersistedAppend(conversationId, assistantAppend.updated, assistantItem);

    const rows = await client!.query<{ mongo_id: string; role: string; seq: string }>(
      `SELECT btrim(mongo_id::text) AS mongo_id, role, seq
         FROM ${STORE_TABLE}
        WHERE btrim(conversation_id::text) = $1
        ORDER BY seq ASC`,
      [conversationId]
    );
    const storedIds = rows.rows.map((row) => row.mongo_id);

    reporter.check("two rows were mirrored for the two appends", rows.rows.length === 2, `rows=${rows.rows.length}`);
    reporter.check(
      "the user row is keyed on the item's provisional id (minted, not Mongo-assigned)",
      storedIds.includes(String(userItem.id)),
      `expected ${String(userItem.id)}; got ${JSON.stringify(storedIds)}`
    );
    reporter.check("the assistant row is keyed on its provisional id", storedIds.includes(String(assistantItem.id)));
    reporter.check(
      "the provisional id was written back onto the in-memory object as _id " +
        "(so a later mutation keys on the value the row carries)",
      String((userItem as any)._id ?? "") === String(userItem.id),
      `_id=${String((userItem as any)._id ?? "absent")}`
    );
  }

  // ══ The §43.4 symptom, stated as an assertion ════════════════════════════════════════════════
  const finalDoc: any = await rawDoc(conversationId);
  reporter.check(
    "FINAL — after a full turn's writes, the Mongo array is still absent",
    !("history" in (finalDoc ?? {})) && !("truncatedHistory" in (finalDoc ?? {}))
  );

  // ══ Cleanup ══════════════════════════════════════════════════════════════════════════════════
  reporter.section("Cleanup");
  if (KEEP) {
    reporter.banner(`   --keep given; throwaway ${conversationId} left in place for inspection`);
  } else {
    let storeRowsDeleted = 0;
    if (storeAvailable) storeRowsDeleted = await store.deleteForConversation(conversationId);
    await collection.deleteOne({ _id: new mongoose.Types.ObjectId(conversationId) });
    const stillThere = await rawDoc(conversationId);

    if (storeAvailable) {
      const left = await client!.query(
        `SELECT count(*)::int AS n FROM ${STORE_TABLE} WHERE btrim(conversation_id::text) = $1`,
        [conversationId]
      );
      reporter.check(
        "throwaway removed from both stores",
        !stillThere && left.rows[0].n === 0,
        `pg rows deleted=${storeRowsDeleted}, remaining=${left.rows[0].n}`
      );
    } else {
      reporter.check("throwaway removed from Mongo", !stillThere);
    }
  }

  if (client) await client.end();
  await mongoose.disconnect();
  process.exit(reporter.finish());
};

run().catch(async (error: any) => {
  console.error(`Write-path pilot failed: ${error?.message ?? error}`);
  try {
    await mongoose.disconnect();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
