# Session 05 — SystemGraphManager Cleanup & `getProject`

| Field | Value |
|-------|--------|
| **ID** | 05 |
| **Priority** | P1 |
| **Estimate** | S |
| **Depends on** | 04 preferred |
| **Branch** | `feat/system-graph-05-manager-cleanup` |

---

## 1. Objective

1. Implement `getProject` (currently `throw new Error("Method not implemented.")`).
2. Remove dead code: unused `kvp` map, large commented block in `getProject`.
3. Fix `getSubgraph` O(n²) `hasPersistedChild` scan.
4. Stamp manual links with `runId: 'manual'` if session 02 landed; else TODO comment.

---

## 2. Allowed files

- `services/SystemGraphManager.ts` (primary)
- `types/service.types.ts` (if interface signatures need tweaks)
- Unit test: prefer existing traversal test  
  `__tests__/unit/SystemGraphManagerTraversal.unit.test.ts` or create  
  `services/graph/SystemGraphManager.unit.test.ts`
- README minor

---

## 3. Implementation details

### 3.1 `getProject(pathSpec: string)`

Delegate:

```ts
async getProject(pathSpec: string): Promise<IReactorProject> {
  if (!pathSpec) throw new ApiError('A path or id is required', 400);
  const project = await this.projectService.getProject(pathSpec);
  if (!project) throw new ApiError(`Project ${pathSpec} not found`, 404);
  return project as IReactorProject;
}
```

Confirm `ReactorProjectService.getProject` accepts id/FQN/path (resolver already uses it).

### 3.2 Delete

- `const kvp = { tsql: ...}` entire object
- Commented historical TSql pathSpec block inside getProject

### 3.3 Subgraph child index

Inside `getSubgraph` loop, maintain:

```ts
const childCountByParent = new Map<number, number>();
// when adding node with parentId:
if (node.parentId != null) {
  childCountByParent.set(node.parentId, (childCountByParent.get(node.parentId) || 0) + 1);
}
// materialize check:
const hasPersistedChild = (childCountByParent.get(parent.id) || 0) > 0;
```

Also count children discovered via parentId query in the containment section.

### 3.4 createLink manual stamp (if 02 done)

```ts
$setOnInsert: { id, created: now, runId: 'manual' }
```

---

## 4. Acceptance criteria

- [x] `getProject` never throws “not implemented”
- [x] No unused `kvp`
- [x] Subgraph materialize path does not scan all nodes with `.some`
- [x] Existing manager/traversal tests green
- [x] No GraphQL schema changes

---

## 5. Agent Notes

- **`SystemGraphManager.getProject` implemented:** Delegated to `projectService.getProject(pathSpec)` with proper 400 error validation when `pathSpec` is missing and 404 ApiError when the project is not found.
- **Dead code removed:** Deleted unused `kvp` map and old commented TSql code block in `getProject`.
- **`getSubgraph` child index O(1) optimization:** Replaced `nodesById.values().some(...)` with a `childCountByParent` Map tracked during BFS traversal, containment queries, lazy materialization, and node resolution.
- **Manual link runId stamping:** Updated `createLink` to set `runId: 'manual'` in `$setOnInsert` for GC exclusion.
- **Tests:** Extended `__tests__/unit/SystemGraphManagerTraversal.unit.test.ts` to cover `getProject`, `createLink` stamping `runId: 'manual'`, and `getSubgraph` lazy materialization with O(1) child index. All 20 tests pass.
