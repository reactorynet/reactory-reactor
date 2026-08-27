# Session 15 — Hardening: Orchestration, GC Safety, Incremental Depth, GraphQL Façade

| Field | Value |
|-------|--------|
| **ID** | 15 |
| **Priority** | **P0 (post-program hardening)** |
| **Estimate** | L (1–2 days) |
| **Depends on** | Sessions **01–14** already on `master` |
| **Blocks** | Production confidence / program DoD closure |
| **Branch** | `feat/system-graph-15-hardening` |
| **Status** | **done** (2026-08-27) |
| **Review source** | Code review 2026-08-27 — residual risks after agents landed 01–14 |

---

## 1. Objective

Sessions 01–14 delivered the roadmap features, but a production review found **split catalog orchestration**, **GC-after-failed-persist**, **shallow incremental descendant touch**, incomplete **GraphQL façade**, and related leaks. This session **does not add features**. It makes the existing graph pipeline **safe and consistent**.

**Success = no silent multi-processor graph wipe, no GC without successful persist, deep incremental touch, single façade for graph reads, normalized projectId, and tests that lock these invariants.**

---

## 2. Problem evidence (read before coding)

### 2.1 Split orchestration (CRITICAL)

**Good path** — `SystemGraphManager.catalogProject` (~690–755):

```ts
const sharedRunId = randomUUID();
for (let i = 0; i < n; i++) {
  await procService.process(projectSpec, {
    runId: sharedRunId,
    skipGc: !isLast, // only last processor runs GC
  });
}
```

**Bad path** — `ReactorProjectService.processProject` (~898–934):

```ts
const nextProject = await processor.process(project); // NO runId, NO skipGc
```

Callers of `processProject` / service `index` / `sync` that bypass the manager will:

1. Generate a **fresh runId per processor** inside `BaseProjectProcessor.process`
2. Run **GC after each processor** (default `skipGc` falsy)
3. **Delete the previous processor’s nodes/edges** for the same `projectId`

Hybrid projects (NodeJS + Markdown) are the primary victims.

### 2.2 GC after failed persist (CRITICAL)

`BaseProjectProcessor.process` (~end of pipeline):

```ts
await this.persistGraph(nodes, edges, meta); // logs errors, does not throw / return ok
// ...
await this.touchNodes(...)
await this.touchEdges(...)
if (!options?.skipGc && meta.projectId) {
  await ReactorNodeModel.deleteMany({ projectId: pid, runId: { $nin: [runId, 'manual'] } });
  // same for edges
}
```

If `bulkWrite` fails or is skipped, GC can still delete the previous good graph.

### 2.3 Shallow descendant touch (HIGH)

`loadDescendantNodeIds` only loads:

1. direct children of the file, then  
2. children of those children  

Document **SECTION** trees and deeper symbol nesting beyond depth 2 are **not** re-stamped → incremental skip + GC **deletes** them.

### 2.4 GraphQL façade incomplete (MEDIUM)

`ReactorSystemGraph.ts` still imports and uses:

- `ReactorNodeModel`
- `ReactorNodeLinkModel`

(around finds ~728+). Session 06 acceptance claimed no model access; residual remains.

### 2.5 projectId inconsistency (HIGH)

GC / loadPrevious / touch all key on `String(project.id)`. Projects often have `_id` (ObjectId) and optional `id`. Mismatched string forms → empty previous map, skipped GC, or wrong GC scope.

### 2.6 Secondary issues (this session should fix if cheap)

| Issue | Where |
|-------|--------|
| Cache bust only clears ids in `nodes[]`, not `seenNodeIds` | end of `process` |
| Doc mentions only use in-memory `allSymbols` from this processor | second pass in `process` |
| Searchable still stores absolute `path` | `buildSearchable` |
| `ensureFolderChain` uses `nodes.some` O(n) | minor |
| Cross-project link scans pageSize 5000 | out of scope unless trivial |
| Empty Session 01 git commit | docs/notes only |

---

## 3. Out of scope

- New analyzers, new edge types, rst/adoc parsers
- Rewriting BaseProjectProcessor into multiple files (note only)
- Changing GraphIdentity hash formulas
- Full multi-tenant RBAC productization
- Fixing historical empty git commits (mention in Agent Notes; do not rewrite shared master history unless human asks)
- Cross-project publisher index optimization (optional stretch only)

---

## 4. Allowed files

| Path | Action |
|------|--------|
| `services/ReactorProjectService.ts` | **Primary:** fix `processProject` orchestration |
| `services/SystemGraphManager.ts` | Extract/share orchestration helper if needed; thin wrappers |
| `services/ReactorProjectProcessors/BaseProjectProcessor.ts` | persist result, deep BFS touch, projectId normalize, cache bust, searchable path |
| `graphql/resolvers/ReactorSystemGraph.ts` | Remove remaining model usage → manager |
| `types/service.types.ts` | `process` options / `ProcessGraphOptions` if missing |
| `types/model.types.ts` | Only if needed for process result types |
| `services/graph/GraphBuilding.test.ts` | Multi-processor / GC orchestration tests |
| `services/graph/IncrementalProcess.test.ts` | Deep descendant + persist-fail GC tests |
| New: `services/graph/ProcessOrchestration.test.ts` | Optional dedicated suite |
| New: `services/graph/GraphQlFacade.arch.test.ts` or add to existing | Resolver must not import models |
| `services/graph/documents/*` | **Only if** doc-mention DB fallback requires a tiny hook |
| `SystemGraphManager.README.md` | Hardening notes |
| `services/graph/plans/00-README.md` | Status board + DoD |
| `services/graph/plans/15-…` (this file) | Agent Notes on completion |

Do **not** edit unrelated modules, package majors, or tree-sitter loading.

---

## 5. Design

### 5.1 Single orchestration helper (canonical)

Introduce **one** function used by both manager and project service.

**Preferred location:** `SystemGraphManager` method, called from service:

```ts
// Conceptual API
async runProcessorsForProject(
  project: Partial<IReactorProject>,
  opts?: {
    forceFull?: boolean;
    runId?: string;
    linkDocMentions?: boolean;
    processorFqns?: string[]; // optional override
  }
): Promise<{ project: Partial<IReactorProject>; runId: string; results: any[] }>
```

**Algorithm (must match current good manager behavior):**

```
1. Normalize projectId on project (see 5.2)
2. Resolve processor FQN list (explicit providerId | project.processors | detect | File fallback)
3. sharedRunId = opts.runId || randomUUID()
4. for i, fqn in processors:
     isLast = i === last
     await processor.process(project, {
       runId: sharedRunId,
       skipGc: !isLast,
       forceFull: opts.forceFull,
       linkDocMentions: opts.linkDocMentions,
     })
     merge returned project fields
5. optional: linkExternalProjects(projectId) once at end (keep manager behavior)
6. return { project, runId: sharedRunId, results }
```

**`ReactorProjectService.processProject`:**

```ts
async processProject(project, opts?) {
  // validate repoPath...
  // ensure processors detected...
  const graph = this.context.getService<ISystemGraphManager>('reactor.SystemGraphManager@1.0.0');
  if (graph?.runProcessorsForProject) {
    const { project: next } = await graph.runProcessorsForProject(project, opts);
    return next;
  }
  // FALLBACK only if circular DI: inline same algorithm (duplicate carefully)
}
```

**Avoid circular DI:** If ProjectService is already injected into GraphManager, do **not** inject GraphManager into ProjectService.

**Alternative (also acceptable):** put pure helper in  
`services/graph/runProcessorsForProject.ts`  
with signature `(ctx, project, resolveProcessor, opts)` and call from **both** manager and service. **Prefer this if DI is circular.**

```ts
// services/graph/runProcessorsForProject.ts
export async function runProcessorsForProject(
  args: {
    project: Partial<IReactorProject>;
    getProcessor: (fqn: string) => IProjectProcessor | null;
    detectFqns: () => Promise<string[]>;
    opts?: ProcessGraphOptions;
    onAfterAll?: (projectId: string) => Promise<void>; // linkExternalProjects
    log: { error: Function; warn: Function; info: Function };
  }
): Promise<...>
```

Manager `catalogProject` becomes a thin wrapper around this helper.  
Service `processProject` becomes a thin wrapper around this helper.  
**No behavioral fork.**

### 5.2 Normalize `projectId` (canonical string)

Add helper (in GraphIdentity or BaseProjectProcessor):

```ts
export function canonicalProjectId(project: Partial<IReactorProject>): string | undefined {
  const raw =
    (project as any).id ??
    (project as any)._id ??
    null;
  if (raw == null || raw === '') return undefined;
  return String(raw);
}
```

At start of `process()`:

```ts
const projectId = canonicalProjectId(next);
if (projectId) {
  next.id = projectId as any; // keep stable for rest of run
}
// meta.projectId = projectId
// ALL queries: projectId: projectId (never mix ObjectId object vs string inconsistently)
```

**GC rule:** If `!projectId`, log error/warn and **never** `deleteMany`. Persistence may still upsert without project scope only if unavoidable — prefer requiring id for full catalog runs.

Orchestration should ensure Mongo project documents always pass id before process.

### 5.3 `persistGraph` must report success

Change return type:

```ts
protected async persistGraph(...): Promise<{ ok: boolean; nodeOps: number; edgeOps: number; error?: string }>
```

- If Mongo unavailable (tests): return `{ ok: true, nodeOps: 0, edgeOps: 0 }` **or** `{ ok: true }` with note that GC is also skipped when Mongo unavailable (already gated).
- If `bulkWrite` throws: catch, log, return `{ ok: false, error }`.
- Do **not** throw unless you also update all callers — returning `ok` is enough.

In `process()`:

```ts
const persistResult = await this.persistGraph(nodes, edges, meta);
await this.indexSearchables(...); // search failure should NOT trigger GC either; track separately

if (seenNodeIds.size) await this.touchNodes(...)
if (seenEdgeIds.size) await this.touchEdges(...)

const canGc =
  !options?.skipGc &&
  !!meta.projectId &&
  persistResult.ok &&
  isMongoAvailable(ReactorNodeModel.deleteMany);

if (canGc) { deleteMany... }
else if (!options?.skipGc && meta.projectId && !persistResult.ok) {
  this.context.error(`GC skipped because persistGraph failed: ${persistResult.error}`);
}
```

**Also:** if persist failed, do not claim success metrics as clean — set `errors++`.

### 5.4 Deep descendant load (BFS)

Replace depth-2 logic:

```ts
protected async loadDescendantNodeIds(rootParentId: number, projectId: string): Promise<number[]> {
  const all: number[] = [];
  let frontier = [rootParentId];
  const visited = new Set<number>([rootParentId]);
  const MAX_NODES = 50_000; // safety cap
  const MAX_DEPTH = 64;

  for (let depth = 0; depth < MAX_DEPTH && frontier.length && all.length < MAX_NODES; depth++) {
    const children = await ReactorNodeModel.find({
      parentId: { $in: frontier },
      projectId: String(projectId),
    }).select({ id: 1 }).lean();

    const next: number[] = [];
    for (const c of children) {
      if (visited.has(c.id)) continue;
      visited.add(c.id);
      all.push(c.id);
      next.push(c.id);
    }
    frontier = next;
  }
  return all;
}
```

Add unit test with mocked `find` returning 3+ levels.

### 5.5 Cache bust includes seen ids

```ts
const bustIds = new Set<number>();
nodes.forEach(n => n?.id != null && bustIds.add(n.id));
seenNodeIds.forEach(id => bustIds.add(id));
for (const id of bustIds) { clear REACTOR_NODE_${id} }
```

### 5.6 GraphQL façade completion

1. Grep resolver for `ReactorNodeModel` / `ReactorNodeLinkModel`.
2. Replace each with manager methods (`findNodesByType`, `searchNodes`, `getNodes`, `updateNode`, `findLinks` / `getNodeLinks`).
3. Remove model imports from resolver.
4. Add architecture test:

```ts
// GraphQlFacade.arch.test.ts
const src = fs.readFileSync('.../ReactorSystemGraph.ts','utf8');
expect(src).not.toMatch(/ReactorNodeModel/);
expect(src).not.toMatch(/ReactorNodeLinkModel/);
```

### 5.7 Searchable path redaction (cheap)

In `buildSearchable`:

```ts
path: relativePath, // NOT absolute fileSpec.path
// keep absolute out of search index payloads
```

Or set `path: relativePath` and `absolutePath` only if search service needs it internally — default to relative for safety.

### 5.8 Doc mentions DB fallback (if time)

When `allSymbols.length === 0` but `linkDocMentions !== false` and Mongo available:

```ts
const symbols = await ReactorNodeModel.find({
  projectId,
  type: { $in: [/* symbol-like types */] },
  // or data.kind in symbol kinds
}).limit(20000).lean();
```

Only if symbol types are queryable; otherwise document as follow-up and skip.

### 5.9 `ensureFolderChain` micro-opt

Remove `nodes.some`; `folderByRel` Map is sufficient. Optional `folderIds: Set<number>`.

---

## 6. Implementation steps (ordered)

### Phase A — Tests first (TDD)

1. **Orchestration test** (mock processors):
   - Two processors; assert **same** `runId` passed to both.
   - Assert first call `skipGc: true`, second `skipGc: false` (or only last false).
2. **Service path test:** `processProject` with two mock processors — same invariants (this is the regression that is currently red in spirit).
3. **Persist fail ⇒ no GC:**
   - Mock `bulkWrite` to throw / return fail.
   - Spy `deleteMany` — must **not** be called.
4. **Deep descendants:**
   - Mock find to return chain parent→c1→c2→c3.
   - `loadDescendantNodeIds` includes c1,c2,c3.
5. **Arch test:** resolver source has no model imports (write failing test first if models still imported).

### Phase B — Orchestration unify

6. Add `runProcessorsForProject` helper (shared module **or** manager method + service delegate).
7. Refactor `SystemGraphManager.catalogProject` to use it (behavior preserve).
8. Refactor `ReactorProjectService.processProject` to use it.
9. Pass through `forceFull` from `enqueueCatalog` / index paths if not already.

### Phase C — Process safety

10. `canonicalProjectId` + stamp everywhere.
11. `persistGraph` → `{ ok }`; gate GC.
12. BFS `loadDescendantNodeIds`.
13. Cache bust `seenNodeIds`.
14. Searchable relative path.
15. Optional folder Map micro-opt.

### Phase D — GraphQL

16. Eliminate model usage in resolver.
17. Arch test green.

### Phase E — Docs

18. README hardening bullet.
19. Update `00-README.md` status: session 15 pending→done; fix program DoD checkboxes that are truly met; leave honest residual if any.
20. Fill Agent Notes.

---

## 7. Test plan

```bash
cd reactory-express-server

NODE_OPTIONS=--max-old-space-size=6144 npx jest \
  src/modules/reactory-reactor/services/graph/GraphBuilding.test.ts \
  src/modules/reactory-reactor/services/graph/IncrementalProcess.test.ts \
  src/modules/reactory-reactor/services/graph/SearchIdAlignment.test.ts \
  src/modules/reactory-reactor/services/graph/ProcessOrchestration.test.ts \
  src/modules/reactory-reactor/services/graph/GraphQlFacade.arch.test.ts \
  --forceExit

# Broader if time:
NODE_OPTIONS=--max-old-space-size=6144 npx jest \
  src/modules/reactory-reactor/services/graph \
  --forceExit
```

Prefer `./bin/jest.sh` when present.

### Minimum new cases checklist

| # | Case | Expect |
|---|------|--------|
| 1 | Two processors via **service** `processProject` | shared runId; GC once |
| 2 | Two processors via **manager** `catalogProject` | unchanged / still correct |
| 3 | persistGraph ok=false | deleteMany not called |
| 4 | Descendant depth 3+ | all ids returned / touched |
| 5 | Resolver file text | no ReactorNode(Model\|LinkModel) |
| 6 | buildSearchable | no absolute path in `path` field |
| 7 | Missing projectId | GC not called; warn logged |

---

## 8. Acceptance criteria

- [x] `ReactorProjectService.processProject` and `SystemGraphManager.catalogProject` share **one** orchestration implementation (no divergent GC behavior).
- [x] Multi-processor runs always use one `runId`; only the last process performs GC (unless single processor).
- [x] `persistGraph` returns success flag; **GC runs only if persist succeeded** and `projectId` present and `!skipGc`.
- [x] `loadDescendantNodeIds` is BFS (or equivalent) with depth/node caps — depth ≥ 3 covered by test.
- [x] Cache invalidation includes skipped/`seenNodeIds`.
- [x] `ReactorSystemGraph.ts` does not import or reference node/link Mongoose models (arch test green).
- [x] Searchable payloads do not expose absolute filesystem paths as `path`.
- [x] `canonicalProjectId` used for meta + queries in `process`.
- [x] Existing graph test suites remain green.
- [x] README + `00-README` status updated; Agent Notes filled.
- [x] No GraphIdentity formula changes; no bare `tree-sitter` requires.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Circular DI GraphManager ↔ ProjectService | Prefer pure `runProcessorsForProject.ts` helper |
| Changing processProject breaks callers expecting partial merge | Preserve merge of returned project fields |
| BFS too heavy on huge trees | MAX_NODES + MAX_DEPTH caps; log truncation |
| Arch test brittle on import paths | Match symbol names, allow type-only comments none |
| GC skip on persist fail leaves stale + new partial | Accept; better than wipe; metrics flag `persistFailed` |
| indexSearchables fails after persist ok | Still allow GC (nodes are source of truth); optional: don't GC if you also version search by runId later |

---

## 10. Non-goals reminder for the agent

If you discover large refactors (splitting BaseProjectProcessor), **note them** under Agent Notes. Do not start Session 16 scope creep.

---

## 11. Suggested commit message

```text
fix(system-graph): Session 15 — unify processor orchestration, safe GC, deep incremental touch, GQL façade

- Shared runProcessorsForProject for manager + project service
- persistGraph returns ok; GC only on success
- BFS loadDescendantNodeIds; cache-bust seen ids
- Remove residual model access from ReactorSystemGraph
- canonicalProjectId + relative searchable paths
```

---

## 12. Agent Notes

- **Branch:** `feat/system-graph-15-hardening` (module repo: `reactory-express-server/src/modules/reactory-reactor`)
- **Helper location:** pure `services/graph/runProcessorsForProject.ts` (avoids GraphManager ↔ ProjectService DI cycle)
- **Tests run:** `NODE_OPTIONS=--max-old-space-size=6144 npx jest src/modules/reactory-reactor/services/graph --forceExit` → **19 suites / 211 tests PASS**
- **Closeout fixes (parent Reactor):**
  1. `persistGraph` mock paths: `process()` tolerates undefined return via `|| { ok: true, ... }` when tests stub `persistGraph`
  2. `linkExternalProjects` short-circuits when Mongo unavailable (catalogProject test timeout)
  3. `GraphQLFacade.test.ts` expectation updated to `findNodesByType(types, 1000)` matching resolver
- **Deviations:** none material; GraphIdentity formulas unchanged
- **Follow-ups deferred:**
  - Doc-mention DB symbol fallback when processor-local `allSymbols` empty
  - Cross-project publisher index (avoid pageSize 5000 scan)
  - Platform: sub-agent tool bootstrap (support ticket REACTORY-0/20260827/535581872)
- **Program DoD boxes updated in 00-README?** yes
