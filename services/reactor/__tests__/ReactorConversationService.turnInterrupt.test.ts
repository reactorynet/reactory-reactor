import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { ObjectId } from "mongodb";
import ReactorConversationService from "../ReactorConversationService";
import ReactorConversationModel from "../../../models/ReactorChatState";
import TaskModel from "@reactory/server-modules/reactory-core/models/Task";

/**
 * The SERVICE's half of the turn-scoped interrupt fix.
 *
 * `turnInterrupt.spec.ts` proves the epoch state machine. This file proves the
 * wiring: that a turn opens an epoch, that `interruptToolExecution` stamps the
 * request with the epoch of the turn running at request time, that the AUTO loop's
 * gate (`takeTurnInterrupt`) honours a same-turn interrupt, and that a leftover from
 * a previous turn is discarded AT WARN instead of silently disarming the next turn's
 * first iteration.
 *
 * Ticket REACTORY-302016408/20261104/2715764250, conversation
 * `6adb0c56e695bd8de286f2ca`: the flag was set at 06:38:28.950 and the turn that
 * began at 06:39:12.683 died 6.5 s later, before its two `listSupportTickets` calls
 * were classified — no `executing N tool(s)`, no `pausing`, no per-tool error.
 *
 * The loop itself is deliberately not driven here: standing up a provider, an SSE
 * transport and Mongo would make this the test that gets deleted when it flakes.
 * `takeTurnInterrupt` is exactly the call the loop makes, so the behaviour asserted
 * below is the behaviour of the loop's gate.
 */
describe("ReactorConversationService - turn-scoped interrupts", () => {
  let service: any;
  let mockContext: any;

  const ledger = () => (ReactorConversationService as any).turnInterrupts;

  beforeEach(() => {
    // The ledger is process-wide static state (one per server, as the interrupt map
    // always was). Reset it so one test's conversation id cannot leak into another.
    ledger().reset();

    mockContext = {
      getService: jest.fn(),
      user: { _id: new ObjectId(), id: "u1", firstName: "Ada", lastName: "Lovelace" },
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      hasAnyRole: jest.fn(() => true),
    };

    service = Object.create(ReactorConversationService.prototype);
    service.context = mockContext;
    service.sessionLog = jest.fn();
    service.validateChatSessionId = jest.fn();
    service.mirrorPersistedAppend = jest.fn(async () => {});
    service.streamingTransportManager = {
      hasTransport: jest.fn(async () => false),
      sendEventToSession: jest.fn(async () => {}),
    };

    // `interruptToolExecution` settles pending approval tasks and clears `processing`
    // before returning. Both are best-effort in production; left live they reach a
    // model with no connection and stall for mongoose's 10 s buffer timeout.
    jest.spyOn(TaskModel, "updateMany").mockReturnValue({
      exec: jest.fn(async () => ({ modifiedCount: 0 })),
    } as any);
    jest.spyOn(ReactorConversationModel, "findOneAndUpdate").mockReturnValue({
      exec: jest.fn(async () => ({})),
    } as any);
    jest.spyOn(ReactorConversationModel, "findById").mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn(async () => ({ history: [] })),
      }),
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    ledger().reset();
  });

  /** The lines `sessionLog` was asked to write, as `[level, message, meta]` tuples. */
  const logLines = () =>
    service.sessionLog.mock.calls.map((call: any[]) => ({
      level: call[0],
      message: call[1] as string,
      meta: (call[2] || {}) as Record<string, any>,
    }));

  const warnedMessages = () =>
    logLines().filter((l: any) => l.level === "warn").map((l: any) => l.message);

  describe("a stale interrupt does not stop the next turn's tools (the regression)", () => {
    it("lets the next turn dispatch after an interrupt whose own turn never observed it", async () => {
      const conversationId = new ObjectId().toString();

      // Turn 1: the user interrupts while it is running. Its AUTO loop has already
      // exited (or the turn had no tool batch), so nothing consumed the request.
      const turn1 = service.beginTurnInterruptEpoch(conversationId, "reactor");
      await service.interruptToolExecution(conversationId, "reactor", "stop");

      expect(ledger().isArmed(conversationId)).toBe(true);

      // 44 seconds later: a new user message, a new turn.
      const turn2 = service.beginTurnInterruptEpoch(conversationId, "reactor");

      expect(turn2).toBeGreaterThan(turn1);

      // The gate the AUTO loop calls at its first statement: the batch is dispatched.
      const verdict = service.takeTurnInterrupt(conversationId, turn2, "reactor");
      expect(verdict.stop).toBe(false);
      expect(verdict.discarded).toBeNull();
    });

    it("says at WARN that the leftover was discarded and why", async () => {
      const conversationId = new ObjectId().toString();

      service.beginTurnInterruptEpoch(conversationId, "reactor");
      await service.interruptToolExecution(conversationId, "reactor", "stop");
      service.beginTurnInterruptEpoch(conversationId, "reactor");

      const discardLine = warnedMessages().find((m: string) =>
        /Discarding an interrupt left over from an earlier turn/.test(m)
      );

      expect(discardLine).toBeDefined();
      // It says which (stale) turn asked and that it cannot stop this one.
      expect(discardLine).toContain("It cannot stop this turn");
      const meta = logLines().find((l: any) =>
        /Discarding an interrupt left over/.test(l.message)
      ).meta;
      expect(meta.discardedReason).toBe("stop");
      expect(meta.discardedEpoch).toBe(1);
      expect(meta.turnEpoch).toBe(2);
    });

    it("discards a leftover even if the next turn asks the gate directly", () => {
      // Belt and braces: `takeTurnInterrupt` is epoch-scoped on its own, so no caller
      // that skips `beginTurn` can resurrect the leak.
      const conversationId = new ObjectId().toString();
      const turn1 = service.beginTurnInterruptEpoch(conversationId, "reactor");
      ledger().request(conversationId, "stop");

      const verdict = service.takeTurnInterrupt(conversationId, turn1 + 1, "reactor");

      expect(verdict.stop).toBe(false);
      expect(verdict.discarded?.reason).toBe("stop");
      expect(
        warnedMessages().some((m: string) => /belongs to an earlier turn/.test(m))
      ).toBe(true);
    });
  });

  describe("an interrupt raised during the current turn still stops that turn", () => {
    it("returns a stop verdict for the turn whose epoch was current at request time", async () => {
      const conversationId = new ObjectId().toString();

      const turn = service.beginTurnInterruptEpoch(conversationId, "reactor");
      await service.interruptToolExecution(conversationId, "reactor", "user cancelled");

      const verdict = service.takeTurnInterrupt(conversationId, turn, "reactor");

      // The fix is emphatically not "ignore interrupts".
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toBe("user cancelled");
    });

    it("lets a turn that starts afterwards run normally", async () => {
      const conversationId = new ObjectId().toString();

      const turn1 = service.beginTurnInterruptEpoch(conversationId, "reactor");
      await service.interruptToolExecution(conversationId, "reactor", "stop");
      expect(service.takeTurnInterrupt(conversationId, turn1, "reactor").stop).toBe(true);

      // Consumed by turn 1, so turn 2 is unaffected even without a discard.
      const turn2 = service.beginTurnInterruptEpoch(conversationId, "reactor");
      expect(service.takeTurnInterrupt(conversationId, turn2, "reactor").stop).toBe(false);
    });
  });

  describe("interruptToolExecution", () => {
    it("records the request and warns when no turn is running at all", async () => {
      const conversationId = new ObjectId().toString();

      await service.interruptToolExecution(conversationId, "reactor", "stop");

      // Nothing to stop — and the log says so rather than leaving a flag whose only
      // future effect would be on a turn the user never asked about.
      expect(
        warnedMessages().some((m: string) =>
          /no turn is running/.test(m)
        )
      ).toBe(true);
    });
  });

  describe("reportAbandonedToolCalls (the observability floor)", () => {
    it("writes one WARN naming tool + tool_call_id for every call being dropped", () => {
      const conversationId = new ObjectId().toString();

      const described = service.reportAbandonedToolCalls({
        conversationId,
        personaId: "reactor",
        toolCalls: [
          { id: "call_9f8a1", function: { name: "listSupportTickets", arguments: "{}" } },
          { id: "call_9f8a2", function: { name: "listSupportTickets", arguments: "{}" } },
        ],
        iteration: 0,
        turnEpoch: 3,
        reason: "user cancelled",
        cause: "user interrupt",
      });

      const line = logLines().find((l: any) => /ABANDONING/.test(l.message));

      expect(line).toBeDefined();
      expect(line.level).toBe("warn");
      expect(line.message).toContain("listSupportTickets(call_9f8a1)");
      expect(line.message).toContain("listSupportTickets(call_9f8a2)");
      expect(line.message).toContain("iteration 0");
      expect(line.message).toContain("cause: user interrupt");
      expect(line.meta.abandonedToolCallIds).toEqual(["call_9f8a1", "call_9f8a2"]);
      expect(line.meta.reason).toBe("user cancelled");
      expect(line.meta.turnEpoch).toBe(3);

      // The ids are handed back so the accompanying summary line can carry them
      // without recomputing (and without diverging from what was logged).
      expect(described.meta.abandonedToolCallIds).toEqual(["call_9f8a1", "call_9f8a2"]);
    });

    it("still writes a line when the batch is empty", () => {
      const conversationId = new ObjectId().toString();

      service.reportAbandonedToolCalls({
        conversationId,
        toolCalls: [],
        iteration: 4,
        cause: "provider failure",
      });

      const line = logLines().find((l: any) => /ABANDONING/.test(l.message));
      expect(line).toBeDefined();
      expect(line.level).toBe("warn");
      expect(line.meta.abandonedToolCallIds).toEqual([]);
    });
  });
});
