# Session 04 — O(1) Catalog Node & Project Lookup

| Field | Value |
|-------|--------|
| **ID** | 04 |
| **Priority** | P0 |
| **Estimate** | S–M |
| **Depends on** | None (parallel with 01) |
| **Blocks** | 05, 12 |
| **Branch** | `feat/system-graph-04-catalog-o1` |

---

## 1. Objective

`getCatalogNode(id)` loads **all** projects (pageSize 1000), maps each to a node, then `.find`.  
`getProjectForCatalogNode` also scans up to 1000 projects.

**Resolve catalog roots and reverse project lookups in O(1) / O(log n) without full catalog materialization.**

---

## 2. Problem evidence

`SystemGraphManager.ts`:

- `getCatalogNodes`: `getProjects({ pageSize: 1000 })` + map `getProjectNode`
- `getCatalogNode`: `const all = await getCatalogNodes(); all.find(...)`
- `getProjectForCatalogNode`: full project list + `nodeId(projectLogicalKey(p)) === node.id`

Hard cap 1000 projects silently drops the rest.

---

## 3. Out of scope

- Changing how project roots look in the UI
- Full GraphQL rewrite
- GC (02) — but if `graphRootId` stored on project, coordinate field name

---

## 4. Allowed files

| Path | Action |
|------|--------|
| `models/ReactorProject.ts` | Optional `graphRootId: Number` indexed field |
| `types/service.types.ts` | Type field |
| `ReactorProjectService.ts` | Persist graphRootId on create/update/catalog; query by graphRootId |
| `SystemGraphManager.ts` | Rewrite getCatalogNode / getProjectForCatalogNode / maybe getCatalogNodes paging |
| Tests under `services/` or `__tests__/` for manager | Add |
| README | Note |

---

## 5. Design

### 5.1 Store graph root id on project

On project create / catalog / process start:

```ts
project.graphRootId = nodeId(projectLogicalKey(project))
```

Index: `{ graphRootId: 1 }` unique sparse.

### 5.2 `getCatalogNode(id)`

```ts
async getCatalogNode(id: number): Promise<ReactorNode> {
  // 1. Try persisted SYSTEM/DATASTORE root
  const persisted = await ReactorNodeModel.findOne({ id }).lean();
  if (persisted && (persisted.parentId == null)) return persisted as ReactorNode;

  // 2. Project by graphRootId
  const project = await this.projectService.getProjectByGraphRootId(id);
  // or getProjects({ filter: { graphRootId: id }, pageSize: 1 })
  if (!project) throw new ApiError(`Node ${id} not found`, 404);
  return this.getProjectNode(project);
}
```

### 5.3 `getProjectForCatalogNode`

```ts
const project = await projectService.getProjectByGraphRootId(node.id)
  || await projectService.getProject(String(node.id)); // fallback
```

**Add** `getProjectByGraphRootId(id: number)` on ReactorProjectService using Mongo findOne.

### 5.4 `getCatalogNodes` pagination

Change signature if types allow:

```ts
getCatalogNodes(paging?: { page: number; pageSize: number })
```

Default pageSize 100 (not 1000). GraphQL `ReactorCatalogNodes` should pass paging args if schema allows; if schema has no paging, keep backward compat but raise pageSize carefully and document debt.

### 5.5 Backfill

On read path: if project missing `graphRootId`, compute and optionally `$set` (lazy backfill). Don’t require migration job.

---

## 6. Implementation steps

1. Add `graphRootId` to project model + service setter on save/catalog.
2. Implement `getProjectByGraphRootId`.
3. Rewrite manager methods.
4. Unit tests with mocked projectService (no full list expectation).
5. Ensure `getNode` still works (uses getCatalogNode for roots).

---

## 7. Acceptance criteria

- [ ] `getCatalogNode` does not call getProjects without a filter that limits to one project.
- [ ] `getProjectForCatalogNode` uses graphRootId index path.
- [ ] Lazy backfill sets graphRootId when missing.
- [ ] Existing root id formula unchanged (`projectLogicalKey` → `nodeId`).
- [ ] Tests prove single-project fetch mock is used.

---

## 8. Agent Notes
