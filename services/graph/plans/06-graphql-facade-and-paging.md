# Session 06 — GraphQL Façade Consistency & Paging Fixes

| Field | Value |
|-------|--------|
| **ID** | 06 |
| **Priority** | P1 |
| **Estimate** | M |
| **Depends on** | 03 (search), 05 (manager) |
| **Branch** | `feat/system-graph-06-graphql-facade` |

---

## 1. Objective

Make GraphQL **graph** operations thin wrappers over `SystemGraphManager`. Fix paging bugs. Stop ad-hoc `ReactorNodeModel.find` for core list/search queries.

---

## 2. Problem evidence (`ReactorSystemGraph.ts`)

| Issue | Location |
|-------|----------|
| Synthetic DATASTORE nodes | `ReactorNodesByNameAndNameSpace` (may be fixed in 03 — verify) |
| Paging offset off-by-one | `(page === 0 ? 1 : page) * pageSize` |
| Direct model find | `ReactorNodesForType`, `ReactorNodesByTerm`, `ReactorNodeLinks` |
| Category filter on catalog only | `ReactorNodeByCategory` |
| `ReactorUpdateNode` bypasses manager | end of file |
| Typo typename | `ReactorSysteGraphSaveFailure` (missing m) — fix if schema allows dual |

---

## 3. Allowed files

- `graphql/resolvers/ReactorSystemGraph.ts`
- `SystemGraphManager.ts` — **only** if you must add thin helpers:
  - `findNodesByType(types, limit)`
  - `findNodesByTerm(term, limit)` already partially as `searchNodes`
  - `findLinks(query)` wrapping model
- GraphQL schema files under module `graphql/` **additive only** (optional paging args)
- Tests if any resolver tests exist; otherwise manager-level tests enough

---

## 4. Design rules

1. Resolvers call `graphService(context)` for graph data.
2. Standard paging helper:

```ts
function normalizePaging(paging?: PagingRequest): { page: number; pageSize: number; skip: number } {
  const page = Math.max(paging?.page || 1, 1);
  const pageSize = Math.min(Math.max(paging?.pageSize || 25, 1), 500);
  return { page, pageSize, skip: (page - 1) * pageSize };
}
```

3. `ReactorNodesForType` → manager method using `ReactorNodeModel.find({ type: { $in } }).limit` **inside manager**, not resolver.
4. `ReactorNodesByTerm` → `searchNodes(term)` without requiring nameSpace when global; keep limit 100 default (not 1000 unbounded).
5. `ReactorNodeLinks` → `getNodeLinks` or dedicated paged manager API.
6. `ReactorUpdateNode` → manager `updateNode(id, patch)` new small method (persist + cache bust `REACTOR_NODE_${id}`).
7. Do **not** break client field names. Additive GraphQL only.

---

## 5. Implementation steps

1. Add `normalizePaging` module-level helper next to existing `graphService` helper.
2. Fix all resolver paging call sites.
3. Move direct model queries into manager methods.
4. Wire resolvers.
5. Fix save failure typename only if schema enum/union includes both or update schema carefully.
6. Smoke-read schema definitions for ReactorNode queries.

---

## 6. Acceptance criteria

- [ ] No `ReactorNodeModel` / `ReactorNodeLinkModel` imports needed in resolver **or** only used inside clearly temporary code removed
- [ ] Page 1 skip = 0; page 2 skip = pageSize
- [ ] Type/term queries capped (≤ 200–500)
- [ ] Update node goes through manager and clears cache key
- [ ] Existing clients still receive same primary field shapes

---

## 7. Agent Notes
