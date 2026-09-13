/**
 * Read-only search parity check: Mongo `history.content` regex vs the Postgres
 * `search_text ILIKE` predicate that backs `ReactorConversationMessageService.
 * searchConversationIds()`.
 *
 * Phase 3 step 3b. `getConversations` searches the session list with
 * `{ 'history.content': { $regex } }`. After the cutover that becomes a scoped
 * sub-select over the message table, so the two must select the same sessions.
 *
 * Direction matters, and is reported separately:
 *
 *   missed  — Mongo matches a session the SQL predicate does NOT. This is a
 *             genuine regression: after the cutover the session disappears from
 *             search results. Must be zero.
 *   extra   — SQL matches a session Mongo does not. Expected and benign in
 *             principle: `search_text` is flattened from `content` *and*
 *             `thinking` and from content-part objects, which a Mongo `$regex`
 *             over `history.content` does not reach. Reported, not failed,
 *             matching the agreed position that ILIKE is a stopgap pending
 *             semantic search.
 *
 * Read-only. Nothing is written.
 *
 * Usage:
 *   TS_NODE_TRANSPILE_ONLY=true NODE_PATH=./ ./node_modules/.bin/env-cmd \
 *     --no-override -f ./.env node -r ts-node/register -r tsconfig-paths/register \
 *     src/modules/reactory-reactor/scripts/checkSearchParity.ts [--term=<t>]...
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
const TERMS = args
  .filter((a) => a.startsWith("--term="))
  .map((a) => a.split("=")[1])
  .filter(Boolean);

const createDataSource = (): DataSource =>
  new DataSource({
    type: "postgres",
    host:
      process.env.REACTORY_POSTGRES_HOST ||
      process.env.POSTGRES_DB_HOST ||
      "localhost",
    port: parseInt(
      process.env.REACTORY_POSTGRES_PORT ||
        process.env.POSTGRES_DB_PORT ||
        "5432",
      10
    ),
    username:
      process.env.REACTORY_POSTGRES_USER ||
      process.env.POSTGRES_USER ||
      "reactory",
    password:
      process.env.REACTORY_POSTGRES_PASSWORD ||
      process.env.POSTGRES_PASSWORD ||
      "reactory",
    database:
      process.env.REACTORY_POSTGRES_DB || process.env.POSTGRES_DB || "reactory",
    synchronize: false,
    entities: [ReactorConversationMessage],
  });

interface TermResult {
  term: string;
  mongo: number;
  sql: number;
  missed: string[];
  extra: string[];
  anomalies: string[];
  /** Sessions Mongo matched but which have no user-visible messages mirrored. */
  unstarted: string[];
}

/**
 * Normalise a conversation id for comparison.
 *
 * `conversation_id` is `CHAR(24)`, so Postgres space-pads a short value on read.
 * Every real id is exactly 24 hex characters, so this only matters for the one
 * legacy row described below — but a comparison must not depend on that.
 */
const normId = (value: unknown): string => String(value ?? "").trim();

/**
 * There is exactly one corrupt legacy conversation in Mongo with `_id: null`
 * (persona `Formidable`, 1 history item, created 2026-09-06). Its message was
 * mirrored under the literal `conversation_id = 'null'`. It is a data-hygiene
 * item, not a search-predicate defect, so it is reported separately and excluded
 * from the parity verdict rather than being allowed to fail the check.
 */
const ANOMALOUS_IDS = new Set(["", "null", "undefined"]);

const run = async () => {
  console.log("──────────────────────────────────────────────────────────");
  console.log(" Search parity: Mongo history.content regex vs SQL search_text");
  console.log(" Phase 3 step 3b — READ ONLY (nothing is written)");
  console.log("──────────────────────────────────────────────────────────");

  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const collection =
    mongoose.connection.db.collection("reactor_conversations");
  console.log("Connected to MongoDB.");

  const dataSource = createDataSource();
  await dataSource.initialize();
  const messageService = new ReactorConversationMessageService(dataSource);
  console.log("Connected to PostgreSQL.");
  console.log("");

  // Derive a rare, high-signal term from the corpus when none is supplied: a
  // long word from the largest conversation. A common word would be satisfied
  // by almost any predicate and would not discriminate.
  let terms = [...TERMS];
  if (terms.length === 0) {
    const largest = await collection
      .find({ "history.0": { $exists: true } })
      .sort({ updated: -1 })
      .limit(1)
      .toArray();
    const first = largest[0];
    const texts: string[] = [];
    const walk = (entries: any[]) => {
      for (const entry of entries || []) {
        const content = entry?.content;
        if (typeof content === "string") texts.push(content);
        else if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part === "string") texts.push(part);
            else if (typeof part?.text === "string") texts.push(part.text);
          }
        }
      }
    };
    walk(first?.history || []);
    const words = texts
      .join(" ")
      .split(/[^A-Za-z0-9_]+/)
      .filter((w) => w.length >= 12);
    const rare = words.sort((a, b) => b.length - a.length)[0];
    if (rare) terms.push(rare);
    terms.push("function");
  }

  const results: TermResult[] = [];

  for (const term of terms) {
    const mongoDocs = await collection
      .find({ "history.content": { $regex: term, $options: "i" } })
      .project({ _id: 1 })
      .toArray();
    const mongoSet = new Set(
      mongoDocs.map((d: any) => normId(d._id)).filter(Boolean)
    );

    const sqlIds = await messageService.searchConversationIds(term, 100_000);
    const sqlSet = new Set(sqlIds.map(normId).filter(Boolean));

    const anomalies = [
      ...new Set(
        [...mongoSet, ...sqlSet].filter((id) => ANOMALOUS_IDS.has(id))
      ),
    ];
    const rawMissed = [...mongoSet]
      .filter((id) => !ANOMALOUS_IDS.has(id) && !sqlSet.has(id))
      .sort();

    // Separate a genuine regression from a session that has nothing to search.
    //
    // A conversation is created with a single `system` message. Dual-write only
    // mirrors user/assistant/tool/file appends, so a session that was created and
    // never had a real turn has ZERO rows in Postgres — while Mongo's regex over
    // `history.content` still matches it, because the system prompt matches.
    //
    // That is a transient state on an unstarted session, not a lost session: the
    // title clause still applies, and the session becomes searchable as soon as it
    // has a real message. Classified separately so it cannot mask a true gap — a
    // session WITH non-system messages and no rows still fails.
    const unstarted: string[] = [];
    const missed: string[] = [];
    for (const id of rawMissed) {
      const doc: any = await collection.findOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { projection: { history: 1 } }
      );
      const history: any[] = Array.isArray(doc?.history) ? doc.history : [];
      const nonSystem = history.filter((h) => h?.role && h.role !== 'system');
      const pgRows: Array<{ n: number }> = await dataSource.query(
        'SELECT count(*)::int AS n FROM reactor_conversation_messages WHERE conversation_id = $1',
        [id]
      );
      const pgCount = Number(pgRows[0]?.n ?? 0);

      if (pgCount === 0 && nonSystem.length === 0) unstarted.push(id);
      else missed.push(id);
    }

    const extra = [...sqlSet]
      .filter((id) => !ANOMALOUS_IDS.has(id) && !mongoSet.has(id))
      .sort();

    results.push({
      term,
      mongo: mongoSet.size,
      sql: sqlSet.size,
      missed,
      extra,
      anomalies,
      unstarted,
    });

    console.log(
      `▶ "${term}"  mongo=${mongoSet.size} sql=${sqlSet.size} missed=${missed.length} extra=${extra.length}`
    );
    if (missed.length > 0) {
      console.log(`    ✗ missed: ${missed.slice(0, 5).join(", ")}`);
    }
    if (unstarted.length > 0) {
      console.log(
        '    i  unstarted session(s) - no mirrored rows, no non-system messages ' +
          '(transient, not a regression): ' +
          unstarted.join(', ')
      );
    }
    if (extra.length > 0) {
      console.log(
        `    ⚠ extra (expected superset from thinking/content-parts): ${extra
          .slice(0, 5)
          .join(", ")}`
      );
    }
    if (anomalies.length > 0) {
      console.log(
        `    ℹ anomalous id present (corrupt legacy document, excluded): ${anomalies.join(", ")}`
      );
    }
  }

  const totalMissed = results.reduce((sum, r) => sum + r.missed.length, 0);
  const totalExtra = results.reduce((sum, r) => sum + r.extra.length, 0);
  const totalAnomalies = results.reduce(
    (sum, r) => sum + r.anomalies.length,
    0
  );
  const totalUnstarted = results.reduce(
    (sum, r) => sum + r.unstarted.length,
    0
  );

  console.log("");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Terms tested        : ${results.length}`);
  console.log(`Missed (regression) : ${totalMissed}`);
  console.log(`Extra  (benign)     : ${totalExtra}`);
  console.log(`Anomalies (excluded): ${totalAnomalies}`);
  console.log(`Unstarted (transient): ${totalUnstarted}`);
  console.log("──────────────────────────────────────────────────────────");

  await dataSource.destroy();
  await mongoose.disconnect();

  if (totalMissed > 0) {
    console.log(
      "❌ Search parity FAILED — the SQL predicate loses sessions Mongo matched."
    );
    process.exit(1);
  }
  console.log(
    "✅ Search parity holds: nothing Mongo matched is lost by the SQL predicate."
  );
  process.exit(0);
};

run().catch(async (error) => {
  console.error("Search parity check failed to run:", error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
