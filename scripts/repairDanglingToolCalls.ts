#!/usr/bin/env node
/**
 * Make a conversation's transcript satisfy the tool-call closure invariant. READ-ONLY unless `--apply`.
 *
 * THE INVARIANT
 *
 * OpenAI-compatible endpoints reject a transcript in which an assistant message carrying
 * `tool_calls` is not **immediately followed** by that call's tool results:
 *
 *   `400 An assistant message with 'tool_calls' must be followed by tool messages responding to
 *    each 'tool_call_id'. (insufficient tool messages following tool_calls message)`
 *
 * The error is **not retryable**, so one violation makes every later turn on that conversation fail
 * identically, forever, while the UI shows only "SendMessage attempt 1 failed".
 *
 * Reading that message suggests the requirement is that each call is *answered*. It is not — it is
 * that the call is immediately **followed** by its results. That distinction is the whole reason this
 * tool detects two defects rather than one:
 *
 *   - **missing**   — no `tool` row answers the `tool_call_id`. Caused by a dropped persist.
 *   - **misplaced** — a `tool` row answers it, but sits later than the call. Caused by overlapping
 *                     turns interleaving their appends into one conversation. Every call is answered
 *                     here, so any check that only counts matches reports the transcript as fine.
 *
 * A `misplaced` result is repaired by **moving** it into position, never by inserting a duplicate or
 * a placeholder: the call did produce output, and replacing that with "no result was recorded" would
 * destroy real tool output and mislead the model.
 *
 * WHY POSITION MATTERS AND WHY THIS ORDER
 *
 * `seq` is dense and unique per conversation, and a result is only valid directly after its call, so
 * both repairs have to relocate rows rather than append them. Each pass fixes **one** violation and
 * re-reads, because a move changes the `seq` of everything between the two positions — computing a
 * second target from the pre-move read would aim at a slot that no longer means what it did. The loop
 * is bounded and exits as soon as a pass finds nothing to do, so a transcript that cannot converge is
 * reported rather than spun on.
 *
 * WHAT IT WRITES
 *
 * A synthesised result says plainly that no result was recorded, and carries the same text the
 * request-side guard (`OpenAIService.closeToolCallGaps`) uses. It is deliberately not a
 * plausible-looking success: the model must be able to tell that the tool produced nothing, or it
 * will reason from a result that never existed.
 *
 * Usage:
 *   RUN() { TS_NODE_TRANSPILE_ONLY=true NODE_PATH=./ ./node_modules/.bin/env-cmd --no-override -f ./.env \
 *             node -r ts-node/register -r tsconfig-paths/register "$@"; }
 *   R=src/modules/reactory-reactor/scripts/repairDanglingToolCalls.ts
 *
 *   RUN $R --conversation=6aad3a01879ddde16cdac9f1             # report only
 *   RUN $R --conversation=6aad3a01879ddde16cdac9f1 --apply     # repair it
 *   RUN $R --scan                                              # every conversation, report only
 *
 * Options:
 *   --conversation=<id>   conversation to inspect
 *   --scan                inspect every conversation that has messages (implies report-only)
 *   --apply               perform the repairs (requires --conversation)
 *   --json                machine-readable report
 */
import "reflect-metadata";
import { ObjectId } from "mongodb";
import ReactorConversationMessageService from "../services/reactor/ReactorConversationMessageService";

/** Mirrors the placeholder in `OpenAIService.closeToolCallGaps` so both read identically. */
const NO_RESULT_RECORDED =
  "[No result was recorded for this tool call. The tool did not report an output — treat the call as unavailable and continue without its result.]";

type ViolationKind = "missing" | "misplaced";

interface Violation {
  kind: ViolationKind;
  toolCallId: string;
  toolName: string;
  /** `seq` of the assistant message that made the call. */
  assistantSeq: number;
  /** For `misplaced`: the `seq` of the result that needs to move. */
  resultSeq?: number;
  /** For `misplaced`: the `seq` slot the result should occupy. */
  targetSeq?: number;
}

interface Row {
  seq: string;
  role: string;
  mongoId?: string | null;
  toolCallId?: string | null;
  toolCalls?: unknown;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};

const conversationArg = value("--conversation");
const apply = flag("--apply");
const scan = flag("--scan");
const asJson = flag("--json");

const line = (s = "") => {
  // eslint-disable-next-line no-console
  console.log(s);
};

/**
 * Every position in which the closure invariant is broken, in transcript order.
 *
 * One rule, applied per assistant message: walking forward from it, the next `tool` rows must answer
 * its calls, in call order. A call with no result anywhere is `missing`; a call whose result exists
 * but does not appear in that run is `misplaced`.
 */
const findViolations = (rows: Row[]): Violation[] => {
  const resultByCallId = new Map<string, Row>();
  for (const row of rows) {
    if (row.role === "tool" && row.toolCallId) {
      const id = String(row.toolCallId);
      if (!resultByCallId.has(id)) resultByCallId.set(id, row);
    }
  }

  const violations: Violation[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.role !== "assistant" || !Array.isArray(row.toolCalls) || row.toolCalls.length === 0) {
      continue;
    }

    // How many results of this batch are already in place directly after the call.
    let placed = 0;

    for (const call of row.toolCalls as any[]) {
      const id = call?.id ? String(call.id) : null;
      if (!id) continue;
      const name = call?.function?.name || call?.name || "unknown";

      const result = resultByCallId.get(id);
      if (!result) {
        violations.push({
          kind: "missing",
          toolCallId: id,
          toolName: name,
          assistantSeq: Number(row.seq),
        });
        continue;
      }

      const expected = rows[index + 1 + placed];
      if (expected && String(expected.toolCallId) === id) {
        placed += 1;
        continue;
      }

      // Present but not in position. The slot it should occupy is the one currently held by the row
      // that would come next — or, at the end of the transcript, one past the last row.
      const slotRow = rows[index + 1 + placed];
      const targetSeq = slotRow
        ? Number(slotRow.seq)
        : Number(rows[rows.length - 1]?.seq ?? 0) + 1;

      violations.push({
        kind: "misplaced",
        toolCallId: id,
        toolName: name,
        assistantSeq: Number(row.seq),
        resultSeq: Number(result.seq),
        targetSeq,
      });
    }
  }

  return violations;
};

const main = async () => {
  if (!conversationArg && !scan) {
    line("Refusing to run without a target.");
    line("  --conversation=<id>   inspect one conversation");
    line("  --scan                inspect every conversation with messages");
    process.exit(2);
  }
  if (apply && !conversationArg) {
    line("--apply requires an explicit --conversation=<id>. Refusing to write across a scan.");
    process.exit(2);
  }

  // The migration DataSource is used deliberately: it is entity-only and has `synchronize: false`,
  // so an ad-hoc repair tool cannot alter the schema as a side effect of connecting.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dataSource = require("../migrations/typeorm/data-source").default;
  await dataSource.initialize();

  const store = new ReactorConversationMessageService(dataSource);

  let conversationIds: string[];
  if (conversationArg) {
    conversationIds = [conversationArg];
  } else {
    const raw = await dataSource.query(
      `SELECT DISTINCT conversation_id AS id FROM reactor_conversation_messages ORDER BY conversation_id`
    );
    conversationIds = raw.map((r: any) => String(r.id));
  }

  line(`Inspecting ${conversationIds.length} conversation(s) — mode: ${apply ? "APPLY" : "report only"}`);

  const reports: Array<{ conversationId: string; totalMessages: number; violations: Violation[] }> = [];
  for (const conversationId of conversationIds) {
    const rows = (await store.getActiveMessages(conversationId)) as unknown as Row[];
    if (rows.length === 0) continue;
    reports.push({ conversationId, totalMessages: rows.length, violations: findViolations(rows) });
  }

  const broken = reports.filter((r) => r.violations.length > 0);
  const describe = (v: Violation) =>
    v.kind === "missing"
      ? `seq ${v.assistantSeq}  ${v.toolName}  ${v.toolCallId}  — NO RESULT ANYWHERE`
      : `seq ${v.assistantSeq}  ${v.toolName}  ${v.toolCallId}  — result at seq ${v.resultSeq}, should be ${v.targetSeq}`;

  if (asJson) {
    line(JSON.stringify({ mode: apply ? "apply" : "report", broken }, null, 2));
  } else {
    line();
    line(`Conversations inspected    : ${reports.length}`);
    line(`Conversations malformed    : ${broken.length}`);
    line(
      `Violations                 : ${broken.reduce((n, r) => n + r.violations.length, 0)}` +
        ` (missing ${broken.reduce((n, r) => n + r.violations.filter((v) => v.kind === "missing").length, 0)},` +
        ` misplaced ${broken.reduce((n, r) => n + r.violations.filter((v) => v.kind === "misplaced").length, 0)})`
    );
    line();
    for (const report of broken) {
      line(`${report.conversationId}  (${report.totalMessages} active messages)`);
      for (const violation of report.violations) line(`    ${describe(violation)}`);
    }
  }

  if (!apply) {
    if (broken.length > 0) {
      line();
      line("Nothing was written. Re-run with --conversation=<id> --apply to repair.");
    }
    await dataSource.destroy();
    process.exit(0);
  }

  const target = broken[0];
  if (!target) {
    line();
    line("Invariant already holds — nothing to repair.");
    await dataSource.destroy();
    process.exit(0);
  }

  line();
  line(`Repairing ${target.violations.length} violation(s) in ${target.conversationId} …`);

  // One violation per pass, re-reading between passes: a move rewrites the `seq` of every row
  // between the two positions, so any target computed from an earlier read is stale.
  const MAX_PASSES = 500;
  let passes = 0;

  while (passes < MAX_PASSES) {
    const rows = (await store.getActiveMessages(target.conversationId)) as unknown as Row[];
    const violations = findViolations(rows);
    if (violations.length === 0) break;

    const violation = violations[0];
    passes += 1;

    if (violation.kind === "misplaced") {
      const moved = await store.moveMessageToSeq(
        target.conversationId,
        String(rows.find((r) => Number(r.seq) === violation.resultSeq)?.mongoId),
        violation.targetSeq as number
      );

      if (moved === null) {
        line(`    FAILED to move the result for ${violation.toolCallId}`);
        process.exitCode = 1;
        break;
      }

      line(`    moved ${violation.toolName} ${violation.toolCallId}: seq ${violation.resultSeq} -> ${moved}`);
      continue;
    }

    const entry = {
      _id: new ObjectId(),
      role: "tool",
      content: NO_RESULT_RECORDED,
      tool_call_id: violation.toolCallId,
      tool_name: violation.toolName,
      timestamp: new Date(),
      tool_results: [] as any[],
    };

    const inserted = await store.insertMessageAtSeq(
      target.conversationId,
      entry,
      violation.assistantSeq + 1
    );

    if (!inserted) {
      line(`    FAILED to insert a result for ${violation.toolCallId}`);
      process.exitCode = 1;
      break;
    }

    line(`    inserted ${violation.toolName} ${violation.toolCallId} at seq ${inserted.seq}`);
  }

  // Re-read and re-run the same detection. A repair tool that reports success without re-checking is
  // how a tool reports green while the transcript is still broken.
  const after = (await store.getActiveMessages(target.conversationId)) as unknown as Row[];
  const remaining = findViolations(after);

  line();
  line(`Verification: ${remaining.length} violation(s) remain (expected 0) after ${passes} pass(es).`);
  if (remaining.length > 0) {
    for (const violation of remaining) line(`    ${describe(violation)}`);
    process.exitCode = 1;
  }

  await dataSource.destroy();
  process.exit(process.exitCode ?? 0);
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
