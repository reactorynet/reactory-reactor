/**
 * Turn-scoped user interrupts for the AUTO tool-execution loop.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * `interruptToolExecution()` used to SET a per-conversation flag and never clear
 * it. Only the AUTO loop cleared it (`clearInterrupt`), and only if that loop
 * happened to observe it. So an interrupt raised while no loop was running — the
 * click arriving after the interrupted turn had already exited its loop, or while
 * the turn was between provider calls — survived the turn it was meant for and
 * killed the NEXT one.
 *
 * That is not a rare corner. It is the whole of ticket
 * REACTORY-302016408/20261104/2715764250: conversation `6adb0c56e695bd8de286f2ca`,
 * 2026-11-04.
 *
 *   - flag set 06:23:01.214 → the next tool-using turn died at 06:35:11.006 (12 minutes later)
 *   - flag set 06:38:28.950 → user message 06:39:12.683 → that turn died at 06:39:19.206 (44 s later)
 *
 * At 06:39:19 the AUTO loop's interrupt check — the FIRST statement in the loop
 * body, ahead of `iteration++` — saw the leftover flag and broke immediately. The
 * assistant message at 06:39:19.060 carried two `listSupportTickets` tool calls
 * (both `status: "pending"`) that were therefore never classified: no
 * `executing N tool(s)`, no `pausing`, no per-tool error, nothing. A `select` for
 * those two `tool_call_id`s returns zero rows — neither was ever answered. That
 * silence is the "no dispatch trace" the ticket reports.
 *
 * THE INVARIANT
 * -------------
 * An interrupt requested while turn N is running may only ever affect turn N —
 * never turn N+1.
 *
 * HOW IT IS ENFORCED
 * ------------------
 * Each conversation carries a monotonically increasing *turn epoch*. A turn opens
 * a new epoch as its first act (`beginTurn`), and an interrupt is stamped with the
 * epoch that was current when the user asked for it (`request`). The AUTO loop
 * asks `verdict(conversationId, turnEpoch)` and is stopped only when the stamp
 * matches the epoch of the turn it is running.
 *
 * Both halves of the invariant then fall out of one comparison:
 *
 *   - An interrupt raised *during* turn N is stamped N. Turn N's loop matches, so
 *     it stops. The fix is emphatically not "ignore interrupts".
 *   - An interrupt left over from turn N is stamped N while the loop is running N+1.
 *     It cannot match, so it is discarded (and reported) instead of silently
 *     disarming the next turn's first iteration.
 *
 * WHY NOT SIMPLY CLEAR THE FLAG AT TURN START
 * ------------------------------------------
 * Clearing at `sendMessage` entry also fixes the leak, but it cannot distinguish
 * the two cases above by inspection: it discards every flag present at turn start,
 * including a legitimate one raised during the same turn before the loop was
 * reached (a user who clicks stop while the provider is still streaming the tool
 * calls). This ledger encodes *which turn* asked, so the choice is a comparison
 * rather than a timing assumption. It also keeps a record of what was discarded,
 * which is the observability the ticket asked for — a silently dropped interrupt
 * is precisely the same class of invisibility as a silently dropped tool call.
 *
 * WHAT IT DOES NOT SOLVE
 * ----------------------
 * The stamp is taken server-side, at the moment `interruptToolExecution` runs. A
 * request that arrives in the few milliseconds after turn N releases the
 * conversation lock and turn N+1 has already opened its epoch is indistinguishable
 * from a request aimed at N+1, and will stop N+1. Closing that window needs a
 * client-supplied turn token, which the interrupt API does not carry. The window
 * here is milliseconds; the window the bug had was twelve minutes. Recorded rather
 * than hidden, so the boundary is visible to whoever adds the token.
 *
 * Kept free of any service, model or logger dependency: the state machine is a
 * pure function of (conversationId, epoch) so the invariant above can be asserted
 * directly, without standing up a provider, a transport or a database.
 */

/** One recorded interrupt request. */
export interface IInterruptRecord {
  /** What the user said, if anything (may be the empty string). */
  reason: string;
  /** The turn epoch that was current when the interrupt was requested. */
  epoch: number;
  /** Wall-clock time of the request, for the log line. */
  requestedAt: number;
}

/** The AUTO loop's decision for one iteration boundary. */
export interface IInterruptVerdict {
  /** True when the running turn must stop before dispatching this iteration. */
  stop: boolean;
  /** The user's reason when `stop` is true, otherwise null. */
  reason: string | null;
  /**
   * An interrupt that belonged to a *different* turn and has been discarded here.
   * Reported by the caller so a dropped interrupt is never invisible.
   */
  discarded: IInterruptRecord | null;
}

/** What `beginTurn` reports back: this turn's epoch, plus any leftover to report. */
export interface ITurnStart {
  /** The epoch of the turn that just started. */
  epoch: number;
  /** An interrupt left over from an earlier turn, discarded as this turn began. */
  discarded: IInterruptRecord | null;
}

export class TurnInterruptLedger {
  /** conversationId → epoch of the most recently started turn. */
  private epochs: Map<string, number> = new Map();

  /** conversationId → the outstanding interrupt request, if any. */
  private interrupts: Map<string, IInterruptRecord> = new Map();

  /**
   * Open a new turn epoch for a conversation and return it.
   *
   * Any interrupt still outstanding at this point belongs to a turn that is over —
   * a request the previous turn never reached its loop to observe. It is removed
   * and returned so the caller can say so at WARN, rather than leaving it in place
   * to be re-evaluated (and mis-honoured) by whichever turn asks next.
   */
  beginTurn(conversationId: string, now: number = Date.now()): ITurnStart {
    const epoch = (this.epochs.get(conversationId) ?? 0) + 1;
    this.epochs.set(conversationId, epoch);

    let discarded: IInterruptRecord | null = null;
    const leftover = this.interrupts.get(conversationId);
    if (leftover) {
      this.interrupts.delete(conversationId);
      discarded = leftover;
    }

    return { epoch, discarded };
  }

  /** The epoch of the turn currently running on a conversation (0 when none has). */
  currentEpoch(conversationId: string): number {
    return this.epochs.get(conversationId) ?? 0;
  }

  /**
   * Record a user interrupt, stamped with the epoch of the turn that is running
   * when the request is made. The stamp — not the arrival time — is what decides
   * which turn is allowed to honour it.
   */
  request(conversationId: string, reason?: string, now: number = Date.now()): IInterruptRecord {
    const record: IInterruptRecord = {
      reason: reason || '',
      epoch: this.currentEpoch(conversationId),
      requestedAt: now,
    };
    this.interrupts.set(conversationId, record);
    return record;
  }

  /**
   * The AUTO loop's gate, called at the top of each iteration.
   *
   * Consumes at most one record, so a single request stops exactly one turn: a
   * matching interrupt is returned as `stop` and removed, a non-matching one is
   * returned as `discarded` and removed. Removing either way is deliberate —
   * a stale record that were merely ignored would re-surface at every later
   * iteration boundary and every later turn.
   */
  verdict(conversationId: string, turnEpoch: number): IInterruptVerdict {
    const record = this.interrupts.get(conversationId);
    if (!record) return { stop: false, reason: null, discarded: null };

    this.interrupts.delete(conversationId);

    if (record.epoch !== turnEpoch) {
      return { stop: false, reason: null, discarded: record };
    }

    return { stop: true, reason: record.reason, discarded: null };
  }

  /** Whether an interrupt is outstanding at all (diagnostics only). */
  isArmed(conversationId: string): boolean {
    return this.interrupts.has(conversationId);
  }

  /** Drop all state. For tests and for a conversation being deleted. */
  reset(conversationId?: string): void {
    if (!conversationId) {
      this.epochs.clear();
      this.interrupts.clear();
      return;
    }
    this.epochs.delete(conversationId);
    this.interrupts.delete(conversationId);
  }
}

export default TurnInterruptLedger;
