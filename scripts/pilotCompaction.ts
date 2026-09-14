#!/usr/bin/env node
/**
 * Phase 3c step 1b — truncation / compaction exercise (WRITES throwaways, then deletes them).
 *
 * This is the gate that no existing harness provided, and its absence is exactly how "a displacement
 * is only ever recorded in the Mongo array" survived a full phase of verification.
 *
 * It adapts to the instance, because truncation *means* something different depending on where the
 * transcript lives:
 *
 *  - **Store mode** (`postgres`, store present): the displaced rows must become `archived` with the
 *    right reason, the **system prompt must stay active**, and compaction must place its summary
 *    immediately ahead of the kept messages — which needs a `seq` shift, because every slot below
 *    the first kept message is taken.
 *  - **Array mode** (un-migrated, or `mongo`): there is no store to assert against, so the check
 *    asserts the array rewrite instead — `history` shrinks to system + kept and `truncatedHistory`
 *    grows by exactly the displaced count. Skipping the exercise entirely would have been the easy
 *    option and the wrong one: this is the behaviour every other instance runs today.
 *
 * Compaction's *summary generation* is not exercised in either mode — it calls the LLM. The new code
 * is the archiving and the placement, and those are what run.
 *
 * Usage:
 *   TS_NODE_TRANSPILE_ONLY=true NODE_PATH=./ ./node_modules/.bin/env-cmd --no-override -f ./.env \
 *     node -r ts-node/register -r tsconfig-paths/register \
 *     src/modules/reactory-reactor/scripts/pilotCompaction.ts [--keep] [--require-applicable]
 */
import "reflect-metadata";
import mongoose from "mongoose";
import { Client } from "pg";
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

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");

const setSource = (value: "mongo" | "postgres") => {
  process.env.REACTOR_MESSAGES_SOURCE = value;
  process.env.REACTOR_MESSAGE_SOURCE = value;
};

const FILLER =
  "The quick brown fox jumps over the lazy dog while the reactor core is being migrated to " +
  "Postgres and every message is accounted for one row at a time. ";

/** A stub carrying just what these methods touch, built on the real prototype. */
const makeService = (userId: mongoose.Types.ObjectId) => {
  const svc: any = Object.create(ReactorConversationService.prototype);
  const noop = (): void => undefined;
  svc.context = { user: { _id: userId }, error: noop, warn: noop, info: noop, debug: noop, log: noop };
  svc.sessionLog = (level: string, message: string, data?: any) =>
    console.log(`      [${level}] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
  return svc;
};

const historyItems = (exchanges: number, startIndex = 0) => {
  const items: any[] = [];
  for (let i = 1; i <= exchanges; i += 1) {
    items.push({
      id: new mongoose.Types.ObjectId(),
      role: "user",
      content: `turn ${startIndex + i} question. ${FILLER}`,
      timestamp: new Date(),
      tool_results: [],
    });
    items.push({
      id: new mongoose.Types.ObjectId(),
      role: "assistant",
      content: `turn ${startIndex + i} answer. ${FILLER}`,
      timestamp: new Date(),
      tool_results: [],
    });
  }
  return items;
};

const run = async () => {
  const reporter = new Reporter("Phase 3c step 1b — truncation / compaction exercise", {
    requireApplicable: hasRequireApplicable(args),
  });

  const pgConfig = resolvePgConfig();
  const probe = await probeInstance({ pgConfig, mongoUri: resolveMongoUri() });

  reporter.banner(` WRITES throwaways, then deletes them`);
  reporter.banner(` postgres : ${redactPg(pgConfig)}`);
  reporter.banner(` mongodb  : ${redactUri(resolveMongoUri())}`);
  reporter.banner(` instance : ${probe.expectations.describe}`);
  probe.notes.forEach((note) => reporter.banner(` note: ${note}`));

  if (!probe.mongo.reachable || !probe.mongo.collectionExists) {
    reporter.notApplicable("truncation / compaction", "the conversations collection is not reachable here");
    process.exit(reporter.finish());
  }

  // The probe uses a raw client; the store service needs the ORM DataSource initialised before
  // `isAvailable()` can be true — otherwise this falls to "array mode" on a migrated instance and
  // the store-side assertions never run. Held in an outer binding because the naive-shift probe
  // further down also needs it.
  let dataSource: any = null;
  if (probe.store.tableExists) {
    dataSource = require("../models").ReactorPostgresDataSource;
    if (!dataSource.isInitialized) await dataSource.initialize();
  }
  const store = new ReactorConversationMessageService();
  const storeUsable = probe.store.tableExists && store.isAvailable();
  const mode: "store" | "array" = storeUsable ? "store" : "array";

  reporter.banner(` mode     : ${mode === "store" ? "store — displacements become archived rows" : "array — displacements rewrite the Mongo arrays"}`);

  let client: Client | null = null;
  if (mode === "store") {
    client = new Client(pgConfig);
    await client.connect();
  }

  const collection = mongoose.connection.collection(CONVERSATIONS_COLLECTION);
  const userId = new mongoose.Types.ObjectId();
  const svc = makeService(userId);
  const created: string[] = [];

  const newConversationId = async (history: any[] | undefined) => {
    const conversationId = new mongoose.Types.ObjectId().toString();
    created.push(conversationId);
    await new ReactorConversationModel({
      _id: new mongoose.Types.ObjectId(conversationId),
      personaId: `PilotPersona-${conversationId.slice(-6)}`,
      user: userId,
      modelId: "pilot-model",
      providerId: "pilot-provider",
      started: new Date(),
      ...(history ? { history } : {}),
      vars: {},
      meta: { title: "Phase3c compaction pilot" },
      macros: [],
      tools: [],
      toolApprovalMode: "prompt",
    }).save();
    return conversationId;
  };

  // ══ Exercise 1 — truncation ══════════════════════════════════════════════════════════════════
  reporter.section(
    mode === "store"
      ? "Exercise 1 — truncateConversationHistory, array absent, source=postgres"
      : "Exercise 1 — truncateConversationHistory, array authoritative, source=mongo"
  );
  setSource(mode === "store" ? "postgres" : "mongo");

  const truncId = await newConversationId(mode === "store" ? undefined : []);
  const systemItem: any = {
    id: new mongoose.Types.ObjectId(),
    role: "system",
    content: `You are PilotPersona. Persona prompt for ${truncId}. ${FILLER}`,
    timestamp: new Date(),
    tool_results: [],
  };

  if (mode === "store") {
    await store.appendMessage(truncId, systemItem);
    for (const item of historyItems(6)) await store.appendMessage(truncId, item);
    await collection.updateOne(
      { _id: new mongoose.Types.ObjectId(truncId) },
      { $unset: { history: "" } }
    );
  } else {
    await collection.updateOne(
      { _id: new mongoose.Types.ObjectId(truncId) },
      { $set: { history: [systemItem, ...historyItems(6)] } }
    );
  }

  const readRows = () =>
    client
      ? client.query<{ seq: string; role: string; archived: boolean; reason: string | null; id: string }>(
          `SELECT seq, role, archived, archived_reason AS reason, btrim(mongo_id::text) AS id
             FROM ${STORE_TABLE}
            WHERE btrim(conversation_id::text) = $1
            ORDER BY seq ASC`,
          [truncId]
        )
      : Promise.resolve({ rows: [] as any[] });

  const docOf = async (id: string) =>
    (await collection.findOne({ _id: new mongoose.Types.ObjectId(id) })) as any;

  // Self-calibrating budget: keep the system prompt + the last exchange, force the rest out.
  const asItems =
    mode === "store"
      ? await store.getActiveMessages(truncId)
      : ((await docOf(truncId))?.history ?? []);
  const asPlain = mode === "store" ? store.toMessages(asItems as any) : asItems;
  const tokens = (asPlain as any[]).map((item) => svc.estimateHistoryItemTokens(item));
  const targetTokens = tokens[0] + tokens.slice(-2).reduce((a: number, b: number) => a + b, 0) + 1;

  const beforeRows = await readRows();
  const beforeDoc = await docOf(truncId);

  const result = await svc.truncateConversationHistory(truncId, targetTokens);
  reporter.check("truncation removed messages", result.removedMessages > 0, `removed=${result.removedMessages}`);

  if (mode === "store") {
    const afterRows = await readRows();
    const activeAfter = afterRows.rows.filter((row) => !row.archived);
    const archivedAfter = afterRows.rows.filter((row) => row.archived);

    reporter.check(
      "displaced rows were archived with reason 'truncated'",
      archivedAfter.length > 0 && archivedAfter.every((row) => row.reason === "truncated"),
      `archived=${archivedAfter.length}`
    );
    reporter.check(
      "the SYSTEM PROMPT stayed active (a seq-boundary archive would have taken it)",
      activeAfter.some((row) => row.role === "system"),
      `system rows active=${activeAfter.filter((r) => r.role === "system").length}`
    );
    reporter.check(
      "the active transcript still starts with the system message",
      activeAfter.length > 0 && activeAfter[0].role === "system"
    );
    reporter.check(
      "the first active non-system message is a user message (the charted invariant)",
      activeAfter.filter((row) => row.role !== "system")[0]?.role === "user"
    );
    reporter.check(
      "the kept messages are the NEWEST ones (a suffix, not an arbitrary set)",
      (() => {
        const kept = new Set(activeAfter.filter((row) => row.role !== "system").map((row) => row.id));
        const all = beforeRows.rows.filter((row) => row.role !== "system");
        const expected = new Set(all.slice(all.length - kept.size).map((row) => row.id));
        return [...kept].every((id) => expected.has(id));
      })()
    );
    const dupes = await client!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT seq FROM ${STORE_TABLE}
          WHERE btrim(conversation_id::text) = $1 GROUP BY seq HAVING count(*) > 1) d`,
      [truncId]
    );
    reporter.check("no duplicate seq after truncation", Number(dupes.rows[0].n) === 0);
  } else {
    const afterDoc = await docOf(truncId);
    const historyAfter: any[] = afterDoc?.history ?? [];
    const truncatedAfter: any[] = afterDoc?.truncatedHistory ?? [];
    const beforeHistory: any[] = beforeDoc?.history ?? [];

    reporter.check(
      "the armed array DISPLACED messages into truncatedHistory (source=mongo writes the arrays)",
      truncatedAfter.length === result.removedMessages && truncatedAfter.length > 0,
      `truncatedHistory=${truncatedAfter.length}, removed=${result.removedMessages}`
    );
    reporter.check(
      "history shrank by exactly the displaced count",
      historyAfter.length === beforeHistory.length - result.removedMessages,
      `${beforeHistory.length} -> ${historyAfter.length}`
    );
    reporter.check(
      "the system prompt is still in history",
      historyAfter.some((item) => item?.role === "system")
    );
    reporter.check(
      "the first non-system entry in history is a user message",
      historyAfter.filter((item) => item?.role !== "system")[0]?.role === "user"
    );
    reporter.check(
      "the kept tail is preserved in order",
      (() => {
        const beforeTail = beforeHistory.slice(-historyAfter.filter((i) => i?.role !== "system").length);
        const afterNonSystem = historyAfter.filter((item) => item?.role !== "system");
        return beforeTail.length === afterNonSystem.length &&
          beforeTail.every((item, index) => String(item.id) === String(afterNonSystem[index]?.id));
      })()
    );
  }

  // ══ Exercise 2 — compaction's placement primitive ════════════════════════════════════════════
  reporter.section("Exercise 2 — compaction: archive a prefix by id, then place the summary ahead of kept");

  if (mode !== "store") {
    reporter.notApplicable(
      "prefix archived by id",
      "no message store on this instance — archiving is a store concept"
    );
    reporter.notApplicable("summary inserted ahead of the kept messages", "no message store on this instance");
    reporter.notApplicable("no row lost or duplicated by the seq shift", "no message store on this instance");
    reporter.notApplicable("active read order is [system…, summary, …kept]", "no message store on this instance");
  } else {
    const compId = await newConversationId(undefined);
    await store.appendMessage(compId, {
      id: new mongoose.Types.ObjectId(),
      role: "system",
      content: `You are PilotPersona. ${FILLER}`,
      timestamp: new Date(),
      tool_results: [],
    });
    for (const item of historyItems(5)) await store.appendMessage(compId, item);
    await collection.updateOne({ _id: new mongoose.Types.ObjectId(compId) }, { $unset: { history: "" } });

    const rowsBefore = await client!.query<{ seq: string; role: string; id: string }>(
      `SELECT seq, role, btrim(mongo_id::text) AS id FROM ${STORE_TABLE}
        WHERE btrim(conversation_id::text) = $1 ORDER BY seq ASC`,
      [compId]
    );
    const nonSystem = rowsBefore.rows.filter((row) => row.role !== "system");
    const toArchive = nonSystem.slice(0, 6);
    const kept = nonSystem.slice(6);

    const archived = await store.archiveByMongoIds(
      toArchive.map((row) => row.id),
      "compacted"
    );
    reporter.check("prefix archived by id", archived === toArchive.length, `archived=${archived}/${toArchive.length}`);

    const summary: any = {
      id: new mongoose.Types.ObjectId(),
      role: "system",
      content: "[Conversation Compaction Summary] earlier messages were archived and replaced with this summary.",
      timestamp: new Date(),
      tool_results: [],
    };

    const inserted = await store.insertCompactionSummary(compId, summary);
    reporter.check("summary inserted ahead of the kept messages", Boolean(inserted), JSON.stringify(inserted));

    const rowsAfter = await client!.query<{ seq: string; role: string; archived: boolean; id: string }>(
      `SELECT seq, role, archived, btrim(mongo_id::text) AS id FROM ${STORE_TABLE}
        WHERE btrim(conversation_id::text) = $1 ORDER BY seq ASC`,
      [compId]
    );
    const activeAfter = rowsAfter.rows.filter((row) => !row.archived);
    const summaryRow = rowsAfter.rows.find((row) => row.id === String(summary.id));

    reporter.check("the summary row is active", Boolean(summaryRow) && summaryRow!.archived === false);
    reporter.check(
      "the summary sits IMMEDIATELY before the first kept message",
      (() => {
        const keptSeqs = activeAfter.filter((row) => row.role !== "system").map((row) => Number(row.seq));
        return Number(summaryRow!.seq) === Math.min(...keptSeqs) - 1;
      })(),
      `summary seq=${summaryRow?.seq}`
    );
    reporter.check(
      "no row was lost or duplicated by the shift",
      rowsAfter.rows.length === rowsBefore.rows.length + 1,
      `${rowsBefore.rows.length} -> ${rowsAfter.rows.length}`
    );
    reporter.check(
      "no duplicate seq after the shift",
      new Set(rowsAfter.rows.map((row) => row.seq)).size === rowsAfter.rows.length
    );
    reporter.check(
      "kept messages preserved their relative order",
      (() => {
        const keptIds = new Set(kept.map((row) => row.id));
        const observed = activeAfter.filter((row) => keptIds.has(row.id)).map((row) => row.id);
        return observed.length === kept.length && observed.every((id, index) => id === kept[index].id);
      })()
    );
    reporter.check(
      "archived rows are still archived (the shift did not resurrect them)",
      rowsAfter.rows.filter((row) => row.archived).length === toArchive.length,
      `archived=${rowsAfter.rows.filter((row) => row.archived).length}`
    );

    const activeOrder = activeAfter.map((row) => row.role);
    const summaryIndex = activeOrder.indexOf("system") === 0 ? activeOrder.lastIndexOf("system") : -1;
    reporter.check(
      "active read order is [system…, summary, …kept]",
      activeOrder[0] === "system" &&
        summaryIndex > 0 &&
        activeAfter[summaryIndex].id === String(summary.id) &&
        activeAfter.slice(summaryIndex + 1).every((row) => row.role !== "system"),
      activeOrder.join(",")
    );

    // Informational: the naive one-step shift is not merely stylistically inferior. Reported rather
    // than asserted, because whether it survives is order-dependent — which is exactly the point.
    //
    // The three outcomes are kept apart on purpose. Reporting a broken probe as "the shift failed"
    // would be a false positive of the kind this migration has produced eight times over, so a
    // probe that cannot run says so instead of claiming evidence.
    if (!dataSource) {
      reporter.log("note: naive-shift probe skipped (no DataSource on this instance)");
    } else {
      try {
        await dataSource.transaction(async (manager: any): Promise<void> => {
          await manager.query(
            `UPDATE ${STORE_TABLE} SET seq = seq + 1 WHERE conversation_id = $1 AND seq >= $2`,
            [compId, Number(summaryRow!.seq) + 1]
          );
          throw new Error("__ROLLBACK__");
        });
        reporter.log("note: a naive `seq = seq + 1` succeeded here (rolled back) — order-dependent, not a guarantee");
      } catch (error: any) {
        const message = String(error?.message ?? error);
        if (message.includes("__ROLLBACK__")) {
          reporter.log("note: a naive `seq = seq + 1` succeeded here (rolled back) — order-dependent, not a guarantee");
        } else if (/duplicate key|unique constraint/i.test(message)) {
          reporter.log(`note: a naive \`seq = seq + 1\` FAILED here — ${message.split("\n")[0]}`);
        } else {
          reporter.log(`note: the naive-shift probe could not run (${message.split("\n")[0]})`);
        }
      }
    }
  }

  // ══ Cleanup ══════════════════════════════════════════════════════════════════════════════════
  reporter.section("Cleanup");
  if (KEEP) {
    reporter.banner(`   --keep given; left in place: ${created.join(", ")}`);
  } else {
    let allGone = true;
    for (const id of created) {
      if (mode === "store") await store.deleteForConversation(id);
      await collection.deleteOne({ _id: new mongoose.Types.ObjectId(id) });
      const doc = await collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
      let rowsLeft = 0;
      if (client) {
        const left = await client.query(
          `SELECT count(*)::int AS n FROM ${STORE_TABLE} WHERE btrim(conversation_id::text) = $1`,
          [id]
        );
        rowsLeft = left.rows[0].n;
      }
      if (doc || rowsLeft > 0) allGone = false;
    }
    reporter.check("throwaways removed from every store they were written to", allGone);
  }

  if (client) await client.end();
  await mongoose.disconnect();
  process.exit(reporter.finish());
};

run().catch(async (error: any) => {
  console.error(`Compaction exercise failed: ${error?.message ?? error}`);
  console.error(error?.stack?.split("\n").slice(0, 6).join("\n"));
  try {
    await mongoose.disconnect();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
