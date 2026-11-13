# Test Plan — executeYamlWorkflow / listWorkflowInstances (REACTORY-302016408/20261113/2498408002)

Revision 3 — addresses PR #54 review round 2 (4 blocking, 8 non-blocking).

## Defects covered

| Id | Defect | Assertion |
| --- | --- | --- |
| D1 | instance id discarded | returned `instanceId` is the id the service reported, and it resolves through `getWorkflowHistory` |
| D2 | `timeout` a documented no-op | absent from props type, usage text and tool schema |
| D3 | `success: true` with empty outputs reads as "completed" | `status` always present; `outputs`/`state` gone; no top-level field `undefined` |
| D4 | silent catalog overwrite | default run performs no catalog write and leaves the entry byte-identical |
| D5 | dispatched run cannot be found | `listWorkflowInstances` points at `getRecentExecutions` / `getWorkflowHistory` |
| B1 (r2) | `register: true` reported `'registry'` for a brand-new FQN | lookup snapshot taken **before** the save; own registration is `'file'` |
| B2 (r2) | a dispatched-but-unconfirmed run was `'failed'` | `'dispatched_unconfirmed'` + `fqn` + do-not-retry + `getRecentExecutions` |
| B3 (r2) | warning offered a remedy that cannot work | bump `version` / restart; `definitionStale` when a catalog write changes nothing |
| B4 (r2) | registry documented as a live view but is always empty | copy says it is not populated for engine runs; `engineRunsTracked: false` |
| C5 (r2) | unchanged re-runs always warned | provenance compares executable content, not FQN presence |
| N3 (r2) | circuit-breaker resets were dead code | block removed |
| N4 (r2) | "catalog was not written" was an unobserved claim | "could not be confirmed" + `loadStatus` + error codes |
| N5 (r2) | `PARTIAL` accepted silently | `loadStatus` on the receipt |
| N6 (r2) | dispatch branches used different input envelopes | both pass `{ input }` |
| N7 (r2) | schema hid the string form of `inputs` | `oneOf: [object, string]` |
| N8 (r2) | dead `instance?.instanceId` fallback | only `.id` read |
| N2 (r2) | harness unfaithful / false fidelity claim | `saveWorkflowDefinition` fake registers into the registry; `selectWorkflowByName` mirror uses highest semver |

## Scenarios

Registry contract:
- [x] no `timeout`; `register` boolean; `filePath` required
- [x] `inputs` is `oneOf` object|string
- [x] three statuses + `definitionSource` + `definitionStale` documented; `saveWorkflowYaml` remedy gone

Dispatch result:
- [x] `dispatched`, `instanceId`, `fqn`, `registered: false`, `definitionSource: 'file'`, `definitionStale: false`
- [x] no `undefined` field; no `outputs`/`state`/`instanceStatus`/`statusLabel`; `loadStatus` absent without a write
- [x] dispatch via `IReactoryWorkflowService.startWorkflow({ input })`
- [x] string inputs parsed
- [x] id resolves via `getWorkflowHistory` while the record says `status 0 / 'Pending'`
- [x] runner fallback uses the same `{ input }` envelope (N6)
- [x] no id → `dispatched_unconfirmed` + `fqn` + do-not-retry (B2)
- [x] throw during dispatch → `dispatched_unconfirmed` + `fqn` + stack (B2)
- [x] throw before dispatch → `failed` + `fqn`, nothing dispatched

Catalog integrity:
- [x] default: no write + entry byte-identical
- [x] `register: true` new FQN: writes, `loadStatus: 'SUCCESS'`, `definitionSource: 'file'`, no warning, no extra append (B1)
- [x] `register: true` on a differing existing FQN: `registered: true` **and** `definitionStale: true` + warning (B3)
- [x] `PARTIAL` surfaces `loadStatus` (N5)
- [x] `PARSE_ERROR`: `failed`, `loadStatus` on receipt, error codes preserved, "could not be confirmed" not "not written" (N4)
- [x] missing `saveResult` / missing `loadStatus`: `failed`
- [x] invalid definition: `failed` before any write or dispatch

Provenance:
- [x] unregistered FQN → `'file'`, registered with `filePath`, run resolves to the file
- [x] second run of the same file → `'file'`, silent, registry does not grow (C5)
- [x] file changed in place → `'registry'` + warning (C5)
- [x] differing registered entry → `'registry'`, no append, run resolves to the registered location
- [x] repeated/concurrent calls do not grow the registry
- [x] runner without `getWorkflowByName` → `'file'`

Input rejection: missing `filePath` / missing file / bad YAML / missing identifier triple.

listWorkflowInstances:
- [x] copy states the registry is not populated for engine runs and no longer says "may not appear here yet"
- [x] `id` filter is not an instance id
- [x] `engineRunsTracked: false` + note when total is 0
- [x] no note for a page past the end of a non-empty result
- [x] no note when instances are present
- [x] all filters + pagination reach the service
- [x] context / service-missing / throw paths

## Coverage

```bash
node scripts/ai/run-worktree-tests.js ai/macro/workflow/__tests__/executeYamlWorkflow.test.ts \
  --coverage --coverageThreshold='{}' \
  --collectCoverageFrom="src/modules/reactory-worktrees/ai-REACTORY-302016408-20261113-2498408002/ai/macro/workflow/executeYaml.macro.ts" \
  --collectCoverageFrom="src/modules/reactory-worktrees/ai-REACTORY-302016408-20261113-2498408002/ai/macro/workflow/listWorkflowInstances.macro.ts"
```

`--coverageThreshold='{}'` is required: the inherited server config sets a threshold for
`./src/authentication/**/*.ts`, which a narrowed run collects nothing for, so Jest exits 1 on an
all-green run.

| File | % Stmts | % Branch | % Funcs | % Lines |
| --- | --- | --- | --- | --- |
| `executeYaml.macro.ts` | 90.40 | 81.30 | 100 | 92.72 |
| `listWorkflowInstances.macro.ts` | 100 | 94.11 | 100 | 100 |

Uncovered lines in `executeYaml.macro.ts` (95, 119, 188, 193, 260-261, 299, 323) are the
uninitialised-runner branch, the "service not registered" branch, the stable-stringify catch, and
`failure()` message paths whose siblings are asserted.

## Results

- [x] `node scripts/ai/run-worktree-tests.js ai/macro/workflow/__tests__/executeYamlWorkflow.test.ts ai/macro/__tests__/MacroRegistry.contract.test.ts`
      → `Test Suites: 2 passed, 2 total`, `Tests: 44 passed, 44 total`, exit code **0**.
- [x] Coverage target met for both changed files.
