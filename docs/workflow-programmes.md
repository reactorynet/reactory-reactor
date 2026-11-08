# Workflow programmes (the reconciler)

**Status: reconciler shipped; child reporting pending.**
The scheduling, dispatch, adoption, verification, stall and abort paths below are
implemented and tested. **No child currently reports its own outcome yet** — see
[Known limitation](#known-limitation-child-reporting-is-not-wired-up) — so in
production a package advances to `running` and is then settled by the stall path
rather than by a pushed success. This is the permanent orchestration answer, not a
stopgap.

A *programme* is a dependency graph of work packages that must advance without an
agent babysitting it. An agent turn cannot wait for a future event, so the loop that
advances the graph is a scheduled workflow — not a conversation.

- State: `models/WorkflowProgramme.ts` → Mongo collection `workflow_programmes`
- Decisions: `services/reactor/WorkflowProgrammeService.ts`
- Tick: `workflow/WorkflowProgrammeReconciler.yaml` (`reactor.WorkflowProgrammeReconciler@1.0.0`)
- Cadence: `workflow/schedules/reactor.workflowprogrammereconciler-1.0.0-schedule.yaml` (60s)

## Why not a parent workflow

`invoke_workflow(..., waitForCompletion: true)` is rejected **permanently**.
`InvokeWorkflowStep` keeps `childInstanceId` in a **local variable** and calls
`startWorkflow` unconditionally inside an in-step `while` poll loop. A crash, deploy
or step retry mid-wait starts a **second child** against the same ticket. It is not
merely fragile — it is duplicative.

The reconciler is *`startWorkflow` and return*. Nothing waits. The next tick reads
state and decides.

## Why the decisions are in a service, not YAML

A reconciler is a compare-and-set state machine. YAML has no vocabulary for "update
this subdocument only if it still says `ready` and has never carried a dispatch id".
That predicate is the idempotency boundary. Keeping it in typed code also makes every
acceptance criterion testable without a workflow engine.

## State model

### Programme

`active` → `paused` (resume → `active`) and → `aborted`.
`active`/`paused` → `completed` | `failed` when no package can advance further.

### Package

```
pending ──deps satisfied──► ready ──claim──► dispatching ──adopt──► running
   │                                                                  │
   └──a dependency failed/cancelled──► blocked                        ├──► succeeded
                                                                      └──► failed
abort ──► cancelled (from any non-terminal state)
```

`blocked`, `succeeded`, `failed`, `cancelled` are terminal.

## The three guarantees

### 1. Idempotency is a predicate, not a lock

A dispatch claim is a single conditional write:

```js
findOneAndUpdate(
  {
    programmeId,
    packages: { $elemMatch: { id, state: 'ready', dispatchId: { $exists: false } } },
  },
  { $set: { 'packages.$.state': 'dispatching', 'packages.$.dispatchId': dispatchId, … },
    $inc: { 'packages.$.attempt': 1 } },
)
```

`null` means another tick won — **success**, never an error. Two concurrent ticks
therefore start exactly one child. (The whole-document form
`'packages.dispatchId': { $exists: false }` from the design note would be wrong: as
soon as one package carried a dispatch id, no other package in the programme could
ever be dispatched. The predicate is per element.)

A 55-second per-programme lease is single-flight on top of that. It is not the
correctness boundary.

### 2. Recovery is by `dispatchId`, never heuristic

The dispatch id is minted **before** the child starts and passed **into** the child as
input. If the tick crashes between "start" and "adopt the instance id", the next tick
finds the child by that exact value in the child's workflow history (`data.inputs.dispatchId`)
and adopts it.

A `startWorkflow` that **threw** is deliberately left in `dispatching`, not re-armed:
the call may still have created a child. The `dispatchId` lookup is the only recovery
that cannot duplicate. A `dispatching` package with **no** child found, older than
`staleMs`, is re-armed; that is the only path that retries.

### 3. Push, then verify

Children write their own outcome into the package through
`WorkflowProgrammeService.reportPackageOutcome({ dispatchId, status, prUrl, mergedSha, error })`:

| report | result |
|---|---|
| `status: failed` | `failed` |
| `status: completed` + `mergedSha` | `succeeded` (push, no external call) |
| `status: completed`, no PR | `succeeded` (nothing to merge) |
| `status: completed` + `prUrl`, no `mergedSha` | stays `running`, `awaiting_merge` — the tick verifies |

The tick reads Mongo in the common case. `gh` is consulted only for a package that
claims success without a merge SHA, at most once per `verificationIntervalMs` (5 min)
and at most `maxVerificationsPerTick` times per programme per tick. A `gh` failure is
recorded in `lastVerificationError` and **never** fails a package: a transient CLI
error must not block a wave. A PR that is `OPEN` counts as evidence of life and
resets the package's SLA window.

## Stalls

`lastProgressAt` (per package: dispatch, child report, or a successful verification)
older than `slaMinutes` escalates **once per SLA window**: notify the owner
(`stalledNotifiedAt` marks the window), increment `stallCount`, and record why. Only
when the **stall** budget is spent (`stallCount >= maxAttempts`) does the package
become `failed` and send its own `failed` message.

`stallCount` is deliberately separate from `attempt` (which counts *dispatch*
attempts). "Three failed starts" and "one start plus two silent windows" are different
diagnoses, and a single counter could not tell them apart — the failure message now
names the budget that ran out.

A failed engineering run needs a human, not a silent retry. The programme-level
watermark is deliberately not used as a fallback: a sibling advancing must not make a
quiet package look alive.

### Before escalating, the child itself is consulted

A package that has not *reported* is not necessarily *dead*. When a package goes
overdue, the tick reads its child instance's own status
(`core.ReactoryWorkflowService.getWorkflowHistoryById`) — one engine read per package
per SLA window, never per tick:

| child status | verdict |
|---|---|
| Runnable / Suspended (0, 1) | **alive** — refresh `lastProgressAt`, do not escalate |
| Complete (2) | `failed` with `child_completed_unreported` — it finished and reported nothing |
| Terminated / DeadLettered (3, 4) | `failed` with `child_terminated` |
| unreadable / unknown | fall through to the SLA path (the conservative branch) |

This exists because the *first* version escalated a healthy 12-hour
`core.ProcessAITicket` run as "gone silent" at 45/90/135 minutes and failed it at
~180 while it was still working. A live child is never silent.

## Pause, resume, abort

- **Pause** writes document state only. In-flight children are left completely
  untouched — a pause is a statement about the next step, not a kill switch.
- **Resume** writes `active`; the next tick re-reads the graph and continues from
  actual state. Nothing is re-dispatched because nothing was reset.
- **Abort** moves the programme to `aborted` **first**, then cancels every
  non-terminal child via `core.ReactoryWorkflowService.cancelWorkflowInstance`
  (resolving a `dispatching` package's child by its dispatch id when it was never
  adopted), then marks every remaining package `cancelled`. Finished packages keep
  their outcome.

  "Moves first" alone is not enough, because a tick may already be inside
  `startWorkflow`. The dispatch **claim** therefore carries the programme state
  (`expectProgrammeStates: ['active']`) in the same conditional write, so a claim and
  an abort contend for one document and the later write loses. And when a claim did
  win but the child's adopt write loses, the tick **cancels the child it just
  started** and records why. A human's stop cannot leave an uncancelled run behind.
  `abort()` reports those mid-flight packages separately as `pendingDispatch`, which
  is distinct from `cancelFailures` (nothing had failed — the uncertainty is real).

Both are authorised to the **programme owner** or a holder of an administrative role
(`ADMIN`, `SUPERADMIN`, `DEVELOPER`), and are **refused for the system account**, so
the audit trail names a person: `pausedByUserId` / `pausedByEmail` /
`abortedByUserId` / `abortedByEmail`.

## Dispatch identity

Each child is started under the **programme owner's rebuilt context**
(`createWorkflowContext({ userEmail, partnerKey })`), so the child run and every chat
session/task it creates belong to the person who owns the programme. If the owner
context cannot be rebuilt the tick falls back to its own identity and logs a warning.

## Notifications

`WorkflowProgrammeService.notify` sends through
`communicator.CommunicatorService@1.0.0.send` (the required channel) and **also**
raises a task on the guaranteed task surface. Evidence is persisted
(`notifiedAt`, `notifiedEvent`, `notificationChannel`, `notificationError`), so "the
owner was told" is a fact in the record rather than an inference from a log line.
Settling is a state transition that only one caller can win, so a repeated tick cannot
send a second email.

Two kinds of message, with two separate dedupe keys (conflating them was a real
defect — a package failure used to consume the programme's terminal notification):

| kind | events | dedupe evidence | subject |
|---|---|---|---|
| programme terminal | `completed`, `failed`, `aborted` | `notifiedAt` + `notifiedEvent`, written only by the transition winner | `Programme "X" completed successfully` / `stopped with failures` / `was aborted` |
| per package | `stalled`, `failed` | `stalledNotifiedAt` (per window) and `failedNotifiedAt` (claimed once, atomically) | `Programme "X" — package "id" has gone silent` / `… package "id" failed` |

So a programme with three failing packages sends three distinct package messages and
exactly one terminal message, in that order.

## Child reporting is wired up (1.4.8)

`core.ProcessAITicket` 1.4.8 is the first production caller of
`reportPackageOutcome`. Reporting is **path-specific**, because a step placed after a
step that terminates the instance never runs:

| how the run ends | what reports | reported status |
|---|---|---|
| success, pull request opened | `programmeOutcomeGate` → `reportProgrammeOutcome` at the end of the run | `completed` + `prUrl` (the tick then verifies the merge with `gh`) |
| success, nothing to publish | same end gate, no `prUrl` | `completed` with **no** `prUrl` — the legitimate "no merge to wait for" branch |
| review rejection / exhaustion | same end gate | `failed` + `error` (runStatus, verdict, cycle count, PR state) |
| run produced no work / non-completion | same end gate | `failed` + `error` |
| no ticket found | same end gate | `failed` + `error` |
| **publish-readiness blocked** | `publishBlockReportGate` → `reportPublishBlockOutcome`, authored immediately **before** `publishBlockHalt` | `failed` + the `describePublishBlock` detail; the instance then terminates |
| **contaminated primary checkout** | `submoduleBaselineReportGate` → `reportSubmoduleBaselineOutcome`, authored immediately **before** `submoduleBaselineHalt` | `failed` + the formatted guard violations; the instance then terminates |
| engine-level termination (throw, step timeout, programmatic cancel) | **nothing — no step can run after it** | the package is failed by the reconciler's `child_terminated` branch, from the child instance status |

The last row is the one honest gap: a run that dies at the engine level cannot report
itself, so its package fails with `child_terminated` rather than a child-authored
reason. It is still a failure, never a success.

Mechanics common to every reporting path:

- The child declares `dispatchId`, `programmeId` and `packageId` as **optional** inputs.
  A Support-path dispatch supplies none of them, so it behaves exactly as before and
  calls nothing.
- `readProgrammeDispatch` is hoisted above `ticketGuard` and every report is gated on
  `steps.readProgrammeDispatch.stdout !== ''`, so a `${input.dispatchId}` placeholder
  can never masquerade as an id — and the two halting branches, which live inside the
  ticket-guarded pipeline, can still reach it.
- The end gate derives its status from `variables.runStatus`: `completed` only when the
  run reached the publish path. A halted run never sends a `prUrl`, and no `mergedSha`
  is ever invented.
- Each report step is `continueOnError: true` (never `retryPolicy` — the two are
  mutually exclusive): a failed report must not retroactively fail an engineering run
  that already succeeded. `programmeOutcomeLanded` logs at WARN when the programme did
  not accept the end-gate push, because a swallowed report is precisely the
  `child_completed_unreported` failure the bridge exists to remove.

The reconciler's refusal is unchanged: a child that completes without reporting is
still failed `child_completed_unreported`. Only an actual report can settle a
package, and `succeeded` still requires a merge SHA, a verified merge, or a completed
report with no PR to wait for.

## Provisioning the schedule

The Scheduler reads `<APP_DATA_ROOT>/workflows/schedules` — or `./data/workflows/schedules`
when `APP_DATA_ROOT` is unset — and **nothing copies files there**.

The only copy in version control is the reviewable one in this module at
`workflow/schedules/reactor.workflowprogrammereconciler-1.0.0-schedule.yaml`. It is
**not** committed to `reactory-data`: that repository ignores `workflows/*`, so every
schedule on a host is a deployment-installed artefact. Do not read "the runtime copy
lives in reactory-data" as "the deploy carries it".

**Deployment step:** copy that file into `<APP_DATA_ROOT>/workflows/schedules/` (or
bake it into the data image) before expecting the tick to run.
`WorkflowProgrammeService.onStartup` logs a warning naming the exact destination when
it is absent, so a missing schedule is visible at boot instead of showing up as a
programme that never moves. The check resolves the data root exactly as the Scheduler
does, so it cannot disagree with where the tick actually looks.

## Operations

Create a programme from any signed-in user's context:

```ts
const service = context.getService('reactor.WorkflowProgrammeService@1.0.0');
await service.createProgramme({
  name: 'Reactor hardening',
  childWorkflowId: 'core.ProcessAITicket@1.4.8',
  childInputDefaults: { agentId: 'ReactorAIPersona' },
  packages: [
    { id: 'schema', title: 'Schema migration', input: { ticketReference: 'ACME-1' } },
    { id: 'api', title: 'API surface', dependsOn: ['schema'], input: { ticketReference: 'ACME-2' } },
  ],
});
```

Read: `getProgramme({ programmeId })`, `listProgrammes({ state })`.
Control: `pause`, `resume`, `abort` — each takes `{ programmeId, reason }`.
A child asks about itself: `getPackageStatus({ dispatchId })`.

The reconciler is addressed by the schedule with no inputs (all active/paused
programmes, `limit` 25). `reconcile({ programmeId })` exists for ops and tests.

## Tests

`services/reactor/__tests__/WorkflowProgrammeService.test.ts` pins the acceptance
criteria directly:

- two concurrent claim calls (and two concurrent `reconcile` passes) start exactly one child;
- a crash between dispatch and adopt is recovered by `dispatchId` with no second start;
- a thrown start is recovered on the next tick, never re-armed;
- pause stops new dispatch and leaves a running child running; resume continues;
- abort cancels non-terminal children and marks the rest;
- completion and failure notify once, through the communicator, with a task fallback;
- stalls notify once per window and fail only at the attempt budget;
- `gh` is called only for an untrusted claim, and its failure never fails a package.

`workflow/__tests__/WorkflowProgrammeReconciler.contract.test.ts` keeps the YAML, the
registry entry and the 60-second schedule in step — including asserting that no
`invoke_workflow` step exists.

## Not in scope

The GraphQL/macro surface for creating and controlling programmes is deliberately not
part of this change; the service is the API, and it already enforces ownership and
role checks. Continuations remain the primitive for interactive follow-up: they handle
"wake me later", the reconciler handles multi-step dependent work.
