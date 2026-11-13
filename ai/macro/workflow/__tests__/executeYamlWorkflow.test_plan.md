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

- [ ] Schema/registry: no `timeout`, `register` is a boolean, usage text mentions `register`.
- [ ] Happy path: dispatch returns `status: 'dispatched'`, `instanceId`, `fqn`, `registered: false`, `instanceStatus: 'running'`.
- [ ] Returned `instanceId` is the key that resolves the run in the history surface (human-approval workflow).
- [ ] No `undefined` top-level field is ever returned (success and failure shapes).
- [ ] `outputs` / `state` are not part of the result.
- [ ] Default run does not call `saveWorkflowDefinition` (registered definition unchanged); catalog write happens only with `register: true`.
- [ ] `register: true` failure (`PARSE_ERROR`) returns `status: 'failed'` and does not dispatch.
- [ ] Invalid definition (validation) returns `status: 'failed'` without dispatching.
- [ ] Dispatch that yields no instance id returns `status: 'failed'` (never `success: true`).
- [ ] String `inputs` are parsed and forwarded as `{ input }`.
- [ ] Missing `filePath` / missing file / unparseable YAML / invalid identifier triple are rejected.
- [ ] Thrown errors return `status: 'failed'` with the message.
- [ ] `listWorkflowInstances`: empty result carries the `note` hint; non-empty result does not.
- [ ] `listWorkflowInstances`: registry/tool descriptions name the in-memory registry as the source and `getRecentExecutions`/`getWorkflowHistory` as the lookup path.

## Coverage targets

- Target: 80% minimum for the two targeted files.
- Measured: recorded in the completion report.

## Test results

- [ ] All tests passing — see the completion report for the exact command, exit code and counts.
