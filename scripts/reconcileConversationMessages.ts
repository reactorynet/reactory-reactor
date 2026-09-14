/**
 * Reconcile the Postgres conversation message log against Mongo, then repair it.
 *
 * The one tool that brings the two stores into exact agreement and leaves the
 * table correctly indexed.
 *
 * TWO KINDS OF REPAIR
 *
 * A) CONTENT DIFFERS — Postgres holds rows Mongo does not (orphans), or is
 *    missing rows Mongo has. The transcript content must change, so `seq` is
 *    re-derived from the authoritative Mongo order. That order is the Mongo
 *    history array, which for an append-only transcript equals `mongo_id`
 *    ascending. This is NOT assumed: the array order is verified against
 *    `mongo_id` order first and the conversation is SKIPPED if they differ.
 *
 * B) NUMBERING ONLY — content already matches, but `seq` is wrong: duplicated,
 *    negative, or left in a temporary offset range by an interrupted run.
 *    Nothing must move, so the existing relative order is preserved and simply
 *    compacted to 1..N. This needs no order guarantee, which matters because many
 *    backfilled conversations legitimately do not have `mongo_id`-sorted arrays.
 *
 * SAFETY
 *   - Dry run by default. Pass `--apply` to write.
 *   - Idempotent: a reconciled conversation is left untouched on re-run.
 *   - Re-sequencing shifts by the current maximum rather than a constant, so it
 *     is safe even when rows already occupy a temporary range.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/reconcileConversationMessages.ts
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/reconcileConversationMessages.ts --apply
 *   npx ts-node -r tsconfig-paths/register src/modules/reactory-reactor/scripts/reconcileConversationMessages.ts --apply --conversation=<id>
 */
import "reflect-metadata";
import mongoose from "mongoose";
import { Client } from "pg";
import { resolveMongoUri, resolvePgConfig, STORE_TABLE } from "./lib/instanceProbe";

const MONGODB_URI = resolveMongoUri();

/** At or above this, a `seq` value is a temporary placeholder, not a real position. */
const PLACEHOLDER_SEQ_BASE = 1000000000;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const INCLUDE_ACTIVE = args.includes("--include-active");

/**
 * A conversation written within this window is treated as live and skipped.
 *
 * Re-sequencing a conversation that is being appended to cannot be made safe by
 * retrying: the writer computes `MAX(seq)+1` while this script renumbers 1..N, so
 * the two can collide on the unique guard. The collision is harmless (the
 * statement fails, nothing corrupts) but it makes the run unreliable. Skipping
 * active conversations gives a deterministic result for every settled one, and
 * the live conversation can be reconciled once idle.
 */
const ACTIVE_WRITER_WINDOW_MS = 120000;
const ONLY_CONVERSATION = args.find((a) => a.startsWith("--conversation="))?.split("=")[1];

const pgConfig = resolvePgConfig();

/** Postgres rejects NUL bytes in text/jsonb; Mongo stores them happily. */
const stripNul = (value: string) => value.replace(/\u0000/g, "");

const toJson = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  try {
    return stripNul(JSON.stringify(value));
  } catch {
    return null;
  }
};

const toText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return stripNul(value);
  return stripNul(JSON.stringify(value));
};

const buildSearchText = (message: any): string | null => {
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string") parts.push(value);
    else if (value && typeof value === "object") {
      const text = (value as any).text;
      if (typeof text === "string") parts.push(text);
    }
  };
  const content = message?.content;
  if (Array.isArray(content)) content.forEach(push);
  else push(content);
  push(message?.thinking);
  const joined = stripNul(parts.join("\n")).trim();
  return joined.length > 0 ? joined : null;
};

const readMongoId = (item: any): string | null => {
  const raw = item?._id ?? item?.id;
  if (!raw) return null;
  const value = String(raw);
  return value || null;
};

const mongoIdOf = (row: any): string =>
  String(row?.mongoId ?? row?.mongo_id ?? "").trim();

const arrayOrderMatchesIdOrder = (ids: string[]): boolean => {
  for (let i = 1; i < ids.length; i += 1) {
    if (ids[i - 1] > ids[i]) return false;
  }
  return true;
};

/**
 * Shift that moves every row clear of the current range, so the follow-up update
 * cannot transiently collide with a not-yet-moved row.
 *
 * Renumbering writes values 1..n, so every shifted row must land ABOVE n. The
 * shift therefore has to be `n - min + 1`: derived from the row count, not `max`.
 *
 * Three wrong answers this replaced, all of which tripped the unique guard:
 *   `max + 1`       — maps a negative value into the unmoved positive range.
 *   `max - min + 1` — for an all-negative range ({-3,-2,-1}, n=3) it yields
 *                     {0,1,2}, which overlaps the target 1..3.
 *   `n - min + 1`   — clears the target 1..n but NOT the rows' own range once the
 *                     seq set is non-contiguous. Pruning one row from {1..26}
 *                     leaves n=25 with max=26, and shifting by 25 lands a row on
 *                     the surviving seq=26.
 *
 * The shifted block must clear BOTH the target range (1..n) and the current
 * range (min..max), so the shift is `max(n, max) - min + 1`.
 */
const safeSeqShift = async (client: Client, conversationId: string): Promise<number> => {
  const { rows } = await client.query(
    `SELECT COALESCE(MIN(seq), 0) AS min, COALESCE(MAX(seq), 0) AS max, count(*) AS n
       FROM reactor_conversation_messages WHERE conversation_id = $1`,
    [conversationId]
  );
  const min = Number(rows[0]?.min ?? 0);
  const max = Number(rows[0]?.max ?? 0);
  const n = Number(rows[0]?.n ?? 0);
  return Math.max(n, max) - min + 1;
};

/**
 * Compact `seq` to 1..N, preserving the CURRENT relative order.
 * Used when content is already correct and only the numbering is wrong.
 */
const compactSeq = async (client: Client, conversationId: string): Promise<void> => {
  const shift = await safeSeqShift(client, conversationId);

  await client.query(
    `UPDATE reactor_conversation_messages
        SET seq = seq + $2, updated_at = now()
      WHERE conversation_id = $1`,
    [conversationId, shift]
  );

  await client.query(
    `WITH ordered AS (
       SELECT id, row_number() OVER (ORDER BY seq ASC, mongo_id ASC) AS rn
         FROM reactor_conversation_messages
        WHERE conversation_id = $1
     )
     UPDATE reactor_conversation_messages m
        SET seq = o.rn, updated_at = now()
       FROM ordered o
      WHERE m.id = o.id`,
    [conversationId]
  );
};

/**
 * Re-derive `seq` from `mongo_id` order. Only called after that order has been
 * verified to match Mongo's array order.
 */
const resequenceFromMongoIdOrder = async (
  client: Client,
  conversationId: string
): Promise<void> => {
  const shift = await safeSeqShift(client, conversationId);

  await client.query(
    `UPDATE reactor_conversation_messages
        SET seq = seq + $2, updated_at = now()
      WHERE conversation_id = $1`,
    [conversationId, shift]
  );

  await client.query(
    `WITH ordered AS (
       SELECT id, row_number() OVER (ORDER BY mongo_id ASC) AS rn
         FROM reactor_conversation_messages
        WHERE conversation_id = $1
     )
     UPDATE reactor_conversation_messages m
        SET seq = o.rn, updated_at = now()
       FROM ordered o
      WHERE m.id = o.id`,
    [conversationId]
  );
};

/**
 * Align the `archived` flag with which Mongo list owns each message.
 *
 * `history` maps to active rows and `truncatedHistory` to `archived = true` rows.
 * Compaction moves a message from the former to the latter; if the mirror write
 * that accompanies it is missed, Postgres keeps serving a displaced message as
 * part of the active transcript, so the window returns messages Mongo considers
 * archived. That is a flag defect, not a missing row, and it shows up as a window
 * divergence rather than a gap.
 */
const archiveParitySync = async (
  client: Client,
  conversationId: string,
  toArchive: string[],
  toActivate: string[]
): Promise<void> => {
  if (toArchive.length > 0) {
    await client.query(
      `UPDATE reactor_conversation_messages
          SET archived = true,
              archived_at = COALESCE(archived_at, now()),
              archived_reason = COALESCE(archived_reason, 'truncated'),
              updated_at = now()
        WHERE conversation_id = $1 AND mongo_id = ANY($2::char(24)[])`,
      [conversationId, toArchive]
    );
  }

  if (toActivate.length > 0) {
    await client.query(
      `UPDATE reactor_conversation_messages
          SET archived = false, archived_at = NULL, archived_reason = NULL, updated_at = now()
        WHERE conversation_id = $1 AND mongo_id = ANY($2::char(24)[])`,
      [conversationId, toActivate]
    );
  }
};

const insertMessage = async (
  client: Client,
  conversationId: string,
  message: any,
  seq: number
): Promise<void> => {
  await client.query(
    `INSERT INTO reactor_conversation_messages
       (mongo_id, conversation_id, seq, role, content, thinking, thinking_blocks, images,
        refusal, tool_call_id, tool_name, tool_args, tool_calls, tool_results, tool_errors,
        provider_response, component, rating, annotations, audio, search_text, archived,
        archived_at, archived_reason, message_ts)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,
             $9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
             $16::jsonb,$17,$18,$19::jsonb,$20::jsonb,$21,$22,
             $23,$24,$25)`,
    [
      readMongoId(message),
      conversationId,
      seq,
      String(message?.role ?? "assistant"),
      toJson(message?.content ?? null),
      toText(message?.thinking ?? null),
      toJson(message?.thinking_blocks ?? null),
      toJson(message?.images ?? null),
      toText(message?.refusal ?? null),
      message?.tool_call_id ?? null,
      toText(message?.tool_name ?? null),
      toJson(message?.tool_args ?? null),
      toJson(message?.tool_calls ?? null),
      toJson(message?.tool_results ?? null),
      toJson(message?.tool_errors ?? null),
      toJson(message?.response ?? null),
      toText(message?.component ?? null),
      typeof message?.rating === "number" ? message.rating : null,
      toJson(message?.annotations ?? null),
      toJson(message?.audio ?? null),
      buildSearchText(message),
      Boolean(message?.archived),
      message?.archivedAt ? new Date(message.archivedAt) : null,
      message?.archivedReason ?? null,
      message?.timestamp ? new Date(message.timestamp) : null,
    ]
  );
};

const ensureIndexes = async (client: Client): Promise<void> => {
  // Quoted so the names match the entity and migrations exactly. Unquoted
  // identifiers fold to lower case in Postgres and would sit alongside as
  // duplicate indexes.
  await client.query(
    `CREATE INDEX IF NOT EXISTS "IDX_rcm_conv_archived_seq"
       ON reactor_conversation_messages (conversation_id, archived, seq)`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS "IDX_rcm_conv_role_seq"
       ON reactor_conversation_messages (conversation_id, role, seq)`
  );
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rcm_conv_seq"
       ON reactor_conversation_messages (conversation_id, seq)`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS "IDX_rcm_search_text_trgm"
       ON reactor_conversation_messages USING gin (search_text gin_trgm_ops)`
  );

  for (const legacy of [
    "idx_rcm_conv_archived_seq",
    "idx_rcm_conv_role_seq",
    "idx_rcm_conv_seq",
    "idx_rcm_search_text_trgm",
  ]) {
    await client.query("DROP INDEX IF EXISTS " + legacy);
  }
};

const run = async () => {
  console.log("──────────────────────────────────────────────────────────");
  console.log(" Conversation message reconciliation");
  console.log(` Mode : ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  console.log("──────────────────────────────────────────────────────────");

  const client = new Client(pgConfig);
  try {
    await client.connect();
  } catch (error: any) {
    console.log("");
    console.log(`NOT APPLICABLE — cannot reach the message store: ${error?.message ?? error}`);
    if (APPLY) {
      console.log("  REFUSING TO WRITE: this run was asked to apply changes to a store it cannot reach.");
      process.exit(2);
    }
    process.exit(0);
  }
  await mongoose.connect(MONGODB_URI as string);

  // ── Environment preflight, BEFORE any work ──────────────────────────────────────────────────
  //
  // This script is part of the migration toolkit and is expected to run against instances in
  // different states. The one thing it must never do is write into a database that has no message
  // store — so the table is proved to exist before anything else happens, and a write run refuses
  // outright rather than failing part-way through with partial results.
  {
    const reg = await client.query<{ t: string | null }>(
      "SELECT to_regclass($1) AS t",
      [`public.${STORE_TABLE}`]
    );
    if (!reg.rows[0]?.t) {
      console.log("");
      console.log(`NOT APPLICABLE — ${STORE_TABLE} does not exist in this database.`);
      console.log("  Nothing to " + "reconcile" + ".");
      if (APPLY) {
        console.log("  REFUSING TO WRITE: this run was asked to apply changes to a store that is not there.");
        await client.end();
        process.exit(2);
      }
      await client.end();
      process.exit(0);
    }
  }


  const filter: Record<string, any> = ONLY_CONVERSATION
    ? { _id: new mongoose.Types.ObjectId(ONLY_CONVERSATION) }
    : { history: { $exists: true, $ne: [] } };

  const cursor = mongoose.connection
    .collection("reactor_conversations")
    .find(filter, { projection: { history: 1, truncatedHistory: 1, updated: 1 } });

  let scanned = 0;
  let compacted = 0;
  let resequenced = 0;
  let prunedTotal = 0;
  let insertedTotal = 0;
  let insertedArchivedTotal = 0;
  let archiveSyncedTotal = 0;
  // Conversations with no Mongo `history` are skipped below. That is correct — there is nothing
  // to reconcile against — but it must be COUNTED, or a post-`$unset` corpus reports
  // "0 needing repair" having examined nothing. A vacuous pass is not a clean bill of health.
  let noArraySkipped = 0;
  // Rows newer than every known id: real post-cutover messages, never pruned. Counted so the
  // summary EXPLAINS a Postgres row count larger than the Mongo arrays rather than leaving it
  // looking like drift.
  let postCutoverTotal = 0;
  const skipped: string[] = [];
  const touched: string[] = [];
  const failures: string[] = [];

  for await (const doc of cursor as any) {
    const conversationId = String(doc._id);
    const history: any[] = Array.isArray(doc.history) ? doc.history : [];
    const truncated: any[] = Array.isArray(doc.truncatedHistory)
      ? doc.truncatedHistory
      : [];
    if (history.length === 0) {
      noArraySkipped += 1;
      continue;
    }
    scanned += 1;

    // One malformed conversation must not abort the run. A conversation that is
    // being written to can fail on the unique guard when it races the live
    // writer; that is recorded and skipped, not fatal.
    try {

    const mongoItems = history.filter((item) => readMongoId(item));
    const mongoOrder = mongoItems.map((item) => readMongoId(item) as string);

    // `truncatedHistory` holds the messages displaced from `history` by
    // truncation/compaction. They are legitimately present in Postgres as
    // `archived = true` rows, so their ids must join the authoritative set.
    // Omitting them made EVERY archived row read as an orphan, which forced any
    // conversation with compacted history down the content-repair path.
    const archivedItems = truncated.filter((item) => readMongoId(item));
    const archivedIds = new Set(
      archivedItems.map((item) => readMongoId(item) as string)
    );
    const knownIds = new Set([...mongoOrder, ...archivedIds]);

    const { rows } = await client.query(
      `SELECT mongo_id AS "mongoId", seq, archived
         FROM reactor_conversation_messages WHERE conversation_id = $1`,
      [conversationId]
    );
    const pgIds = new Set(rows.map((row) => mongoIdOf(row)).filter(Boolean));

    // An orphan is an ACTIVE row Postgres holds that Mongo owns in neither
    // `history` nor `truncatedHistory`. Archived rows are never orphans: they
    // may be the only surviving copy of compacted history, and auto-deleting one
    // would lose data Mongo no longer carries.
    const allCandidates = Array.from(
      new Set(
        rows
          .filter((row) => !row.archived)
          .map((row) => mongoIdOf(row))
          .filter((id) => id && !knownIds.has(id))
      )
    );

    // ── Post-cutover messages are NOT orphans ─────────────────────────────────────────────────
    //
    // The write-path cutover stopped persisting the embedded array, so a conversation that has
    // received messages since is FROZEN at its pre-cutover contents while the store keeps growing.
    // Those rows carry `mongo_id`s Mongo never held — which is exactly what the test above looks
    // for — so without this split every post-cutover message reads as an orphan and the prune
    // deletes the newest messages the migration exists to preserve.
    //
    // `mongo_id` is an ObjectId and therefore time-ordered: a candidate sorting strictly ABOVE
    // every known id is newer than anything the array ever carried. A genuine dual-write-era
    // orphan interleaves within the known range, so this discriminates rather than permits.
    const maxKnownId = Array.from(knownIds).reduce<string>((max, id) => (id > max ? id : max), "");
    const isPostCutover = (id: string): boolean => maxKnownId !== "" && id > maxKnownId;
    const postCutover = allCandidates.filter(isPostCutover);
    postCutoverTotal += postCutover.length;

    // PRUNABLE orphans only. Everything downstream uses this name, so the prune, the skip
    // conditions and the idempotency comparison are all safe by construction.
    const orphans = allCandidates.filter((id) => !isPostCutover(id));

    // "Missing" is judged against `history` for the ACTIVE set and against
    // `truncatedHistory` for the ARCHIVED set. They are inserted differently — a
    // history item is written active, a truncated item archived — so they are
    // tracked separately. Treating a truncated item as an ordinary missing row
    // would re-insert displaced history as an ACTIVE message.
    const missing = mongoItems.filter((item) => !pgIds.has(readMongoId(item) as string));
    const missingArchived = archivedItems.filter(
      (item) => !pgIds.has(readMongoId(item) as string)
    );

    const { rows: dupRows } = await client.query(
      `SELECT count(*) AS n FROM (
         SELECT seq FROM reactor_conversation_messages
          WHERE conversation_id = $1 GROUP BY seq HAVING count(*) > 1
       ) d`,
      [conversationId]
    );
    const duplicateSeq = Number(dupRows[0]?.n ?? 0);

    const hasPlaceholderSeq = rows.some((row) => {
      const value = Number(row.seq);
      // Positions are 1..n; 0 was never a valid value. This also catches the
      // case where rows exist with the WRONG ORDER but no duplicates: values
      // {0,1,2} look plausible yet are neither contiguous from 1 nor correctly
      // ordered, so they must be normalised.
      return Number.isFinite(value) &&
        (value < 1 || value >= PLACEHOLDER_SEQ_BASE);
    });

    // Whether ORDER can be judged at all: only when Mongo's array order equals
    // `mongo_id` order, since that is the only order derivable from the table.
    const mongoOrderDerivable = arrayOrderMatchesIdOrder(mongoOrder);
    // Order is compared over the rows that correspond to `history` items only:
    // `mongoOrder` is derived from `history`, so neither an archived row nor a
    // row Mongo has since moved to `truncatedHistory` can appear in it. Comparing
    // against the full active set would see a length mismatch — not a mis-order —
    // for any conversation whose compacted messages are still flagged active in
    // Postgres, and re-issue the resequence forever, so the tool would never be
    // idempotent.
    const historyIdSet = new Set(mongoOrder);
    const activeHistoryIdsBySeq = rows
      .filter((row) => !row.archived && historyIdSet.has(mongoIdOf(row)))
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .map((row) => mongoIdOf(row));
    const orderMatches =
      !mongoOrderDerivable ||
      (activeHistoryIdsBySeq.length === mongoOrder.length &&
        activeHistoryIdsBySeq.every((id, index) => id === mongoOrder[index]));

    // Archive-flag drift: rows whose `archived` flag disagrees with which Mongo
    // list owns them. Computed before the skip test so a conversation that is
    // correct in every other respect is still repaired.
    const rowsToArchive = rows
      .filter((row) => !row.archived && archivedIds.has(mongoIdOf(row)))
      .map((row) => mongoIdOf(row));
    const rowsToActivate = rows
      .filter((row) => row.archived && historyIdSet.has(mongoIdOf(row)))
      .map((row) => mongoIdOf(row));

    if (
      orphans.length === 0 &&
      missing.length === 0 &&
      duplicateSeq === 0 &&
      !hasPlaceholderSeq &&
      orderMatches &&
      rowsToArchive.length === 0 &&
      rowsToActivate.length === 0 &&
      missingArchived.length === 0
    ) {
      continue;
    }
    // Skip a conversation that is being written to right now: renumbering it
    // races the writer's `MAX(seq)+1` and trips the unique guard. Deterministic
    // results for settled conversations are worth more than a flaky run.
    const updatedAt = doc.updated ? new Date(doc.updated).getTime() : 0;
    const ageMs = Date.now() - updatedAt;
    if (!INCLUDE_ACTIVE && updatedAt > 0 && ageMs < ACTIVE_WRITER_WINDOW_MS) {
      skipped.push(
        `${conversationId}: written ${Math.round(ageMs / 1000)}s ago; ` +
          `skipped as active (re-run when idle, or pass --include-active)`
      );
      continue;
    }

    touched.push(conversationId);

    // Case B: content already agrees; only numbering, order and/or archive flags
    // are wrong.
    if (orphans.length === 0 && missing.length === 0 && missingArchived.length === 0) {
      // Compacting preserves the EXISTING relative order, so it fixes duplicates
      // and placeholder values but cannot repair a mis-ordered transcript. When
      // the order is derivable and does not match, resequence instead.
      const needsOrderFix = mongoOrderDerivable && !orderMatches;
      const needsSeqFix = duplicateSeq > 0 || hasPlaceholderSeq;
      const needsArchiveSync = rowsToArchive.length > 0 || rowsToActivate.length > 0;

      if (!APPLY) {
        console.log(
          `   ↳ would reconcile ${conversationId}: ` +
            `order=${needsOrderFix ? "resequence" : "ok"} ` +
            `seq=${needsSeqFix ? "fix" : "ok"} ` +
            `archive=${rowsToArchive.length}->archived/${rowsToActivate.length}->active ` +
            `(rows=${rows.length})`
        );
        continue;
      }

      if (needsOrderFix) {
        await resequenceFromMongoIdOrder(client, conversationId);
        resequenced += 1;
        console.log(`   ↳ resequenced ${conversationId} (order corrected)`);
      } else if (needsSeqFix) {
        await compactSeq(client, conversationId);
        compacted += 1;
        console.log(`   ↳ compacted seq for ${conversationId} (${rows.length} rows)`);
      }

      if (needsArchiveSync) {
        await archiveParitySync(client, conversationId, rowsToArchive, rowsToActivate);
        archiveSyncedTotal += rowsToArchive.length + rowsToActivate.length;
        console.log(
          `   ↳ archive flags synced for ${conversationId}: ` +
            `${rowsToArchive.length} archived, ${rowsToActivate.length} activated`
        );
      }
      continue;
    }

    // Case A: content differs, so order must come from Mongo. Verify first.
    if (!arrayOrderMatchesIdOrder(mongoOrder)) {
      skipped.push(
        `${conversationId}: Mongo array order differs from mongo_id order; ` +
          `needs manual review (orphans=${orphans.length} missing=${missing.length})`
      );
      continue;
    }

    if (postCutover.length > 0) {
      // Informational, and deliberately loud: these are real messages that simply post-date the
      // array. They are never pruned, and their presence explains a row count larger than Mongo.
      console.log(
        `   ↳ ${conversationId}: ${postCutover.length} row(s) post-date the newest known id — ` +
          `post-cutover messages, NOT orphans; never pruned.`
      );
    }

    if (!APPLY) {
      console.log(
        `   ↳ would reconcile ${conversationId}: ` +
          `orphans=${orphans.length} missing=${missing.length} ` +
          `missingArchived=${missingArchived.length}`
      );
      continue;
    }

    // Atomic content repair. A half-applied repair leaves placeholder rows
    // sorting before the transcript, which is worse than no repair, and the
    // live writer makes that failure mode reachable. All or nothing.
    // Declared outside the transaction so the summary line below can report the
    // real deletion count rather than the orphan candidate count.
    let prunedHere = 0;

    await client.query("BEGIN");
    try {
    if (orphans.length > 0) {
      // `= ANY(...)` deletes exactly the orphan rows. The previous
      // `mongo_id <> ALL(...)` selected everything OUTSIDE the orphan set —
      // i.e. the valid transcript — and would have destroyed it had a
      // conversation with orphans ever reached this path.
      const { rowCount } = await client.query(
        `DELETE FROM reactor_conversation_messages
          WHERE conversation_id = $1
            AND archived = false
            AND mongo_id = ANY($2::char(24)[])`,
        [conversationId, orphans]
      );
      prunedHere = rowCount ?? 0;
      prunedTotal += prunedHere;
    }

    // Placeholder base is derived from the CURRENT minimum so it is always below
    // every existing row, including any placeholder left by an interrupted run.
    // A fixed base would collide with those.
    const { rows: minRows } = await client.query(
      `SELECT COALESCE(MIN(seq), 0) AS min FROM reactor_conversation_messages WHERE conversation_id = $1`,
      [conversationId]
    );
    let placeholder = Number(minRows[0]?.min ?? 0) - 1;

    for (const message of missing) {
      await insertMessage(client, conversationId, message, placeholder);
      placeholder -= 1;
      insertedTotal += 1;
    }

    // Displaced history mirrors as `archived = true`. The Mongo item carries no
    // such field, so it is forced here: without it a compacted message would be
    // inserted as ACTIVE and would re-enter the live window.
    for (const message of missingArchived) {
      await insertMessage(
        client,
        conversationId,
        { ...message, archived: true, archivedAt: new Date(), archivedReason: "truncated" },
        placeholder
      );
      placeholder -= 1;
      insertedArchivedTotal += 1;
    }

    await resequenceFromMongoIdOrder(client, conversationId);
      await client.query("COMMIT");
      resequenced += 1;
    } catch (txError) {
      await client.query("ROLLBACK");
      throw txError;
    }

    console.log(
      `   ↳ reconciled ${conversationId}: pruned=${prunedHere} inserted=${missing.length}`
    );
    } catch (error: any) {
      // A conversation that races the live writer fails on the unique guard;
      // record it and carry on rather than aborting the whole run.
      failures.push(`${conversationId}: ${error?.message ?? error}`);
    }
  }

  let indexNote = "skipped (dry run)";
  if (APPLY) {
    const { rows } = await client.query(`
      SELECT count(*) AS n FROM (
        SELECT conversation_id, seq FROM reactor_conversation_messages
         GROUP BY conversation_id, seq HAVING count(*) > 1
      ) d
    `);
    if (Number(rows[0]?.n ?? 0) === 0) {
      await ensureIndexes(client);
      indexNote = "all 4 ensured";
    } else {
      indexNote = `blocked: ${rows[0].n} duplicate seq values remain`;
    }
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log(" Summary");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Conversations scanned         : ${scanned}`);
  // A corpus whose arrays have all been retired matches the filter in ZERO documents, so the
  // loop never runs and every counter above is trivially 0. That is a vacuous pass, not a
  // clean result, and the operator must be able to tell the two apart.
  if (!ONLY_CONVERSATION && scanned === 0) {
    const corpusDocs = await mongoose.connection
      .collection("reactor_conversations")
      .countDocuments();
    if (corpusDocs > 0) {
      console.log(
        `  ⚠ NOTHING WAS EXAMINED: none of the ${corpusDocs} conversation document(s) holds a ` +
          `Mongo history array, so there is nothing to reconcile against.`
      );
      console.log(
        "    This is expected once the array has been retired. This run is NOT evidence that " +
          "the message store is correct."
      );
    }
  }
  if (noArraySkipped > 0) {
    console.log(
      `  (not examined, no Mongo array): ${noArraySkipped}` +
        `  — nothing to reconcile against; expected once \`history\` has been retired`
    );
  }
  if (postCutoverTotal > 0) {
    console.log(
      `  (post-cutover rows, never pruned): ${postCutoverTotal}` +
        `  — written after their array was frozen; these explain a Postgres count above Mongo`
    );
  }
  console.log(`Conversations needing repair  : ${touched.length}`);
  console.log(`  compacted (numbering only)  : ${compacted}`);
  console.log(`  resequenced (content fixed) : ${resequenced}`);
  console.log(`Orphan rows deleted           : ${prunedTotal}`);
  console.log(`Archive flags synced          : ${archiveSyncedTotal}`);
  console.log(`Messages inserted             : ${insertedTotal}`);
  console.log(`Archived messages inserted    : ${insertedArchivedTotal}`);
  console.log(`Skipped                       : ${skipped.length}`);
  console.log(`Failed                        : ${failures.length}`);
  if (failures.length > 0) {
    console.log("\n⚠️  First failures:");
    failures.slice(0, 5).forEach((line) => console.log(`   - ${line}`));
  }
  console.log(`Indexes                       : ${indexNote}`);

  if (skipped.length > 0) {
    console.log("\n⚠️  Skipped:");
    skipped.slice(0, 10).forEach((line) => console.log(`   - ${line}`));
  }

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to write.");
  } else if (skipped.length === 0) {
    console.log("\n✅ Reconcile complete: Mongo and Postgres agree, indexes in place.");
  } else {
    console.log("\n⚠️  Reconcile finished with skipped conversations; see above.");
  }

  await mongoose.disconnect();
  await client.end();
};

run().catch(async (error) => {
  console.error("Reconcile error:", error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
