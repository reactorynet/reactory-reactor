/**
 * Report gaps between Mongo conversation history and the Postgres message log.
 *
 * Read-only diagnostic. For every conversation it compares the Mongo `_id`s (the
 * authoritative transcript) against the `mongo_id`s held in Postgres and reports:
 *
 *   - how many messages each side has
 *   - how many Mongo messages are missing from Postgres
 *   - whether the missing ones sit at the TAIL of the transcript or in the MIDDLE
 *
 * That tail/middle distinction matters: the backfill inserts new rows at their
 * array position, so a tail gap inserts cleanly whereas a middle gap collides
 * with the existing unique `(conversation_id, seq)` guard and must be resolved by
 * re-sequencing rather than positional insert.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/reportMessageGaps.ts
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/reportMessageGaps.ts --limit=20
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/reportMessageGaps.ts --conversation=<id>
 */
import "reflect-metadata";
import mongoose from "mongoose";
import { Client } from "pg";
import { resolveMongoUri, resolvePgConfig } from "./lib/instanceProbe";

const MONGODB_URI = resolveMongoUri();

const args = process.argv.slice(2);
const CONVERSATION = args.find((a) => a.startsWith("--conversation="))?.split("=")[1];
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || 25);

const pgConfig = resolvePgConfig();

interface GapReport {
  conversationId: string;
  mongoCount: number;
  postgresCount: number;
  missing: number;
  missingAtTailOnly: boolean;
  extraInPostgres: number;
}

const run = async () => {
  const client = new Client(pgConfig);
  await client.connect();
  await mongoose.connect(MONGODB_URI as string);

  const conversationFilter: Record<string, any> = CONVERSATION
    ? { _id: new mongoose.Types.ObjectId(CONVERSATION) }
    : { history: { $exists: true, $ne: [] } };

  const cursor = mongoose.connection
    .collection("reactor_conversations")
    .find(conversationFilter, { projection: { history: 1 } });

  const reports: GapReport[] = [];
  let scanned = 0;

  for await (const doc of cursor as any) {
    const conversationId = String(doc._id);
    const history: any[] = Array.isArray(doc.history) ? doc.history : [];
    const mongoIds = history
      .map((item) => String(item?._id ?? item?.id ?? ""))
      .filter(Boolean);

    if (mongoIds.length === 0) continue;
    scanned += 1;

    const { rows } = await client.query(
      `SELECT mongo_id AS "mongoId" FROM reactor_conversation_messages WHERE conversation_id = $1`,
      [conversationId]
    );
    const pgIds = new Set(rows.map((row) => String(row.mongoId)));
    const mongoSet = new Set(mongoIds);

    // Missing: in Mongo, absent from Postgres. Determine if they are only at the tail.
    let firstMissingIndex = -1;
    let missingCount = 0;
    mongoIds.forEach((id, index) => {
      if (!pgIds.has(id)) {
        missingCount += 1;
        if (firstMissingIndex === -1) firstMissingIndex = index;
      }
    });

    const missingAtTailOnly =
      missingCount > 0 && firstMissingIndex === mongoIds.length - missingCount;

    const extraInPostgres = [...pgIds].filter((id) => !mongoSet.has(id)).length;

    if (missingCount > 0 || extraInPostgres > 0) {
      reports.push({
        conversationId,
        mongoCount: mongoIds.length,
        postgresCount: pgIds.size,
        missing: missingCount,
        missingAtTailOnly,
        extraInPostgres,
      });
    }
  }

  console.log("──────────────────────────────────────────────────────────");
  console.log(" Conversation message gap report (read-only)");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Conversations scanned : ${scanned}`);
  console.log(`Conversations with gap: ${reports.length}`);

  const totalMissing = reports.reduce((sum, r) => sum + r.missing, 0);
  const totalExtra = reports.reduce((sum, r) => sum + r.extraInPostgres, 0);
  const middleGaps = reports.filter((r) => r.missing > 0 && !r.missingAtTailOnly);
  const tailGaps = reports.filter((r) => r.missing > 0 && r.missingAtTailOnly);

  console.log(`Mongo messages missing from Postgres : ${totalMissing}`);
  console.log(`Rows in Postgres not in Mongo        : ${totalExtra}`);
  console.log(`  of which tail-only gaps            : ${tailGaps.length} conversation(s)`);
  console.log(`  of which MID-TRANSCRIPT gaps       : ${middleGaps.length} conversation(s)`);

  if (reports.length > 0) {
    console.log("\nTop conversations by missing count:");
    reports
      .slice()
      .sort((a, b) => b.missing - a.missing)
      .slice(0, LIMIT)
      .forEach((r) =>
        console.log(
          `   - ${r.conversationId}  mongo=${r.mongoCount} pg=${r.postgresCount}` +
            `  missing=${r.missing}${r.missing > 0 ? (r.missingAtTailOnly ? " (tail)" : " (MID)") : ""}` +
            `  extra=${r.extraInPostgres}`
        )
      );
  }

  console.log(
    "\nMID-TRANSCRIPT gaps cannot be filled by positional insert: the slot is\n" +
      "already occupied, so the unique (conversation_id, seq) guard rejects it.\n" +
      "Those conversations need a re-sequence after insert."
  );

  await mongoose.disconnect();
  await client.end();
};

run().catch(async (error) => {
  console.error("Gap report error:", error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
