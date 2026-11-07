# Durable agent continuation — analysis, design and decision

> **Status as of 2026-11-07 — read this before acting on anything below.**
>
> This analysis was produced on 2026-10-23 for `REACTORY-302016408/20261023/2167897731`
> and is committed here verbatim, because until now it existed only in an agent workspace
> (`reactor-data/profiles/reactor/personas/workflowwill/workspace/docs/`, mirrored to
> `reactor/.../workspace/notes/`) and was therefore invisible to anyone reading the repository.
>
> **What has since shipped, against §11's four decisions:**
>
> | Decision | Status |
> |---|---|
> | **D3** — `wait_event` timeout fix | ✅ **Shipped**, as §11's first option: validation *rejects* `timeout` in a `wait_event` block. `reactory-core/workflow/YamlFlow/validators/WaitEventTimeoutContract.ts`; wired into `YamlFlowBuilder` on three paths; 42 tests. A build failure now prevents the silent-signal-loss bug described in §0.1 from being reintroduced. |
> | **D2** — P2 as Option A, register-then-wait | ✅ **Shipped.** `continuationMacro.macro.ts` (`scheduleContinuation` / `cancelContinuation` / `listContinuations`), `AgentContinuationService`, `AgentContinuation.yaml` + `AgentContinuationSweeper.yaml`, collection `reactor_continuations`. The shape is as recommended: instance started at registration with the owner's identity (attribution by construction), firing is an event publish, expiry is a sentinel carrying `outcome: 'not_observed'`, `expirePrompt` is mandatory. |
> | **D4(a)** — programme state in its own collection | ⏸ **Not exercised** — depends on D1. |
> | **D4(b)** — serialisation stance | ⚠️ **Partially.** Per-session caps (3 pending) and a 60 s minimum interval bound interleaving, but do not *serialise* two simultaneous fires. §11's recommended "accept `CONVERSATION_PROCESSING` and re-arm" was not implemented as such. |
> | **D1** — P1 programme reconciler | ❌ **Not built.** §3 remains unimplemented design. This is the only outstanding decision, and it is the one that actually removes the agent from the loop. |
>
> **Practical note:** the shipped implementation follows this design closely enough that §5 (Option A design) reads as a description of what exists, not a proposal. For day-to-day usage see the companion `docs/agent-continuations.md`, which is the operating guide; this document is the rationale, the corrected capability inventory (§2) and the failure analysis.
>
> Two claims in the body have been superseded by events and are left unedited so the record stays honest: §0.3's `ServiceManager` assessment stands (still fixed), and the "decision required" framing in §11 is now only true of D1.

---

# Durable agent continuation — analysis, design and decision

**Ticket:** `REACTORY-302016408/20261023/2167897731`
**Author:** WorkflowWill
**Date:** 2026-10-23
**Status:** analysis only — nothing implemented, no workflow registered, no code changed.

---

## 0. Executive summary

The requirement is correct and the failure is real: an agent cannot legitimately say "I will
monitor that and report back", because a chat turn is the unit of execution and nothing resumes it.
Everything else follows from that.

Four findings reshape the ticket's stated plan, and two of them are blocking:

1. **`wait_event` does not time out.** The ticket says it "suspends and resumes on **event or
   timeout**". The suspend half is true and genuinely durable. The timeout half is false — there is
   no timer anywhere in the path. Worse, the *opposite* hazard exists: `YamlFlowBuilder` derives
   `effectiveDate` as `now + timeout`, and the engine treats `effectiveDate` as a **lower bound on
   event time**, not a deadline. So specifying `timeout: 3600000` does not arm a 1-hour timer; it
   makes the workflow **deaf for the first hour** and then it waits forever. Signals published
   inside that window are consumed and silently discarded.
   → The ambiguity in robustness item 3 does not exist; the *real* defect is worse and must be
   fixed before any continuation primitive can be built on `wait_event`.

2. **`delay`, `invoke_workflow(waitForCompletion)` and `ReactorSendMessage` are not the primitives
   the ticket believes.** `delay` is a blocking `await` inside a step (not a durable sleep);
   `invoke_workflow` with `waitForCompletion` is an in-step `while` poll loop that re-starts the
   child on every replay. Both hold a step open, which is exactly the "12–40h parent wait" the
   ticket already wanted to reject — but the reason to reject it is stronger than fragility: it is
   **not crash-safe**, and a restart mid-wait **duplicates the child workflow**.

3. **The `ServiceManager` singleton attribution defect is already fixed.** Ticket
   `…3703515660` was remediated by `7979abec fix(services): bind singleton services to the
   caller's execution context (#62)`: cached singletons are now wrapped in a per-caller `Proxy`
   facade (`src/services/serviceExecutionContext.ts`). The suspected trap is closed. The real
   attribution hinge for a continuation is elsewhere — `WorkflowIdentity` / `__identity`
   rehydration in `YamlFlowRuntime.ts` — and it is a **silent fail-open to the system user** when
   identity is absent or unresolvable. That must be closed by construction, not by convention.

4. **The live `reactory.ReactorySupportWorkflowService` already knows about (3)** and carries a
   hand-rolled fail-closed guard (`planDispatch` refuses to dispatch when the running identity is
   absent or is the system user). That is the strongest available evidence that this is a live,
   production-relevant hazard rather than a theoretical one — and that per-feature guards are the
   wrong place to solve it.

**Recommendation:** proceed with **P1 as a scheduled reconciler, immediately**, because it needs no
platform change and because its tick loop *is* the firing engine P2 needs. Build **P2 as Option A**,
but with a materially different shape from the ticket's sketch:

- **Register-then-wait, not fire-then-send.** The `AgentContinuationWorkflow` instance is started at
  *registration* time from the live session context. That single decision gives correct attribution
  (via `__identity`), a durable record with no extra collection semantics, and a free audit trail.
  Firing is an **event publish**, never a `startWorkflow` under the system user.
- **One waiting mechanism, many firing mechanisms.** The workflow waits on exactly one event name;
  `at`, `condition`, `task` and `webhook` all resolve to "someone publishes that event". The sweeper
  handles time and conditions; `publishWorkflowEvent` handles external signals.
- **Expiry is a sentinel event, not a timeout.** A sweeper publishes `{outcome: 'expired'}` on the
  same key at the deadline. The resumed step therefore *can* distinguish a real signal from an
  expiry — because both arrive as data, not as a race between a signal and a clock.

**Decision required:** see §11. Four items, one of which (the `wait_event` timeout fix) is a
prerequisite rather than a choice.

---

## 1. Scope and method

Everything below was read from source in `reactory-express-server` at `2026-10-23`, not inferred from
documentation. Line references are given so the claims are checkable. Where a claim depends on engine
internals, the dependency is `@reactorynet/workflow-es` and `@reactorynet/workflow-es-mongodb` as
vendored in `node_modules`.

The ticket asks me to verify or correct the capability inventory. I have done that, and §2 is the
most important section in this document.

---

## 2. Corrected capability inventory

### 2.1 `wait_event` — suspend: real. Resume-on-timeout: **does not exist**.

The ticket's chain is correct up to the last link.

**Registration and mapping (verified):**

- `YamlStepRegistry.ts:509` registers `wait_event`.
- `YamlFlowBuilder.ts` (the `case 'wait_event'` branch) maps
  `{eventName, eventKey, timeout, outputVariable}` onto `WaitForEventStepBody`:

  ```ts
  s.effectiveDate = timeoutMs != null ? new Date(nowMs() + timeoutMs) : new Date();
  ```

**What the step body does (verified, `YamlStepBody.ts:284-308`):**

```ts
public run(context) {
  const pointer = context.pointer;
  if (pointer && this.stepName) pointer.stepName = this.stepName;

  if (!pointer?.eventPublished) {
    const eff = this.effectiveDate || new Date(2000, 1, 1);
    return ExecutionResult.waitForEvent(this.eventName, this.eventKey, eff);
  }

  this.eventData = pointer.eventData;
  return ExecutionResult.next();
}
```

There are exactly two branches. `pointer.eventPublished` is the only discriminator, and it is set in
exactly one place in the entire engine:

```
workflow-es/build/src/services/event-queue-worker.js:174-177
  let pointers = workflow.executionPointers.filter(
    p => p.eventName === sub.eventName && p.eventKey === sub.eventKey && !p.eventPublished);
  for (let p of pointers) { p.eventData = evt.eventData; p.eventPublished = true; p.active = true; }
```

**What `effectiveDate` actually means (verified):**

`ExecutionResult.waitForEvent(name, key, effectiveDate)` stores it as `eventAsOf`
(`models/execution-result.js:45`), which `ExecutionResultProcessor` copies to
`subscription.subscribeAsOf` (`services/execution-result-processor.js:46`). The engine then matches a
subscription to an event only when `subscribeAsOf <= event.eventTime`:

```
memory-persistence-provider.js:66   x.subscribeAsOf <= asOf
mongodb-provider.js:141            subscribeAsOf: { $lte: asOf }
```

So `effectiveDate` is a **watermark for "ignore events older than this"**, not a deadline. This is
stated explicitly in Reactory's own code, in the *other* suspension path (`YamlStepBody.ts:507`):

> `// effectiveDate is ALWAYS now: the engine matches a subscription only when`
> `// subscribeAsOf <= event.eventTime, so a future effectiveDate would make`
> `// the subscription ignore events published before it — delaying eligibility`
> `// rather than timing the wait out. Timeouts must be delivered as events.`

**Is there a timer anywhere?** No.

- `determineNextExecutionTime` (`workflow-executor.js:355-386`) computes the next wake-up **only
  from `pointer.sleepUntil` on `active` pointers**. A pointer waiting for an event is set
  `active = false` (`execution-result-processor.js:37`), so it contributes nothing.
- The poll worker (`poll-worker.js`) scans `getRunnableInstances()`; the Mongo provider filters
  `nextExecution: { $lt: Date.now() }` (`mongodb-provider.js:119-129`). A waiting instance has
  `nextExecution = null`, which matches, so it is re-enqueued — but the executor only runs
  `executionPointers.filter(x => x.active)` (`workflow-executor.js:20`), so the tick is a no-op.
- `WorkflowRunner` has no expiry sweeper. The only sweeper is `sweepYamlFinalize`
  (`WorkflowRunner.ts:1019`), which closes instance log managers and nothing else.
- No `src/**` code writes `eventPublished`, and none scans for `WaitingForEvent` pointers.

**Consequences, precisely:**

| Config | Actual behaviour |
|---|---|
| `wait_event` with **no** `timeout` | `effectiveDate = now`. Waits indefinitely. Correct. |
| `wait_event` with `timeout: 0` | `effectiveDate = now`. Same as above. |
| `wait_event` with `timeout: T > 0` | Subscription watermark is `t0 + T`. An event at `t0 + X` for `X < T` **does not match**: it is marked processed (`event-queue-worker.js:170`) and the instance is never woken. From `t0 + T` onward events match. **It never expires.** |

The last row is a latent, silent data-loss bug in a public step type. It has not bitten yet because
the only shipped usage — `workflows/examples/WaitEvent.yaml` — omits `timeout`, and there is no test
coverage for the timeout branch at all (grep for `effectiveDate` and for `timeout` around
`wait_event` in `YamlFlow/__tests__/` returns nothing).

**Answer to the ticket's question 3:** the resumed step *can* distinguish "the event arrived" from
"the deadline passed" — but only vacuously, because a deadline never passes. This is not the feared
false-positive. It is the mirror-image failure: **a real signal can be discarded, and the wait can
hang forever.** Both are unacceptable for a continuation, and the design must not use
`wait_event.timeout` at all. Expiry must be delivered as an event (§5.4). I recommend a separate,
small fix so that `timeout` is either rejected by the validator or implemented as a sentinel — see
§8, Phase 1.

### 2.2 `delay` — blocking, not durable

`DelayStep.ts` computes a duration and then `await this.delay(duration)` inside `executeStep`,
returning no `control.sleep` directive. The step therefore holds a slot in the execution path for the
whole delay. On restart it replays and re-delays from scratch. It is a `setTimeout`, not a suspension
point, and is unusable for hour-scale waits.

A durable sleep *does* exist at the engine level (`ExecutionResult.sleep` → `pointer.sleepUntil` →
`nextExecution` → poll worker), and `YamlStepBody` honours a step that returns `control.sleep`. But
the `delay` step does not use it. If a durable `wait_until` step is ever wanted, it is a ~20-line
step that returns `control.sleep` — worth knowing, not needed here.

### 2.3 `invoke_workflow` with `waitForCompletion` — unsafe, not merely fragile

`InvokeWorkflowStep.ts`:

```ts
const child = await workflowService.startWorkflow(workflowId, { input });
childInstanceId = child?.id;          // local variable, never persisted
...
while (Date.now() < deadline) {       // in-step blocking poll loop
  await new Promise(r => setTimeout(r, pollInterval));
  instance = await workflowService.getWorkflowHistoryById(childInstanceId);
  ...
}
```

Three independent problems for a long parent wait:

1. **It is not durable.** The loop runs inside the step. `DEFAULT_TIMEOUT_MS` is 5 minutes, so a
   12-hour child requires the caller to raise `timeout` to ~14 hours, which parks a live
   `setTimeout` chain for that long.
2. **It re-dispatches on replay.** `childInstanceId` is a local, and `startWorkflow` is
   unconditional. If the process dies mid-wait, the instance reloads with this pointer still
   `active`; the step re-runs and **starts a second child**. The same happens on any `retryPolicy`
   attached to the step. There is no `dispatchId`, no adoption, no dedupe.
3. **On timeout it reports `success: false`** while the child is still running — so the parent
   cannot distinguish "the child failed" from "I stopped watching".

This is the strongest argument for P1 being a reconciler: the naive parent-wait is not just fragile
under restart, it is *actively duplicative* under restart.

### 2.4 Attribution — the trap the ticket suspected is already closed; a different one is open

**The suspected trap (item 5 / ticket `…3703515660`) is fixed.** `ServiceManager.getService` no
longer returns the raw memoized singleton:

```ts
// src/services/ServiceManager.ts:187
if (instances[singleton_key] && effectiveLifeCycle === "singleton") {
  return getContextBoundInstance(instances[singleton_key], context);
}
```

`getContextBoundInstance` (`src/services/serviceExecutionContext.ts`) returns a `Proxy` whose
`context` property resolves to the caller and whose methods run with the facade as `this`, so
`this.context` is correct even after an `await`, with no shared mutable state. It also rebinds
singleton *dependencies* transitively. Landed in `7979abec … (#62)`; ticket status is `closed`.

So for the wake path the question is not "does a singleton leak the system user". It is:

> **Which context does the workflow step hold in the first place?**

Answer (`YamlFlowRuntime.ts:97-131`): a workflow step cannot hold a request context — it may run
after a restart, weeks later. It rebuilds one from serialisable identity carried in workflow data:

```ts
export interface WorkflowIdentity { userEmail?: string; partnerKey?: string; }

export async function createWorkflowContext(identity?: WorkflowIdentity) {
  const hasIdentity = !!(identity?.userEmail || identity?.partnerKey);
  if (!hasIdentity) return state.systemContext ?? undefined;   // ← silent fail-open
  ...
  await ctx.forUser(identity.userEmail);
  await ctx.forPartner(identity.partnerKey);
  return ctx;
}
```

And `WorkflowRunner.buildYamlWorkflowData` seeds it (`WorkflowRunner.ts:916-938`):

```ts
__identity: {
  userEmail: identityOverride?.userEmail || ctx?.user?.email,
  partnerKey: identityOverride?.partnerKey || ctx?.partner?.key,
}
```

**Therefore, concretely, for a continuation:**

- `ReactorConversationService` declares no `lifeCycle`, so the `@service` decorator defaults it to
  `"instance"` (`src/application/decorators/service.ts`). It is constructed per resolution **with the
  context it is handed**. No singleton hazard at all on this path.
- Every conversation operation is keyed on the caller's user:
  `{ _id: chatSessionId, user: this.context.user }` (`ReactorConversationService.ts:5765, 5797, 5827`,
  and ~20 more). So a wake turn is attributed to whoever `this.context.user` is.
- If the continuation workflow was started by the session owner, `__identity.userEmail` is the owner,
  the rehydrated context's user *is* the owner, the `{_id, user}` query matches, and the turn is
  correctly attributed. **Ownership and tenancy are preserved.**
- If the workflow was started under the system context (the scheduler default, or any internal
  caller), `__identity.userEmail` is the system user and the query **does not match** — it fails
  closed with "Chat session not found or you do not have permission", which is the right failure but
  an unhelpful one, and it fails *per fire*, i.e. hours after registration, in a context with no
  human watching.
- If identity is **absent** (e.g. `SYSTEM_USER_EMAIL` unset, as the Support service's own comment
  notes), `createWorkflowContext` falls back to `state.systemContext`. That is a silent fail-open to
  the system user, and it is the actual hazard — not the singleton one.

**Mitigation (by construction, not convention):**

1. Start `AgentContinuationWorkflow` at **registration** time from the live session context.
   `startWorkflow` already threads `this.context` (`ReactoryWorkflowService.ts:1067`), so `__identity`
   is the owner with no new impersonation API.
2. Assert at registration: `context.user._id` present **and** not the system user; refuse to register
   otherwise. (Reuse the reasoning already encoded in
   `ReactorySupportWorkflowService.planDispatch`, but at the primitive, so every feature inherits it
   rather than re-implementing it.)
3. At wake time, verify `continuation.ownerUserId === context.user._id` before delivering. A mismatch
   is `orphaned`, never a system-context send.
4. Do **not** use `identityOverride` / `runAs` for continuations. `runAs` exists on schedules
   (`Scheduler.ts:87, 631-637`) and is appropriate for a fixed-purpose nightly job, not for per-user
   state; a schedule has one identity, a continuation set has many.

**One residual hazard worth flagging now** (not a blocker, but it will bite later): `YamlFlowRuntime`
caches **one context object per identity for the process lifetime** (`contextCache`, keyed
`userEmail|partnerKey`). Two concurrent workflow instances for the same user share a single mutable
`ReactoryContext`. `ReactoryContext.runAs()` and `forUser()` mutate `this.user` **in place**
(`ReactoryContextProvider.ts:276-292`), and `context.state` is shared, so a `request`-lifecycle
service resolved from that context is shared across concurrent instances for that user. Today nothing
in the wake path calls `runAs`, so this is latent. If P2 lands, either key the cache per instance or
document the rehydrated context as strictly read-only.

### 2.5 Corrected inventory

| Capability | Ticket says | Verified | Usable for continuation? |
|---|---|---|---|
| `wait_event` — durable suspend | Real | **Real** (`YamlStepBody.ts:284`) | Yes — the only suspension primitive |
| `wait_event` — resume on timeout | Real | **False.** No timer; `timeout` makes it deaf for `timeout` ms, then waits forever | **No — must not be used.** Expiry via sentinel event |
| `delay` | "timed resume" | **Blocking `await` in-step**, replays from zero on restart | No |
| `invoke_workflow` `waitForCompletion` | Real, returns child status | Real but **in-step poll loop**, **re-dispatches on replay**, reports failure on timeout | No for hours; fine for seconds–minutes |
| `user_activity` + `completeWorkflowTask` | Real, carries `chatSessionId` | Real, resumable, approver stamped server-side from authenticated context (`UserActivityStep.ts:117-140`) | Yes — for `task` triggers |
| `agent_conversation` with `sessionId` | Real, resumes same conversation | Real (`AgentConversationStep.ts`) | Yes — but as a *worker*, not as a waiter |
| `ReactorSendMessage` / `ReactorConversationService.sendMessage` | "the missing wake-up primitive" | Real; `chatSessionId` accepted; **per-conversation turn lock already implemented** (`acquireConversationTurn`) | Yes — call the **service**, not the GraphQL resolver |
| `publishWorkflowEvent` / `signalWorkflowInstance` | Real | Real, tenant-scoped (`ReactoryWorkflowService.ts:1164-1250`) | Yes — the firing mechanism |
| `cross_instance_variable` | Restart-safe store | Real, `findOneAndUpdate` + upsert (atomic per document) | Partially — see §3.2 |
| `createWorkflowSchedule` + `Scheduler.ts` | Real cron | Real, supports `runAs` | Yes — the tick |
| `todo` trigger fields | Absent | **Confirmed absent**; macro actions are create/add/update/assign/list/remove with `status` only | No — see §4.2 |
| Singleton context binding | Suspected defect | **Fixed** (`serviceExecutionContext.ts`, `#62`) | N/A |
| `__identity` rehydration | Not mentioned | Real; **silent fail-open to system context** when absent | **Hazard — must be asserted** |

---

## 3. P1 — programme reconciler

### 3.1 The case for it (the ticket's instinct is right, and for a stronger reason)

The naive alternative is a parent workflow per wave that `invoke_workflow`s children with
`waitForCompletion: true`. Rejecting it on "fragility" undersells the problem:

1. **It duplicates work on restart.** §2.3: the step has no persisted child id and calls
   `startWorkflow` unconditionally. A deploy, a crash or a step retry starts a second engineering run
   against the same ticket and worktree. That is not a risk; it is what the code does.
2. **The wait is not durable, so it pins a live timer for the duration.** A 12–40h programme would
   hold a `while` loop and an open pointer for 12–40h, with the parent's liveness becoming a
   precondition for the programme's progress.
3. **It has no concurrency control.** `maxConcurrent` is a property of the *programme*, not of any one
   parent. A parent-per-wave model encodes the DAG twice — once in the wave structure, once in the
   manifests — and can drift.
4. **The failure surface is worse.** If the parent dies, the children keep running but nothing depends
   on them any more: the programme silently stops progressing while appearing healthy. A reconciler
   cannot have this failure mode, because it holds no state between ticks.

The reconciler inverts all four: state is external and durable, dispatch is idempotent by
construction, no process must survive the programme, and concurrency is a single counter in one
document.

### 3.2 Where programme state lives

Three candidates:

| Option | Verdict |
|---|---|
| `cross_instance_variable` | **Insufficient as primary.** It is a `key → JSON blob` with `findOneAndUpdate` + upsert — atomic per *document*, but the document is the whole programme. Two ticks that both read the manifest and write it back will clobber each other's package transitions, and there is no way to conditionally update *one* package without a read-modify-write. Acceptable only as a bootstrap, or as a single-flight tick lease. |
| Workflow instance data | **No.** It couples programme state to the lifecycle of one workflow version (`fingerprintSeed` will refuse to resume an instance against an edited definition), and it is not queryable for a UI without loading whole instances. |
| Dedicated Mongo collection | **Recommended.** |

Recommended shape: one document per programme, packages as subdocuments.

```ts
// reactor/models/WorkflowProgramme.ts  (new collection: `workflow_programmes`)
interface IProgrammePackage {
  id: string;                      // stable, author-assigned: "W1"
  ticketReference: string;
  agentId: string;                 // persona
  workdir: string;
  dependsOn: string[];             // package ids
  maxAttempts: number;             // default 2

  state: 'blocked' | 'ready' | 'dispatching' | 'running'
       | 'succeeded' | 'failed' | 'skipped' | 'aborted';

  // dispatch ledger — this is what makes a tick idempotent
  dispatchId?: string;             // uuid, minted once, written BEFORE startWorkflow
  dispatchAttempts: number;
  childInstanceId?: string;
  childWorkflowId?: string;        // e.g. core.ProcessAITicket@1.4.6
  dispatchedAt?: Date;

  // outcome, pushed by the child (see §3.3)
  outcome?: { status: string; prUrl?: string; mergedSha?: string; reportedAt: Date; reportedBy: string };
  verifiedAt?: Date;               // last time the tick independently confirmed the outcome

  slaMinutes?: number;             // stall detection budget
  lastProgressAt?: Date;
  error?: string;
}

interface IWorkflowProgramme {
  _id: ObjectId;
  name: string;                    // "communicator outbound messaging"
  ownerUserId: ObjectId;           // who to notify, who may abort
  ownerEmail: string;
  partnerKey: string;
  state: 'running' | 'paused' | 'aborted' | 'completed';
  maxConcurrent: number;           // programme-wide cap
  packages: IProgrammePackage[];
  tickLease?: { holder: string; expiresAt: Date };
  lastTickAt?: Date;
  createdAt: Date; updatedAt: Date;
}
```

Why this survives a restart harmlessly: the reconciler holds **no** between-tick state. Every decision
is re-derivable from the document plus observable world state. A restart is indistinguishable from a
long gap between ticks.

Indexes: `{ state: 1 }`, `{ 'packages.state': 1 }`, `{ 'packages.childInstanceId': 1 }`,
`{ 'packages.dispatchId': 1 }` (unique sparse — makes the "have I already started this?" lookup a
point read).

### 3.3 Idempotency across ticks and restarts

The rule: **never let the side effect be the thing you rely on to know it happened.**

Three-phase dispatch per package, all conditional updates:

```
1. CLAIM      findOneAndUpdate(
                { _id: programme, state: 'running',
                  'packages': { $elemMatch: { id, state: 'ready' } },
                  'packages.dispatchId': { $exists: false } },
                { $set: { 'packages.$.state': 'dispatching',
                          'packages.$.dispatchId': newUuid(),
                          'packages.$.dispatchedAt': now },
                  $inc: { 'packages.$.dispatchAttempts': 1 } },
                { returnDocument: 'after' })
              → null means someone else claimed it. That is the success case.
```

```
2. START      startWorkflow(childWorkflowId, { ticketReference, worktree, dispatchId })
              — dispatchId is passed INTO the child as input, so the child is self-identifying.
```

```
3. ADOPT      findOneAndUpdate(
                { _id, 'packages': { $elemMatch: { id, state: 'dispatching', dispatchId } } },
                { $set: { 'packages.$.state': 'running',
                          'packages.$.childInstanceId': childInstanceId,
                          'packages.$.lastProgressAt': now } })
```

**Crash between 2 and 3.** The next tick finds a package in `dispatching` with a `dispatchId` and no
`childInstanceId`, older than a grace window (two tick intervals). It **reconciles rather than
re-dispatches**:

```
findWorkflowInstances({ workflowDefinitionId: childWorkflowId, search: dispatchId })
  → found      ⇒ ADOPT it (write childInstanceId), do not start anything
  → not found  ⇒ reset to 'ready' and let the normal path re-claim it
```

Because `dispatchId` is passed as child input, this lookup is exact, not heuristic. And a
re-dispatch after a genuine "not found" is safe: `ProcessAITicket` already re-enters a worktree by
`sessionId`/workdir rather than starting from zero, and the package's `dispatchAttempts` bounds the
damage at `maxAttempts`.

**Double-fire of an event, or a duplicate tick:** the `$elemMatch` guard plus `state: 'ready'` means
the second caller's `findOneAndUpdate` matches nothing. Idempotency is in the predicate, not in a lock.

**Why not a lock alone?** A lease prevents two *concurrent* ticks but says nothing about a tick that
crashed after dispatch. The conditional state transition is the durable guarantee; the lease is only
an optimisation.

### 3.4 Cadence

- **Tick every 60s**, single-flight via a lease (`RedisService` lock, or `tickLease` on the programme
  document with `expiresAt = now + 2×interval`).
- Sixty seconds is chosen for **P2 compatibility**, not for P1. P1 would be fine at 5 minutes; running
  both off one 60s tick costs one indexed query per programme and saves a second scheduler.
- **Do not put `gh` or ticket lookups on the hot path.** See §3.5 — children push outcomes, so the
  common tick reads Mongo only.

### 3.5 Where a reconciler is genuinely worse — and the fix that removes the worst part

The ticket asked to be shown the counter-case. There are four, and one is serious.

1. **Loss of causal visibility.** With a parent workflow, the run tree shows parent → child. With a
   reconciler, the relationship lives in the manifest. *Fix:* make the programme document the UI and
   the notification source. This is a real cost — it is a new surface — but it is also strictly more
   informative than a run tree, because it shows *waiting* work, which a parent workflow does not.

2. **A latency floor on every dependency.** Wave N+1 starts up to one tick late. At 60s × 7 waves that
   is ≤ 7 minutes on a 12–40h programme: irrelevant. At 5-minute ticks it would start to matter; hence
   60s.

3. **Every dependency must be *observable*, and observables are expensive.** "PR merged" means a
   `gh pr view` — an external, rate-limited, non-transactional call, once per package per tick. On a
   40h programme with 11 packages that is ~2,800 external calls, which is both slow and rude. **This is
   the serious objection to pure reconciliation.** The fix is to make it a hybrid:

   > **Children push; the tick only pulls to verify.**
   >
   > The child workflow's last steps write its terminal outcome into the package (`outcome`, `prUrl`,
   > `mergedSha`) via a service call. The tick therefore reads Mongo for the common case and only falls
   > back to `gh` when (a) a package claims success but has not been verified, or (b) a package is
   > overdue with no report. Verification is then O(packages that changed) instead of
   > O(packages × ticks).

   This also removes a correctness worry: a reconciler that trusts only its own polling can be fooled
   by a transient `gh` failure into thinking a merged PR is unmerged, and so block the wave forever. A
   pushed outcome is durable and idempotent.

4. **The reconciler cannot pass data between packages as naturally as a parent can.** A parent can hand
   a child's return value straight to the next child. Here, handoff is by reference: the manifest
   carries `prUrl`, `branch`, `mergedSha`, and the dispatcher passes them in the child's input. That is
   adequate — the artefacts are already identifiable — but it does mean the manifest schema, not the
   workflow, defines the contract between waves.

**Verdict:** the reconciler is right, *provided* it is a push-then-verify reconciler rather than a
poll-everything reconciler. Pure polling reconciliation is the version that would deserve the
criticism.

### 3.6 Stalls, pauses and aborts

**Stall detection.** A package in `running` whose `lastProgressAt` is older than its `slaMinutes`
(default: 2× the child's own timeout) is `stalled`:

- If the child instance is **terminal and failed** → mark `failed`, record `error`, notify, and block
  dependents with `blocked` + reason. Do not silently retry: a failed engineering run needs a human.
- If the child instance is **terminal and succeeded** but no `outcome` was pushed → mark `succeeded`
  from the instance data (the tick already has the instance; this is one read).
- If the child is **still running** past SLA → increment a stall counter, notify the owner once (not
  every tick — dedupe on `lastNotifiedAt`), leave running. Only after `maxAttempts` is exceeded does it
  become `failed`.

**Pause / abort.** Both are ordinary document updates, checked at the top of the tick:

- `state: 'paused'` → evaluate nothing, dispatch nothing. Running children are **not** touched
  (pausing a programme should not kill an in-flight engineering run). Resuming is the reverse update;
  the tick resumes from whatever the children actually did, which is only possible because state is
  external.
- `state: 'aborted'` → stop dispatching, cancel every non-terminal child via
  `cancelWorkflowInstance`, mark remaining `aborted`, notify once.
- Exposed as `pauseProgramme` / `resumeProgramme` / `abortProgramme` mutations, authorised to the
  programme `ownerUserId` (or an admin role) — **not** the system user, so the audit trail names a
  person.

### 3.7 Programme manifest — sketch

```yaml
# reactor.CommunicatorProgramme.yaml (illustrative)
nameSpace: reactor
name: CommunicatorProgramme
version: 1.0.0
inputs:
  programmeId: { type: string, required: true }

steps:
  - id: loadProgramme
    type: mongo_query
    config:
      collection: workflow_programmes
      action: findOne
      filter: { _id: "${input.programmeId}" }

  # ── single-flight: claim the tick or leave ──────────────────────────────
  - id: claimTick
    type: service_invoke
    dependsOn: loadProgramme
    config:
      serviceId: reactor.WorkflowProgrammeService@1.0.0
      method: claimTick
      params: { programmeId: "${input.programmeId}", leaseMs: 120000 }

  - id: tick
    type: condition
    dependsOn: claimTick
    config:
      condition: "${steps.claimTick.outputs.claimed === true}"
      thenSteps:
        - id: reconcilePackages
          type: service_invoke
          config:
            serviceId: reactor.WorkflowProgrammeService@1.0.0
            method: reconcile      # returns the dispatch plan (pure + persisted intent)
            params: { programmeId: "${input.programmeId}" }

        # NOTE: a for_each whose items come from the reconcile step. Dispatch is
        # idempotent per package because the claim already happened inside
        # `reconcile` (state: ready → dispatching), so a replay of this loop is a
        # no-op rather than a duplicate child.
        - id: dispatchReady
          type: for_each
          config:
            items: "${steps.reconcilePackages.outputs.plan}"
            itemVariable: pkg
            steps:
              - id: startChild
                type: invoke_workflow
                config:
                  workflowId: "${pkg.childWorkflowId}"
                  input:
                    ticketReference: "${pkg.ticketReference}"
                    workdir: "${pkg.workdir}"
                    dispatchId: "${pkg.dispatchId}"
                  waitForCompletion: false     # ← never true
              - id: adoptChild
                type: service_invoke
                config:
                  serviceId: reactor.WorkflowProgrammeService@1.0.0
                  method: adopt
                  params:
                    programmeId: "${input.programmeId}"
                    packageId: "${pkg.id}"
                    dispatchId: "${pkg.dispatchId}"
                    childInstanceId: "${steps.startChild.outputs.instanceId}"

        - id: notify
          type: service_invoke
          config:
            serviceId: reactor.WorkflowProgrammeService@1.0.0
            method: notifyIfNeeded
            params: { programmeId: "${input.programmeId}" }

  - id: releaseTick
    type: service_invoke
    dependsOn: tick
    config:
      serviceId: reactor.WorkflowProgrammeService@1.0.0
      method: releaseTick
      params: { programmeId: "${input.programmeId}" }
```

Registered once via `createWorkflowSchedule` with a cron of every minute and an explicit `runAs` = the
programme owner (so the tick's notification and audit writes name a person, and `__identity` is never
the system user).

Note the deliberate shape: **the decision is a service call, not YAML.** YAML is a poor place for
conditional state machines with compare-and-set semantics, and the workflow's job here is only to be
the durable, observable tick. That also makes the reconciler unit-testable without the engine.

---

## 4. P2 — the general continuation primitive

### 4.1 Option comparison

Scored against the ten robustness requirements plus the honesty goal. `✅` meets, `◐` partial, `❌`
fails.

| Criterion | **A** Continuation record + workflow | **B** Extend `todo` | **C** Long-lived `agent_conversation` | **D** Client polling |
|---|---|---|---|---|
| 1. Atomic claim / idempotency | ✅ `findOneAndUpdate` on `state` | ◐ would need the same machinery inside the todo model | ✅ engine-owned | ❌ last writer wins |
| 2. Bounded wait + explicit expiry | ✅ sentinel event | ◐ same need, hidden in a shared model | ✅ child timeout, but coarse | ❌ |
| 3. Distinguishable expiry | ✅ `eventData.outcome` | ◐ | ◐ child status | ❌ |
| 4. Unguessable `eventKey` | ✅ per-continuation 32-byte key | ◐ todo id is an ObjectId — guessable, and the todo API leaks ids | ✅ instance-scoped | ❌ |
| 5. Attribution preserved | ✅ register-then-wait → `__identity` = owner | ◐ depends on who polls | ✅ (creator) | ✅ (browser session) |
| 6. Deleted session / revoked access | ✅ explicit `orphaned` → task + communicator | ❌ silently stuck | ◐ step fails | ◐ |
| 7. Per-session serialisation | ✅ existing `acquireConversationTurn` | ◐ | ✅ | ❌ |
| 8. Cost caps | ✅ record-level caps + existing budget gate | ◐ | ❌ a live conversation per wait | ❌ unbounded polling |
| 9. Observability | ✅ `pendingContinuations` query | ✅ **best-in-class** — the todo UI already exists | ◐ instance list | ❌ |
| 10. Headless delivery | ✅ send + persist + communicator | ◐ | ✅ | ❌ |
| Durability across restart | ✅ engine + Mongo | ❌ nothing polls a todo | ✅ | ❌ |
| Discoverability for the model | ◐ new tool to learn | ✅ **best** — the model already reaches for `todo` | ◐ | n/a |
| Blast radius | new module, no changes to `todo` | **high** — shared by tool + step + UI | low | n/a |

**Recommendation: A**, with `todo` later becoming a read-only projection (`todo.continuationId`). The
ticket's instinct is right, and the reason is sharper than "the todo model shouldn't carry scheduler
semantics":

> `todo` is a **user-facing, user-editable** surface. A continuation is a **capability with security
> and cost consequences**. If triggering lives in a record the user can edit, then the user can make
> the agent wake itself — every minute, forever, at their budget's expense, and via
> `publishWorkflowEvent` on a guessable id. Separating them is not tidiness; it is the difference
> between a feature and a self-service denial-of-service.

### 4.2 On B specifically (the discoverability objection, taken seriously)

B's real advantage is that "a todo that wakes me" is the model's existing mental model — the owner said
exactly that. That advantage is **worse than it looks**, in three ways:

1. **It teaches the model to make promises again.** If `todo` can carry a trigger, the model will
   write `todo(dueAt=…)` and believe it has scheduled something — while the todo macro has no
   scheduler behind it. The failure we are eliminating is *an unbacked promise*; moving it into a
   second surface would re-create it with better camouflage.
2. **It cannot enforce the invariants.** Requirement 4 (unguessable key), 8 (per-session caps) and 9
   (visible pending state) are all properties of the trigger, and the trigger would live in a
   collection the `todo` tool writes directly.
3. **It does not remove the work.** B still needs a durable waiter, an atomic claim, an expiry and a
   wake delivery — i.e. all of A — plus a schema change to a shared model. It is A with a coupling
   problem and no saving.

The discoverability win is real, but it is obtainable without B: **make the projection the discoverable
thing.** `todo(action=list)` reads continuations and renders
`⏳ waiting on PR #482 merge until 14:00 (continuation 6f3a…)`. The model sees one surface; the
scheduler owns the other. If a model calls `todo(dueAt=…)` it is rejected with a message that names the
correct tool — which teaches the right behaviour instead of silently accepting a lie.

### 4.3 On C (long-lived `agent_conversation` inside a workflow)

Correct tool where `ProcessAITicket` uses it, and unsuitable here — for a reason the ticket
half-states:

- **Right:** a batch engineering run where the agent must hold a *working memory* across many tool
  calls and minutes of work. The conversation **is** the work; its cost is the work's cost.
- **Wrong here:** a continuation has no work to do while it waits. Holding an `agent_conversation` open
  for 40 hours means paying for a live context window to represent the sentence "not yet". And it
  cannot express the interactive case at all: the session already exists and belongs to the user, so
  the workflow would be a *second* conversation rather than a resumption of the first.
- **Right for one narrow case:** a continuation whose `resumePrompt` requires multi-turn investigation
  ("check the PR, and if CI is red, look at the failure and file a follow-up") can hand off into
  `agent_conversation` *after* wake. The wait itself must still be the cheap event wait.

### 4.4 On D (client polling)

Not a candidate. The requirement is that an agent's promise be honouring-able *when no browser is
open* — that is the whole point ("the owner was away"). Client polling makes the guarantee conditional
on the user's tab being alive, which is the current silent failure with extra steps. It also cannot
enforce caps, cannot attribute, and cannot notify. The only thing it offers is latency, which a 60s
server tick already matches for this use case.

---

## 5. Design — Option A

### 5.1 The one architecturally important decision: register-then-wait

The ticket's sketch is "on fire, atomically claim the record and call `ReactorSendMessage`". That
works, but it makes the fire-time context the origin of the send — and a fire-time context is, by
definition, a system context (a sweeper has no user). It then needs `runAs`/impersonation to be
attributed correctly, and that is precisely where §2.4's fail-open lives.

Instead: **start the workflow at registration time.**

```
register (live user context)                  fire (system context)
─────────────────────────────                 ─────────────────────
insert continuation {state: pending}          publish event, key = correlationKey
startWorkflow(AgentContinuation, {id})        payload {outcome:'observed'|'expired', …}
  → __identity = owner                          (no user context needed)
  → instance waits on wait_event              ─────────────────────
  → on resume, rebuilds OWNER's context
  → sends the turn AS THE OWNER
```

Consequences, all of them wins:

- **Attribution is solved structurally.** The sweeper never touches a session, so it cannot
  mis-attribute one. It only publishes events, which are tenant-scoped, not user-scoped.
- **The wait is the engine's native suspension**, so it is durable, restart-safe and costs nothing
  while parked.
- **The record has a second home.** The continuation document *and* the workflow instance both exist;
  the document is the queryable index, the instance is the durable waiter. They are reconciled by
  `continuationId`.
- **Cancellation is trivial:** cancel the workflow instance, mark the record `cancelled`. No sweeper
  needs to know.
- **No impersonation API is needed**, which is important because none exists (only `Scheduler`'s
  `runAs`, which is per-schedule, not per-record).

The cost is one workflow instance per pending continuation. Instances are small Mongo documents parked
on a pointer; a few hundred concurrent continuations is nothing. This is a good trade.

### 5.2 Schema

```ts
// reactor/models/AgentContinuation.ts — collection `reactor_continuations`
export type ContinuationTrigger =
  | { kind: 'at';        at: Date }
  | { kind: 'event';     eventName: string }                  // external publishes wake
  | { kind: 'condition'; serviceId: string; method: string;
      params: Record<string, any>; expectPath: string; expectValue: any }
  | { kind: 'task';      taskId?: string }                    // user_activity
  | { kind: 'webhook';   label: string };                     // fireContinuation(id, token)

export interface IAgentContinuation {
  _id: ObjectId;
  continuationId: string;          // == _id.toString(), used in workflow input
  correlationKey: string;          // 32 random bytes, base64url — the eventKey. NEVER derived.
  chatSessionId: string;
  personaId: string;

  // identity, captured at registration and re-asserted at wake
  ownerUserId: ObjectId;
  ownerEmail: string;
  partnerKey: string;

  trigger: ContinuationTrigger;
  reason: string;                  // "waiting on PR #482 merge" — shown to the user
  resumePrompt: string;            // sent as the wake turn when observed
  expirePrompt: string;            // sent when NOT observed. REQUIRED. §5.4

  state: 'pending' | 'armed' | 'firing' | 'fired' | 'expired'
       | 'cancelled' | 'orphaned' | 'failed';
  fireAt: Date;                    // the deadline — every continuation is bounded
  firedAt?: Date;
  firedBy?: 'signal' | 'condition' | 'expiry' | 'task' | 'webhook';
  outcome?: 'observed' | 'not_observed';

  workflowInstanceId: string;      // the durable waiter
  attempt: number;                 // send attempts
  maxAttempts: number;             // default 2
  lastError?: string;

  // delivery record
  wakeRole: 'user';
  wakeMessageId?: string;
  notifiedVia?: 'session' | 'communicator' | 'task';

  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;                 // TTL index — hard garbage collection
}
```

Indexes:

```
{ correlationKey: 1 }            unique
{ state: 1, fireAt: 1 }          the sweeper's working set
{ chatSessionId: 1, state: 1 }   per-session caps + serialisation
{ ownerUserId: 1, state: 1 }     the user's "what am I waiting on" list
{ expiresAt: 1 }                 TTL, expireAfterSeconds: 0
```

The `correlationKey` is the security boundary. It is `crypto.randomBytes(32)` encoded base64url, never
a session id, ticket id, TODO id or anything derivable. `publishWorkflowEvent` matching is by exact
`eventKey` and tenant, so an attacker who cannot guess the key cannot fire the continuation — and
nothing in any user-facing surface ever returns the key (§5.6).

### 5.3 Service and macro signatures

```ts
// reactor.AgentContinuationService@1.0.0   (lifeCycle: 'instance')
register(input: {
  chatSessionId: string;
  personaId: string;
  reason: string;
  resumePrompt: string;
  expirePrompt: string;            // required — no default
  trigger: ContinuationTrigger;
  ttlMs: number;                   // becomes fireAt
}): Promise<{ continuationId: string; fireAt: Date }>;

cancel(input: { continuationId: string; reason?: string }): Promise<{ cancelled: boolean }>;

list(input: {
  chatSessionId?: string;
  state?: IAgentContinuation['state'];
  limit?: number;
}): Promise<Array<PublicContinuationView>>;      // NO correlationKey in the view

// internal, system-context safe (never touches a session)
claimDue(now: Date, limit: number): Promise<ContinuationFirePlan[]>;
claim(continuationId: string): Promise<IAgentContinuation | null>;   // atomic
markFiring(continuationId: string, firedBy): Promise<void>;
complete(continuationId: string, outcome: 'observed' | 'not_observed'): Promise<void>;
orphan(continuationId: string, reason: string): Promise<void>;

// the only place a session is touched, always under the owner's context
deliver(input: { continuationId: string; outcome: 'observed' | 'not_observed' }): Promise<DeliverResult>;

fire(input: { continuationId: string; token: string; source: string }): Promise<{ fired: boolean }>;
```

Agent-facing macros (thin wrappers, so the model has one obvious call):

```
scheduleContinuation({ atMs | eventName | condition | task, reason, resumePrompt, expirePrompt, ttlMs })
  → { continuationId, fireAt }
cancelContinuation({ continuationId })
listContinuations({ chatSessionId? })
```

`scheduleContinuation` **refuses** when: no `chatSessionId`; the caller is the system user; the
session's owner ≠ the caller; the session already has ≥ `maxPendingPerSession` (default 3); the last
fire was < `minIntervalMs` ago (default 60s); or the user's budget is exhausted. Each refusal returns a
message the model can act on, so it reports honestly instead of promising.

### 5.4 The expiry mechanism — the crux

Because `wait_event` cannot time out (§2.1), expiry is delivered as data:

```
AgentContinuationSweeper (every 60s, system context, holds no user identity)
  for each continuation in state ∈ {pending, armed}:
    if now >= fireAt            →  publish "agent.continuation.wake" {key: correlationKey,
                                     outcome: 'expired', reason: 'deadline_passed', fireAt}
    else if trigger.kind = 'at' and now >= trigger.at
                                →  publish … {outcome: 'observed', firedBy: 'at'}
    else if trigger.kind = 'condition'
                                →  evaluate; if satisfied, publish … {outcome: 'observed'}
    else                        →  leave parked
  // 'event', 'task', 'webhook' triggers are published by their own source, not here
```

The workflow:

```yaml
nameSpace: reactor
name: AgentContinuation
version: 1.0.0
description: Durable agent continuation — parks a conversation until a time or signal, then wakes it.
inputs:
  continuationId: { type: string, required: true }

steps:
  - id: load
    type: service_invoke
    config:
      serviceId: reactor.AgentContinuationService@1.0.0
      method: get
      params: { continuationId: "${input.continuationId}" }

  # Guard the whole body: a cancelled/orphaned continuation must not wait.
  - id: guard
    type: condition
    dependsOn: load
    config:
      condition: "${steps.load.outputs.continuation.state === 'pending'}"
      thenSteps:
        - id: arm
          type: service_invoke
          config:
            serviceId: reactor.AgentContinuationService@1.0.0
            method: markArmed
            params: { continuationId: "${input.continuationId}" }

        # The ONLY wait. NO `timeout` key — see §2.1. Expiry arrives as an event.
        - id: wait
          type: wait_event
          config:
            eventName: agent.continuation.wake
            eventKey: "${steps.load.outputs.continuation.correlationKey}"
            outputVariable: wake

        - id: deliver
          type: service_invoke
          config:
            serviceId: reactor.AgentContinuationService@1.0.0
            method: deliver
            params:
              continuationId: "${input.continuationId}"
              outcome: "${variables.wake.outcome}"

  - id: done
    type: end
```

`deliver` is the only function that touches a session, and it runs inside the instance, so
`context.user` **is** the session owner (§2.4). It:

```
1. assert continuation.ownerUserId === context.user._id        → else orphan()
2. atomic claim: findOneAndUpdate({_id, state:'armed'}, {$set:{state:'firing'}})
   → null ⇒ already fired; return {delivered:false}         (idempotent)
3. session exists? ReactorConversationModel.findOne({_id, user: context.user})
   → null ⇒ orphan(): create a communicator notification + a user task; return
4. send:
   conversationService.sendMessage({
     personaId, chatSessionId,
     role: 'user',
     streamingMode: StreamingMode.NONE,        // headless
     message: outcome === 'observed' ? resumePrompt : expirePrompt,
   })
5. mark {state: 'fired'|'expired', outcome, firedAt, wakeMessageId}
```

Step 2 makes a double-fire a no-op even if both the real signal and the expiry event were published in
the same instant. (The engine also collapses them: `seedSubscription` terminates the subscription, so
the second event finds no subscriber. Two independent protections.)

**Why both prompts are mandatory.** `resumePrompt` says what to do when the signal arrived.
`expirePrompt` must state, in words the model cannot soften, that the signal was *not observed* and
that it must say so:

> "The wait you registered for '<reason>' expired at <fireAt> without the signal being observed. You
> do not know whether it happened. Tell the user plainly that it was not observed and what you can
> check now. Do not report it as having happened."

That single string is the thing that makes the original failure — "I confidently report a merge that
never happened" — structurally impossible. It belongs in the record, not in a persona prompt, so it
cannot be edited away by a persona change.

### 5.5 State machine

```
                    register (owner ctx)
                            │
                            ▼
                       ┌─────────┐   workflow started, instance parked
                       │ pending │──────────────────────────────┐
                       └────┬────┘                              │
                            │ markArmed (step 1 of instance)    │ cancel
                            ▼                                   │ (user or
                       ┌─────────┐                              │  system)
              ┌────────│  armed  │──────────┐                   │
              │        └────┬────┘          │                   │
   wake event │             │ wake event    │ deadline (sweeper)│
   observed   │             │ (any source)  │ → sentinel event  │
              ▼             ▼               ▼                   ▼
         ┌─────────┐   ┌─────────┐    ┌──────────┐      ┌───────────┐
         │ firing  │   │ firing  │    │  firing  │      │ cancelled │
         └────┬────┘   └────┬────┘    └────┬─────┘      └───────────┘
              │ send ok      │ send ok      │ send ok
              ▼              ▼              ▼
         ┌─────────┐                       ┌──────────┐
         │  fired  │  outcome=observed     │ expired  │ outcome=not_observed
         └─────────┘                       └──────────┘

   firing ── session missing / owner mismatch ──▶ orphaned  (task + communicator)
   firing ── send throws, attempt < max ───────▶ armed      (retry next tick)
   firing ── send throws, attempt >= max ──────▶ failed     (task + communicator)
```

Invariants:

- `firing` is reachable from `armed` only by an atomic conditional update. Two would-be firers cannot
  both win.
- Terminal states (`fired`, `expired`, `cancelled`, `orphaned`, `failed`) are never re-entered.
- The only transitions that touch a session are `firing → fired|expired` and `firing → orphaned`.
- `pending → cancelled` happens when the workflow never started; `armed → cancelled` also cancels the
  instance.

### 5.6 Failure-mode matrix

| # | Failure | Detected by | Effect if unhandled | Mitigation | Residual risk |
|---|---|---|---|---|---|
| 1 | Same event published twice | `claim()` returns null on the 2nd | Duplicate wake turn, double cost | Atomic `state: armed → firing`; engine also terminates the subscription | Negligible |
| 2 | Sweeper restarts mid-tick | next tick, `state` unchanged | None — the claim is the only side effect and it did not happen | Idempotent predicates; no in-memory state | None |
| 3 | Crash between claim and send | `state: firing` older than 2 ticks | Continuation stuck, user never woken | Sweeper re-arms `firing` older than `2×tick` with `attempt < max` → `armed`; retry | Possible duplicate send if the first send half-succeeded; bounded by `maxAttempts` and visible in the record |
| 4 | Session deleted | `ReactorConversationModel.findOne({_id,user})` → null | Silent loss of the wake | `orphaned` → communicator notification + user task; `listContinuations` shows it | None |
| 5 | User revoked / deactivated | same query returns null **or** send fails auth | Silent loss | same as 4; also re-assert `ownerUserId === context.user._id` before sending | None |
| 6 | Identity absent at wake | `context.user` falsy | **Silent send as system user** (`createWorkflowContext` fallback) | Register-time assertion + wake-time assertion + `deliver` refuses → `orphaned` | Only if a future refactor bypasses `deliver` |
| 7 | Two continuations fire on one session | `acquireConversationTurn` returns null for the 2nd | Interleaved turns, corrupted transcript | Existing per-conversation lock + `minIntervalMs` per session | Lock is **in-process only** (§7) — see gap G2 |
| 8 | Event fires for a cancelled continuation | `state` is `cancelled` → `claim` null | Wasted event | No-op; workflow instance already terminated | None |
| 9 | Guessable key / forged fire | n/a | Third party wakes someone's agent | 32-byte random key; key never exposed by `list`; `fireContinuation` requires the token | None, provided the key is not logged. **Must not log it** |
| 10 | Model registers many continuations | `maxPendingPerSession` | Budget burn | Cap 3 pending + 60s min interval + existing `enforceUsageBudget` on the wake turn | None |
| 11 | `eventKey` empty | `register` rejects | `publishWorkflowEvent` requires a key (`ReactoryWorkflowService.ts:1171`) | Validation at register | None |
| 12 | Deadline in the past | `register` rejects | Immediate expiry | Validation | None |
| 13 | Wait never arms (workflow start fails) | `pending` with no instance after 1 tick | Agent told "registered" but nothing waits | `register` awaits `startWorkflow`; on failure the record is deleted and the call **throws** — the model must not claim success | Small window between insert and start |
| 14 | Tenant mismatch on publish | Event not delivered to the subscription (tenant-scoped match) | Silent non-wake | The sweeper publishes under the **instance's** tenant, exactly as `signalWorkflowInstance` already does (`ReactoryWorkflowService.ts:1222-1232`) | Must read tenant from the instance, not the calling context |
| 15 | Definition edited under a parked instance | engine fingerprint (`M10`, `fingerprintSeed`) | Dead-lettered instance = lost wake | Never edit `reactor.AgentContinuation@1.0.0` in place; bump the version | Versioning discipline |

---

## 6. Explicit answers to robustness items 1–10

**1. Idempotent atomic claim.** ✅ `findOneAndUpdate({_id, state:'armed'}, {$set:{state:'firing',
firedAt, firedBy}}, {returnDocument:'after'})`. `null` ⇒ another firer won ⇒ no-op. Two independent
protections: the conditional update, and the engine's subscription termination
(`event-queue-worker.js:186`), which drops a second event for the same `(name, key)`.
*Design consequence beyond the ticket:* the same predicate discipline must apply to **workflow start**
(item 13 in §5.6), or the primitive inherits `invoke_workflow`'s duplicate-child bug.

**2. Bounded waits with an explicit "expired / not observed" wake.** ✅ Every record has a mandatory
`fireAt`. Expiry is a **sentinel event**, not a timeout, because §2.1 shows the timeout does not exist.
`expirePrompt` is a required field with required wording. No continuation can be registered without
both prompts.

**3. Timeout vs event ambiguity — verified, and the premise is wrong.** The resumed step **can**
distinguish: `pointer.eventPublished` is only ever set by the event-seeding path
(`event-queue-worker.js:174-177`), so the `else` branch in `WaitForEventStepBody` is reached only after
a real event. There is no expiry path at all — no timer, no sweeper, no `sleepUntil` scheduling for a
parked pointer. So the feared false-positive cannot occur. **The actual defect is inverted and worse:**
`YamlFlowBuilder` passes `effectiveDate = now + timeout`, which the engine reads as `subscribeAsOf`, so
a positive `timeout` makes the workflow **ignore every event published in the next `timeout` ms** and
then wait forever. Reactory's own code documents this hazard in the sibling suspension path
(`YamlStepBody.ts:507-511`: *"Timeouts must be delivered as events"*) but `YamlFlowBuilder`'s
`wait_event` branch does not follow it. **What the design must add:** expiry as data (§5.4), plus making
`wait_event.timeout` either a validation error or a sentinel implementation (§8, Phase 1). Until that
fix lands, `wait_event` is safe **only** without a `timeout` key — which is exactly how this design uses
it, and how the only shipped example (`WaitEvent.yaml`) uses it.

**4. Signal security.** ✅ `correlationKey = crypto.randomBytes(32).toString('base64url')`,
unique-indexed, never derived from any identifier, never returned by `list`, never logged. `eventKey`
matching is exact and tenant-scoped, so knowing the event *name* is useless without the key.
`fireContinuation` requires both the continuation id and the token. Additionally:
`publishWorkflowEvent` requires a non-empty key (`ReactoryWorkflowService.ts:1169-1173`), so an empty
key cannot be used as a wildcard.

**5. Attribution and tenancy — verified; the suspected trap is closed, a different one is open.**
`ReactorSendMessage` → `ReactorConversationService.sendMessage` → every query is
`{_id: chatSessionId, user: this.context.user}`. The service is `lifeCycle: 'instance'` (no `lifeCycle`
declared, decorator default `"instance"`), so it is constructed with the context it is handed — the
`ServiceManager` singleton facade fix (`#62`, `serviceExecutionContext.ts`) makes this robust even for
the services that *are* singletons, but this one never needed it. The step's context comes from
`createWorkflowContext(data.__identity)` (`YamlFlowRuntime.ts:97`), seeded by `buildYamlWorkflowData`
from the **start** context (`WorkflowRunner.ts:930`). **Therefore: registration-time start ⇒ owner
attribution; fire-time start ⇒ system attribution.** The mitigation is architectural, not defensive:
**register-then-wait** (§5.1), plus three assertions (register: caller is a real, non-system user; wake:
`ownerUserId === context.user._id`; deliver: refuse and `orphan` on mismatch). **Do not** use
`runAs`/`identityOverride` — it is per-schedule, not per-record, and it is how the system identity gets
in.
*Residual:* the per-identity `contextCache` in `YamlFlowRuntime` shares one mutable `ReactoryContext`
across concurrent instances for the same user, and `runAs`/`forUser` mutate it in place. Nothing in this
design calls them; that must be stated as an invariant or the cache keyed per instance.

**6. Session deleted or access revoked.** ✅ Two failure modes, one path: the ownership query returns
null, or the send throws. Either way `deliver` → `orphaned`: a communicator notification to the owner
**and** a user task (via the existing task surface), with the `reason` and the fact that the signal was
not delivered. `listContinuations` shows it. `expiresAt` TTL reclaims it after a bounded window. It can
never vanish silently, because the only path that would vanish is the one that throws, and throwing is
caught into `orphaned`.

**7. Per-session serialisation.** ◐ **Already exists, but only within one process.** `sendMessage` wraps
every turn in `acquireConversationTurn(chatSessionId)` — a static `Map` of active turns with a polling
wait and owner-checked release (`ReactorConversationService.ts:5595-5624`), and returns
`CONVERSATION_PROCESSING` rather than interleaving. That satisfies the requirement on a single node.
**Gap (G2):** it is in-process state, so two API nodes would not serialise. Mitigation for P2: the
continuation sweeper is single-flight by lease, so it cannot fire twice concurrently; for cross-node
safety of two *different* continuations on one session, take a short distributed lease
(`RedisService` / `RateLimiterService`) keyed on `chatSessionId` in `deliver`, or accept the
`CONVERSATION_PROCESSING` refusal and re-arm for the next tick (simplest, and it degrades to "one tick
late" rather than "interleaved"). I recommend the latter first.

**8. Cost and abuse.** ✅ Four layers, all cheap: (a) `maxPendingPerSession` = 3; (b) `minIntervalMs` =
60s between fires on a session; (c) the wake turn is `role: 'user'`, and `sendMessage` already gates the
first user turn through `enforceUsageBudget` (`ReactorConversationService.ts:5727-5737`) against
`ReactorUserUsageStatus`/budgets — so an exhausted budget refuses the wake instead of spending; (d)
`expiresAt` TTL prevents zombie records. Note the ordering: the budget gate must run **before** the claim
is irreversible, or a refused turn burns the single wake. Fix: claim after the budget pre-check, and
re-arm on refusal.

**9. Observability.** ✅ `listContinuations` + a GraphQL `ReactorPendingContinuations` field (same shape
as the existing `ReactorPendingClientToolCalls`) returning
`{ continuationId, reason, state, fireAt, firedAt, outcome, chatSessionId }` — **never the
`correlationKey`**. UI renders "waiting on PR #482 merge until 14:00". This is the requirement that turns
the honesty claim into a verifiable statement: the model says "I am waiting on X until Y", and the user
can open a panel and see the exact record. Without this surface, P2 is just a better-hidden promise.

**10. Headless reply delivery.** ✅ The wake turn uses `streamingMode: NONE` and `role: 'user'`; the reply
is persisted to the conversation and the transcript (`sessionLog`, `ChatSessionResourceManager`). Because
the session's persona may be idle with no SSE transport, `sendMessage` must not be called in `SSE` mode —
it would return `ReactorInitiateSSEResponse` instead of replying (`ReactorConversationService.ts:5810-5830`).
For a genuinely absent user, add a communicator notification on `outcome: not_observed` and on any
`orphaned`/`failed` — which is also the synergy the ticket notes: the programme that P1 is fixing is the
one that delivers P2's notifications.

### Additional failure modes the ticket did not list

- **`eventKey` must not be logged.** It is the credential. Existing helpers log `eventName`/`eventKey`
  freely (`WorkflowRunner.ts:1410`, `workflow-host.js:161`). A continuation key inside those logs is a
  leaked token. Either use a separate logger path or (better) a dedicated event name whose handler never
  logs the key.
- **Two `wait_event`s in one definition sharing an `eventKey`** would both be seeded by one event
  (`seedSubscription` sets `eventPublished` on *all* matching pointers). Harmless here, because the key
  is per-continuation, but it is a reason the key must never be a workflow instance id.
- **A parked instance is re-enqueued every poll tick** (`nextExecution = null` matches `$lt: Date.now()`
  in BSON ordering). It no-ops, but with many parked continuations this is wasted queue traffic.
  Acceptable at expected volumes; if it becomes a problem the fix is in the engine
  (`nextExecution: { $ne: null, $lt: now }`), not in this design.
- **Definition fingerprint.** A parked instance is fingerprinted (`M10`, `fingerprintSeed`). Editing
  `reactor.AgentContinuation@1.0.0` in place **dead-letters** every parked continuation. The version must
  be bumped for any edit, which means in-flight continuations keep running the old definition — correct
  but worth knowing before the first hotfix.

---

## 7. Gap register (what this design does not solve by itself)

| Id | Gap | Severity | Disposition |
|---|---|---|---|
| **G1** | `wait_event.timeout` is broken (§2.1). Silent signal loss + unbounded wait in a public step. | **High** — latent, untested, and a trap for the next author | Fix as a prerequisite (§8, Phase 1) |
| **G2** | Per-conversation turn lock is in-process only, so multi-node interleaving is possible. | Medium | Accept the `CONVERSATION_PROCESSING` refusal and re-arm, or add a Redis lease |
| **G3** | `createWorkflowContext` fails **open** to the system context when identity is absent. | **High** — the real attribution trap | Assert at register and at deliver; consider making the runtime fail closed |
| **G4** | `invoke_workflow(waitForCompletion)` re-dispatches the child on replay. | Medium — P1 avoids it entirely, but it is a foot-gun | Out of scope; note it in the step's docs or add `dispatchId` support |
| **G5** | Per-identity `contextCache` shares a mutable context (and `context.state`) across concurrent instances for one user. | Low today, Medium after P2 | Document as read-only, or key the cache per instance |
| **G6** | `delay` is not durable although it is documented as a wait primitive. | Low | Documentation, or return `control.sleep` |

---

## 8. Sequencing recommendation

**Yes — P1 ships immediately, regardless of P2. And the ordering is not merely "P1 is urgent"; it is
"P1 builds the thing P2 needs".**

| Phase | Content | Depends on | Why this order |
|---|---|---|---|
| **0 — P1 now** (this week) | Programme document + `WorkflowProgrammeService` + reconciler workflow + 60s schedule + push-reporting child step + notify | Existing primitives only | Unblocks 7 waves of live work with **zero platform change**. Delivers the single-flight tick loop that P2 reuses. |
| **1 — `wait_event` timeout fix** (small, ~½ day) | Make `timeout` a validation error, *or* implement it as a sweeper-published sentinel. Add the missing test. | Phase 0 (same sweeper) | **Prerequisite for P2.** Building a continuation on a `wait_event` whose `timeout` silently discards signals would ship the exact class of bug the ticket exists to remove. |
| **2 — P2 primitive** | `AgentContinuation` model + service + `AgentContinuationWorkflow` + `scheduleContinuation`/`cancelContinuation` macros + sweeper integration + `listContinuations` query | Phases 0, 1 | Needs the tick loop (0) and a trustworthy `wait_event` (1) |
| **3 — Delivery + visibility UI** | Wake delivery, communicator notification, pending-continuations panel, todo projection | Phase 2 | Makes the honesty claim *checkable*; without this P2 is not yet a fix |
| **4 — Hardening** | Distributed session lease (G2), budget ordering, cap tuning | Phase 3 usage data | Only measurable once real |

**Why not P2 first?** Three reasons. (a) P2 needs a tick loop, and Phase 0 builds one that is already
battle-tested on real work. (b) P2 needs `wait_event` to be trustworthy, which is a platform fix that
Phase 0 does not require. (c) The live requirement — the owner's seven waves — is *not* a continuation
problem; it is an orchestration problem, and a continuation primitive would not fix it. The agent should
not be in the loop at all for the programme (§3), which is exactly what the ticket argues and what I
agree with.

**Stopgap status of P1:** P1 is not a stopgap. It is the correct permanent answer for multi-step
dependent work, and it should not be retired when P2 lands. P2 handles the *interactive* follow-up
("check whether the PR merged and tell me"), P1 handles the *programme* ("advance the waves"). Confusing
them is what produced the original failure: the orchestrator used a conversational promise to stand in
for a scheduler.

---

## 9. Probes

Both of my questions are answered from source, so **no probe is required to proceed**. If you want
empirical confirmation before committing, these are the two smallest possible — both read-only, no code,
no deployment.

**Probe A — confirm the `wait_event` timeout semantics against live data (1 query).**
A `wait_event` with `timeout: T` creates a subscription whose watermark is `start + T`. On any live
instance that has ever used one, and on the sample workflow if you start it:

```js
// mongo
db.eventsubscriptions.find({}, { eventName: 1, eventKey: 1, subscribeAsOf: 1 }).sort({_id: -1}).limit(5)
```

Compare `subscribeAsOf` to the instance's start time. If it is **start + timeout**, the subscription is
deaf until then and the deadline is not a deadline. To confirm the second half: publish the event 5s
after arming, observe no resume; publish again after `timeout` elapses, observe resume. That is one YAML,
two `publishWorkflowEvent` calls, and it takes ten minutes.

**Probe B — confirm attribution origin (1 query).**

```js
// mongo
db.workflowinstances.find(
  { workflowDefinitionId: 'reactor.ProcessAITicket@1.4.6' },
  { 'data.__identity': 1, createTime: 1 }
).sort({ createTime: -1 }).limit(3)
```

If `__identity.userEmail` is a real person, the register-then-wait design will attribute correctly. If it
is absent or the system address, the workflow that produced it was started under a system context and
every AI session it created is already invisible to its owner — which would also mean the Support
module's `planDispatch` guard is load-bearing in production, not merely defensive.

---

## 10. What would invalidate this design

Stated plainly, so the recommendation can be falsified rather than merely trusted.

1. **If `wait_event` *does* time out** — i.e. if the deployed engine differs from the vendored
   `@reactorynet/workflow-es` (a private patch, a newer minor) — then the inversion in §2.1 is wrong. The
   design's expiry-via-sentinel would still work, but it would be redundant and the reasoning would need
   revisiting. Probe A settles it. **This is the one assumption worth checking before Phase 1.**
2. **If workflow instances are aggressively pruned**, register-then-wait loses its durable waiter. The
   continuation record would have to become the waiter (a sweeper-driven fire-then-send), costing the
   attribution benefit. Check the retention policy on `workflowinstances`.
3. **If `ProcessAITicket` cannot accept a `dispatchId` and re-enter idempotently**, P1's adoption path
   degrades to best-effort and a crash window can duplicate a run. It already re-enters by
   `sessionId`/workdir, so this is likely fine — but it should be verified before Phase 0 goes live.
4. **If the budget model forbids background turns** (e.g. only interactive turns are billable), the wake
   turn is impossible regardless of mechanism.

---

## 11. The decision I need

**D1 — P1: approve the reconciler with push-reporting children.**
Reject the parent-workflow `waitForCompletion` model permanently, not temporarily: it duplicates children
on restart (§2.3), and no amount of timeout tuning fixes that. Approve a programme document in Mongo as
the single source of truth, conditional-update claims for idempotency, a 60s single-flight tick, and
children that *push* their outcome so the tick does not poll `gh` per package per minute.

**D2 — P2: approve Option A, in the register-then-wait shape.**
Not fire-then-send. Registration starts the durable waiter from the live session context (correct
attribution by construction); firing is an event publish requiring no user context at all; expiry is a
sentinel event carrying `outcome: 'not_observed'`; `expirePrompt` is a mandatory field so the "report
honestly" instruction is data, not persona text. `todo` becomes a read-only projection in Phase 3 — I
judge B to be strictly worse (it re-creates the unbacked promise on a user-editable surface and cannot
enforce key secrecy or caps), while its discoverability advantage is fully recoverable through the
projection.

**D3 — approve the `wait_event` timeout fix as a prerequisite.**
Either reject `timeout` in validation or implement it via the sentinel path. This is a latent, untested,
silent-signal-loss bug in a public step type; building P2 on it would be negligent. It is small, and it
is the one item where "analysis only" should be followed quickly by a patch.

**D4 — confirm the two open sub-choices:**
(a) programme state in a new `workflow_programmes` collection (my recommendation) rather than
`cross_instance_variable`; (b) the per-session serialisation stance for P2 — accept
`CONVERSATION_PROCESSING` and re-arm next tick (simplest, one tick of latency) versus a Redis lease
(strict, more moving parts). I recommend (a) and the simple form of (b), revisited in Phase 4.

If D1–D3 are approved, Phase 0 and Phase 1 are both measured in days and neither requires a design
review. Phase 2 is where the estimate becomes uncertain, and it should not start until Phase 1 has
landed.

---

## Appendix — evidence index

| Claim | Evidence |
|---|---|
| `wait_event` registered | `YamlFlow/steps/registry/YamlStepRegistry.ts:509` |
| `effectiveDate = now + timeout` | `YamlFlow/YamlFlowBuilder.ts`, `case 'wait_event'` |
| Only two branches; `eventPublished` is the discriminator | `YamlFlow/execution/YamlStepBody.ts:284-308` |
| `eventPublished` set only by event seeding | `workflow-es/build/src/services/event-queue-worker.js:174-186` |
| `effectiveDate` → `eventAsOf` → `subscribeAsOf` | `models/execution-result.js:45`; `services/execution-result-processor.js:46` |
| `subscribeAsOf <= event.eventTime` matching | `memory-persistence-provider.js:66`; `mongodb-provider.js:141` |
| Reactory documents "timeouts must be delivered as events" | `YamlFlow/execution/YamlStepBody.ts:507-511` |
| No timer for parked pointers | `workflow-executor.js:355-386` (only `sleepUntil`, only `active`); `workflow-executor.js:20`; `mongodb-provider.js:119-129`; `workflow-host.js` `start()` |
| Signalled events before the watermark are discarded | `event-queue-worker.js:168-172` (marks processed), `:174` (filter), `:186` (terminate) |
| `delay` blocks | `YamlFlow/steps/core/DelayStep.ts` (awaits, returns no `control.sleep`) |
| `invoke_workflow` polls in-step, no dispatch id | `YamlFlow/steps/core/InvokeWorkflowStep.ts:76-145` |
| Per-turn lock already exists (in-process) | `reactor/services/reactor/ReactorConversationService.ts:5595-5624, 5626-5668` |
| Conversation queries keyed on `context.user` | `ReactorConversationService.ts:5765, 5797, 5827` (and ~20 more) |
| `ReactorConversationService` is `instance` lifecycle | `@service({…})` with no `lifeCycle`; default in `application/decorators/service.ts` |
| Singleton context facade fix | `src/services/serviceExecutionContext.ts`; `src/services/ServiceManager.ts:187`; commit `7979abec (#62)` |
| Identity rehydration + fail-open | `YamlFlow/execution/YamlFlowRuntime.ts:97-131` |
| `__identity` seeded from start context / override | `workflow/WorkflowRunner/WorkflowRunner.ts:916-938` |
| `startWorkflow` threads the caller context | `core/services/Workflow/ReactoryWorkflowService.ts:1067` |
| Tenant must come from the instance on publish | `ReactoryWorkflowService.ts:1222-1232` (`signalWorkflowInstance`) |
| Support module's fail-closed identity guard | `core/services/ReactorySupportWorkflowService.ts:1319-1341, 1410-1440` |
| `cross_instance_variable` is per-document atomic | `YamlFlow/steps/core/CrossInstanceVariableStep.ts:134` (`upsert: true`) |
| Scheduler supports `runAs` | `workflow/Scheduler/Scheduler.ts:87, 630-637` |
| `wait_event` used with no timeout anywhere shipped | `workflows/examples/WaitEvent.yaml` (only occurrence) |
| No test for the timeout branch | no `effectiveDate` / timeout assertions under `YamlFlow/__tests__/` |
| Budget gate on the first user turn | `ReactorConversationService.ts:5727-5737` |
| SSE mode would not reply headlessly | `ReactorConversationService.ts:5810-5830` |
