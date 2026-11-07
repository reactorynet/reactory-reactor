# Agent continuations and the programme reconciler — analysis and design

**Status:** P2 (continuation) is **shipped**. P1 (programme reconciler) is **not built**.
**Supersedes:** the "analysis first" deliverable on `REACTORY-302016408/20261023/2167897731`.
**Verified against:** `reactory-express-server` / `reactory-reactor`, 2026-11-07.

## 0. Honest framing

The ticket asked for analysis **before** implementation, with implementation explicitly out of scope. That did not happen in that order: P2 was built, and this document is partly retrospective.

It is written anyway, because two things were lost by skipping it:

1. **The rejected options were never recorded.** `docs/agent-continuations.md` explains *how to use* what shipped and says nothing about what was considered and why it lost. A future reader cannot tell a considered decision from an accident.
2. **P1 was never designed at all.** The multi-step orchestration problem this ticket was opened for — the one that produced the original failure — is still unsolved, and shipping P2 did not solve it.

So: §3 is a retrospective decision record for P2. §4 is a prospective design for P1. §5 answers the robustness matrix against shipped code rather than against speculation.

---

## 1. The two problems, kept separate

They were tangled in the ticket and must not be again.

**P1 — Multi-step orchestration.** A programme of dependent work packages (e.g. seven waves, W1→W11) must progress to completion without an agent babysitting it. The agent should not be in the loop at all.

**P2 — Agent continuation.** When an agent legitimately needs to follow up later — "check whether the PR merged", "wait for the webhook", "report back in an hour" — it must be able to *register* that interest and be *woken*, instead of making a promise it cannot keep.

The failure that opened the ticket was an agent saying *"I'll monitor the run and report when QualityQuinn's verdict lands."* That is a **P2** failure — a promise with no mechanism. The owner's challenge (*"How are you monitoring the run? You have no active turns waiting?"*) was correct.

But the underlying need was **P1**: the programme should not have needed an agent watching at all.

---

## 2. Capability inventory — verified

| Capability | Status | Evidence |
|---|---|---|
| `wait_event` durable suspend | Real, **without timeout** | `YamlStepRegistry.ts`; `WaitEventTimeoutContract.ts` now *rejects* `timeout:` in a `wait_event` block |
| `publishWorkflowEvent` / `signalWorkflowInstance` | Real | GraphQL mutations |
| `user_activity` + `completeWorkflowTask` | Real, carries `chatSessionId` | `ProcessAITicket` approval task |
| `delay` timed resume | Real | core step |
| `cross_instance_variable` — persistent vars | **Real, MongoDB-backed** | `steps/core/CrossInstanceVariableStep.ts`; `scope: global \| workflow`, actions `set/get/delete` |
| Schedule (cron) | Real, **with a lock model** | `Scheduler/Scheduler.ts`, `SchedulerLock.model.ts` |
| `invoke_workflow` with `waitForCompletion` | Real | returns child `instanceId`, `status`, `data` |
| `agent_conversation` with `sessionId` | Real | resumes the same conversation |
| `ReactorSendMessage` | Real | the wake-up hop |
| **Continuation primitive** | **Shipped** | `continuationMacro.macro.ts`, `AgentContinuationService.ts`, `AgentContinuation.yaml`, `AgentContinuationSweeper.yaml` |
| **Programme reconciler** | **Absent** | no reconciler, no manifest, no readiness loop anywhere in the module tree |

Two corrections to the original inventory:

- **`wait_event` cannot carry a timeout.** The original ticket treated `effectiveDate = now + timeout` as a usable feature. It is not: the sibling ticket `…/20261023/1912269283` established that a `timeout` silently discards in-window events, and a contract test now fails the build if `timeout:` reappears in any `wait_event`. Any design predicated on "wait with a timeout" is built on a defect.
- **`cross_instance_variable` is workflow-scoped, not programme-scoped.** `scope: workflow` keys a variable to a workflow *definition*, not to one *programme run*. Two concurrent programmes using the same reconciler definition would collide on the same key. This matters for §4 and is the single most important constraint on P1's state design.

---

## 3. Retrospective decision record — P2

### Options as presented, and what actually happened

**A — First-class Continuation.** A `Continuation` record (`chatSessionId`, `personaId`, trigger, `resumePrompt`, state, `firedAt`, `correlationKey`) plus a workflow and `scheduleContinuation` / `cancelContinuation` / `listContinuations` macros; on fire, atomically claim and call `ReactorSendMessage`. — **Chosen and shipped.**

**B — Extend `todo` with trigger + callback fields.** — **Rejected**, in favour of `todo` becoming a read-only *projection* over continuations (`todo.continuationId`). This is the right call and worth recording why: `todo` is a user-facing checklist shared by the `todo` tool and the `todo` workflow step. Putting scheduling semantics in it would mean polling a todo collection as if it were a scheduler, and it would let a model conjure a wake-up by writing a checklist item. Today `todo(dueAt: …)` is explicitly **rejected** in favour of `scheduleContinuation`, which is the correct separation.

**C — Long-lived `agent_conversation` inside a workflow** (what `ProcessAITicket` does). — **Retained for batch runs only.** Correct where a workflow owns the session and the human is not waiting on a chat reply; unsuitable for an interactive turn that must return, and token-expensive (a held conversation pays context on every step).

**D — Client-side polling.** — **Rejected** as unsound: it dies with the tab, cannot be attributed, and cannot be bounded or audited server-side.

### Two design decisions the shipped implementation made that the ticket did not specify

1. **Trigger evaluation is allowlisted, not caller-declared.** `condition` triggers name a `serviceId`/`method` pair, and that pair must be registered via `registerConditionPredicate` — "not by a caller, and never by a model" (`AgentContinuationService.ts:107`). With an empty allowlist, `condition` triggers are refused outright. This closes the obvious abuse path: a model cannot point a poller at an arbitrary service method to read data it should not see.

2. **Bounded waits are mandatory.** `expirePrompt` is required, and expiry is delivered as a sentinel (`outcome: 'not_observed'`) rather than by a `wait_event` timeout. This is what makes the honesty claim verifiable: a wake that did not observe its signal reports that it did not.

### What P2 does not do

It does not remove the agent from the loop — it makes the agent's promise *honest*. An agent that registers a continuation is still going to be woken, still spend a turn, still report. That is the right shape for interactive work and the wrong shape for a seven-wave programme.

---

## 4. P1 — design for the programme reconciler

### Shape

A **scheduled reconciler** (Argo/Tekton model), not a waiting parent. The naive parent — `invoke_workflow(waitForCompletion: true)` per wave — should stay rejected: `ProcessAITicket` has a 12 h timeout and polls for merge, so a parent would hold a 12–40 h wait and silently lose the programme if either side dies.

Each tick:

1. **Load the programme manifest** — packages with `{ id, ticketReference, dependsOn[], agentId, workdir, maxConcurrent, slaMinutes }`.
2. **Evaluate readiness from observable state only** — ticket status `resolved`, PR merged via `gh`, child instance terminal. Never from "did I dispatch it".
3. **Dispatch** any package whose dependencies are satisfied and which is not already running.
4. **Persist programme state** (see below).
5. **Notify** the owner on completion, failure, or stall.

### The five questions the ticket asked

**Q1 — Where does programme state live?**

Not `cross_instance_variable` with `scope: workflow` alone. That scope keys to the workflow *definition*, so two concurrent programmes running the same reconciler definition would overwrite each other's `watermark` and `dispatched` list.

Recommended: a small Mongo document per programme, `reactor_programme_runs`, keyed by `programmeId`:

```
{ programmeId, manifestVersion, packages: [{ id, state, instanceId, dispatchedAt, completedAt, lastError }],
  paused, aborted, createdAt, updatedAt }
```

Use `cross_instance_variable` only for genuinely global, singleton values (e.g. a reconciler high-watermark). The reason to prefer a document over a variable is that the reconciler needs **per-package** state, and a `set/get` string variable forces the whole thing into one JSON blob that two ticks can clobber on a read-modify-write race.

**Q2 — How is "already dispatched" made idempotent across ticks and restarts?**

Do not infer it from history. Record it, and make the record the decision:

```
findOneAndUpdate(
  { programmeId, 'packages.id': pkgId, 'packages.state': 'ready' },
  { $set: { 'packages.$.state': 'dispatching', 'packages.$.dispatchedAt': now } },
  { returnDocument: 'after' }
)
```

Only the tick that wins the atomic transition dispatches. A second tick — concurrent, or waking after a restart — finds no `ready` package and does nothing. Then `dispatching → dispatched` records the child `instanceId`. A package stuck in `dispatching` past a short timeout is a **crashed dispatch**, not a running one, and may be retried (with a bounded attempt count) — that distinction is why the intermediate state exists.

This is the same claim pattern as `AgentContinuationService`, deliberately: one proven idiom, not two.

**Q3 — Cadence?**

Every 2 minutes while any package is active; hourly when the programme is idle but incomplete (so a long human-gated stall costs nothing); and stop scheduling entirely once terminal. Use the existing `Scheduler` + `SchedulerLock` rather than a long-lived workflow, so a server restart cannot lose the programme — the cron is re-armed from persisted schedule state, and the lock prevents two nodes reconciling simultaneously.

Avoid sub-minute cadence: dispatch is expensive (`ProcessAITicket` spins a worktree), and readiness rarely changes faster than a person merges a PR.

**Q4 — A package that stalls in `in_progress`?**

Observable-state readiness cannot distinguish "working" from "wedged". Add an explicit stall rule:

- `dispatchedAt + slaMinutes` exceeded **and** no child instance transition → mark `stalled`, notify, do **not** auto-redispatch.
- If the child instance is terminal but the ticket is not `resolved`, that is a **different** failure (published but unmerged) — route it to the merge-follow-up path rather than treating it as a stall.

Auto-redispatch on stall is tempting and wrong: today's evidence (`6aeeedb0`, 14 merge polls; `6aeefbe2`, reviewer step terminated) shows the common stall causes are external — a human not merging, or a provider fault — and redispatching burns a second run into the same wall.

**Q5 — Human pause / abort?**

`paused: true` on the programme document. The reconciler still ticks, still evaluates, but dispatches nothing; already-running children are left alone (they are `ProcessAITicket` runs with their own approval gates and should not be killed by a programme pause). `aborted: true` is terminal: no further dispatch, children allowed to finish, programme marked failed with the reason. Both need a GraphQL mutation and an owner-facing control — a pause that requires editing Mongo is not a control.

### Concurrency

`maxConcurrent` is enforced at dispatch time by counting packages in `dispatched`/`dispatching` within the same atomic step, not by a separate counter that can drift.

---

## 5. Robustness matrix — verified against shipped code

| # | Requirement | Status |
|---|---|---|
| 1 | Idempotent claim | **Met.** Atomic `findOneAndUpdate` on `state: 'armed'`; a second fire is a no-op. |
| 2 | Bounded waits, honest expiry | **Met.** `expirePrompt` mandatory; "must state plainly it was not observed" wording asserted. |
| 3 | Timeout vs event ambiguity | **Met, by avoidance.** `wait_event` is used *without* timeout; expiry is a sentinel with `outcome: 'not_observed'`. A build-time contract test rejects `timeout:` in any `wait_event`. |
| 4 | Signal security | **Partially met.** `correlationKey` is stripped from logs; the instance is started at registration with the owner's identity. **Open:** key guessability is not addressed — an unguessable `eventKey` (or partner scoping on `publishWorkflowEvent`) is still needed. |
| 5 | Attribution / tenancy | **Met.** Started at registration with the owner's identity, so the wake is sent as the owner *structurally*, not via `runAs`. Avoids the `ServiceManager` singleton system-context defect. |
| 6 | Session deleted / user revoked | **Met.** Orphan branches `session_missing`, `owner_mismatch`, `no_identity`. |
| 7 | Per-session serialisation | **Partially met.** Caps limit pending continuations per session (3) and enforce a 60 s minimum interval, which bounds interleaving but does not *serialise* two fires at the same instant. A per-session claim would be needed for a hard guarantee. |
| 8 | Cost and abuse | **Met.** Per-session caps, minimum interval, budget check. |
| 9 | Observability | **Met.** `listContinuations` + `todo` projection (`todo.continuationId`) so "waiting until 14:00" is visible. |
| 10 | Headless reply delivery | **Partially met.** Queue-and-resume exists. Communicator fan-out for an away user is not wired — it depends on the communicator work in this same programme. |

**Residual risks, in priority order:** (4) key guessability, (7) true serialisation, (10) away-user notification.

---

## 6. Sequencing recommendation

**P2 first was correct, and it is done.** Not because it solves P1, but because it was the smaller, better-understood primitive, and P1 needs it: a reconciler that wants to tell an owner "wave 3 is done" now has a way to do that without holding a workflow open.

**P1 is still worth building**, and is the only thing that removes the agent from the loop. It should be a **separate ticket** from this one. Scope it as: manifest schema, `reactor_programme_runs` model, reconciler workflow, pause/abort mutations, stall detection, and the notifier.

**Do not** build P1 as a parent workflow holding `waitForCompletion`. That was rejected for good reason and the rejection still holds.

**Do not** let P1 wait for P2 hardening. Risks (4) and (7) are real but P1's dispatch path does not depend on them.

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Two reconcilers tick concurrently | Double dispatch | `SchedulerLock` + atomic claim (both required; the lock alone is not enough after a crash) |
| Programme state as one JSON variable | Lost updates on read-modify-write | Per-package state in a document, atomic per-package transitions |
| Stall misread as failure | Auto-redispatch into the same wall | Stall → notify, never auto-redispatch; distinguish stall from published-but-unmerged |
| Reconciler definition reused by two programmes | `workflow`-scoped variables collide | Programme-keyed document, not `cross_instance_variable` scope `workflow` |
| `condition` trigger absent-mindedly used for P1 readiness | Reads arbitrary service methods | Keep the predicate allowlist; P1 readiness should be explicit, typed checks, not a generic poller |
| P1 built before the manifest is stable | Reconciler hard-codes package shapes | Define the manifest schema first; treat it as the contract |

## 8. Open questions for the owner

1. Is P1 still wanted, now that a single agent can legitimately register continuations? A programme of seven waves still cannot progress unattended without it — but a smaller programme of two waves with a human in the loop might not need it.
2. Should a paused programme be resumable mid-flight, or does pause imply drain-then-stop?
3. Should P1's notifier go through the communicator (which this programme is itself repairing), or stay in-app until communicator is trustworthy?
