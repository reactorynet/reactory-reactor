# Session 08 — Incremental Re-Index by Content Hash

| Field | Value |
|-------|--------|
| **ID** | 08 |
| **Priority** | P1 |
| **Estimate** | L (1–2 days) |
| **Depends on** | **01**, **02**, **03** |
| **Blocks** | 09 |
| **Branch** | `feat/system-graph-08-incremental` |

---

## 1. Objective

Full `process()` re-reads and re-parses every file every run.  

**Skip analysis + searchable rebuild for files whose content hash (and optionally mtime/size) is unchanged since the last indexed node. Still include unchanged file node ids in the current `runId` stamp so GC keeps them.**

---

## 2. Out of scope

- Async job orchestration (09) — but design options compatible with jobs
- Watchman/FSEvents live watchers
- Partial pathSpec-only mode beyond existing pathSpecs (can enhance lightly)

---

## 3. Allowed files

- `BaseProjectProcessor.ts` (core)
- `types/model.types.ts` if contentHash/mtime fields need typing
- `GraphBuilding.test.ts` + new `IncrementalProcess.test.ts`
- Analyzers: **do not change** unless hash helper needs export
- README §9 → move incremental from future to done

---

## 4. Design

### 4.1 Hash function

```ts
import { createHash } from 'crypto';
function fileContentHash(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}
```

Store on node: `contentHash`, optionally `data.mtimeMs`, `data.size`.

### 4.2 Load previous file node map

At start of process (after root):

```ts
const previous = await ReactorNodeModel.find({
  projectId: String(project.id),
  type: { $in: [FILE, DOCUMENT] }, // and FOLDER? folders have no content — always stamp
}).select({ id: 1, contentHash: 1, parentId: 1, data: 1, type: 1 }).lean();

const prevById = new Map(previous.map(n => [n.id, n]));
```

If Mongo unavailable in unit tests, inject `loadPreviousNodes` hook.

### 4.3 Per-file flow

```
read file bytes once (or stat first)
hash = sha256(bytes)
fileNode = build file node with contentHash
prev = prevById.get(fileNode.id)

if (prev?.contentHash === hash && !options.forceFull) {
  // FAST PATH
  // Re-stamp existing graph: need symbols+edges from previous run kept
  // Strategy:
  //   A) Don't delete them: mark file + all descendants + edges from file as "seen"
  //   B) Re-load child symbol ids from DB and add to seen set without re-parse
  seenNodeIds.add(fileNode.id)
  const childIds = await loadDescendantIds(fileNode.id) // symbols, sections
  childIds.forEach(id => seenNodeIds.add(id))
  const edgeIds = await loadEdgeIdsTouching(fileNode.id, childIds)
  edgeIds.forEach(...)
  // Still upsert file node with new runId/indexedAt/contentHash (metadata refresh)
  nodes.push(fileNode) // lightweight, no analyseFileFull
  // Searchable: skip re-index OR push stub — prefer skip and track skippedSearchableIds
  continue
}

// SLOW PATH: analyseFileFull as today
```

### 4.4 GC interaction (critical)

Session 02 GC deletes nodes where `runId !== current`.  

Unchanged symbols **must** be re-stamped with current runId **or** GC must use a seen-set:

**Preferred for incremental:**

Replace blind `deleteMany runId $ne` with:

```ts
// After process:
// 1. Upsert all nodes/edges in `nodes`/`edges` with current runId
// 2. For skipped files, bulk updateMany { id: { $in: seenIds } }, { $set: { runId, indexedAt } }
// 3. Then deleteMany { projectId, runId: { $ne: current } } excluding manual
```

Implement `touchNodes(ids, meta)` and `touchEdges(ids, meta)` bulk updates.

### 4.5 Folders

Folder nodes have no contentHash — always recreate via ensureFolderChain (cheap) and stamp runId.

### 4.6 forceFull option

```ts
process(project, { forceFull?: boolean, runId?, skipGc? })
```

### 4.7 Metrics log

```ts
context.info(`process ${name}: analysed=${n} skipped=${s} folders=${f} edges=${e}`)
```

### 4.8 Search index

- Unchanged files: do not re-send full content to search (expensive).
- Deleted files: GC removes nodes; search index may still hold orphans → call search delete by nodeId if API exists; else document “periodic full reindex”.
- If search service supports deleteById, use it for GC’d file ids.

---

## 5. Implementation steps

1. Add hash helper + fields on file nodes in process.
2. Implement previous snapshot load (mockable).
3. Implement skip path + touchNodes/touchEdges.
4. Adjust GC to run after touches.
5. Tests:
   - First process analyses N files.
   - Second process same disk → analyseFileFull called 0 times (spy).
   - Modify one file → exactly 1 analyse.
   - Delete one file → after GC, node gone (mock deleteMany).
6. README.

---

## 6. Acceptance criteria

- [ ] Unchanged file does not call `analyseFileFull`
- [ ] Unchanged symbols survive GC (touched runId)
- [ ] Changed file re-analyses and replaces symbol set (old symbols GC’d)
- [ ] forceFull re-analyses all
- [ ] Log includes skip counts
- [ ] GraphBuilding still green; new incremental tests green

---

## 7. Risks

| Risk | Mitigation |
|------|------------|
| touchNodes misses edge ids | Query edges where source in seen set |
| Multi-processor | Shared runId from 02; each processor touches its claimed files only; final GC once |
| Hash collision | SHA-256 fine |
| Memory reading large files twice | Read once for hash+searchable+parse |

---

## 8. Agent Notes
