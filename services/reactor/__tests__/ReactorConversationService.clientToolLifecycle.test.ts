import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService, {
  resolveClientToolTimeoutMs,
} from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";

/**
 * The client-tool call lifecycle, end to end.
 *
 * A client-routed tool call has no server-side execution path: the server forwards
 * it, writes a placeholder so the transcript stays provider-valid, and waits for the
 * browser to report a result. Every defect this file covers lives in that wait, and
 * every one of them was silent:
 *
 *  1. the wait had no deadline, so an abandoned turn never ended;
 *  2. the AUTO loop announced `complete` while the result was still outstanding, so
 *     the client believed the turn was over and never reported it;
 *  3. an empty report re-entered the provider loop with nothing new to show it;
 *  4. the same `toolCallId` could be persisted twice (observed 55 ms apart);
 *  5. a submission with no payload was persisted as the literal string "No result",
 *     i.e. a contentless report masqueraded as a successful one.
 *
 * The harness is an in-memory model of the message store, deliberately faithful about
 * the one thing the defects turn on: `replaceToolMessageByToolCallId` replaces the
 * placeholder row **in place**, so a later read sees an answered row. Without that,
 * the duplicate guard would look correct while doing nothing.
 */
describe("ReactorConversationService - client tool call lifecycle", () => {
  const PERSONA = "ReactorAIPersona";
  const CALL_ID = "call_chart_1";
  const TOOL_NAME = "chart";

  let service: any;
  let conversation: any;
  let assistantMessage: any;
  let messages: any[];
  let store: any;
  let conversationId: string;

  const toolCall = () => ({
    id: CALL_ID,
    type: "function",
    function: { name: TOOL_NAME, arguments: '{"type":"bar","data":[1,2]}' },
  });

  /** Exactly what the placeholder row looks like, written by the real producer below. */
  const placeholderMarker = `[Client-side tool "${TOOL_NAME}"`;

  const toolRowsFor = (callId: string) =>
    messages.filter((m) => m.role === "tool" && m.tool_call_id === callId);

  const build = (options: { ageMs?: number } = {}) => {
    messages = [];

    // The paused turn: an assistant message carrying the forwarded call. `ageMs` is how
    // the deadline is exercised — the age is derived from this timestamp, which is why a
    // test can produce an expired call without waiting 45 seconds or faking a clock.
    assistantMessage = {
      id: new ObjectId().toString(),
      role: "assistant",
      content: "",
      tool_calls: [toolCall()],
      timestamp: new Date(Date.now() - (options.ageMs ?? 0)),
    };
    messages.push(assistantMessage);

    conversation = {
      _id: new ObjectId(),
      personaId: PERSONA,
      tools: [{ type: "function", runat: "client", function: { name: TOOL_NAME } }],
      macros: [],
      // Empty on purpose: the store is the source under test, and a non-empty history
      // would let a broken store read still pass.
      history: [],
    };
    conversationId = conversation._id.toString();

    jest.spyOn(ReactorConversationModel, "findOne").mockReturnValue({
      populate: () => ({ exec: async () => conversation }),
      exec: async () => conversation,
      lean: () => ({ exec: async () => conversation }),
      select: () => ({ lean: () => ({ exec: async () => conversation }) }),
    } as any);
    jest.spyOn(ReactorConversationModel, "findById").mockReturnValue({
      lean: () => ({ exec: async () => ({ history: messages }) }),
      exec: async () => ({ history: messages }),
    } as any);
    // The placeholder writer goes through the model (its `$push` is stripped for an
    // existing document, hence the mirror fallback the service hands the pushed item to).
    jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockReturnValue({
      exec: async () => conversation,
    } as any);

    store = {
      getActiveMessages: jest.fn(async () => messages),
      toMessages: (rows: any[]) => rows,
      replaceToolMessageByToolCallId: jest.fn(
        async (_conversationId: string, callId: string, patch: any) => {
          const row = messages.find(
            (m) => m.role === "tool" && m.tool_call_id === callId
          );
          if (!row) return 0;
          // In place, exactly like the store implementation: the placeholder stops being
          // a placeholder here, which is what makes the call answered.
          row.content = patch.content;
          if (Array.isArray(patch.toolResults)) row.tool_results = patch.toolResults;
          if (patch.timestamp) row.timestamp = patch.timestamp;
          return 1;
        }
      ),
      appendToolResultToOwningMessage: jest.fn(
        async (_conversationId: string, callId: string, entry: any) => {
          const owner = messages.find(
            (m) =>
              m.role === "assistant" &&
              (m.tool_calls || []).some((c: any) => c.id === callId)
          );
          if (!owner) return 0;
          owner.tool_results = [...(owner.tool_results || []), entry];
          return 1;
        }
      ),
    };

    service = Object.create(ReactorConversationService.prototype);
    service.context = {
      user: { _id: new ObjectId() },
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };
    service.sessionLog = jest.fn();
    service.validateChatSessionId = jest.fn();
    service.getMessageStore = () => store;
    // The status write is asserted, not performed: `mirrorToolCallStatus` is the write.
    service.mirrorToolCallStatus = jest.fn(async () => {});
    service.enforceUsageBudget = jest.fn(async () => null);
    service.streamingTransportManager = { sendEventToSession: jest.fn(async () => {}) };
    // The mirror is what makes a `$push`ed row visible to the store-backed reads, so it
    // pushes into the same array the store reads. Without this the placeholder would not
    // exist as far as the lifecycle predicates are concerned.
    service.mirrorPersistedAppend = jest.fn(async (_cid: string, _doc: any, entry: any) => {
      if (entry) messages.push(entry);
    });
    // The continuation is out of scope here (it is a provider turn); its presence is
    // asserted only where it must NOT happen.
    service.sendMessage = jest.fn(async () => ({
      __typename: "ReactorChatMessage",
      content: "continued",
    }));
  };

  /** The pause: forward the call and write the placeholder, using the real producer. */
  const pauseTurn = async () => {
    await service.persistClientToolForwarding({
      conversationId,
      toolCall: toolCall(),
      toolName: TOOL_NAME,
      streamingMode: "SSE",
      personaId: PERSONA,
    });
  };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe("the observed sequence", () => {
    it("pause -> complete -> zero-result -> late result -> duplicate", async () => {
      build();
      await pauseTurn();

      // The paused turn really is paused: the placeholder row exists, and it is NOT an
      // answer, so the replay surface must still report the call.
      expect(toolRowsFor(CALL_ID)).toHaveLength(1);
      expect(toolRowsFor(CALL_ID)[0].content).toContain(placeholderMarker);

      const pending = await service.getPendingClientToolCalls({
        chatSessionId: conversationId,
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        toolCallId: CALL_ID,
        toolName: TOOL_NAME,
        expired: false,
      });

      // `complete` is NOT emitted while a result is outstanding — including when the
      // provider would otherwise have looked finished.
      expect(
        service.resolveStreamTermination({
          streamingMode: "SSE",
          hasClientToolsPending: true,
          providerAlreadySentCompletion: "some streamed content",
        })
      ).toBe("paused_for_client_tool");
      // ...and the ordinary completion path still emits `complete`, so the gate is not
      // simply refusing everything.
      expect(
        service.resolveStreamTermination({
          streamingMode: "SSE",
          hasClientToolsPending: false,
          providerAlreadySentCompletion: false,
        })
      ).toBe("complete");

      // The zero-result submission is rejected and cannot spawn a continuation.
      const zeroResult = await service.completeClientToolCalls({
        chatSessionId: conversationId,
        personaId: PERSONA,
        results: [],
      });

      expect(zeroResult.__typename).toBe("ReactorErrorResponse");
      expect(zeroResult.code).toBe("CLIENT_TOOL_RESULT_REQUIRED");
      expect(zeroResult.message).toContain(TOOL_NAME);
      expect(zeroResult.pendingToolCalls).toEqual([
        expect.objectContaining({ toolCallId: CALL_ID, toolName: TOOL_NAME }),
      ]);
      expect(service.sendMessage).not.toHaveBeenCalled();

      // The late result — the one that arrives after the empty report — persists once.
      const late = await service.completeClientToolCalls({
        chatSessionId: conversationId,
        personaId: PERSONA,
        continueProcessing: false,
        results: [{ toolCallId: CALL_ID, toolName: TOOL_NAME, result: '{"rendered":true}' }],
      });

      expect(late.__typename).toBe("ReactorChatMessage");

      const answeredRows = toolRowsFor(CALL_ID);
      expect(answeredRows).toHaveLength(1);
      expect(answeredRows[0].content).toContain("rendered");
      expect(answeredRows[0].content).not.toContain(placeholderMarker);
      expect(assistantMessage.tool_results).toHaveLength(1);

      // The duplicate — 55 ms later, in the ticket — is refused and NOT persisted twice.
      const duplicate = await service.completeClientToolCalls({
        chatSessionId: conversationId,
        personaId: PERSONA,
        results: [{ toolCallId: CALL_ID, toolName: TOOL_NAME, result: '{"rendered":true}' }],
      });

      expect(duplicate.__typename).toBe("ReactorErrorResponse");
      expect(duplicate.code).toBe("CLIENT_TOOL_RESULT_REJECTED");
      expect(duplicate.rejectedResults).toEqual([
        expect.objectContaining({
          toolCallId: CALL_ID,
          toolName: TOOL_NAME,
          reason: "already-answered",
        }),
      ]);

      expect(toolRowsFor(CALL_ID)).toHaveLength(1);
      expect(assistantMessage.tool_results).toHaveLength(1);
      expect(service.sendMessage).not.toHaveBeenCalled();

      // The warning names the tool and the call id, so an operator can find it.
      expect(service.sessionLog).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining(CALL_ID),
        expect.objectContaining({ toolName: TOOL_NAME, toolCallId: CALL_ID }),
        conversationId,
        PERSONA
      );

      // And the call is no longer outstanding.
      const stillPending = await service.getPendingClientToolCalls({
        chatSessionId: conversationId,
      });
      expect(stillPending).toEqual([]);
    });
  });

  describe("the deadline", () => {
    it("resolves an unanswered client tool by timeout, naming the tool and the wait", async () => {
      // Ten minutes old: far past the default deadline, and provably so without a fake
      // clock, because the age is derived from the owning message's timestamp.
      build({ ageMs: 10 * 60_000 });
      await pauseTurn();

      const closed = await service.reconcileExpiredClientToolCalls(conversationId, PERSONA);

      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({ toolCallId: CALL_ID, toolName: TOOL_NAME });
      expect(closed[0].ageMs).toBeGreaterThanOrEqual(10 * 60_000);

      // A FAILURE result, not the placeholder: it names the tool and says it timed out.
      const rows = toolRowsFor(CALL_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toContain(TOOL_NAME);
      expect(rows[0].content).toMatch(/timed out/i);
      expect(rows[0].content).not.toContain(placeholderMarker);

      // The call's status is settled, not left running.
      expect(service.mirrorToolCallStatus).toHaveBeenCalledWith(
        conversationId,
        CALL_ID,
        "error"
      );

      // WARN with tool name, call id and elapsed ms — the three facts needed to tell
      // "the browser was slow" from "the browser never heard about the call".
      expect(service.sessionLog).toHaveBeenCalledWith(
        "warn",
        expect.stringMatching(/timed out after \d+ ms/),
        expect.objectContaining({
          toolName: TOOL_NAME,
          toolCallId: CALL_ID,
          ageMs: expect.any(Number),
        }),
        conversationId,
        PERSONA
      );

      // No longer reported as pending: a reconnecting client is not handed a call the
      // transcript has already failed.
      const pending = await service.getPendingClientToolCalls({
        chatSessionId: conversationId,
      });
      expect(pending).toEqual([]);
    });

    it("leaves a call inside the deadline alone", async () => {
      // The control. Without it, a reconciler that failed everything immediately would
      // still pass the test above — and would fail every live client tool.
      build({ ageMs: 1_000 });
      await pauseTurn();

      const closed = await service.reconcileExpiredClientToolCalls(conversationId, PERSONA);

      expect(closed).toEqual([]);
      expect(toolRowsFor(CALL_ID)).toHaveLength(1);
      expect(toolRowsFor(CALL_ID)[0].content).toContain(placeholderMarker);
      expect(service.mirrorToolCallStatus).not.toHaveBeenCalled();
    });

    it("reports age and expiry per pending call rather than enforcing silently", async () => {
      build({ ageMs: 5_000 });
      await pauseTurn();

      const pending = await service.getPendingClientToolCalls({
        chatSessionId: conversationId,
      });

      expect(pending).toHaveLength(1);
      expect(pending[0].ageMs).toBeGreaterThanOrEqual(5_000);
      expect(pending[0].expired).toBe(false);
      expect(pending[0].createdAt).toEqual(expect.any(String));
    });

    it("parses the timeout from the environment, defaulting and flooring a bad value", () => {
      // Exported precisely so these rules can be asserted without waiting 45 seconds.
      expect(resolveClientToolTimeoutMs(undefined)).toBe(45_000);
      expect(resolveClientToolTimeoutMs("")).toBe(45_000);
      expect(resolveClientToolTimeoutMs("not-a-number")).toBe(45_000);
      // `REACTOR_CLIENT_TOOL_TIMEOUT_MS=45` most likely means 45 seconds; honouring it
      // as 45 ms would fail every client tool in the system.
      expect(resolveClientToolTimeoutMs("45")).toBe(1_000);
      expect(resolveClientToolTimeoutMs("120000")).toBe(120_000);
    });
  });

  describe("the turn-boundary reconciler", () => {
    /**
     * The gap the first live test of this fix exposed.
     *
     * The deadline is derived, not scheduled, so it only bites where something looks.
     * In the live session `side_panel_state` was forwarded at 13:18:42.858 and the very
     * next log entry was the user's message 5 min 14 s later, because the browser never
     * called either endpoint that ran the reconciler. The abandoned call was therefore
     * never examined and its placeholder travelled into the next turn.
     *
     * A new user message is the one event guaranteed to follow an abandoned pause, so
     * the turn boundary is where the reconciler has to run.
     */
    it("fails an abandoned call before the next turn is dispatched", async () => {
      build({ ageMs: 10 * 60_000 });
      await pauseTurn();

      const closed = await service.reconcileAbandonedClientToolsBeforeDispatch(
        conversation,
        conversationId,
        PERSONA
      );

      expect(closed).toHaveLength(1);

      // The placeholder is gone, replaced by a named timeout failure. This is the
      // difference between "the model was told nothing happened" and "the model was
      // told the tool timed out".
      const rows = toolRowsFor(CALL_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toMatch(/timed out/i);
      expect(rows[0].content).not.toContain(placeholderMarker);

      // And the turn boundary says so out loud, naming the tool and the wait.
      expect(service.sessionLog).toHaveBeenCalledWith(
        "warn",
        expect.stringMatching(/abandoned client tool call\(s\) had timed out before this turn was dispatched/),
        expect.objectContaining({
          conversationId,
          toolCalls: [
            expect.objectContaining({ toolName: TOOL_NAME, toolCallId: CALL_ID }),
          ],
        }),
        conversationId,
        PERSONA
      );
    });

    it("leaves a call that is still inside its deadline alone", async () => {
      // The control. Without it, a reconciler that failed everything at the turn
      // boundary would pass the test above and break every live client tool.
      build({ ageMs: 1_000 });
      await pauseTurn();

      const closed = await service.reconcileAbandonedClientToolsBeforeDispatch(
        conversation,
        conversationId,
        PERSONA
      );

      expect(closed).toEqual([]);
      expect(toolRowsFor(CALL_ID)[0].content).toContain(placeholderMarker);
      expect(service.sessionLog).not.toHaveBeenCalledWith(
        "warn",
        expect.stringMatching(/abandoned client tool call/),
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });

    it("never blocks the user's message when reconciliation fails", async () => {
      // The most important property of the call site: housekeeping must not cost the
      // user their prompt. A throw here would fail `sendMessage` outright, which is
      // strictly worse than the bug being fixed.
      build({ ageMs: 10 * 60_000 });
      await pauseTurn();

      service.reconcileExpiredClientToolCallsWithin = jest.fn(async () => {
        throw new Error("store unavailable");
      });

      const closed = await service.reconcileAbandonedClientToolsBeforeDispatch(
        conversation,
        conversationId,
        PERSONA
      );

      expect(closed).toEqual([]);
      expect(service.sessionLog).toHaveBeenCalledWith(
        "warn",
        expect.stringMatching(/failed to reconcile expired client tool calls: store unavailable/),
        expect.objectContaining({ conversationId }),
        conversationId,
        PERSONA
      );
    });
  });

  describe("the duplicate toolCallId", () => {
    it("is rejected and persisted exactly once, even within one submission", async () => {
      build();
      await pauseTurn();

      const submission = { toolCallId: CALL_ID, toolName: TOOL_NAME, result: '{"ok":true}' };

      const result = await service.completeClientToolCalls({
        chatSessionId: conversationId,
        personaId: PERSONA,
        continueProcessing: false,
        // The same call twice in one request: the ticket saw this 55 ms apart, and the
        // guard has to hold for both shapes.
        results: [submission, { ...submission }],
      });

      expect(store.replaceToolMessageByToolCallId).toHaveBeenCalledTimes(1);
      expect(store.appendToolResultToOwningMessage).toHaveBeenCalledTimes(1);
      expect(toolRowsFor(CALL_ID)).toHaveLength(1);
      expect(assistantMessage.tool_results).toHaveLength(1);

      // A partial rejection still reports the recorded result: the turn continues, and
      // the refusal is visible in the log.
      expect(result.__typename).toBe("ReactorChatMessage");
      expect(service.sessionLog).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("already recorded"),
        expect.objectContaining({ toolCallId: CALL_ID, reason: "already-answered" }),
        conversationId,
        PERSONA
      );
    });
  });

  describe("the contentless payload", () => {
    it("is rejected at the boundary with an error naming the tool", async () => {
      build();
      await pauseTurn();

      const result = await service.completeClientToolCalls({
        chatSessionId: conversationId,
        personaId: PERSONA,
        continueProcessing: false,
        results: [{ toolCallId: CALL_ID, toolName: TOOL_NAME }],
      });

      expect(result.__typename).toBe("ReactorErrorResponse");
      expect(result.code).toBe("CLIENT_TOOL_RESULT_REJECTED");
      expect(result.message).toContain(TOOL_NAME);
      expect(result.rejectedResults).toEqual([
        expect.objectContaining({ toolCallId: CALL_ID, toolName: TOOL_NAME, reason: "empty-result" }),
      ]);

      // Nothing was written: the placeholder is untouched and nothing claims success.
      expect(store.replaceToolMessageByToolCallId).not.toHaveBeenCalled();
      expect(toolRowsFor(CALL_ID)).toHaveLength(1);
      expect(toolRowsFor(CALL_ID)[0].content).toContain(placeholderMarker);
      expect(assistantMessage.tool_results).toBeUndefined();
      // The literal string this defect used to persist.
      expect(JSON.stringify(messages)).not.toContain("No result");
    });

    it("still records a user decision and an explicit error", async () => {
      // The paths that legitimately carry no `result`. A rejection that swallowed these
      // would trade one silent failure for another.
      build();
      await pauseTurn();

      const declined = await service.completeClientToolCalls({
        chatSessionId: conversationId,
        personaId: PERSONA,
        continueProcessing: false,
        results: [
          {
            toolCallId: CALL_ID,
            toolName: TOOL_NAME,
            decision: "declined",
          } as any,
        ],
      });

      expect(declined.__typename).toBe("ReactorChatMessage");
      expect(toolRowsFor(CALL_ID)[0].content).toMatch(/chose not to run/i);

      // And an explicit error report is a result, not a contentless submission.
      build();
      await pauseTurn();

      const errored = await service.completeClientToolCalls({
        chatSessionId: conversationId,
        personaId: PERSONA,
        continueProcessing: false,
        results: [
          {
            toolCallId: CALL_ID,
            toolName: TOOL_NAME,
            isError: true,
            error: "canvas unavailable",
          } as any,
        ],
      });

      expect(errored.__typename).toBe("ReactorChatMessage");
      expect(toolRowsFor(CALL_ID)[0].content).toContain("canvas unavailable");
    });
  });
});
