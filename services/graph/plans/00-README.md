# SystemGraph Improvement Program — Agent Session Plans

> **Audience:** Isolated coding agents (Grok Build, Claude, Codex, etc.) with ~256k context.
> **Goal:** Execute the SystemGraph hardening roadmap as **independent, ordered sessions**.
> **Source analysis date:** 2026-08-26
> **Code root:** `reactory-express-server/src/modules/reactory-reactor/`

---

## How to use this pack

1. Read **this file** first (conventions + order).
2. Open **exactly one** session plan (`01-…` through `14-…`).
3. Do **not** expand scope into later sessions.
4. When done, update the **Session Status** table below and leave a short `NOTES.md` in your PR/branch description (or append to the session file under `## Agent Notes`).
5. Run the session’s **Acceptance Criteria** before marking complete.

### Recommended agent prompt template

```text
You are implementing ONE SystemGraph session plan only.

Read and follow:
  src/modules/reactory-reactor/services/graph/plans/00-README.md
  src/modules/reactory-reactor/services/graph/plans/<SESSION_FILE>.md

Rules:
- Stay inside the session scope and file allow-list.
- Prefer safeEditFile / small patches over rewrites.
- Follow TDD: add/adjust tests in the listed test files first or with the change.
- Do not refactor unrelated code.
- Do not load tree-sitter except via TreeSitterEngine.
- Preserve deterministic GraphIdentity ids.
- After changes, run the listed test commands.
- Summarize what you changed and any follow-ups at the end.
```

---

## Non-negotiable design invariants

Agents must **preserve** these. Violating them is a failed session even if tests pass partially.

| # | Invariant | Where |
|---|-----------|--------|
| I1 | Node id = `Hash(logicalKey)` via `GraphIdentity.nodeId` | `services/graph/GraphIdentity.ts` |
| I2 | Edge id = `Hash(source->target:type)` via `linkId` | same |
| I3 | Logical keys use `projectFqn::relativePath` and `#symbol` / `#anchor` | same |
| I4 | Never emit an edge to a node the analyzer did not / will not create | document + code analyzers |
| I5 | Hybrid processors use `claimsFile()`; File processor is fallback-only | `BaseProjectProcessor` |
| I6 | Resolve paths in **realpath** / canonical space on both sides | process + docs emitter |
| I7 | Load `tree-sitter` **only** through `TreeSitterEngine` | `analyzers/treesitter/` |
| I8 | `CONTAINS` edges are synthesized from `parentId`, not bulk-persisted as primary topology | `SystemGraphManager.getSubgraph` |
| I9 | Interactive tree + batch process must agree on node **id**, **type**, and **kind** | `makeTreeNode` vs `fileNodeForProcess` |

---

## Repository map (read these, don’t reinvent)

```
services/
  SystemGraphManager.ts              # façade: nodes, links, subgraph, path, catalog
  SystemGraphManager.README.md       # living architecture doc
  ReactorProjectService.ts           # projects CRUD / detect / index
  ReactorProjectProcessors/
    BaseProjectProcessor.ts          # tree walk, process(), persist, search index
    NodeJS|Python|Java|CSharp|…/     # thin language processors
  graph/
    GraphIdentity.ts
    analyzers/                       # TS, Python, Java, Kotlin, C#, treesitter, support
    documents/                       # markdown/plaintext → outline → edges
    testUtils.ts
    plans/                           # ← YOU ARE HERE
models/
  ReactorGraphNode.ts                # reactor_nodes
  ReactorNodeLink.ts                 # reactor_node_links
  ReactorProject.ts
graphql/resolvers/
  ReactorSystemGraph.ts
types/
  model.types.ts
  service.types.ts
```

---

## Execution order and dependencies

```
01 hierarchy ─────────────────────────────────────────────┐
02 schema+GC ─── requires 01 (folder nodes must exist) ───┤
03 search-id alignment ─── can parallel 01 after schema  ─┤
04 catalog O(1) ─── can parallel 01                       │
05 manager cleanup ─── after 04 preferred                 │
06 graphql façade ─── after 05                            │
07 mongo indexes ─── after 02                             │
08 incremental index ─── after 01+02+03                   │
09 async jobs ─── after 08                                │
10 tsconfig paths ─── independent after 01                │
11 tree-sitter python ─── independent                     │
12 cross-project edges ─── after 02+04                    │
13 docs symbol mentions ─── after 01+03                   │
14 observability+tenancy ─── after 08+09                  │
```

### Parallelism (safe)

| Wave | Sessions | Notes |
|------|----------|-------|
| A | **01** alone first if possible | Unlocks almost everything |
| B | **02**, **03**, **04** | After or with late 01; 02 needs 01 merged |
| C | **05**, **07**, **10**, **11** | Mostly independent |
| D | **06** after 05; **08** after 01–03 | |
| E | **09**, **12**, **13** | |
| F | **14** last | |

---

## Session status board

| ID | File | Priority | Est. | Status | Owner |
|----|------|----------|------|--------|-------|
| 01 | `01-persist-folder-hierarchy.md` | P0 | M | done | |
| 02 | `02-project-scoped-gc-and-schema.md` | P0 | M | done | |
| 03 | `03-searchable-node-id-alignment.md` | P0 | S | done | |
| 04 | `04-catalog-lookup-o1.md` | P0 | S | done | |
| 05 | `05-manager-cleanup-and-getproject.md` | P1 | S | done | |
| 06 | `06-graphql-facade-and-paging.md` | P1 | M | done | |
| 07 | `07-mongo-indexes-and-project-fields.md` | P1 | S | pending | |
| 08 | `08-incremental-reindex.md` | P1 | L | pending | |
| 09 | `09-async-catalog-jobs.md` | P1 | M | pending | |
| 10 | `10-typescript-path-aliases.md` | P2 | M | pending | |
| 11 | `11-treesitter-python-and-engine-guard.md` | P2 | M | pending | |
| 12 | `12-cross-project-externals.md` | P3 | M | pending | |
| 13 | `13-docs-symbol-mentions.md` | P3 | M | pending | |
| 14 | `14-observability-tenancy-cache.md` | P4 | M | pending | |

Status values: `pending` | `in_progress` | `blocked` | `done` | `wontfix`

---

## Testing conventions

### Preferred runner (Reactory express server)

```bash
cd /Users/wernerw/Projects/reactory/reactory-express-server
# If bin/jest.sh exists:
./bin/jest.sh <relative-test-path>

# Fallback used historically for graph suites:
NODE_OPTIONS=--max-old-space-size=6144 npx jest <path> --forceExit
```

`--forceExit` is required when tests import `src/context` (MCP interval keeps Jest alive).

### Baseline suites every session should keep green if touched

- `services/graph/GraphBuilding.test.ts`
- `services/graph/documents/DocumentGraph.test.ts`
- Language analyzer tests under `services/graph/analyzers/*.test.ts`
- Processor tests under `services/ReactorProjectProcessors/**/**.test.ts`

### Do not

- Start Mongo-dependent e2e unless the session says so.
- Bump major deps.
- Change GraphQL schema field names without a dual-read period (additive only).
- Require `tree-sitter` via bare `require('tree-sitter')`.

---

## Coding conventions for agents

1. **Small PRs / commits per session** — one session = one branch ideally: `feat/system-graph-01-hierarchy`.
2. **TDD** — add failing test asserting the bug/invariant, then fix.
3. **Types** — update `types/model.types.ts` / `service.types.ts` when adding fields.
4. **Logging** — use `context.info/warn/error`, never `console.log` in services.
5. **Idempotence** — all writes upsert by deterministic `id`.
6. **No drive-by refactors** — if you notice a bug outside scope, note it under Agent Notes; don’t fix it here.
7. **Update README** — if behavior changes user-visible architecture, add a short bullet to `SystemGraphManager.README.md` §9 or the relevant section (session will say when).

---

## Definition of done (program level)

Program is **done** when:

- [ ] Persisted graph preserves folder hierarchy (`parentId` chain).
- [ ] Re-index GC removes deleted file/symbol/edge nodes per project.
- [x] Search hits resolve to real graph nodes (same id space).
- [x] Catalog node/project lookup is O(1) (no full project list scan).
- [x] `getProject` on manager does not throw.
- [x] GraphQL graph queries go through manager (no ad-hoc model filters for core paths).
- [ ] Mongo indexes match hot queries; `projectId` is first-class.
- [ ] Incremental re-index skips unchanged files by hash.
- [ ] Heavy catalog/index mutations are async jobs.
- [ ] All listed tests green; README future-work items updated.

---

## Shared glossary

| Term | Meaning |
|------|---------|
| **logicalKey** | Stable string identity input to `nodeId` |
| **ancestryKey** | `node.key` pipe-delimited id path for lazy walk |
| **FQN** | `nameSpace.name@version` |
| **process()** | Batch discover → analyse → persist → search index |
| **providerId** | Processor service FQN that owns expansion |
| **claimsFile** | Whether a processor may emit/overwrite a file node |
| **runId** | UUID/timestamp for one process invocation (session 02) |
| **contentHash** | Hash of file bytes for incremental skip (session 08) |

---

## Contact / ownership

- Module: `reactory-reactor`
- Primary services: `reactor.SystemGraphManager@1.0.0`, `reactor.ReactorProjectService@1.0.0`
- Plans maintained under: `services/graph/plans/`

_End of master index._
