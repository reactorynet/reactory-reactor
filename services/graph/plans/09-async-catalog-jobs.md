# Session 09 — Async Catalog / Index Jobs

| Field | Value |
|-------|--------|
| **ID** | 09 |
| **Priority** | P1 |
| **Estimate** | M |
| **Depends on** | **08** (incremental makes jobs cheaper; can start after 02 if needed) |
| **Branch** | `feat/system-graph-09-async-jobs` |

---

## 1. Objective

`ReactorSyncCatalogNodes` and `ReactorIndexNodes` run `process()` inline on the GraphQL request thread — timeouts on large repos.

**Enqueue catalog/index work as a workflow (or background job), return immediately with a job/execution id, and expose status.**

---

## 2. Out of scope

- Rewriting the entire project service
- UI progress component (document GraphQL fields for client)
- Distributed workers beyond existing Reactory workflow engine

---

## 3. Allowed files

- `graphql/resolvers/ReactorSystemGraph.ts` — mutations return job handles
- GraphQL schema for reactor module (search `ReactorSyncCatalogNodes`, `ReactorIndexNodes`)
- New workflow YAML under e.g.  
  `src/modules/reactory-reactor/workflows/` or `reactory-core/workflows/`  
  name suggestion: `reactor.CatalogProjectGraph@1.0.0`
- `SystemGraphManager.ts` / `ReactorProjectService.ts` — `enqueueCatalog(projectId, opts)`
- Optional model for job status if workflow history is insufficient
- README

---

## 4. Design

### 4.1 Prefer existing workflow engine

Use patterns from Reactor instructions:

- `executeYamlWorkflow` with inputs `{ projectId, forceFull, runId }`
- Poll via `getWorkflowHistory` / recent executions

Workflow steps (conceptual):

1. `loadProject` — fetch project by id  
2. `detectProcessors`  
3. `processAll` — call catalog with shared runId (session 02)  
4. `finalizeGc`  
5. `emitMetrics`

### 4.2 Mutation response shape (additive)

Keep old success shape if possible; prefer union:

```graphql
type ReactorCatalogJobAccepted {
  jobId: String!
  message: String
}
# existing success/failure types remain for sync fallback
```

Feature flag / arg:

```graphql
ReactorSyncCatalogNodes(request: ..., async: Boolean = true)
```

When `async: false`, preserve old blocking behavior for tests/admin.

### 4.3 Status query

```graphql
ReactorCatalogJobStatus(jobId: String!): ReactorCatalogJobStatus
```

Map workflow instance status → `PENDING|RUNNING|COMPLETE|FAILED` + error message + stats if available.

### 4.4 Idempotency

Same project re-enqueue while RUNNING → return existing jobId (store `project.indexingJobId` or query recent executions by projectId input).

### 4.5 Auth

Same roles as existing mutations; do not open ANON.

---

## 5. Implementation steps

1. Locate existing workflow YAML examples in repo; copy structure.
2. Implement workflow definition + register in module.
3. Add `enqueueCatalogProject(projectId, opts)` service method.
4. Change mutations to default async.
5. Add status query.
6. Tests: mock workflow trigger; assert mutation doesn’t await process().
7. Document client polling.

---

## 6. Acceptance criteria

- [x] Default sync catalog mutation returns in < 1s with job id (mocked engine)
- [x] `async: false` still blocks and catalogs (for scripts)
- [x] Status query reflects workflow terminal states
- [x] No double concurrent full process for same project without force
- [x] Schema additive / backward compatible as much as possible

---

## 7. Agent Notes

- Workflow file path: `src/modules/reactory-reactor/workflow/CatalogProjectGraph.yaml`
- Registration mechanism used: Registered via `YAML_WORKFLOWS` in `src/modules/reactory-reactor/workflow/index.ts` using `loadYamlWorkflow` under `reactor.CatalogProjectGraph@1.0.0`
- Service implementation: `enqueueCatalog(projectId, opts)` added to `ReactorProjectService` and `SystemGraphManager`, persisting `project.indexingJobId` for idempotency unless `forceFull: true`. `getCatalogJobStatus(jobId)` maps workflow instance status codes (0/4 -> PENDING, 1 -> RUNNING, 2 -> COMPLETE, 3 -> FAILED).
- GraphQL surface: Added `ReactorCatalogJobAccepted` type to `CatalogNodeSyncResult` union in `mutations.graphql`. Added `async: Boolean = true` parameter to `ReactorSyncCatalogNodes` and `ReactorIndexNodes`. Added `ReactorCatalogJobStatus` query in `queries.graphql`.
- Test coverage: `src/modules/reactory-reactor/services/graph/AsyncCatalogJobs.test.ts` (15 passing tests).
