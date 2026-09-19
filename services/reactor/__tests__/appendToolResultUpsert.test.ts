import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import ReactorConversationMessageService from "../ReactorConversationMessageService";

/**
 * `appendToolResultToOwningMessage` — upsert semantics.
 *
 * The method used to append unconditionally, which is wrong in the specific case
 * it now has to handle: the client-tool replay path re-reports the *same*
 * completion when a client reconnects, and every report added another copy of the
 * payload to a JSONB column while rewriting that column in full. So the behaviours
 * under test are: replace the existing entry, keep the original timeline, write
 * nothing when nothing changed, and still append a genuinely new result.
 *
 * Driven through a fake repository rather than a database, because what matters
 * here is the array arithmetic and the decision to write — not Postgres.
 */
describe("ReactorConversationMessageService - appendToolResultToOwningMessage", () => {
  let service: any;
  let rows: Array<{ id: string; tool_results: any[] }>;
  let update: jest.Mock<any>;
  let query: jest.Mock<any>;

  const build = (initial: any[]) => {
    rows = [{ id: "row-1", tool_results: initial }];
    update = jest.fn<any>(async (_criteria: any, patch: any) => {
      rows[0].tool_results = patch.toolResults;
      return { affected: 1 };
    });
    query = jest.fn<any>(async () => rows);

    service = new ReactorConversationMessageService({} as any);
    service.getRepository = () => ({ query, update });
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("appends when the call has no existing result", async () => {
    build([]);

    const affected = await service.appendToolResultToOwningMessage("conv-1", "call_1", {
      id: "call_1",
      name: "chart",
      content: '{"type":"bar"}',
    });

    expect(affected).toBe(1);
    expect(rows[0].tool_results).toHaveLength(1);
    expect(rows[0].tool_results[0].id).toBe("call_1");
  });

  it("replaces rather than duplicates when the same call is reported again", async () => {
    // The bug. A second report must not grow the array.
    build([{ id: "call_1", name: "chart", content: '{"type":"bar"}' }]);

    await service.appendToolResultToOwningMessage("conv-1", "call_1", {
      id: "call_1",
      name: "chart",
      content: '{"type":"line"}',
    });

    expect(rows[0].tool_results).toHaveLength(1);
    expect(rows[0].tool_results[0].content).toBe('{"type":"line"}');
  });

  it("does not grow the array across repeated identical reports", async () => {
    // The replay loop: N reports of the same completion, one entry.
    build([]);
    const entry = { id: "call_1", name: "chart", content: '{"type":"bar"}' };

    for (let i = 0; i < 5; i += 1) {
      await service.appendToolResultToOwningMessage("conv-1", "call_1", {
        ...entry,
        timestamp: new Date(2026, 8, 16, 10, i),
      });
    }

    expect(rows[0].tool_results).toHaveLength(1);
  });

  it("writes nothing at all when an identical report arrives", async () => {
    // The point of the timestamp-insensitive comparison: a redundant replay should
    // cost one SELECT, not a full rewrite of the JSONB column.
    build([
      { id: "call_1", name: "chart", content: '{"type":"bar"}', timestamp: new Date(1000) },
    ]);

    const affected = await service.appendToolResultToOwningMessage("conv-1", "call_1", {
      id: "call_1",
      name: "chart",
      content: '{"type":"bar"}',
      timestamp: new Date(9999),
    });

    expect(affected).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("preserves the original timestamp when it does replace", async () => {
    // A replay must not move the timeline: the entry records when the tool ran,
    // not when it was last reported.
    const original = new Date(1000);
    build([{ id: "call_1", name: "chart", content: "old", timestamp: original }]);

    await service.appendToolResultToOwningMessage("conv-1", "call_1", {
      id: "call_1",
      name: "chart",
      content: "new",
      timestamp: new Date(9999),
    });

    expect(rows[0].tool_results[0].content).toBe("new");
    expect(rows[0].tool_results[0].timestamp).toEqual(original);
  });

  it("keeps results for different calls side by side", async () => {
    // Upsert must not collapse distinct calls: a turn can carry several.
    build([{ id: "call_1", name: "chart", content: "a" }]);

    await service.appendToolResultToOwningMessage("conv-1", "call_2", {
      id: "call_2",
      name: "d3",
      content: "b",
    });

    expect(rows[0].tool_results).toHaveLength(2);
    expect(rows[0].tool_results.map((entry: any) => entry.id)).toEqual(["call_1", "call_2"]);
  });

  it("replaces only the targeted call, leaving siblings untouched", async () => {
    build([
      { id: "call_1", name: "chart", content: "a" },
      { id: "call_2", name: "d3", content: "b" },
    ]);

    await service.appendToolResultToOwningMessage("conv-1", "call_2", {
      id: "call_2",
      name: "d3",
      content: "b-updated",
    });

    expect(rows[0].tool_results).toHaveLength(2);
    expect(rows[0].tool_results[0].content).toBe("a");
    expect(rows[0].tool_results[1].content).toBe("b-updated");
  });

  it("appends when the incoming result carries no id", async () => {
    // Nothing to key on, so the previous append behaviour is the only option —
    // better a possible duplicate than silently discarding a result.
    build([{ id: "call_1", name: "chart", content: "a" }]);

    await service.appendToolResultToOwningMessage("conv-1", "call_1", {
      name: "anonymous",
      content: "no id here",
    });

    expect(rows[0].tool_results).toHaveLength(2);
  });

  it("coerces a numeric id so it still matches", async () => {
    // Ids arrive as ObjectId-ish values in some paths; comparison is by string.
    build([{ id: 12345, name: "chart", content: "a" }]);

    const affected = await service.appendToolResultToOwningMessage("conv-1", "12345", {
      id: 12345,
      name: "chart",
      content: "a",
    });

    expect(rows[0].tool_results).toHaveLength(1);
    expect(affected).toBe(0); // identical -> no write
  });

  it("treats a non-array tool_results column as empty", async () => {
    rows = [{ id: "row-1", tool_results: null as any }];
    update = jest.fn<any>(async (_criteria: any, patch: any) => {
      rows[0].tool_results = patch.toolResults;
      return { affected: 1 };
    });
    query = jest.fn<any>(async () => rows);
    service = new ReactorConversationMessageService({} as any);
    service.getRepository = () => ({ query, update });

    await service.appendToolResultToOwningMessage("conv-1", "call_1", {
      id: "call_1",
      name: "chart",
      content: "a",
    });

    expect(rows[0].tool_results).toHaveLength(1);
  });

  it("returns 0 without querying when arguments are missing", async () => {
    build([]);

    expect(await service.appendToolResultToOwningMessage("", "call_1", { id: "call_1" })).toBe(0);
    expect(await service.appendToolResultToOwningMessage("conv-1", "", { id: "call_1" })).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 0 when the store is unavailable", async () => {
    service = new ReactorConversationMessageService({} as any);
    service.getRepository = () => null;

    const affected = await service.appendToolResultToOwningMessage("conv-1", "call_1", {
      id: "call_1",
    });

    expect(affected).toBe(0);
  });

  it("reports how many rows it changed", async () => {
    // The return value is the caller's signal that the owning row was found.
    rows = [
      { id: "row-1", tool_results: [] },
      { id: "row-2", tool_results: [] },
    ];
    update = jest.fn<any>(async () => ({ affected: 1 }));
    query = jest.fn<any>(async () => rows);
    service = new ReactorConversationMessageService({} as any);
    service.getRepository = () => ({ query, update });

    const affected = await service.appendToolResultToOwningMessage("conv-1", "call_1", {
      id: "call_1",
      name: "chart",
      content: "a",
    });

    expect(affected).toBe(2);
  });
});
