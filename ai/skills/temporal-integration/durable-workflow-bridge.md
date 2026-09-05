# Reactory ⇄ Temporal Durable Workflow Bridge Skill

## Overview

Reactory runs two orchestration engines, and most mistakes in this area come from
reaching for the wrong one — or from wiring them together in a way that *looks*
connected but silently drops work.

| | Reactory workflow engine (`workflow-es`) | Temporal |
|---|---|---|
| Definition | YAML in the workflow catalog, or a code workflow | Deterministic TypeScript on a worker |
| State | Mutable instance snapshot persisted per step boundary | Append-only event history, replayed |
| Strength | Business/UI orchestration: forms, tasks, approvals, tenant context, services | Distributed execution: fan-out, retries, sagas, timers measured in days |
| Weakness | Not built for thousands of parallel activities or multi-day timers | Knows nothing about Reactory users, forms, tenants or services |

The bridge lets a YAML workflow **start a Temporal execution and suspend on it**
without holding a worker, and lets Temporal **wake that instance** when it settles.

Read this before authoring any workflow that touches Temporal, and before debugging
a workflow that appears to be "stuck waiting".

---

## 1. When Temporal is (and is not) applicable

**Use Temporal when the work has any of these properties:**

- **High fan-out.** Thousands of items each needing independent retry and progress
  (a 10,000-row payout batch, a bulk re-index). The Reactory engine persists a full
  instance snapshot per step boundary; it is not built for that shape.
- **Long timers.** Anything waiting hours to weeks. Temporal's timers cost nothing
  while pending; the Reactory engine's poll worker scans the database.
- **Cross-service sagas with compensation.** Money movement, provisioning, anything
  where a partial failure must be unwound precisely.
- **Exactly-once side effects under retry.** Temporal's activity semantics plus a
  deterministic workflow id are far stronger than a step-level retry policy.

**Keep it in the Reactory engine when the work is:**

- **User- or form-facing.** Approvals, task queues, anything rendering a Reactory
  component. Temporal has no notion of a Reactory user, tenant, form or service.
- **Service orchestration inside Reactory.** `service_invoke`, `graphql_*`,
  `mongo_*`, `email`, `search` — these steps already run with a rehydrated Reactory
  context, tenant and identity.
- **Short.** If the whole thing finishes in seconds and needs no fan-out, a Temporal
  round trip adds a cluster dependency and a second failure domain for nothing.

**The usual correct shape is BOTH:** Reactory owns the experience and the control
plane (validation, approval gates, notifications, audit); Temporal owns the durable
execution kernel. `reactory-temporal-examples.ApproveBatchPayout@1.0.0` is the
reference implementation of exactly that split.

**Do not use Temporal at all if the cluster is not part of the deployment.** Every
step below fails cleanly without one, but a workflow that *requires* Temporal will
not run. Check first: `reactory.TemporalClientService@1.0.0` must be registered and
`$TEMPORAL_ADDRESS` reachable.

---

## 2. The step inventory

All registered by the `reactory-temporal` module into the shared YAML step registry,
so they are addressed by `type:` like any core step.

| Step type | Purpose |
|---|---|
| `temporal_workflow` | Start an execution, optionally await its outcome |
| `temporal_await` | Await an execution started elsewhere (earlier step, mutation, operator) |
| `temporal_signal` | Send a Signal — releases a Temporal `await condition(...)` gate |
| `temporal_query` | Read live in-flight state (read-only, side-effect free) |
| `temporal_update` | Workflow Update — validated, synchronous request/response |
| `temporal_cancel` | Graceful cancellation (workflow can clean up) |
| `temporal_terminate` | Immediate termination (no cleanup — prefer cancel) |
| `temporal_describe` | Status/metadata without waiting; use it to branch |

Connection for every step: inline `connection`, or a named `connectionKey` resolved
as **explicit config → partner setting `temporal/<key>` → `TEMPORAL_<KEY>_ADDRESS` →
`TEMPORAL_ADDRESS` → localhost:7233**.

---

## 3. Await modes — the decision that matters most

`temporal_workflow` and `temporal_await` take `awaitMode`:

| Mode | Behaviour | Choose when |
|---|---|---|
| `none` | Start and continue | Fire-and-forget, or you will wait later in the flow |
| `event` | **Durable suspend.** Registers a completion watch, then parks the instance — no worker held, survives restarts | Long runs, multi-day gates. The default choice for real work |
| `sleep_poll` | **Durable poll.** Sleeps, re-runs, re-checks | Short runs, or a deployment without the event bridge |
| `block_poll` | Waits inside the step | Only the non-durable executor (CLI/tests). Restarts its wait after a crash |

Degradation is automatic and deliberate: `event` falls back to `sleep_poll` when the
bridge service is unavailable, and both fall back to `block_poll` when the engine
cannot suspend. A suspension nobody can satisfy would hang the instance forever, so
the step refuses to create one.

---

## 4. Non-negotiable rules

### 4.1 `workflowId` MUST be deterministic

```yaml
workflowId: "batch_${input.batchId}"     # correct
workflowId: "batch_${env.RANDOM}"        # WRONG — a retry starts a second execution
```

The engine re-executes a step on retry and after a process restart. With a
deterministic id plus the default `idConflictPolicy: USE_EXISTING`, the second run
adopts the existing execution and reports `reattached: true`. With a random id you
get duplicate money movement. `validateConfig` warns when the id contains no
`${...}` reference — heed it unless the workflow is genuinely a singleton.

### 4.2 Never do I/O inside a Temporal workflow function

Temporal replays workflow code deterministically. `fetch`, `Date.now()`,
`Math.random()`, database calls and `setTimeout` are all illegal there. Put them in
an **activity**. To call back into Reactory from Temporal, use the
`notifyReactoryActivity` activity, never inline workflow code.

### 4.3 Keep payloads small

Step outputs are persisted into the durable instance, so an oversized result bloats
every subsequent persist. Use `resultPath` to extract just what the flow needs; the
64 KB default cap (`maxResultBytes`) replaces an oversized payload with
`{ truncated: true, bytes }` and a warning naming the run to query for the rest.

### 4.4 Whole-value references keep their type; mixed content does not

```yaml
args:
  - rows: "${input.rows}"              # the ARRAY
    label: "batch ${input.batchId}"    # an interpolated STRING
```

A whole-value `${...}` resolves to the value itself. Anything with surrounding text
is interpolated into a string. Passing `"${input.rows}"` as mixed content would hand
Temporal JSON *text* and `input.rows.reduce(...)` would throw inside the workflow,
far from the cause.

### 4.5 Dotted variable paths must be rooted

```yaml
message: "${variables.batchSummary.rowCount}"   # correct
message: "${batchSummary.rowCount}"             # NEVER RESOLVES — passes through literally
```

A bare name resolves only as a *whole-variable* reference (`${approval}`). A dotted
path must be rooted at `input.` / `inputs.` / `variables.` / `steps.` / `env.`.
Unresolved tokens are passed through verbatim, so this failure is invisible until it
lands in a log line — or in a Temporal signal, permanently recorded in its history.

---

## 5. How the wake-up actually works

```
temporal_workflow (awaitMode: event)
   ├─ starts the execution
   ├─ registers a watch (TemporalWorkflowWatch, durable)
   ├─ describe() — if already terminal, resolves INLINE without suspending
   └─ control.waitForEvent(temporal.workflow.settled, key = workflowId)
                                   ▲
TemporalEventBridgeService ────────┘  publishes on settle, under the INSTANCE's tenant
```

**Event topics.** Awaiting steps subscribe to the collapsed
`temporal.workflow.settled`, published for *every* terminal outcome with `status` in
the payload. The per-outcome topics (`.completed`, `.failed`, `.cancelled`,
`.timeout`) are published in addition, for observability or an explicit `wait_event`.
A step cannot subscribe to four topics at once — the engine matches one
`(eventName, eventKey)` pair per execution pointer — which is why the collapsed topic
exists.

**The correlation key is the Temporal `workflowId`**, not the runId: deterministic,
known before the run starts, and stable across continue-as-new.

### Three hazards the bridge exists to survive

1. **An event with no subscription is DISCARDED.** The engine's event queue marks it
   processed and drops it; there is no replay. A publish that beats the awaiting step
   into suspension is lost forever. Mitigations: the outcome is persisted to the watch
   *before* publishing and re-published until the waiting pointer is observed to have
   consumed it, and the step `describe()`s before parking.
2. **Restarts kill in-memory listeners.** Watches are durable; a sweeper re-attaches
   and reconciles at boot, so a completion that happened while Reactory was down is
   delivered on the first sweep.
3. **Subscriptions are tenant-scoped.** Instances run under `partner.key` as their
   engine tenant. Publishing under the wrong tenant silently wakes nothing. Anything
   publishing an event for an instance must use that instance's tenant —
   `context.workflow.tenantId` inside a step, or `publishWorkflowEvent(..., tenantId)`.

---

## 6. Human approval gates

Temporal must not own a human gate — it has no idea who your users are. Reactory
does, via `user_activity`:

```yaml
  - id: awaitApproval
    name: Await checker approval
    type: user_activity
    config:
      activityType: approval
      assignee: "${input.approverEmail}"      # user id or email; defaults to the starter
      message: "Approve batch ${input.batchId}"
      fqn: core.WorkflowTaskApproval@1.0.0    # the component the UI renders
      props:
        category: Mass payout
      propsMap:                                # lodash paths — types preserved
        amount: steps.batchProgress.outputs.result.totalAmount
        currency: input.currency
```

The step creates a Task, suspends on `workflow.task.completed` keyed by **task id**,
and resumes when the `completeWorkflowTask` mutation fires from the UI. Outputs carry
`approved`, `completedBy`, `completedByEmail`, `completedAt` and the raw `response`.

**The approver identity is stamped server-side from the authenticated context** — it
is never read from the submitted payload, because a client-supplied approver proves
nothing. Use `${steps.<gate>.outputs.completedByEmail}` when passing the approver on
to a Temporal signal, so Temporal's permanent history names a real person.

The canonical pairing — Reactory holds the gate, Temporal holds the money:

```
temporal_workflow (awaitMode: none)   → Temporal parks on its own await condition()
temporal_query                        → show the operator live state
user_activity                         → Reactory task; instance suspends
temporal_signal                       → release Temporal's gate with the real approver
temporal_await (awaitMode: event)     → durable wait for settlement
```

Note: the task queue **polls** (`useWorkflowTasks`, 30s). There is no server→browser
push, so do not expect an instant notification when a gate opens.

---

## 7. Diagnosing a stuck instance

Work in this order; each step tells you which side to look at next.

1. **What is it waiting on?**
   ```bash
   ./bin/reactory workflow get <instanceId>
   ```
   `Waiting for Event` names the parked step. For the exact pair, read the instance's
   `executionPointers` for `eventName` + `eventKey` where `eventPublished` is false.

2. **Did Temporal actually finish?** Query the cluster directly (from the project
   root, so `@temporalio/client` resolves) and compare with what the step is awaiting.
   A `COMPLETED` run plus a still-parked instance means a *delivery* problem, not an
   execution problem.

3. **Inspect the watch** — `temporal_workflow_watches` in Mongo. It localises the
   failure precisely:
   - `pending` → the outcome never arrived; the bridge is not watching (check the
     bridge is started and the cluster is reachable).
   - `settled` with rising `attempts` → published but the waiting pointer has not
     consumed it. Check `clientKey` matches the instance's `tenantId`.
   - `acked` while the instance is still parked → it was published somewhere nothing
     was listening. Almost always a tenant or event-key mismatch.
   - `abandoned` → delivery was retried to exhaustion; `lastError` says why.
   - `instanceId: ""` → the watch cannot verify delivery at all.

4. **Read the instance log** for the step's own account:
   `$REACTORY_DATA/workflows/catalog/<ns>/<name>/<version>/logs/<instanceId>.log`

5. **Wake it manually** once you know the pair — this both unblocks the run and
   confirms the resume path works:
   ```bash
   ./bin/reactory workflow continue <instanceId> \
     --event=temporal.workflow.settled --event-key=<workflowId> \
     --event-data='{"status":"COMPLETED","result":{}}'
   ```

---

## 8. Anti-patterns

- **Using `wait_event`'s `timeout` as a timeout.** It sets the subscription's
  effective date, and matching requires `subscribeAsOf <= eventTime` — so it *delays
  event eligibility* rather than aborting the wait. Timeouts must be delivered as
  events; `awaitTimeout` on the temporal steps does exactly that.
- **Putting `continueOnError` inside `config`.** It is a **step-level** property the
  engine reads off the definition; nested under `config` it is silently ignored.
- **Awaiting a Temporal workflow that parks on its own human gate.** It will never
  settle on its own. Either drive the gate (`temporal_signal`), deliver approval at
  start (`signalOnStart` — atomic `signalWithStart`), or model the gate in Reactory.
- **Assuming a code change is live.** The server runs `babel-node` with no watcher:
  **step code and YAML changes require a server restart.** The CLI compiles current
  source but the long-running server usually wins the race to execute an instance, so
  you cannot use the CLI to test uncommitted step code.
- **Trusting a client-supplied approver id.** Always take identity from the
  authenticated context.

---

## Summary

Reach for Temporal for fan-out, long timers, sagas and exactly-once side effects;
keep users, forms, tenants and Reactory services on the Reactory engine; bridge them
with `awaitMode: event` so the instance suspends instead of blocking. Make
`workflowId` deterministic, keep payloads small, root your template paths, and
remember that an event published to the wrong tenant — or before its subscription
exists — is discarded without a trace. When something is stuck, the watch record in
`temporal_workflow_watches` will tell you which side of the bridge to look at.
