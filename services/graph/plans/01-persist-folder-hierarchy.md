# Session 01 — Persist Folder Hierarchy in Batch `process()`

| Field | Value |
|-------|--------|
| **ID** | 01 |
| **Priority** | P0 |
| **Estimate** | M (half day–1 day) |
| **Depends on** | None (start here) |
| **Blocks** | 02, 08, 13 (and improves 07 subgraph quality) |
| **Branch** | `feat/system-graph-01-hierarchy` |

---

## 1. Objective

Today `BaseProjectProcessor.fileNodeForProcess()` and `symlinkNodeForProcess()` set **`parentId: root.id`** for every file/symlink. The interactive tree (`makeTreeNode`) correctly chains folder parents. Batch and interactive graphs therefore disagree on topology.

**Make batch `process()` persist intermediate FOLDER nodes and parent each file/document/symlink under its immediate folder (or root if top-level), matching `makeTreeNode` identity rules.**

---

## 2. Problem evidence (read before coding)

File: `services/ReactorProjectProcessors/BaseProjectProcessor.ts`

- `makeTreeNode` (~line 460+): `parentId: parent.id`, `key: appendAncestry(parent.key, id)`, folder type `FOLDER`.
- `fileNodeForProcess` (~825+): **`parentId: root.id`**, ancestry only `root|file` — **bug**.
- `symlinkNodeForProcess` (~870+): same flat parenting.
- `process()` (~1030+): pushes file nodes only; never creates folder nodes for path segments.

Invariant **I9** from `00-README.md`: batch and interactive must agree on id/type/kind — and after this session, **parentId + key ancestry depth**.

---

## 3. Out of scope

- GC / runId / contentHash (session 02)
- Search id alignment (session 03)
- Changing analyzer symbol `parentId` (symbols already parent to file)
- GraphQL or SystemGraphManager changes
- Persisting CONTAINS edges (keep synthesizing from parentId)

---

## 4. Allowed files (edit only these)

| Path | Action |
|------|--------|
| `services/ReactorProjectProcessors/BaseProjectProcessor.ts` | **Primary implementation** |
| `services/graph/GraphBuilding.test.ts` | **Add/extend tests** |
| `services/graph/testUtils.ts` | Only if shared helpers needed |
| `services/ReactorProjectProcessors/**/**.test.ts` | Fix if hierarchy assertions break |
| `services/SystemGraphManager.README.md` | One bullet under §5 or §9 |

Do **not** edit models, GraphQL, or analyzers in this session.

---

## 5. Design

### 5.1 Folder node identity

For relative path `src/services/foo.ts`:

| Segment path | logicalKey | type |
|--------------|------------|------|
| `src` | `{fqn}::src` | FOLDER |
| `src/services` | `{fqn}::src/services` | FOLDER |
| `src/services/foo.ts` | `{fqn}::src/services/foo.ts` | FILE/DOCUMENT |

Use existing:

```ts
nodeId(pathLogicalKey(fqn, relativePath))
normalizeRelative(...)
appendAncestry(parentKey, id)
```

### 5.2 Algorithm (inside `process()`, before/while adding files)

```
folderByRelPath: Map<string, ReactorNode> = empty
ensureFolderChain(relativeFilePath):
  parts = relativeFilePath split by '/' excluding filename
  parent = root
  acc = []
  for each part in parts:
    acc.push(part)
    rel = acc.join('/')
    if folderByRelPath has rel: parent = that; continue
    folder = makeFolderNode(parent, part, absPathJoin(repo, rel), rel)
    folderByRelPath.set(rel, folder)
    nodes.push(folder)   // de-dupe by id if multi-processor later
    parent = folder
  return parent

for each fileSpec:
  parentFolder = ensureFolderChain(relativePath of file)
  fileNode = fileNodeForProcess(parentFolder /* not root */, project, absPath)
  ...
```

### 5.3 Refactor `fileNodeForProcess`

Change signature conceptually to:

```ts
private fileNodeForProcess(
  parent: Partial<ReactorNode>,  // immediate parent (folder or root)
  project: Partial<IReactorProject>,
  absPath: string
): ReactorNode
```

- `parentId: parent.id` (NOT always root)
- `key: appendAncestry(parent.key, id)`
- Keep id from full file `relativePath` (unchanged) — **file ids must not change**
- `providerId: this.fqn()` as today
- data.kind / type / language unchanged

Same for `symlinkNodeForProcess`.

### 5.4 `makeFolderNode` helper

Implement private method mirroring `makeTreeNode` folder branch:

- `type: ReactorNodeType.FOLDER`
- `data.kind: 'folder'`
- `data.path`, `relativePath`, `repoPath`, `projectFqn`, `projectId`
- `name: basename(relativePath)`
- `description: \`Folder ${relativePath}\``
- Detect submodule (`.git` in folder) → kind `submodule` if you want parity with tree walk; optional but nice.

### 5.5 Ancestry key depth

Interactive: `rootId|folderId|…|fileId`  
Batch after fix: **same id sequence** for the same paths.

Optional assertion helper in tests: parse keys with `parseAncestry` from GraphIdentity.

### 5.6 Deduplication

If the same folder is ensured twice, same deterministic id → push once (use Map). `persistGraph` upserts by id anyway, but avoid huge duplicate arrays in memory.

### 5.7 Documents & symbols

- Document files: same folder chain; type DOCUMENT as today.
- Symbols from analysis: keep `parentId = fileNode.id` (analyzers already do this). Do not reparent symbols to folders.

### 5.8 Top-level files

`README.md` at repo root → parent = root (ensureFolderChain returns root when parts empty).

---

## 6. Implementation steps (ordered)

1. **Read** `BaseProjectProcessor.ts` sections: `makeTreeNode`, `fileNodeForProcess`, `symlinkNodeForProcess`, `process`.
2. **Write failing test** in `GraphBuilding.test.ts`:
   - Temp project: `src/a/b/hello.ts` (+ package.json if Node processor).
   - Run `process()` (via NodeJS or File processor with testUtils `makeContext` / `writeProject`).
   - Collect nodes from mocked persist **or** spy `persistGraph` / inspect returned structure.
   - **Preferred approach:** spy/mock `ReactorNodeModel.bulkWrite` and `ReactorNodeLinkModel.bulkWrite` OR refactor test to call a package-visible helper.
   - Practical approach already used in GraphBuilding: call processor.process and assert via any returned data; if process doesn’t return nodes, **unit-test new protected/public test seam**:
     - Add `/** @internal test */` method `buildProcessNodes(project)` that returns `{ nodes, edges }` without Mongo, **or**
     - Spy `persistGraph` on the instance: `jest.spyOn(processor as any, 'persistGraph').mockImplementation(async (nodes, edges) => { captured = {nodes, edges}; })`.
3. Assertions:
   - Exists folder node id = `nodeId(pathLogicalKey(fqn,'src'))`
   - Exists folder `src/a`, `src/a/b`
   - File `src/a/b/hello.ts` has `parentId === folder(src/a/b).id`
   - File id equals `nodeId(pathLogicalKey(fqn,'src/a/b/hello.ts'))` (unchanged formula)
   - Folder `src` has `parentId === root.id`
4. Implement `makeFolderNode` + `ensureFolderChain` + signature change.
5. Wire into `process()` for files and symlinks.
6. Re-run tests; fix processor tests that assumed flat parentId.
7. README: note “batch process now persists folder nodes and correct parentId chains”.

---

## 7. Test plan

```bash
cd reactory-express-server
NODE_OPTIONS=--max-old-space-size=6144 npx jest \
  src/modules/reactory-reactor/services/graph/GraphBuilding.test.ts \
  --forceExit

# Also run a processor test if present:
NODE_OPTIONS=--max-old-space-size=6144 npx jest \
  src/modules/reactory-reactor/services/ReactorProjectProcessors \
  --forceExit
```

If `./bin/jest.sh` exists, prefer it with the same paths.

### Minimum new cases

| Case | Expect |
|------|--------|
| Nested file 3 levels deep | 3 folders + file parent chain |
| Root-level file | parentId = root |
| Two files same folder | one folder node id, two files |
| Document under `docs/guide.md` | DOCUMENT parented to `docs` folder |
| Symlink under `links/x` (if easy) | symlink parented to `links` |

---

## 8. Acceptance criteria

- [x] No file/document/symlink from `process()` has `parentId === root.id` unless it lives at repo root.
- [x] Every intermediate path segment has a persisted FOLDER node with deterministic id.
- [x] File node **ids** unchanged vs pre-change formula (only parentId/key change).
- [x] `makeTreeNode` and `fileNodeForProcess` produce the same id for the same relative path.
- [x] GraphBuilding + processor tests green.
- [x] No new CONTAINS rows required in DB.
- [x] Session scope not expanded.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Node array memory for deep trees | Map dedupe; folders << files usually |
| Multi-processor double folder writes | Deterministic id upsert OK |
| Tests coupled to Mongo | Spy `persistGraph` |
| Ancestry key too long | Same as interactive; already pipe-delimited ids |

---

## 10. Agent Notes

_(Agent fills on completion)_

- Branch: feat/system-graph-01-hierarchy
- PR: (local branch only)
- Tests run: GraphBuilding.test.ts (9/9 green incl. 2 new hierarchy cases); all ReactorProjectProcessors suites (37/37 green)
- Deviations: none — stayed inside allowed files; used CapturingProcessor spy pattern already present in the suite; adjusted the second acceptance assertion to use relativePath presence rather than name heuristic (more robust).
- Follow-ups for other sessions: none required for 02/08/13; folder nodes now present so GC and subgraph work will see proper parent chains.
- Acceptance criteria all checked above.
- Diff summary: small targeted patch in BaseProjectProcessor (makeFolderNode + ensureFolderChain + parent refactor) + TDD tests + one-line README note. All invariants (I1–I9) preserved; no CONTAINS edges emitted; file ids unchanged.
