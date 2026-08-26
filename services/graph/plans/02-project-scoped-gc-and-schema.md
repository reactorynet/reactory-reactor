# Session 02 — Project-Scoped Schema Fields + Stale Graph GC

| Field | Value |
|-------|--------|
| **ID** | 02 |
| **Priority** | P0 |
| **Estimate** | M |
| **Depends on** | **01** (folder nodes exist so GC won’t delete only-files incorrectly mid-hierarchy tests) |
| **Blocks** | 07, 08, 12 |
| **Branch** | `feat/system-graph-02-gc-schema` |

---

## 1. Objective

`persistGraph` only **upserts**. Deleted/renamed files leave orphan nodes and edges forever.

**Add first-class `projectId`, `projectFqn`, `runId`, and `indexedAt` on nodes (and edges where applicable). After each successful `process()`, delete nodes/edges for that project whose `runId` is not the current run.**

Also prepare schema for session 07 indexes and session 08 hashes (add optional `contentHash` field **nullable**, but do not implement incremental skip here).

---

## 2. Problem evidence

- `BaseProjectProcessor.persistGraph`: bulkWrite upsert only.
- `ReactorGraphNode` schema: no top-level `projectId` / `runId` (only buried in `data`).
- `ReactorNodeLink`: has `projectId` string already; not consistently set on all analyzer edges (verify).
- No delete path for stale graph entities.

---

## 3. Out of scope

- Incremental hash skip (08)
- Mongo index creation beyond fields (07 owns indexes; you may add schema index defs if trivial)
- Search id changes (03)
- Async jobs (09)

---

## 4. Allowed files

| Path | Action |
|------|--------|
| `types/model.types.ts` | Add optional fields on ReactorNode / link types |
| `models/ReactorGraphNode.ts` | Schema fields |
| `models/ReactorNodeLink.ts` | Ensure projectId/runId/indexedAt |
| `services/ReactorProjectProcessors/BaseProjectProcessor.ts` | Stamp runId; GC after persist |
| `services/graph/analyzers/support.ts` | Stamp projectId/runId on emitted edges/nodes if constructed here |
| `services/graph/documents/DocumentGraphEmitter.ts` | Same if edges omit projectId |
| `services/graph/GraphBuilding.test.ts` | GC unit tests with mocks |
| `services/SystemGraphManager.README.md` | Document runId GC |

Avoid rewriting entire analyzers—prefer stamping in `persistGraph` so all nodes/edges get fields in one place.

---

## 5. Design

### 5.1 Fields

**ReactorNode** (top-level, not only `data`):

| Field | Type | Purpose |
|-------|------|---------|
| `projectId` | String | Owning project id (stringified ObjectId or catalog id) |
| `projectFqn` | String | `nameSpace.name@version` |
| `runId` | String | UUID for this process() invocation |
| `indexedAt` | Date | When this run wrote the node |
| `contentHash` | String, optional | Reserved for session 08 (may be unset) |

**ReactorNodeLink**:

| Field | Type |
|-------|------|
| `projectId` | String (already exists) |
| `runId` | String |
| `indexedAt` | Date |

### 5.2 runId generation

At start of `process()`:

```ts
const runId = randomUUID(); // node:crypto
const indexedAt = new Date();
```

### 5.3 Stamping (preferred single choke point)

In `persistGraph(nodes, edges, meta: { projectId, projectFqn, runId, indexedAt })`:

Before building ops, for each entity:

```ts
entity.projectId = String(meta.projectId ?? '')
entity.projectFqn = meta.projectFqn
entity.runId = meta.runId
entity.indexedAt = meta.indexedAt
// keep data.projectId for backward compat if present
```

Root node: still stamped (project root belongs to project).

### 5.4 GC algorithm

After successful bulkWrite of nodes + edges:

```ts
async gcStaleGraph(meta): Promise<void> {
  if (!meta.projectId) {
    context.warn('gc skipped: no projectId');
    return;
  }
  const pid = String(meta.projectId);
  // Nodes: same project, different or missing runId
  await ReactorNodeModel.deleteMany({
    projectId: pid,
    runId: { $ne: meta.runId },
  });
  await ReactorNodeLinkModel.deleteMany({
    projectId: pid,
    runId: { $ne: meta.runId },
  });
}
```

**Critical safeguards:**

1. **Never GC if projectId empty** — would wipe global graph.
2. **Never GC if nodeOps failed** — only after successful persist.
3. **Multi-processor process()**: each processor currently calls `process` separately with its own runId. That would delete the other processor’s nodes!

### 5.5 Multi-processor conflict (MUST solve)

Today `catalogProject` may run NodeJS then Markdown, each `process()` full pipeline.

**If each process GC’s by runId, the second wipes the first.**

**Required approach for this session (pick one, document in Agent Notes):**

**Option A (recommended): soft GC flag**

```ts
process(project, options?: { runId?: string; skipGc?: boolean; isPrimary?: boolean })
```

- `ReactorProjectService.processProject` / `catalogProject` generates **one shared runId**, passes to all processors.
- Only the **last** processor runs GC, or a dedicated final `gcStaleGraph` call in the orchestrator.
- If only one processor, GC at end of its process as today.

**Option B: don’t GC in processor; add `SystemGraphManager.finalizeProjectGraph(projectId, runId)`**

- Processors only stamp runId (shared).
- Manager/service calls finalize once.

Implement **Option A or B** by also editing:

| Path | If needed |
|------|-----------|
| `services/ReactorProjectService.ts` | Shared runId + finalize |
| `services/SystemGraphManager.ts` | `catalogProject` pass-through |

If you touch these, keep changes minimal.

### 5.6 Manual edges

`SystemGraphManager.createLink` user edges: either **omit runId** (and exclude from GC with `{ runId: { $exists: true, $ne: runId } }` plus don’t delete docs where `runId` missing and `data.manual === true`), or stamp `runId: 'manual'` and **exclude** `runId: 'manual'` from GC.

```ts
deleteMany({
  projectId: pid,
  runId: { $nin: [meta.runId, 'manual'] },
  // nodes without runId from legacy: delete only if indexedAt older? 
})
```

Legacy nodes without `projectId`: **do not delete** in this session (optional one-time migration note).

### 5.7 Tests without Mongo

Unit-test GC filter construction and stamping via spies:

```ts
const deleteMany = jest.fn();
ReactorNodeModel.deleteMany = deleteMany;
// after process with mock persist success, expect deleteMany called with projectId + runId $ne
```

Also test: empty projectId → deleteMany **not** called.

Multi-processor: two process calls same runId → GC once with that runId; nodes from both stamped same runId survive.

---

## 6. Implementation steps

1. Extend types + mongoose schemas.
2. Add `runId` plumbing to `process` signature / options.
3. Stamp in `persistGraph`.
4. Implement `gcStaleGraph` with safeguards.
5. Fix multi-processor orchestration (shared runId + single GC).
6. Exclude manual links.
7. Tests.
8. README §5 persistence bullet.

---

## 7. Acceptance criteria

- [ ] Every node/edge written by process has `projectId`, `runId`, `indexedAt`.
- [ ] Second full process with new runId removes nodes not rewritten.
- [ ] Empty projectId never triggers deleteMany.
- [ ] Multi-processor single catalog run does **not** wipe sibling processor nodes.
- [ ] Manual/user links with `runId: 'manual'` (or equivalent) survive GC.
- [ ] Tests green; no session 08 incremental logic required.

---

## 8. Agent Notes

- Chosen multi-processor strategy (A/B):
- Migration notes for legacy unscoped nodes:
