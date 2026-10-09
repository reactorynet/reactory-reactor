import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";

/**
 * The budget gate on the client-tool continuation.
 *
 * `completeClientToolCalls` re-enters the provider loop when the browser reports
 * its tool results, so it stands at the head of a fresh, billable request — one
 * the `sendMessage` gate never sees, because the user did not send anything. That
 * made it the one route by which a spent budget could still buy calls: a
 * `hardStop` bounded the user's *messages* but not the AI turns they indirectly
 * triggered.
 *
 * Two properties matter and are asserted separately:
 *
 *  1. the gate runs, with the continuation's own turn kind, before any provider
 *     work — so a refusal costs nothing;
 *  2. it runs *after* the tool results are persisted — because those results are
 *     already produced, cost nothing to store, and discarding them would corrupt
 *     the transcript. The caller reports what it found; the operator's budget
 *     decision then decides whether the agent gets to see it.
 */
describe("ReactorConversationService - client-tool continuation budget gate", () => {
  let service: any;
  let conversation: any;

  const build = (overrides: {
    refusal?: any;
    results?: any[];
    continueProcessing?: boolean;
    streamingMode?: string;
  } = {}) => {
    conversation = {
      _id: new ObjectId(),
      personaId: "ReactorAIPersona",
      userId: new ObjectId(),
      user: new ObjectId(),
      providerId: "google",
      modelId: "gemini-3.7-flash",
      tools: [],
      macros: [],
      history: [],
    };

    jest.spyOn(ReactorConversationModel, "findOne").mockReturnValue({
      populate: () => ({ exec: async () => conversation }),
      exec: async () => conversation,
      lean: () => ({ exec: async () => conversation }),
      select: () => ({ lean: () => ({ exec: async () => conversation }) }),
    } as any);

    service = Object.create(ReactorConversationService.prototype);
    service.context = {
      user: { _id: new ObjectId() },
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      // Reached only once the gate has allowed the turn: persona resolution is the
      // first step past it, so the control test walks through here on its way to
      // the provider stub.
      getService: jest.fn(() => ({
        getPersona: async () => ({
          id: "ReactorAIPersona",
          providerId: "google",
          modelId: "gemini-3.7-flash",
        }),
      })),
    };
    service.resolveConversationProvider = jest.fn(async () => "google");
    jest.spyOn(ReactorConversationModel, "findById").mockReturnValue({
      select: () => ({ lean: () => ({ exec: async () => conversation }) }),
      lean: () => ({ exec: async () => conversation }),
      populate: () => ({ exec: async () => conversation }),
      exec: async () => conversation,
    } as any);
    service.sessionLog = jest.fn();
    service.validateChatSessionId = jest.fn();
    service.updateToolCallStatus = jest.fn(async () => 1);
    service.getMessageStore = () => ({
      replaceToolMessageByToolCallId: jest.fn(async () => 1),
      appendToolResultToOwningMessage: jest.fn(async () => 1),
    });

    // The subject of the test: the gate's verdict.
    service.enforceUsageBudget = jest.fn(async () => overrides.refusal ?? null);

    // Anything reaching the provider proves the gate let it through. The
    // continuation delegates to `sendMessage` (which owns the server-side AUTO
    // tool loop), so that is where the sentinel is thrown: reaching it proves the
    // gate allowed the turn through.
    service.providerService = {
      getAdapter: jest.fn(async () => {
        throw new Error("REACHED_PROVIDER");
      }),
    };
    service.sendMessage = jest.fn(async () => {
      throw new Error("REACHED_PROVIDER");
    });

    return {
      chatSessionId: conversation._id.toString(),
      personaId: "ReactorAIPersona",
      results: overrides.results ?? [],
      continueProcessing: overrides.continueProcessing ?? true,
      streamingMode: overrides.streamingMode,
    };
  };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("refuses the continuation when the budget gate blocks", async () => {
    const refusal = {
      __typename: "ReactorErrorResponse",
      code: "BUDGET_EXCEEDED",
      message: "AI usage budget reached",
    };
    const args = build({ refusal });

    const result = await service.completeClientToolCalls(args);

    expect(result).toBe(refusal);
    expect(service.enforceUsageBudget).toHaveBeenCalledTimes(1);
  });

  it("asks the gate with the continuation's own turn kind", async () => {
    // Not `user-turn`: the distinction is what keeps a mid-turn `tool`
    // continuation inside `sendMessage` ungated while this one is gated.
    const args = build({ refusal: { __typename: "ReactorErrorResponse" } });

    await service.completeClientToolCalls(args);

    const [, turnKind] = (service.enforceUsageBudget as jest.Mock).mock.calls[0];
    expect(turnKind).toBe("client-tool-continuation");
  });

  it("does not reach the provider when it refuses", async () => {
    // The whole point: a refusal must cost nothing.
    const args = build({
      refusal: { __typename: "ReactorErrorResponse", message: "budget" },
      streamingMode: "SSE",
    });

    const result = await service.completeClientToolCalls(args);

    expect(result.__typename).toBe("ReactorErrorResponse");
    expect(service.providerService.getAdapter).not.toHaveBeenCalled();
  });

  it("persists the reported results before refusing", async () => {
    // The browser already ran the tool. Its output is free to store and losing it
    // would leave the transcript wrong, so persistence comes first and the gate
    // only governs the follow-up provider call.
    const args = build({
      refusal: { __typename: "ReactorErrorResponse", message: "budget" },
      results: [{ toolCallId: "call_1", toolName: "chart", result: '{"type":"bar"}' }],
    });

    await service.completeClientToolCalls(args);

    expect(service.updateToolCallStatus).toHaveBeenCalledWith(
      expect.any(String),
      "call_1",
      "success"
    );
  });

  it("logs the refusal so an operator can tell it apart from a plain error", async () => {
    const args = build({ refusal: { __typename: "ReactorErrorResponse", message: "budget" } });

    await service.completeClientToolCalls(args);

    expect(service.sessionLog).toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(/continuation was refused/i),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it("proceeds to the provider when the gate allows", async () => {
    // The control. Without this, a gate that refused everything would still pass
    // the tests above.
    const args = build({ refusal: null });

    await expect(service.completeClientToolCalls(args)).rejects.toThrow("REACHED_PROVIDER");
    expect(service.enforceUsageBudget).toHaveBeenCalledTimes(1);
    // The continuation must re-enter the provider loop through `sendMessage` with
    // `continueAfterTools`, so it runs the server-side AUTO tool loop rather than
    // a single provider turn. Without this, a server tool the model requested
    // after a client-tool result was never executed — the turn stalled pending
    // approval.
    expect(service.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "tool", continueAfterTools: true }),
    );
  });

  it("does not consult the gate at all for a report-only call", async () => {
    // `continueProcessing: false` makes no provider request, so there is nothing
    // to refuse — and refusing it would throw away results the browser just sent.
    const args = build({ continueProcessing: false });

    await service.completeClientToolCalls(args);

    expect(service.enforceUsageBudget).not.toHaveBeenCalled();
  });

  it("does not consult the gate when a report-only call is also refused-eligible", async () => {
    // Belt and braces on the ordering: even with a blocking verdict primed, a
    // report-only call returns before the gate is reached.
    const args = build({
      continueProcessing: false,
      refusal: { __typename: "ReactorErrorResponse", message: "budget" },
    });

    const result = await service.completeClientToolCalls(args);

    expect(service.enforceUsageBudget).not.toHaveBeenCalled();
    // Ran the report-only path instead: returns the last assistant message shape.
    expect(result.__typename).toBe("ReactorChatMessage");
  });
});
