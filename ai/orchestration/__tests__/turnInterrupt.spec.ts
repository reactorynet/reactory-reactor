import { describe, it, expect, beforeEach } from "@jest/globals";
import { TurnInterruptLedger } from "../turnInterrupt";

/**
 * The interrupt/epoch state machine that the AUTO tool loop gates on.
 *
 * THE INVARIANT UNDER TEST
 * ------------------------
 * An interrupt requested while turn N is running may only affect turn N — never
 * turn N+1.
 *
 * Both halves matter, and each has been broken in production at least once:
 *
 *  - Too weak (today's bug): the flag survived its own turn and killed the next
 *    one. Conversation `6adb0c56e695bd8de286f2ca`, 2026-11-04: an interrupt set at
 *    06:38:28.950 disarmed the turn that started at 06:39:12.683, which broke out
 *    of its AUTO loop at 06:39:19.206 — 146 ms after its assistant message carrying
 *    two `listSupportTickets` calls was persisted — leaving both calls unanswered
 *    with no dispatch trace at all (ticket
 *    REACTORY-302016408/20261104/2715764250).
 *  - Too strong: ignoring interrupts outright. A user who clicks stop must still
 *    stop the turn they are watching, which is why the epoch is compared rather
 *    than the feature being removed.
 *
 * These are unit tests over the state machine on purpose: reproducing either
 * failure end-to-end needs a live provider, an SSE transport and a database, and a
 * test that heavy is the one that gets deleted when it goes flaky.
 */
describe("TurnInterruptLedger", () => {
  let ledger: TurnInterruptLedger;

  beforeEach(() => {
    ledger = new TurnInterruptLedger();
  });

  describe("a stale interrupt cannot kill the next turn (the regression)", () => {
    it("discards an interrupt whose turn ended without observing it, so the next turn dispatches", () => {
      // Turn 1 starts and the user interrupts it. Turn 1's loop had already exited
      // (or never reached its check), so the request was never consumed — the exact
      // shape of the 06:23:01.214 and 06:38:28.950 interrupts in the ticket.
      const turn1 = ledger.beginTurn("conv-1", 1_000);
      ledger.request("conv-1", "stop", 1_100);

      // 44 seconds later the user sends a new message. A new turn, a new epoch.
      const turn2 = ledger.beginTurn("conv-1", 44_000);

      expect(turn2.epoch).toBe(turn1.epoch + 1);

      // The leftover is reported rather than silently swallowed: a dropped user
      // action has to be visible, or the next investigation starts from zero.
      expect(turn2.discarded).not.toBeNull();
      expect(turn2.discarded?.epoch).toBe(turn1.epoch);
      expect(turn2.discarded?.reason).toBe("stop");
      expect(turn2.discarded?.requestedAt).toBe(1_100);

      // THE ASSERTION THAT MATTERS: the loop's gate lets turn 2 run its tools.
      const verdict = ledger.verdict("conv-1", turn2.epoch);
      expect(verdict.stop).toBe(false);
      expect(verdict.discarded).toBeNull();
    });

    it("never lets a record stamped for an earlier epoch stop a later one, even if no turn start consumed it", () => {
      // Belt and braces for the same invariant. `beginTurn` normally removes the
      // leftover; this proves the gate itself is epoch-scoped, so no future caller
      // that bypasses `beginTurn` can resurrect the leak.
      const { epoch } = ledger.beginTurn("conv-2", 1_000);
      ledger.request("conv-2", "stop", 1_100);

      const verdict = ledger.verdict("conv-2", epoch + 1);

      expect(verdict.stop).toBe(false);
      expect(verdict.discarded?.reason).toBe("stop");
      expect(verdict.discarded?.epoch).toBe(epoch);
    });

    it("does not leave the discarded record behind to be re-evaluated", () => {
      const { epoch } = ledger.beginTurn("conv-3");
      ledger.request("conv-3");
      ledger.verdict("conv-3", epoch + 1);

      expect(ledger.isArmed("conv-3")).toBe(false);
      // A second ask from the same (later) turn sees nothing at all.
      expect(ledger.verdict("conv-3", epoch + 1)).toEqual({
        stop: false,
        reason: null,
        discarded: null,
      });
    });
  });

  describe("an interrupt raised during the current turn still stops it", () => {
    it("stops the turn whose epoch was current when the request was made", () => {
      // The fix must not be "ignore interrupts". A user clicking stop while turn 1
      // is streaming must stop turn 1.
      const { epoch } = ledger.beginTurn("conv-4");
      ledger.request("conv-4", "user cancelled");

      const verdict = ledger.verdict("conv-4", epoch);

      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toBe("user cancelled");
      expect(verdict.discarded).toBeNull();
    });

    it("stops exactly one turn: the request is consumed, not sticky", () => {
      const { epoch } = ledger.beginTurn("conv-5");
      ledger.request("conv-5", "stop");

      expect(ledger.verdict("conv-5", epoch).stop).toBe(true);
      // Re-asked at the next iteration boundary of the same turn: already consumed.
      expect(ledger.verdict("conv-5", epoch).stop).toBe(false);
      expect(ledger.isArmed("conv-5")).toBe(false);
    });

    it("carries an empty reason rather than fabricating one", () => {
      const { epoch } = ledger.beginTurn("conv-6");
      ledger.request("conv-6");

      const verdict = ledger.verdict("conv-6", epoch);
      expect(verdict.stop).toBe(true);
      expect(verdict.reason).toBe("");
    });
  });

  describe("epochs", () => {
    it("starts at 1 for a conversation that has never run a turn", () => {
      expect(ledger.currentEpoch("fresh")).toBe(0);
      expect(ledger.beginTurn("fresh").epoch).toBe(1);
      expect(ledger.currentEpoch("fresh")).toBe(1);
    });

    it("increases monotonically per conversation and independently across conversations", () => {
      ledger.beginTurn("a");
      ledger.beginTurn("a");
      const third = ledger.beginTurn("a").epoch;
      const firstOfB = ledger.beginTurn("b").epoch;

      expect(third).toBe(3);
      expect(firstOfB).toBe(1);
      expect(ledger.currentEpoch("a")).toBe(3);
    });

    it("stamps a request with the epoch current at request time, not at consume time", () => {
      const { epoch } = ledger.beginTurn("conv-7", 5_000);
      const record = ledger.request("conv-7", "stop", 5_100);

      expect(record.epoch).toBe(epoch);
      expect(record.requestedAt).toBe(5_100);
    });

    it("stamps epoch 0 when no turn has ever run, which no loop can ever match", () => {
      // The click arrives with nothing running. There is nothing to stop, and the
      // stamp makes that structurally true instead of a timing assumption.
      const record = ledger.request("never-ran", "stop");
      expect(record.epoch).toBe(0);

      const { epoch } = ledger.beginTurn("never-ran");
      expect(epoch).toBe(1);
      expect(ledger.verdict("never-ran", epoch).stop).toBe(false);
    });
  });

  describe("reset", () => {
    it("clears one conversation without touching the others", () => {
      const a = ledger.beginTurn("a").epoch;
      ledger.beginTurn("b");
      ledger.request("a", "stop");

      ledger.reset("a");

      expect(ledger.currentEpoch("a")).toBe(0);
      expect(ledger.isArmed("a")).toBe(false);
      expect(ledger.currentEpoch("b")).toBe(1);
      // A fresh epoch for `a` restarts at 1 and cannot match the old stamp.
      expect(ledger.verdict("a", a).stop).toBe(false);
    });

    it("clears everything when called with no conversation", () => {
      ledger.beginTurn("a");
      ledger.beginTurn("b");
      ledger.request("a");

      ledger.reset();

      expect(ledger.currentEpoch("a")).toBe(0);
      expect(ledger.currentEpoch("b")).toBe(0);
      expect(ledger.isArmed("a")).toBe(false);
    });
  });
});
