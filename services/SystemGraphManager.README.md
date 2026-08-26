# SystemGraphManager — Code & Documentation Graph Engine

> State of `services/SystemGraphManager.ts` and its supporting providers, processors, analyzers, models and GraphQL surface.
>
> **Intent:** inspect any code base *or documentation set*, index its files, and build a detailed graph of nodes (projects → folders → files/documents → symbols/sections) with edges linking related elements.
>
> **Current state:** delivers that pipeline for **TypeScript/JavaScript (NodeJS/React Native)** with full AST analysis, heuristic analyzers for Python/Java/Kotlin/C#, a **document analyzer** for markdown/reStructuredText/AsciiDoc/plain text (§4), and generic file-tree browsing for **all** languages. Documentation-only and hybrid (code + docs) projects are both graphed. Node identity is deterministic; nodes and edges persist to MongoDB; file contents index to search. Edge CRUD and the graph query surface are wired through GraphQL.

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
            ┌───────────────────┬───────────────────┼───────────────────┬───────────────────┐
            ▼                   ▼                   ▼                   ▼                   ▼
    generic tree walk    TypeScriptAnalyzer   other language      document analyzer   persistence + search
 (folders/files, docs,  (ts compiler API:      analyzers        (services/graph/    (reactor_nodes,
   lazy + cached)         symbols, imports    (heuristic:        documents/:         reactor_node_links,
                          → edges, externals)  py/java/kt/cs)     sections, links,    reactor_graph_<ns>_<name>)
                                                                  topics, resources)
```

### Deterministic identity (`services/graph/GraphIdentity.ts`)
Every node id is `Hash(logicalKey)`:
- project root → `nameSpace.name@version`
- file/folder/document → `<fqn>::<relativePath>`
- symbol → `<fqn>::<relativePath>#<symbolPath>`
- **document section** → `<fqn>::<relativePath>#<anchor-slug>`
- external dep → `npm:<package>`
- **topic** → `topic:<fqn>#<slug>` · **external resource** → `resource:<fqn>#<url>`

Edge id = `Hash(source->target:type)`. Because ids are a pure function of position, re-processing is idempotent, edges never dangle, and an import edge can point at a file/symbol whose node has not been materialised yet. There is **one** numeric id space (the Mongo/static-catalog split is gone).

---

## 2. Processors (`services/ReactorProjectProcessors/`)

All processors now extend **`BaseProjectProcessor`**, which provides:
- deterministic project root node,
- generic recursive folder/file tree expansion (`getChildrenForNode`) with an ignore list (`node_modules`, `.git`, `dist`, `target`, …), folder-first ordering, and paging,
- `process()` — discovers files, builds root/file/symbol/external nodes, resolves edges, **persists** them, and **indexes** file contents to search,
- `analyseFileFull()` hook for language-specific symbol/edge extraction. **The default handles documents** (§4), so every processor graphs the documentation it walks; language processors delegate to `super.analyseFileFull()` for files they do not handle,
- `claimsFile()` hook deciding which files a processor emits nodes for — the escape hatch that lets a supplementary processor contribute to a hybrid project without taking ownership of another processor's nodes,
- default icon attribute + service plumbing.

| Processor | Detection | Tree walk | Symbols + edges (AST) | Icon |
|-----------|-----------|-----------|------------------------|------|
| **NodeJS** | `package.json` (detects `typescript`/`react`) | ✅ (base) | ✅ TypeScript AST analyzer | nodejs |
| **ReactNative** | `react-native` dep | ✅ (base) | ✅ TypeScript AST analyzer | react-native |
| **Python** | requirements/setup/pyproject | ✅ (base) | ✅ Python Tree-sitter AST analyzer (with heuristic fallback) | python |
| **Java** | pom/gradle/ant | ✅ (base) | ✅ Java + Kotlin Tree-sitter AST analyzers | java |
| **CSharp** | `.csproj`/`.sln` | ✅ (base) | ✅ C# Tree-sitter AST analyzer | csharp |
| **TSql** | `.sqlproj`/`.dacpac` | ✅ (base) + Connections node, DATASTORE root, rich menus | — | tsql |
| **Markdown** | documents in root or a docs dir (`docs`, `adr`, `rfcs`, …), or a docs-site config (`mkdocs.yml`, `docusaurus.config.*`, …) | ✅ (base) | ✅ document analyzer (§4); claims documents only on hybrid projects | markdown |
| **File** | any repoPath (**fallback only** — used when nothing else claims the project) | ✅ (base) | documents only (base default) | — |
| **BackStage** | `catalog-info.yaml` | own impl | parses catalog metadata | — |

**Processor selection.** `ReactorProjectService.detectProjectProcessors` returns every processor that claims the project, and `processProject` runs them all — so a NodeJS repo with a `docs/` folder is processed by both NodeJS and Markdown. `File` is deliberately excluded unless nothing else matched: it supports *every* folder, so including it alongside a real processor made it re-walk the whole tree and overwrite each node's `providerId`, which stopped the tree expanding symbols for those files.

## 3. TypeScript analyzer (`services/graph/analyzers/TypeScriptAnalyzer.ts`)

Parses `.ts/.tsx/.js/.jsx` with the TypeScript compiler API in four passes and returns `{ symbols, externals, edges }`:
- **Pass 1 — imports:** builds an import-binding map (local name → resolved file / npm package) and emits `DEPENDENCY` edges (relative imports resolved via extension/`index` lookup; non-relative imports resolved via `tsconfig.json` `compilerOptions.paths` and `baseUrl` against in-repo files via `tsconfigPaths.ts`, cached per repo; bare package imports → external dependency node; `export … from` re-exports).
- **Pass 2 — symbols:** classes (+ one level of methods), functions, interfaces, type aliases, enums, exported const/arrow functions — each a deterministic child node with line number, `symbolKind`, and `exported` flag.
- **Pass 3 — inheritance:** `extends` → `INHERITS` edge, `implements` → `IMPLEMENTS` edge, resolved to the base type's node (same file or via import bindings).
- **Pass 4 — calls:** walks each callable body for call expressions and emits `CALL` edges — `this.method()` → the sibling method, local calls → the local symbol, and cross-file calls resolved through import bindings.

Edges are de-duplicated by deterministic id. `ReactorLinkType` was extended with `CALL`, `INHERITS`, `IMPLEMENTS`, `REFERENCE` (mirrored in the GraphQL enum). Compatible with TS 4.5 (uses legacy `node.modifiers`).

### Other language analyzers (`services/graph/analyzers/`)

AST parsers via `TreeSitterEngine` (with resilient heuristic fallback for Python/C-family) share a `GraphEmitter` (deterministic node/edge construction + local-symbol/import-binding resolution):

- **PythonAnalyzer** — Tree-sitter AST analyzer with indentation heuristic fallback: classes, functions, methods; `import`/`from … import` (relative imports resolved to in-repo files, absolute → external); base-class `INHERITS`; `self.method()`, local and construction `CALL` edges.
- **JavaAnalyzer** — Tree-sitter AST analyzer: classes/interfaces/enums/records, methods and constructors; `import` deps; `extends`→`INHERITS`, `implements`→`IMPLEMENTS`; `this.method()`/sibling and `new X()` `CALL` edges.
- **CSharpAnalyzer** — Tree-sitter AST analyzer: classes/structs/interfaces/enums, methods and constructors; `using` deps; base list `: Base, IFoo` resolved locally or via `IXxx` fallback; `this.method()`/sibling and `new X()` `CALL` edges.
- **KotlinAnalyzer** — Tree-sitter AST analyzer: classes/interfaces/objects, functions and constructors; `import` deps; `constructor_invocation`→`INHERITS` vs `user_type`→`IMPLEMENTS`; `this.method()` and constructor `CALL` edges.

All emit the same `{ symbols, externals, edges }` shape and id-space as the TS analyzer, so persistence, edges and GraphQL resolution work identically. Unresolved references (builtins, cross-namespace bases without an import binding) produce **no** edge, which keeps the graph clean rather than guessing.

## 4. Document analyzer (`services/graph/documents/`)

Documents are graphed in two stages, so a new dialect means a new parser and nothing else:

```
content ──(parser)──► DocumentOutline ──(DocumentGraphEmitter)──► { symbols, externals, edges, filePatch }
```

| File | Role |
|------|------|
| `DocumentTypes.ts` | the dialect-agnostic `DocumentOutline` model, `slugify`/`uniqueSlug` (GitHub-compatible anchors), metrics helpers |
| `MarkdownParser.ts` | markdown/MDX block scanner |
| `PlainTextParser.ts` | `.txt` / extension-less documents; infers structure from underlines, numbered sections and standalone title-case lines |
| `DocumentGraphEmitter.ts` | outline → deterministic nodes/edges; link resolution against the repo |
| `index.ts` | dialect dispatch (`documentFormatFor`, `parseDocument`, `analyseDocumentFile`) |

**Recognised as documents:** `.md`, `.markdown`, `.mdx`, `.rst`, `.adoc`, `.txt`, plus extension-less conventions (`README`, `CHANGELOG`, `LICENSE`, `CONTRIBUTING`, `CODEOWNERS`, …). These get `ReactorNodeType.DOCUMENT` instead of `FILE`, and `data.kind = "document"`.

**What the parser gets right** (and a line-regex pass does not): `#` inside a fenced code block is code, not a heading; `[a](b)` inside a code span or fence is not a link; `---` is frontmatter only at the top of the file, a setext underline only directly under a paragraph, and a thematic break otherwise. It also handles YAML frontmatter (without shifting line numbers), setext headings, explicit `{#custom-id}` anchors and `<a name>` aliases, reference-style links defined anywhere in the file, nested `[![img](a)](b)`, tables, task lists and HTML comments.

**New node types:** `DOCUMENT`, `SECTION`, `TOPIC`, `RESOURCE`. **New link types:** `DOCUMENTS`, `MENTIONS`, `EMBEDS` (mirrored in the GraphQL enums and the client's `GraphExplorer` styling maps).

**The graph produced from a document:**

| Element | Node/edge |
|---------|-----------|
| Heading | `SECTION` node, nested under its parent heading via `parentId` (so `CONTAINS` edges are synthesized as usual) |
| `[x](./other.md#anchor)` | `REFERENCE` → the **section node inside the target document**, plus one to the document itself |
| `[x](#local)` | `REFERENCE` → the local section |
| `[x](./src/index.ts)`, `` `src/config.json` `` | `DOCUMENTS` + `REFERENCE` → the code node — the edge that ties a README to what it describes |
| `![x](./img/a.png)` | `EMBEDS` → the asset node |
| `https://…`, `mailto:…` | `RESOURCE` node (project-scoped, URL-normalised) + `REFERENCE` (or `EMBEDS` for images) |
| frontmatter `tags`/`keywords`/`topics` | `TOPIC` node **shared across the project** + `MENTIONS` — two documents tagged `auth` attach to one node |
| frontmatter `related`/`see_also`/`links` | treated as document-level links |

Two decisions carry the design:

1. **Sections are keyed by their anchor slug, not by heading hierarchy.** `nodeId(<fqn>::docs/guide.md#installing)` is computable from the link `docs/guide.md#installing` alone, so a cross-document anchor resolves to the right node *without parsing the target document first*. Hierarchy lives in `parentId`. Duplicate headings de-duplicate to `overview`, `overview-1`, … exactly as GitHub does.
2. **An edge is only emitted when its target node will exist.** Link destinations are resolved against the repository (extension-less links, directory `index.md`/`README.md`, root-relative `/docs/x`, percent-encoding, query strings), rejecting URLs, missing files and anything escaping the repo root. Resolution happens in canonical `realpath` space on both sides — mixing canonical and non-canonical paths makes `path.relative` degrade to a `../..` walk and silently drops every in-repo edge (this is the macOS `/var` → `/private/var` trap).

A reference originates from the **section containing it** where there is one, otherwise from the document node — so "the Overview section links to X" and "this document relates to X" stay distinct statements.

`analyseFileFull` also returns a `filePatch`, which `process()` merges onto the document's own node: title, frontmatter, tags, heading outline, fenced-code languages and metrics (words, reading minutes, sections, links, tables, tasks). `getAttributes` surfaces these in the explorer's inspector, so a document node is meaningful without expanding it.

## 5. Persistence & search

- **`reactor_nodes`** (numeric `id`, `key`, `parentId`, `providerId`, `source`, `data`, relationship id arrays) — persisted for analysed artifacts (roots, files, symbols, externals). Raw folder browsing stays lazy/cached.
- **`reactor_node_links`** (`ReactorNodeLink` model) — edges keyed by deterministic id, indexed on source/target/projectId.
- **Search** — `process()` writes file searchables to `reactor_graph_<ns>_<name>` via `core.ReactorySearchService`, resolved from context so it works whether the processor was DI- or manually-constructed.

**Batch `process()` now emits FOLDER nodes and correct immediate-parentId chains (matching `makeTreeNode` ancestry depth).** (Session 01)

**Project-scoped GC + runId stamping (Session 02):** `process(project, { runId, skipGc })` stamps `projectId`/`projectFqn`/`runId`/`indexedAt` (and `contentHash` placeholder) on every node/edge via a single choke point in `persistGraph`. A shared `runId` is generated by `catalogProject` and passed to all processors for a given catalog run; only the last processor runs GC. GC uses `deleteMany({ projectId, runId: { $nin: [current, 'manual'] } })`. Empty `projectId` never triggers deletes. Legacy unscoped nodes are not removed this session.

**Searchable node ID alignment (Session 03):** Search index documents carry `id: logicalKey` (string) and `nodeId: graphNodeId` (deterministic number matching the graph file node). `SystemGraphManager.searchNodes` resolves hits without double-hashing (handling explicit numeric `nodeId`, numeric `id`, or string `logicalKey`), preferring persisted graph nodes over synthetic fallbacks. GraphQL `ReactorNodesByNameAndNameSpace` delegates to `searchNodes` directly.

**O(1) catalog node & reverse project lookups (Session 04):** `ReactorProject` stores and indexes `graphRootId` (deterministic `nodeId(projectLogicalKey(project))`), with lazy backfill on reads for legacy records. `SystemGraphManager.getCatalogNode` resolves catalog roots directly via persisted roots or `projectService.getProjectByGraphRootId` in O(1) time without materializing the full project list. `getProjectForCatalogNode` routes directly through `getProjectByGraphRootId`. `getCatalogNodes` supports optional pagination defaulting to `pageSize: 100`.

**SystemGraphManager cleanup & getProject delegation (Session 05):** `SystemGraphManager.getProject` delegates directly to `ReactorProjectService.getProject(pathSpec)` and handles 400/404 errors. Dead static mapping (`kvp`) and commented historical code were removed. `getSubgraph` lazy materialization maintains a `childCountByParent` map for O(1) checks on existing persisted children rather than an O(N) array scan. Manual edge creation via `createLink` stamps `runId: 'manual'` in `$setOnInsert` for GC exclusion.

**GraphQL Façade consistency & paging fixes (Session 06):** GraphQL graph operations in `ReactorSystemGraph.ts` are thin wrappers over `SystemGraphManager` (direct model imports `ReactorNodeModel` and `ReactorNodeLinkModel` removed). Added `normalizePaging` helper ensuring 1-based page indexing (`skip = (page - 1) * pageSize`), added manager query helpers `findNodesByType`, `findNodesByCategory`, `findLinks`, and `updateNode` (with ephemeral cache invalidation), and capped unbounded type/term queries to max 500 items.

**MongoDB Indexes for Graph & Link Models (Session 07):** Declared compound indexes on `reactor_nodes` (`{ projectId: 1, runId: 1 }`, `{ projectId: 1, parentId: 1 }`, `{ projectId: 1, type: 1 }`, `{ type: 1, name: 1 }`, `{ projectFqn: 1, type: 1 }`) and `reactor_node_links` (`{ projectId: 1, runId: 1 }`, `{ source: 1, types: 1 }`, `{ target: 1, types: 1 }`, `{ projectId: 1, source: 1 }`, `{ projectId: 1, target: 1 }`), plus unique sparse index on `reactor_projects.graphRootId`. Production index builds can be executed via Mongoose `syncIndexes()` during scheduled maintenance or directly in MongoDB shell (`db.reactor_nodes.createIndex(...)`, `db.reactor_node_links.createIndex(...)`).

**Incremental re-index by content hash (Session 08):** `BaseProjectProcessor.process` computes a SHA-256 `contentHash` for each file. Unchanged files bypass `analyseFileFull` and search index rebuilding. Descendant symbols/sections and edges for skipped files are touched with the current `runId` so they are preserved during project-scoped GC. `forceFull: true` option forces complete re-analysis.

**Async catalog & index jobs (Session 09):** `ReactorSyncCatalogNodes` and `ReactorIndexNodes` default to asynchronous execution (`async: true`), enqueuing catalog jobs via `enqueueCatalog` and returning `ReactorCatalogJobAccepted` with a `jobId` in < 1s. The jobs execute through the `reactor.CatalogProjectGraph@1.0.0` YAML workflow on the Reactory durable workflow engine. `async: false` is supported for synchronous/script execution. `ReactorCatalogJobStatus` query maps workflow instance status to `PENDING | RUNNING | COMPLETE | FAILED`. Re-enqueuing an active project without `forceFull` returns the existing `jobId` (idempotent).

**Cross-project external dependency linking (Session 12):** `SystemGraphManager.linkExternalProjects(projectId?)` resolves external dependency nodes (e.g. `npm:<pkg>`) against the catalog publisher index (matching `package.json` names, `project.name`, and `publishedPackages`), creating idempotent `REFERENCE` / `DEPENDENCY` edges from external nodes to target project root nodes. Self-links are prevented, and missing publishers create no edges (Invariant I4). Runs automatically at the end of `catalogProject` or on demand via `ReactorLinkCrossProjectDeps` GraphQL mutation.

## 6. SystemGraphManager methods

| Method | Status |
|--------|--------|
| `getProjects` / `getProject` | ✅ delegate to ReactorProjectService (Mongo) |
| `getCatalogNodes` / `getCatalogNode` | ✅ deterministic numeric ids |
| `getNode(id, key)` | ✅ cache → catalog root → **lazy ancestry walk** (the old dead branch now works) |
| `getChildren` | ✅ hardened (null/missing-provider guards, per-node error isolation) |
| `getProjectForCatalogNode` | ✅ Mongo-backed, matched by deterministic id |
| `catalogProject` / `catalogProjects` | ✅ `catalogProjects` now awaits + isolates errors |
| `getLinks / createLink / updateLink / deleteLink` | ✅ backed by `reactor_node_links` (idempotent upserts) |
| `linkExternalProjects` | ✅ cross-project external node to publisher root linking |
| `enqueueCatalog / getCatalogJobStatus` | ✅ async workflow job submission & status polling |
| `getCategoryNodes` | ✅ static taxonomy |

## 7. GraphQL surface

- **Node relationships:** `ReactorNode.dependencies / dependents / inputs / outputs / parent` resolve via the edge store; `ReactorNodeLink.source / target` resolve node objects from ids.
- **Search queries** `ReactorNodesForType` / `ReactorNodesByTerm` query the **persisted graph** (with catalog fallback) instead of filtering the full list in memory. `ReactorCatalogJobStatus` exposes async job execution status (`PENDING`, `RUNNING`, `COMPLETE`, `FAILED`).
- **Mutations** match the schema: `ReactorCreateNodeLink`, `ReactorUpdateNodeLink`, `ReactorDeleteNodeLink`, `ReactorSyncCatalogNodes` (default async, returning `ReactorCatalogJobAccepted`), `ReactorIndexNodes` (default async), `ReactorSaveSystemGraph` — all implemented (the previous throwing/misnamed stubs are gone).

## 8. Tests (no Mongo required)

> Run with `NODE_OPTIONS=--max-old-space-size=6144 npx jest <path> --forceExit`.
> `--forceExit` matters: suites that import `src/context` boot the module
> registry, which starts an MCP `setInterval` that keeps Jest alive.
>
> The whole `reactory-reactor` module is green — **69 suites / 989 tests**.

Shared fixtures via `services/graph/testUtils.ts` (`makeContext`, `writeProject`, `cleanup`, `fileNodeFor`, `symbolId`, `fileId`).

- **`GraphBuilding.test.ts`** — end-to-end pipeline: detection, deterministic root, tree walk ignoring `node_modules`, folder/file expansion, symbol extraction, `process()` graph assembly (nodes+edges+searchables), import-edge resolution (relative + external).
- **Analyzer suites** (`analyzers/*.test.ts`) — TypeScript, Python, Java, Kotlin, C#: symbol extraction, import dependency edges, `INHERITS`/`IMPLEMENTS` edges (cross-file where import bindings allow), `CALL` edges (`this`/`self`/local/construction), edge de-duplication.
- **`documents/MarkdownParser.test.ts`** (37) — slugging, ATX/setext headings, nesting and line ranges, headings-vs-fences, duplicate slugs, explicit ids and `<a name>` aliases, frontmatter (valid, malformed, unterminated, mid-document `---`), links (inline, reference, shortcut, autolink, bare, nested, code-span paths), tables/tasks/metrics, HTML comments.
- **`documents/DocumentGraph.test.ts`** (29) — document detection, URL normalisation, link resolution (relative/parent/root-relative, extension-less, directory index, anchors, repo escapes), anchor-keyed section ids and hierarchy, `DOCUMENTS`/`EMBEDS`/`MENTIONS`/`REFERENCE` edges, project-scoped topics and resources, idempotence, and an assertion that **no edge points at a node the analyzer did not create**.
- **Per-processor tests** (Java, C#, Python, ReactNative, NodeJS, TSql, File, Markdown) — real temp-fixture detection (`supportsProject`/`getProjectTypes`, incl. foreign-project rejection), generic tree-walk, the DATASTORE + Connections behaviour for TSql, a Python `process()` integration, and for Markdown: a documentation-only project end to end, document→section tree expansion, and **hybrid-project ownership** (the markdown processor claims only documents when a language processor is present, everything when it is not).
- **`analyzers/treesitter/TreeSitterEngine.test.ts`** (6) — guards the once-per-process load invariant described below: every grammar parses to a usable `rootNode`, loading a second and third grammar does not disturb the first, the wrapper is cached on the shared native binding, and `parseSource` never returns a null `rootNode`.

### Tree-sitter must load once per process

The core `tree-sitter` JS wrapper may only be **evaluated once per process** — its own source says so. It replaces the native `Tree.prototype.rootNode` with an accessor, having captured the original by destructuring first. `Tree` comes from the native addon, which Node caches per *process*, so a second evaluation destructures the *accessor* (invoked with `this === Tree.prototype`, failing its `this instanceof Tree` guard, yielding `undefined`) and closes over that `undefined`. From then on `tree.rootNode` is `undefined` for the rest of the process.

Under Jest every test file gets a fresh module registry — and a fresh `globalThis` *and* `process`, so no ordinary cache can span them — while the native addon stays shared. The first analyzer suite to load a grammar passed; every later one failed with `Cannot read properties of undefined (reading 'namedChildren')`, which read as flaky cross-suite interference.

`TreeSitterEngine` fixes this by caching the wrapper and the grammar `Language` objects on the one object that *is* process-global: the native binding, reached via `require('node-gyp-build')(<tree-sitter dir>)`, which does **not** evaluate the wrapper. Registries after the first find the cached constructor and never re-require it. Consequently: **load `tree-sitter` only through `TreeSitterEngine`** — a direct `require('tree-sitter')` anywhere else re-breaks every analyzer in the process.

---

## 9. Remaining / future work

1. **Deeper edges** — resolve `Obj.method()` calls where `Obj` is a locally instantiated variable (needs light type inference), `new X()` construction edges, endpoint↔handler, DB FK/view/proc references (TSql), DI wiring.
2. **Higher-fidelity non-TS analyzers** — the Python/Java/C# scanners are heuristic (constructors skipped for Java/C#; cross-file same-package/namespace bases only resolve through explicit import bindings). A real parser (tree-sitter / language server) would raise precision if needed.
3. **Cross-project edges** — ✅ completed via `linkExternalProjects` linking external dependency nodes to publisher project roots.
4. **Category assignment** — attach nodes to the `DefaultReactorNodeCategories` taxonomy during analysis.
5. **Persist folder nodes on demand** if full-tree queries (not just analysed artifacts) become necessary.
6. **Native rst/adoc parsers** — both currently route through the plain-text parser, which picks up their underline/prefix headings but not directives, includes or attribute references. `parseDocument` in `services/graph/documents/index.ts` is the single seam to slot them into.
7. **Docs↔code inference beyond explicit links** — a document that *names* a symbol (rather than linking a path) produces no `DOCUMENTS` edge today. Matching prose mentions against the project's symbol index would connect far more of the documentation, at some precision cost.
8. **Cross-project topics/resources** — `TOPIC` and `RESOURCE` nodes are project-scoped so their `parentId` stays stable. Answering "which projects reference this runbook?" means grouping on `data.url` / `data.slug` across projects, or introducing a global tier.

_Reflects the code on this branch. Key files: `services/graph/GraphIdentity.ts`, `services/graph/analyzers/TypeScriptAnalyzer.ts`, `services/graph/documents/` (`MarkdownParser.ts`, `DocumentGraphEmitter.ts`), `services/ReactorProjectProcessors/BaseProjectProcessor.ts`, `services/SystemGraphManager.ts`, `models/ReactorNodeLink.ts`, `models/ReactorGraphNode.ts`, `graphql/resolvers/ReactorSystemGraph.ts`._
