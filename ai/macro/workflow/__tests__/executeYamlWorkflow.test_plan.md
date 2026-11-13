# Test Plan — executeYamlWorkflow / listWorkflowInstances (REACTORY-302016408/20261113/2498408002)

Revision 2 — addresses review 1 (B1, N1–N5).

## Defects covered

| Id | Defect | Assertion |
| --- | --- | --- |
| D1 | instance id discarded | the returned `instanceId` is the id the service reported, and the same id resolves through `getWorkflowHistory` |
| D2 | `timeout` a documented no-op | `timeout` is absent from the props type, the registry usage text and the tool schema; `register` is present and boolean |
| D3 | `success: true` with empty outputs reads as "completed" | `status` is always present; `outputs`/`state` are gone; no top-level field is `undefined` |
| D4 | silent catalog overwrite | a default run performs no catalog write and leaves the registered entry byte-identical; only `register: true` writes |
| D5 | dispatched run cannot be found | `listWorkflowInstances` describes itself as the in-memory registry and points at `getRecentExecutions` / `getWorkflowHistory`; an empty result carries that hint |
| B1 | a constant presented as an observation | the receipt carries **no** run-status field (`instanceStatus`, `statusLabel` absent), so it cannot contradict the persisted record |
| N1 | "the run uses the file" was false for an already-registered FQN | `definitionSource` is `'registry'` with a `warning`, no dead append, and the run demonstrably resolves to the registered location |
| N4 | unconfirmed catalog write treated as success | a missing `saveResult` or a missing `loadStatus` is a registration failure that does not dispatch |

## Test scenarios

Registry contract (D2, B1 surface):
- [x] no `timeout` in schema or descriptions; `register` boolean; `filePath` still required.
- [x] the receipt shape is documented, including `definitionSource`.

Dispatch result (D1/D3/B1):
- [x] `status: 'dispatched'`, `instanceId`, `fqn`, `registered: false`, `definitionSource: 'file'`.
- [x] no top-level field is `undefined`; `outputs`/`state` absent.
- [x] `instanceStatus` and `statusLabel` are absent — the anti-regression for B1.
- [x] dispatch goes through `IReactoryWorkflowService.startWorkflow({ input })`, not the runner.
- [x] string inputs are parsed.
- [x] the returned id resolves through `getWorkflowHistory` for a `wait_event` human-approval run, whose record says `status 0 / 'Pending'` — asserted *alongside* the receipt's `dispatched`, because they answer different questions.
- [x] runner-id fallback when the service lacks the instance entry point.
- [x] no instance id → `failed`; thrown dispatch → `failed` with `stack`.

Catalog integrity (D4, N4):
- [x] default run: `saveWorkflowDefinition` never called **and** the seeded catalog entry is byte-identical afterwards.
- [x] `register: true` writes once with the file's nameSpace/name/version and that object lands in the catalog.
- [x] `register: true` + `PARSE_ERROR` → `failed`, no dispatch, catalog untouched.
- [x] `register: true` + `undefined` result → `failed` ("no loadStatus returned").
- [x] `register: true` + result without `loadStatus` → `failed`.
- [x] invalid definition → `failed` before any write or dispatch.

Definition provenance (N1) — the fake now models `registerWorkflow`'s append and the
first-match lookups (`startWorkflow` `.find()`, `selectWorkflowByName` `matches.find()`):
- [x] unregistered FQN → `registerWorkflow` once with the file path, `definitionSource: 'file'`, run resolves to the file.
- [x] already-registered FQN → `definitionSource: 'registry'`, `warning` present, `registerWorkflow` **not** called, registry length unchanged, and the run resolves to the **pre-registered** location (a changed file is not picked up).

Input rejection:
- [x] missing `filePath` / missing file / unparseable YAML / missing identifier triple.

listWorkflowInstances (D5):
- [x] registry and tool descriptions name the in-memory registry and the history surface.
- [x] the `id` filter is no longer described as an instance id.
- [x] empty result carries `note`; non-empty does not.
- [x] every filter + pagination reaches the service; context/service/throw error paths.

## Coverage

Reproducible command (2 suites / 30 tests, exit 0):

```bash
node scripts/ai/run-worktree-tests.js ai/macro/workflow/__tests__/executeYamlWorkflow.test.ts \
  --coverage --coverageThreshold='{}' \
  --collectCoverageFrom="src/modules/reactory-worktrees/ai-REACTORY-302016408-20261113-2498408002/ai/macro/workflow/executeYaml.macro.ts" \
  --collectCoverageFrom="src/modules/reactory-worktrees/ai-REACTORY-302016408-20261113-2498408002/ai/macro/workflow/listWorkflowInstances.macro.ts"
```

`--coverageThreshold='{}'` is required: the inherited server config declares a threshold for
`./src/authentication/**/*.ts`, which a narrowed run collects nothing for, so Jest exits 1 with
"Coverage data for ./src/authentication/**/*.ts was not found" on an all-green run. Clearing the
threshold removes that artifact; the table below is from the command above.

| File | % Stmts | % Branch | % Funcs | % Lines |
| --- | --- | --- | --- | --- |
| `executeYaml.macro.ts` | 93.75 | 86.20 | 100 | 94.66 |
| `listWorkflowInstances.macro.ts` | 100 | 100 | 100 | 100 |

Uncovered lines in `executeYaml.macro.ts` (119, 124, 202, 233) are the uninitialised-runner
branch, the "service not registered" branch, and two `failure()` message paths whose siblings are
already asserted.

## Test results

- [x] `node scripts/ai/run-worktree-tests.js ai/macro/workflow/__tests__/executeYamlWorkflow.test.ts ai/macro/__tests__/MacroRegistry.contract.test.ts`
      → `Test Suites: 2 passed, 2 total`, `Tests: 34 passed, 34 total`, exit code **0**.
- [x] Coverage target met for both changed files (table above).
