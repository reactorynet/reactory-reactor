# Session 14 — Observability, Cache Busting, Tenancy & Path Redaction

| Field | Value |
|-------|--------|
| **ID** | 14 |
| **Priority** | P4 |
| **Estimate** | M |
| **Depends on** | **08**, **09** preferred |
| **Branch** | `feat/system-graph-14-ops` |

---

## 1. Objective

Harden production operations:

1. Structured process metrics
2. Cache invalidation on re-index (`REACTOR_NODE_*`)
3. Optional partner/tenant scoping on graph queries
4. Redact absolute filesystem paths from GraphQL-facing node projections

---

## 2. Allowed files

- `BaseProjectProcessor.ts` — metrics object return / log JSON
- `SystemGraphManager.ts` — query filters, cache clear, projection helper
- `ReactorProjectService.ts` — tenant fields if exist
- `graphql/resolvers/ReactorSystemGraph.ts` — apply projection
- Types for `GraphProcessMetrics`
- README ops section
- Tests for redaction + cache clear

---

## 3. Design

### 3.1 Metrics

Emit at end of process:

```ts
interface GraphProcessMetrics {
  projectId: string;
  projectFqn: string;
  runId: string;
  filesDiscovered: number;
  filesAnalysed: number;
  filesSkipped: number;
  foldersCreated: number;
  nodesUpserted: number;
  edgesUpserted: number;
  nodesGcDeleted?: number;
  edgesGcDeleted?: number;
  durationMs: number;
  errors: number;
  byLanguage?: Record<string, number>;
}
```

Log as single JSON line via `context.info('graph.process.complete', metrics)` if context supports meta; else stringified.

Optional: write to project metrics API if `getProjectMetrics` pattern exists.

### 3.2 Cache bust

After successful process/GC:

```ts
// If context supports pattern delete, use it; else track touched ids and delete keys
await context.clearValue?.(`REACTOR_NODE_${id}`)
```

Document limitation if context only has per-key delete.

Also clear on `updateNode` (session 06).

### 3.3 Tenancy

If `IReactorProject` or context has `partnerId` / `organizationId`:

- Stamp on nodes in persistGraph meta
- `getNodeLinks` / `searchNodes` / `getSubgraph` accept optional `partnerId` and filter
- GraphQL: take from `context.user` / partner — **do not trust client-supplied partner alone**

If no multi-tenant model exists in codebase, implement **stub hooks** + comments rather than inventing a full RBAC system. Document “enabled when partnerId present”.

### 3.4 Path redaction

GraphQL projection:

```ts
function publicNode(node) {
  const copy = { ...node };
  if (copy.source && path.isAbsolute(copy.source)) {
    copy.source = copy.data?.relativePath || '[redacted]';
  }
  if (copy.data?.path && path.isAbsolute(copy.data.path)) {
    copy.data = { ...copy.data, path: copy.data.relativePath || undefined };
  }
  return copy;
}
```

Apply in resolver property or manager method used by GraphQL only — **internal process still needs absolute paths**.

### 3.5 Health

Optional `onStartup` log of index presence / collection stats — keep light.

---

## 4. Acceptance criteria

- [x] Process emits structured metrics with counts
- [x] Cache keys for written node ids cleared after process (or documented if impossible)
- [x] Absolute paths not returned on GraphQL node payloads (test)
- [x] Tenant filter hook present; no regression when partnerId absent
- [x] README ops section updated

---

## 5. Agent Notes

- **Implementation Details**:
  - **Structured Process Metrics**: Added `GraphProcessMetrics` to `service.types.ts`. `BaseProjectProcessor.process` tracks `filesDiscovered`, `filesAnalysed`, `filesSkipped`, `foldersCreated`, `nodesUpserted`, `edgesUpserted`, `nodesGcDeleted`, `edgesGcDeleted`, `durationMs`, `errors`, and `byLanguage`, logging as `graph.process.complete` and setting `processor.lastMetrics`.
  - **Cache Busting**: Node cache keys (`REACTOR_NODE_<id>`) for all written/updated nodes are invalidated after `process()` and on `updateNode()`.
  - **Tenancy & Scoping**: `BaseProjectProcessor.persistGraph` stamps `partnerId` and `organizationId` from project/context metadata onto persisted nodes and links. `SystemGraphManager` methods (`getNodeLinks`, `searchNodes`, `findLinks`, `getSubgraph`) support optional tenant filtering via `partnerId` with safe fallback when absent.
  - **Path Redaction**: Added `publicNode` in `SystemGraphManager` to redact absolute filesystem paths from public GraphQL outputs (replacing `source` and `data.path` with relative paths and removing internal `data.repoPath`), and integrated it into all node-returning resolvers in `graphql/resolvers/ReactorSystemGraph.ts`.
  - Added dedicated unit test suite in `ObservabilityTenancyCache.test.ts` covering redaction, metrics emission, cache invalidation, and tenancy metadata stamping. All tests green.
