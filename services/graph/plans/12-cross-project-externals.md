# Session 12 — Cross-Project External Dependency Linking

| Field | Value |
|-------|--------|
| **ID** | 12 |
| **Priority** | P3 |
| **Estimate** | M |
| **Depends on** | **02**, **04** |
| **Branch** | `feat/system-graph-12-cross-project` |

---

## 1. Objective

External nodes like `npm:lodash` are project-local dead ends.  

When another catalogued project **publishes** that package name (matching `package.json` name, Maven coordinates, etc.), create a **REFERENCE or DEPENDENCY** edge from the external node (or directly from importer) to the **target project root node**.

---

## 2. Out of scope

- Downloading packages from npm registry
- Version range SAT solving (record version string only)
- Replacing intra-repo path resolution

---

## 3. Allowed files

- `SystemGraphManager.ts` — `linkExternalProjects(projectId?)` or post-process hook
- `ReactorProjectService.ts` — index of published package names
- `BaseProjectProcessor.ts` — optional hook after process
- Types/models as needed for `data.packageName`
- Tests with two fake projects
- README

---

## 4. Design

### 4.1 Publisher index

Build map once per link pass:

```
packageName → project graphRootId
```

Sources:

- Node: `project` has repoPath → read package.json `name`
- Or store `project.publishedPackages: string[]` at catalog time (preferred durable)

### 4.2 External node identity today

Check analyzer: likely `npm:${pkg}` logical key → nodeId. Confirm in TypeScriptAnalyzer external emission.

### 4.3 Edge

```ts
linkId(externalNode.id, targetRoot.id, ReactorLinkType.REFERENCE)
// types: [REFERENCE] or DEPENDENCY
// runId: 'manual' or current run — use runId from process meta if in-process
title: pkgName
```

Only when target project ≠ source project.

### 4.4 When to run

- End of `catalogProject` after all processors
- Or scheduled maintenance mutation `ReactorLinkCrossProjectDeps`

### 4.5 Confidence

Exact string match on package name only. No fuzzy.

---

## 5. Tests

- Project A depends on `foo-lib`; Project B name `foo-lib` → edge exists.
- No self-link if same project.
- Missing publisher → no edge (I4).

---

## 6. Acceptance criteria

- [x] Cross-project edge created for exact published name match
- [x] Idempotent via linkId
- [x] Does not require network
- [x] GC: edges either re-created each run or runId manual — document choice

---

## 7. Agent Notes

- **Implementation**:
  - `ReactorProjectSchema` / `IReactorProject`: Added `publishedPackages: [String]` property to persist project package aliases.
  - `ReactorProjectService`: Added `getPublishedPackagesIndex()` mapping published package names (from `name`, `publishedPackages`, and repository `package.json`) to project metadata (`projectId`, `graphRootId`, `name`, `fqn`).
  - `SystemGraphManager.linkExternalProjects(projectId?)`:
    - Queries external dependency nodes (`type: DEPENDENCY, data.kind: "external"`), matches package names against the publisher map.
    - Emits deterministic `REFERENCE` + `DEPENDENCY` edges from external nodes to target publisher project root nodes (`graphRootId`).
    - Stamped with `runId: 'manual'` in `$setOnInsert` so project-scoped GC preserves cross-project edges across rebuilds.
    - Prevents self-links to the same project and creates no dangling edges when a publisher is missing (preserving Invariant I4).
    - Integrated automatically into `SystemGraphManager.catalogProject` and exposed via `ReactorLinkCrossProjectDeps` GraphQL mutation.
- **Tests**:
  - Added test suite in `services/graph/CrossProjectExternals.test.ts` covering matched package linking, multiple package aliases, self-link prevention, missing publisher handling, idempotency, and publisher index discovery.
  - Added GraphQL mutation tests in `services/graph/GraphQLFacade.test.ts`.
  - All 16 graph test suites (186 tests) and 9 processor suites (37 tests) passing.
