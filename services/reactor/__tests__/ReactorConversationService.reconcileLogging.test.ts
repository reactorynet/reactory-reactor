import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import ReactorConversationService from "../ReactorConversationService";

/**
 * A failed client tool call must leave a trace in the log an operator actually reads.
 *
 * WHY THIS TEST EXISTS
 *
 * The reconciler already warned when it failed an expired client tool call — but it
 * warned through `sessionLog(..., conversationId, personaId)`, and `sessionLog` writes
 * to the per-conversation file only when it can resolve a logger, which needs a
 * `personaId` or a warm logger cache.
 *
 * `getPendingClientToolCalls` — the replay surface a reconnecting browser asks — has no
 * `personaId` argument, and called the reconciler without one. So the WARN reached the
 * global context and the session log showed nothing.
 *
 * Observed live on 2026-11-04 in conversation `6aead8555c8011ceaa56d2f4`: at 13:41:26
 * the reconciler rewrote the timed-out `side_panel_state` placeholder (the row was
 * updated in place, `msg_ts` bumped to 13:41:26.189), and the session log contained
 * zero reconcile lines. A failing tool call with no log line is precisely the defect
 * class this whole programme exists to remove, so it was reintroduced by the fix.
 *
 * The invariant: every reconcile path must pass a persona, taking the conversation's
 * own `personaId` when the caller has none.
 */
describe("ReactorConversationService - reconcile logging", () => {
  let service: any;

  const PERSONA = "ReactorAIPersona";

  beforeEach(() => {
    jest.restoreAllMocks();
    service = Object.create(ReactorConversationService.prototype);
    service.sessionLog = jest.fn();
    service.context = { user: { _id: "u1" }, warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() };
  });

  it("threads the conversation's persona into the reconciler when none is supplied", async () => {
    const conversation = { _id: "conv1", personaId: PERSONA, history: [] };
    const withinSpy = jest
      .spyOn(service, "reconcileExpiredClientToolCallsWithin")
      .mockResolvedValue([]);

    // The public entry point takes an optional personaId; the replay path has none.
    service.validateChatSessionId = jest.fn();

    // Call the internal helper directly with no persona, exactly as the replay path
    // used to call the reconciler.
    await service.reconcileAbandonedClientToolsBeforeDispatch(conversation, "conv1", undefined);

    expect(withinSpy).toHaveBeenCalledWith(conversation, "conv1", PERSONA);
  });

  it("prefers an explicitly supplied persona over the conversation's", async () => {
    const conversation = { _id: "conv2", personaId: "SomeoneElse", history: [] };
    const withinSpy = jest
      .spyOn(service, "reconcileExpiredClientToolCallsWithin")
      .mockResolvedValue([]);

    await service.reconcileAbandonedClientToolsBeforeDispatch(conversation, "conv2", PERSONA);

    expect(withinSpy).toHaveBeenCalledWith(conversation, "conv2", PERSONA);
  });

  it("names the persona on the abandoned-call WARN so the session logger resolves", async () => {
    const conversation = { _id: "conv3", personaId: PERSONA, history: [] };
    jest.spyOn(service, "reconcileExpiredClientToolCallsWithin").mockResolvedValue([
      { toolCallId: "call_1", toolName: "side_panel_state", ageMs: 67_000 },
    ]);

    await service.reconcileAbandonedClientToolsBeforeDispatch(conversation, "conv3", undefined);

    // 4th = conversationId, 5th = personaId. Without the 5th, `sessionLog` cannot
    // resolve the per-conversation logger and the line is invisible where it matters.
    expect(service.sessionLog).toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(/abandoned client tool call/),
      expect.objectContaining({ conversationId: "conv3" }),
      "conv3",
      PERSONA
    );
  });

  it("names the persona on the reconcile-failure WARN", async () => {
    const conversation = { _id: "conv4", personaId: PERSONA, history: [] };
    jest
      .spyOn(service, "reconcileExpiredClientToolCallsWithin")
      .mockRejectedValue(new Error("store down"));

    await service.reconcileAbandonedClientToolsBeforeDispatch(conversation, "conv4", undefined);

    expect(service.sessionLog).toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(/failed to reconcile expired client tool calls: store down/),
      expect.objectContaining({ conversationId: "conv4" }),
      "conv4",
      PERSONA
    );
  });
});
