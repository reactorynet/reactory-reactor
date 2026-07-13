# SystemGraphManager — Code Graph Engine

> State of `services/SystemGraphManager.ts` and its supporting providers, processors, analyzers, models and GraphQL surface.
>
> **Intent:** inspect any code base, index its files, and build a detailed graph of nodes (projects → folders → files → symbols) with edges linking related elements.
>
> **Current state:** delivers that pipeline for **TypeScript/JavaScript (NodeJS/React Native)** with full AST analysis, and generic file-tree browsing for **all** languages. Node identity is deterministic; nodes and edges persist to MongoDB; file contents index to search. Edge CRUD and the graph query surface are wired through GraphQL.

---

## 1. Architecture

```
GraphQL (ReactorSystemGraph.ts)
        │  queries: ReactorCatalogNodes, ReactorNode(id,key), ReactorNodesForType/ByTerm/ByCategory,
        │           ReactorNode.children / dependencies / dependents / inputs / outputs / parent
        │  mutations: ReactorCreateNodeLink / Update / Delete, ReactorSyncCatalogNodes, ReactorIndexNodes,
        │             ReactorSaveSystemGraph
        ▼
SystemGraphManager (facade + edge store)
        │
        ├── ReactorProjectService ──► MongoDB (reactor_projects)   [single source of truth for projects]
        │
        └── IProjectProcessor (per language) ──► BaseProjectProcessor
                                                    │
                    ┌───────────────────────────────┼───────────────────────────────┐
                    ▼                                ▼                                ▼
            generic tree walk               TypeScriptAnalyzer               persistence + search
        (folders/files, lazy+cached)   (ts compiler API: symbols,        (reactor_nodes, reactor_node_links,
                                        imports → edges, externals)        reactor_graph_<ns>_<name> index)
```

### Deterministic identity (`services/graph/GraphIdentity.ts`)
Every node id is `Hash(logicalKey)`:
- project root → `nameSpace.name@version`
- file/folder → `<fqn>::<relativePath>`
- symbol → `<fqn>::<relativePath>#<symbolPath>`
- external dep → `npm:<package>`

Edge id = `Hash(source->target:type)`. Because ids are a pure function of position, re-processing is idempotent, edges never dangle, and an import edge can point at a file/symbol whose node has not been materialised yet. There is **one** numeric id space (the Mongo/static-catalog split is gone).

---

## 2. Processors (`services/ReactorProjectProcessors/`)

All processors now extend **`BaseProjectProcessor`**, which provides:
- deterministic project root node,
- generic recursive folder/file tree expansion (`getChildrenForNode`) with an ignore list (`node_modules`, `.git`, `dist`, `target`, …), folder-first ordering, and paging,
- `process()` — discovers files, builds root/file/symbol/external nodes, resolves edges, **persists** them, and **indexes** file contents to search,
- `analyseFileFull()` hook for language-specific symbol/edge extraction (default: files are leaves),
- default icon attribute + service plumbing.

| Processor | Detection | Tree walk | Symbols + edges (AST) | Icon |
|-----------|-----------|-----------|------------------------|------|
| **NodeJS** | `package.json` (detects `typescript`/`react`) | ✅ (base) | ✅ TypeScript AST analyzer | nodejs |
| **ReactNative** | `react-native` dep | ✅ (base) | ✅ TypeScript AST analyzer | react-native |
| **Python** | requirements/setup/pyproject | ✅ (base) | ✅ Python analyzer | python |
| **Java** | pom/gradle/ant | ✅ (base) | ✅ Java analyzer | java |
| **CSharp** | `.csproj`/`.sln` | ✅ (base) | ✅ C# analyzer | csharp |
| **TSql** | `.sqlproj`/`.dacpac` | ✅ (base) + Connections node, DATASTORE root, rich menus | — | tsql |
| **File** | any repoPath (fallback) | ✅ (base) | — | — |
| **BackStage** | `catalog-info.yaml` | own impl | parses catalog metadata | — |

## 3. TypeScript analyzer (`services/graph/analyzers/TypeScriptAnalyzer.ts`)

Parses `.ts/.tsx/.js/.jsx` with the TypeScript compiler API in four passes and returns `{ symbols, externals, edges }`:
- **Pass 1 — imports:** builds an import-binding map (local name → resolved file / npm package) and emits `DEPENDENCY` edges (relative imports resolved via extension/`index` lookup; bare imports → external dependency node; `export … from` re-exports).
- **Pass 2 — symbols:** classes (+ one level of methods), functions, interfaces, type aliases, enums, exported const/arrow functions — each a deterministic child node with line number, `symbolKind`, and `exported` flag.
- **Pass 3 — inheritance:** `extends` → `INHERITS` edge, `implements` → `IMPLEMENTS` edge, resolved to the base type's node (same file or via import bindings).
- **Pass 4 — calls:** walks each callable body for call expressions and emits `CALL` edges — `this.method()` → the sibling method, local calls → the local symbol, and cross-file calls resolved through import bindings.

Edges are de-duplicated by deterministic id. `ReactorLinkType` was extended with `CALL`, `INHERITS`, `IMPLEMENTS`, `REFERENCE` (mirrored in the GraphQL enum). Compatible with TS 4.5 (uses legacy `node.modifiers`).

### Other language analyzers (`services/graph/analyzers/`)

No AST parser is available in-runtime for Python/Java/C#, so these are careful **heuristic scanners** sharing a `GraphEmitter` (deterministic node/edge construction + local-symbol/import-binding resolution) and, for C-family languages, `sanitizeCLike` (blanks comments/strings), `matchBrace`, `topLevelMembers` and `emitBraceTypes` in `support.ts`.

- **PythonAnalyzer** — indentation-aware: classes, functions, methods; `import`/`from … import` (relative imports resolved to in-repo files, absolute → external); base-class `INHERITS`; `self.method()`, local and construction `CALL` edges.
- **JavaAnalyzer** — brace-based: classes/interfaces/enums, methods; `import` deps; `extends`→`INHERITS`, `implements`→`IMPLEMENTS`; `this.method()`/sibling `CALL` edges. Constructors (no return type) are intentionally not surfaced.
- **CSharpAnalyzer** — brace-based: classes/structs/interfaces/enums, methods; `using` deps; base list `: Base, IFoo` split into `INHERITS`/`IMPLEMENTS` via the `IXxx` naming convention; `this.method()`/sibling `CALL` edges.

All emit the same `{ symbols, externals, edges }` shape and id-space as the TS analyzer, so persistence, edges and GraphQL resolution work identically. Unresolved references (builtins, cross-namespace bases without an import binding) produce **no** edge, which keeps the graph clean rather than guessing.

## 4. Persistence & search

- **`reactor_nodes`** (numeric `id`, `key`, `parentId`, `providerId`, `source`, `data`, relationship id arrays) — persisted for analysed artifacts (roots, files, symbols, externals). Raw folder browsing stays lazy/cached.
- **`reactor_node_links`** (`ReactorNodeLink` model) — edges keyed by deterministic id, indexed on source/target/projectId.
- **Search** — `process()` writes file searchables to `reactor_graph_<ns>_<name>` via `core.ReactorySearchService`, resolved from context so it works whether the processor was DI- or manually-constructed.

## 5. SystemGraphManager methods

| Method | Status |
|--------|--------|
| `getProjects` / `getProject` | ✅ delegate to ReactorProjectService (Mongo) |
| `getCatalogNodes` / `getCatalogNode` | ✅ deterministic numeric ids |
| `getNode(id, key)` | ✅ cache → catalog root → **lazy ancestry walk** (the old dead branch now works) |
| `getChildren` | ✅ hardened (null/missing-provider guards, per-node error isolation) |
| `getProjectForCatalogNode` | ✅ Mongo-backed, matched by deterministic id |
| `catalogProject` / `catalogProjects` | ✅ `catalogProjects` now awaits + isolates errors |
| `getLinks / createLink / updateLink / deleteLink` | ✅ backed by `reactor_node_links` (idempotent upserts) |
| `getCategoryNodes` | ✅ static taxonomy |

## 6. GraphQL surface

- **Node relationships:** `ReactorNode.dependencies / dependents / inputs / outputs / parent` resolve via the edge store; `ReactorNodeLink.source / target` resolve node objects from ids.
- **Search queries** `ReactorNodesForType` / `ReactorNodesByTerm` query the **persisted graph** (with catalog fallback) instead of filtering the full list in memory.
- **Mutations** match the schema: `ReactorCreateNodeLink`, `ReactorUpdateNodeLink`, `ReactorDeleteNodeLink`, `ReactorSyncCatalogNodes`, `ReactorIndexNodes`, `ReactorSaveSystemGraph` — all implemented (the previous throwing/misnamed stubs are gone).

## 7. Tests (41 tests / 12 suites, no Mongo required)

Shared fixtures via `services/graph/testUtils.ts` (`makeContext`, `writeProject`, `cleanup`, `fileNodeFor`, `symbolId`, `fileId`).

- **`GraphBuilding.test.ts`** — end-to-end pipeline: detection, deterministic root, tree walk ignoring `node_modules`, folder/file expansion, symbol extraction, `process()` graph assembly (nodes+edges+searchables), import-edge resolution (relative + external).
- **Analyzer suites** (`analyzers/*.test.ts`) — TypeScript, Python, Java, C#: symbol extraction, import dependency edges, `INHERITS`/`IMPLEMENTS` edges (cross-file where import bindings allow), `CALL` edges (`this`/`self`/local/construction), edge de-duplication.
- **Per-processor tests** (Java, C#, Python, ReactNative, NodeJS, TSql, File) — real temp-fixture detection (`supportsProject`/`getProjectTypes`, incl. foreign-project rejection), generic tree-walk for Python/File, the DATASTORE + Connections behaviour for TSql, and a Python `process()` integration proving symbols/edges flow through the full pipeline.

All green; full project typechecks clean (no new errors).

---

## 8. Remaining / future work

1. **Deeper edges** — resolve `Obj.method()` calls where `Obj` is a locally instantiated variable (needs light type inference), `new X()` construction edges, endpoint↔handler, DB FK/view/proc references (TSql), DI wiring.
2. **Higher-fidelity non-TS analyzers** — the Python/Java/C# scanners are heuristic (constructors skipped for Java/C#; cross-file same-package/namespace bases only resolve through explicit import bindings). A real parser (tree-sitter / language server) would raise precision if needed.
3. **Cross-project edges** — link external `npm:`/`java:`/`cs:` dependency nodes to the actual project node that publishes them.
4. **Incremental re-index** — only reprocess changed files (mtime/hash) rather than the whole repo.
5. **Category assignment** — attach nodes to the `DefaultReactorNodeCategories` taxonomy during analysis.
6. **Persist folder nodes on demand** if full-tree queries (not just analysed artifacts) become necessary.

_Reflects the code on this branch. Key files: `services/graph/GraphIdentity.ts`, `services/graph/analyzers/TypeScriptAnalyzer.ts`, `services/ReactorProjectProcessors/BaseProjectProcessor.ts`, `services/SystemGraphManager.ts`, `models/ReactorNodeLink.ts`, `models/ReactorGraphNode.ts`, `graphql/resolvers/ReactorSystemGraph.ts`._
