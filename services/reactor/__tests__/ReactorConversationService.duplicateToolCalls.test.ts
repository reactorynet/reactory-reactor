import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";

/**
 * Two calls to the SAME tool in one batch: supported, and proven here.
 *
 * THE DECISION
 * ------------
 * Supported, deliberately, and left that way. The AUTO loop's batch body is
 * `for (const toolCall of toolCalls)`, and every call is dispatched independently:
 *
 *     const toolName = toolCall.function?.name;          // name: shared by both calls
 *     const toolArgs = JSON.parse(toolCall.function.arguments);
 *     ...
 *     await this.executeMacro({ macro: toolName, callId: toolCall.id, args: toolArgs });
 *
 * `executeMacro` keys everything it persists on `callId` — the result row's
 * `tool_call_id` and `tool_results[0].id`, the backfill on the assistant message, and
 * the running/success/error status — so two calls named `listSupportTickets` are two
 * distinct, independently answerable exchanges. Nothing in the path is keyed on the
 * tool NAME. (The per-iteration batch report does push the name per call, so it reads
 * `tools: ["listSupportTickets", "listSupportTickets"]`; that is a truthful count of
 * two executions, not a collision.)
 *
 * Rejecting duplicate names would also be wrong on its own terms: a model routinely
 * asks for the same tool twice in one turn with different arguments (two pages of
 * tickets, two ticket lookups), and refusing that would turn a legitimate request
 * into a failed turn.
 *
 * WHAT THIS SUITE PINS DOWN
 * -------------------------
 * That both calls actually execute and that they produce two DISTINCT results,
 * correctly keyed — not one result written twice, and not a last-writer-wins overwrite.
 *
 * The batch body itself lives inside a ~9,000-line method that needs a provider, an
 * SSE transport and a database to reach. The dispatch step it performs — one
 * `executeMacro` per call, keyed by that call's id — is reproduced here directly, so
 * the keying is asserted where it is decided rather than inferred.
 */
describe("ReactorConversationService - two calls to one tool in one batch", () => {
  let service: any;
  let conversation: any;
  let macroInvocations: any[];
  let findOneAndUpdateCalls: any[];
  let statusUpdates: Array<{ callId: string; status: string }>;

  const conversationId = new ObjectId().toString();

  beforeEach(() => {
    macroInvocations = [];
    findOneAndUpdateCalls = [];
    statusUpdates = [];

    conversation = {
      _id: conversationId,
      providerId: "openai",
      // `null` leaves the tool-result budget unconstrained: this suite is about
      // per-call keying, not about result sizing.
      maxTokens: null,
      tokenCount: 0,
      vars: {},
      tools: [
        { type: "function", runat: "server", function: { name: "listSupportTickets" } },
      ],
      macros: [{ name: "listSupportTickets", runat: "server", roles: [] }],
    };

    service = Object.create(ReactorConversationService.prototype);
    service.context = {
      user: { _id: new ObjectId() },
      hasAnyRole: jest.fn(() => true),
      getService: jest.fn(() => ({
        getPersona: jest.fn(async () => ({ id: "reactor", config: {} })),
      })),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
    };
    service.sessionLog = jest.fn();
    service.validateChatSessionId = jest.fn();
    service.mirrorPersistedAppend = jest.fn(async () => {});
    service.getMessageStore = jest.fn(() => null);
    service.resolveConversationProvider = jest.fn(async () => "openai");
    service.providerService = {
      getAdapter: jest.fn(async () => ({ adaptResponse: (x: any) => x })),
    };
    service.chunkingService = { estimateTokenCount: jest.fn(async () => 5) };
    service.updateToolCallStatus = jest.fn(async (_id: string, callId: string, status: string) => {
      statusUpdates.push({ callId, status });
    });

    // The macro stands in for `listSupportTickets`: it echoes its argument so the two
    // results are distinguishable *by content*, not just by key. If the dispatcher
    // wrote one result twice, the content assertion fails.
    service.macroService = {
      getMacro: jest.fn((name: string) => async (args: any) => {
        macroInvocations.push({ name, args });
        return {
          success: true,
          tool: name,
          data: { page: args?.page ?? 1, marker: `result-for-page-${args?.page ?? 1}` },
        };
      }),
    };

    jest.spyOn(ReactorConversationModel, "findOne").mockReturnValue({
      exec: jest.fn(async () => conversation),
      lean: jest.fn(() => ({ exec: jest.fn(async () => conversation) })),
    } as any);

    jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockImplementation(((
      filter: any,
      update: any
    ) => {
      findOneAndUpdateCalls.push({ filter, update });
      return { exec: jest.fn(async () => conversation) };
    }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The two calls a model can legitimately make in one batch. */
  const batch = [
    { id: "call_9f8a1", function: { name: "listSupportTickets", arguments: '{"page":1}' } },
    { id: "call_9f8a2", function: { name: "listSupportTickets", arguments: '{"page":2}' } },
  ];

  /** Replay the AUTO loop's dispatch step: one `executeMacro` per call, own callId. */
  const dispatchBatch = async () => {
    for (const toolCall of batch) {
      await service.executeMacro({
        macro: toolCall.function.name,
        personaId: "reactor",
        chatSessionId: conversationId,
        calledBy: "server-auto",
        callId: toolCall.id,
        args: JSON.parse(toolCall.function.arguments),
      });
    }
  };

  it("executes both calls, with each call's own arguments", async () => {
    await dispatchBatch();

    expect(macroInvocations).toHaveLength(2);
    expect(macroInvocations.map((i) => i.name)).toEqual([
      "listSupportTickets",
      "listSupportTickets",
    ]);
    // Arguments are per call, not shared: the model asked for two different pages.
    expect(macroInvocations.map((i) => i.args)).toEqual([{ page: 1 }, { page: 2 }]);
  });

  it("persists two distinct tool results, each keyed by its own tool_call_id", async () => {
    await dispatchBatch();

    const resultRows = findOneAndUpdateCalls
      .filter((c) => c.update?.$push?.history)
      .map((c) => c.update.$push.history);

    expect(resultRows).toHaveLength(2);
    expect(resultRows.map((r: any) => r.tool_call_id)).toEqual(["call_9f8a1", "call_9f8a2"]);
    expect(resultRows.map((r: any) => r.tool_name)).toEqual([
      "listSupportTickets",
      "listSupportTickets",
    ]);
    // Distinct content, so this cannot pass by writing the same result twice.
    expect(resultRows[0].content).toContain("result-for-page-1");
    expect(resultRows[0].content).not.toContain("result-for-page-2");
    expect(resultRows[1].content).toContain("result-for-page-2");
    expect(resultRows[1].content).not.toContain("result-for-page-1");
    // ...and the embedded tool_results are keyed the same way.
    expect(resultRows.map((r: any) => r.tool_results[0].id)).toEqual(["call_9f8a1", "call_9f8a2"]);
  });

  it("backfills each result onto the assistant message that owns its own call", async () => {
    await dispatchBatch();

    const backfills = findOneAndUpdateCalls.filter(
      (c) => c.update?.$push?.["history.$.tool_results"]
    );

    expect(backfills).toHaveLength(2);
    expect(backfills.map((c) => c.filter["history.tool_calls.id"])).toEqual([
      "call_9f8a1",
      "call_9f8a2",
    ]);
    expect(backfills.map((c) => c.update.$push["history.$.tool_results"].id)).toEqual([
      "call_9f8a1",
      "call_9f8a2",
    ]);
  });

  it("tracks the status of each call id independently", async () => {
    await dispatchBatch();

    expect(statusUpdates).toEqual([
      { callId: "call_9f8a1", status: "running" },
      { callId: "call_9f8a1", status: "success" },
      { callId: "call_9f8a2", status: "running" },
      { callId: "call_9f8a2", status: "success" },
    ]);
  });

  it("keeps the two results independent when one of the calls fails", async () => {
    // The point of per-call keying: a failure answers ITS call and leaves the other
    // call's result intact. Any name-keyed bookkeeping would conflate them.
    service.macroService.getMacro = jest.fn(
      (name: string) => async (args: any) => {
        if (args?.page === 2) throw new Error("page 2 is not available");
        return { success: true, tool: name, data: { page: args?.page } };
      }
    );

    await dispatchBatch();

    const okRows = findOneAndUpdateCalls
      .filter((c) => c.update?.$push?.history?.tool_call_id === "call_9f8a1")
      .map((c) => c.update.$push.history);
    const errorRows = findOneAndUpdateCalls
      .filter((c) => c.update?.$push?.history?.tool_call_id === "call_9f8a2")
      .map((c) => c.update.$push.history);

    expect(okRows).toHaveLength(1);
    expect(okRows[0].tool_results[0].result).toEqual({
      success: true,
      tool: "listSupportTickets",
      data: { page: 1 },
    });

    expect(errorRows).toHaveLength(1);
    // The failure answers call_9f8a2 itself — it is not left unanswered, which is the
    // condition that makes a provider reject the whole transcript.
    expect(errorRows[0].content).toContain("page 2 is not available");
    expect(statusUpdates).toContainEqual({ callId: "call_9f8a1", status: "success" });
    expect(statusUpdates).toContainEqual({ callId: "call_9f8a2", status: "error" });
  });
});
