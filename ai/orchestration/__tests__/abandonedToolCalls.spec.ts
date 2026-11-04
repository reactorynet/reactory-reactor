import { describe, it, expect } from "@jest/globals";
import { describeAbandonedToolCalls } from "../toolBatchReport";

/**
 * The WARN line that names a discarded batch.
 *
 * WHY THIS LINE IS THE WHOLE OBSERVABILITY FLOOR
 * ----------------------------------------------
 * The AUTO loop checks for an interrupt as its FIRST statement, before
 * `iteration++` and before any classification. So a batch stopped by an interrupt
 * is never executed, deferred, refused, or given a result — and the per-iteration
 * summary that would have reported it never runs. Before this line existed the only
 * output was
 *
 *     AUTO mode: interrupted by user after 0 iteration(s)
 *
 * which is what a turn with nothing to do also prints. In ticket
 * REACTORY-302016408/20261104/2715764250 that left two `listSupportTickets` calls
 * persisted at 06:39:19.060 unaccounted for: a query on their `tool_call_id`s
 * returned zero rows, and nothing in the log said the batch had been dropped. The
 * diagnosis had to be reconstructed from timestamps.
 *
 * The ids are the point, not decoration: they are what a transcript query is keyed
 * on when someone asks "was this call ever answered?".
 */
describe("describeAbandonedToolCalls", () => {
  it("names every call in the batch by tool AND tool_call_id", () => {
    const { message, meta } = describeAbandonedToolCalls(
      [
        { id: "call_9f8a1", function: { name: "listSupportTickets" } },
        { id: "call_9f8a2", function: { name: "listSupportTickets" } },
      ],
      0
    );

    expect(message).toContain("listSupportTickets(call_9f8a1)");
    expect(message).toContain("listSupportTickets(call_9f8a2)");
    // The count is stated, so a reader can tell a one-call drop from a ten-call one
    // without parsing the list.
    expect(message).toContain("2 tool call(s)");
    // And that they will go unanswered, which is the consequence that matters.
    expect(message).toMatch(/NO result/);

    expect(meta.iteration).toBe(0);
    expect(meta.abandonedCount).toBe(2);
    expect(meta.abandonedToolCallIds).toEqual(["call_9f8a1", "call_9f8a2"]);
    expect(meta.abandoned).toEqual([
      { tool: "listSupportTickets", toolCallId: "call_9f8a1" },
      { tool: "listSupportTickets", toolCallId: "call_9f8a2" },
    ]);
  });

  it("reports the iteration the abandonment happened at", () => {
    const { message, meta } = describeAbandonedToolCalls(
      [{ id: "call_1", function: { name: "shell" } }],
      7
    );

    expect(message).toContain("iteration 7");
    expect(meta.iteration).toBe(7);
  });

  it("keeps a line even when the batch cannot be enumerated", () => {
    // A response whose tool_calls were absent or empty still needs an explanation —
    // the loop is only here because something asked for tools.
    const { message, meta } = describeAbandonedToolCalls(undefined, 2);

    expect(message).toContain("0 tool call(s)");
    expect(message).toContain("(none recorded on the response)");
    expect(meta.abandonedToolCallIds).toEqual([]);
  });

  it("falls back for a call with no name or no id rather than printing blanks", () => {
    const { message, meta } = describeAbandonedToolCalls(
      [{ id: "call_x" }, { function: { name: "listSupportTickets" } }, { name: "legacyShape" }],
      1
    );

    expect(message).toContain("listSupportTickets(unknown)");
    // A provider that reports the name at the top level (rather than under
    // `function`) must still be readable.
    expect(message).toContain("legacyShape(unknown)");
    expect(message).toContain("unknown(call_x)");
    expect(meta.abandonedCount).toBe(3);
  });

  it("does not mutate the calls it is given", () => {
    const calls = [{ id: "call_a", function: { name: "shell" } }];
    const snapshot = JSON.parse(JSON.stringify(calls));

    describeAbandonedToolCalls(calls, 0);

    expect(calls).toEqual(snapshot);
  });
});
