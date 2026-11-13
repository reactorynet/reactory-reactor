# Test Plan — executeYamlWorkflow / listWorkflowInstances (REACTORY-302016408/20261113/2498408002)

## Defects covered

| Id | Defect | Assertion |
| --- | --- | --- |
| D1 | instance id discarded | the returned `instanceId` is the id the service reported, and the same id resolves through `getWorkflowHistory` |
| D2 | `timeout` a documented no-op | `timeout` is absent from the props type, the registry usage text and the tool schema; `register` is present and boolean |
| D3 | `success: true` with empty outputs reads as "completed" | `status` is always present; `outputs`/`state` are gone; no top-level field is `undefined` |
| D4 | silent catalog overwrite | a default run never calls `saveWorkflowDefinition`; only `register: true` writes the catalog |
| D5 | dispatched run cannot be found | `listWorkflowInstances` describes itself as the in-memory registry and points at `getRecentExecutions` / `getWorkflowHistory`; an empty result carries that hint |

## Test scenarios

- [x] Schema/registry: no `timeout`, `register` is a boolean, usage text mentions `register`.
- [x] Happy path: dispatch returns `status: 'dispatched'`, `instanceId`, `fqn`, `registered: false`, `instanceStatus: 'running'`.
- [x] Returned `instanceId` is the key that resolves the run in the history surface (human-approval workflow).
- [x] No `undefined` top-level field is ever returned (success and failure shapes).
- [x] `outputs` / `state` are not part of the result.
- [x] Default run does not call `saveWorkflowDefinition` (registered definition unchanged); catalog write happens only with `register: true`.
- [x] `register: true` failure (`PARSE_ERROR`) returns `status: 'failed'` and does not dispatch.
- [x] Invalid definition (validation) returns `status: 'failed'` without dispatching.
- [x] Dispatch that yields no instance id returns `status: 'failed'` (never `success: true`).
- [x] String `inputs` are parsed and forwarded as `{ input }`.
- [x] Missing `filePath` / missing file / unparseable YAML / invalid identifier triple are rejected.
- [x] Thrown errors return `status: 'failed'` with the message.
- [x] `listWorkflowInstances`: empty result carries the `note` hint; non-empty result does not.
- [x] `listWorkflowInstances`: registry/tool descriptions name the in-memory registry as the source and `getRecentExecutions`/`getWorkflowHistory` as the lookup path.
- [x] `listWorkflowInstances`: all filters and the pagination reach the service; context/service/throw error paths.

## Coverage targets

- Target: 80% minimum for the two targeted files.
- Measured with
  `node scripts/ai/run-worktree-tests.js ai/macro/workflow/__tests__/executeYamlWorkflow.test.ts --coverage --collectCoverageFrom=<worktree>/ai/macro/workflow/{executeYaml,listWorkflowInstances}.macro.ts`:

| File | % Stmts | % Branch | % Funcs | % Lines |
| --- | --- | --- | --- | --- |
| `executeYaml.macro.ts` | 91.46 | 80.00 | 100 | 94.66 |
| `listWorkflowInstances.macro.ts` | 100 | 100 | 100 | 100 |

The uncovered lines in `executeYaml.macro.ts` (114, 119, 178, 209) are the `ctx === undefined`
branch, the "service not registered" branch, and the two `failure()` branches whose message
paths are already asserted through their siblings.

Note: the coverage run exits 1 because the inherited server config declares global
`collectCoverageFrom` globs (`./src/authentication/**/*.ts`, …) that this narrowed run does not
cover — `Jest: Coverage data for ./src/authentication/**/*.ts was not found.` The tests
themselves pass in that run; the canonical (non-coverage) run exits 0.

## Test results

- [x] `node scripts/ai/run-worktree-tests.js ai/macro/workflow/__tests__/executeYamlWorkflow.test.ts ai/macro/__tests__/MacroRegistry.contract.test.ts`
      → `Test Suites: 2 passed, 2 total`, `Tests: 30 passed, 30 total`, exit code **0**.
- [x] Coverage target met for both changed files (table above).
