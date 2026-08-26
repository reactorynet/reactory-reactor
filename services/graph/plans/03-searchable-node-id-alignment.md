# Session 03 — Align Searchable IDs with Graph Node IDs

| Field | Value |
|-------|--------|
| **ID** | 03 |
| **Priority** | P0 |
| **Estimate** | S |
| **Depends on** | None strictly; better after 01 |
| **Blocks** | 08 (delta search), 13 |
| **Branch** | `feat/system-graph-03-search-ids` |

---

## 1. Objective

Search index documents and graph nodes use **different hash inputs**, so `searchNodes` / GraphQL search often fail to resolve real nodes (falls back to synthetic FILE stubs).

**Make every file searchable’s identity resolvable to the deterministic graph node id for that file path.**

---

## 2. Problem evidence

`BaseProjectProcessor.buildSearchable`:

```ts
const idString = `${projectFqn(project)}_${fileSpec.type}_${relativePath}`;
return { id: Hash(idString), ... }
```

Graph file node:

```ts
id = nodeId(pathLogicalKey(fqn, relativePath))
// pathLogicalKey = `${fqn}::${relativePath}`
```

`SystemGraphManager.searchNodes` (project-scoped):

```ts
const ids = searchResults.results.map((r) => context.utils.hash(r.id));
```

If `r.id` is already a numeric hash, hashing again is wrong. If `r.id` is a string logical key, must match `pathLogicalKey`.

`ReactorSystemGraph.ReactorNodesByNameAndNameSpace` builds synthetic nodes with `id: context.utils.hash(r.id)` and hardcodes `type: DATASTORE`.

---

## 3. Out of scope

- Full GraphQL façade rewrite (06 will clean resolvers further)
- Search engine internals beyond index payload shape
- Symbol-level search documents (optional stretch)

---

## 4. Allowed files

| Path | Action |
|------|--------|
| `BaseProjectProcessor.ts` | `buildSearchable` + optional symbol searchables later |
| `SystemGraphManager.ts` | `searchNodes` resolution |
| `graphql/resolvers/ReactorSystemGraph.ts` | `ReactorNodesByNameAndNameSpace` only (minimal) |
| `services/graph/GraphBuilding.test.ts` or new `SearchIdAlignment.test.ts` | Tests |
| `SystemGraphManager.README.md` | Note id alignment |

---

## 5. Design

### 5.1 Canonical searchable identity

For a **file/document** node:

```ts
const logicalKey = pathLogicalKey(projectFqn(project), relativePath);
const graphNodeId = nodeId(logicalKey);

searchable = {
  id: logicalKey,           // string stable key OR
  // Prefer BOTH:
  id: logicalKey,
  nodeId: graphNodeId,      // numeric, first-class
  name: path.basename(relativePath),
  nameSpace: project.nameSpace,
  version: project.version,
  source: content.slice(0, MAX),
  path: absPath,
  relativePath,
  type: { id: language || fileSpec.type, name: ... },
  metrics: [...]
}
```

**Decision (implement this):**

1. Store `nodeId: number` on every searchable (explicit).
2. Store `id: string = logicalKey` for human/debug uniqueness in the search engine.
3. Resolution: `const id = typeof r.nodeId === 'number' ? r.nodeId : nodeId(String(r.id))`  
   Do **not** double-hash numeric ids.

### 5.2 `searchNodes` algorithm

```ts
const ids = searchResults.results.map((r) => {
  if (typeof (r as any).nodeId === 'number') return (r as any).nodeId;
  if (typeof r.id === 'number') return r.id;
  // r.id is logicalKey string
  return nodeId(String(r.id));
});
const persisted = await this.getNodes(ids);
// prefer persisted over synthetic
```

### 5.3 GraphQL `ReactorNodesByNameAndNameSpace`

Replace body with:

```ts
return {
  nodes: await graphService(context).searchNodes(term || '', { nameSpace, name, limit: pageSize }),
  paging: ...
};
```

Fix offset to 1-based: `offset = Math.max(page - 1, 0) * pageSize` (page default 1). If full paging fix is deferred to 06, at least don’t use DATASTORE stubs.

### 5.4 Symlink searchables

Same pattern: `pathLogicalKey` for symlink relative path → `nodeId`.

### 5.5 Reindex note

Existing indexes are stale shape. Document: **re-run project index after deploy**. No migration script required this session.

---

## 6. Implementation steps

1. Add unit test: `buildSearchable` nodeId === `nodeId(pathLogicalKey(...))`.
2. Change `buildSearchable` (+ symlink branch in process).
3. Fix `searchNodes` resolution.
4. Minimal GraphQL search query fix.
5. README one-liner.

---

## 7. Acceptance criteria

- [ ] File searchable carries `nodeId` equal to graph file node id.
- [ ] `searchNodes` does not double-hash; resolves persisted nodes when present.
- [ ] `ReactorNodesByNameAndNameSpace` does not force `DATASTORE` type.
- [ ] Tests cover id equality for nested paths (`src/a/b.ts`).
- [ ] No change to GraphIdentity formulas.

---

## 8. Agent Notes

- Reindex required: yes/no note for operators:
