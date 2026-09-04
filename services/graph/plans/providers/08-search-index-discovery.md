# Session 08 — Search Index Discovery & Agent Affordances

| Field | Value |
|-------|--------|
| **ID** | providers/08 |
| **Priority** | P1 |
| **Estimate** | M |
| **Depends on** | — (independent of 01–07; more valuable once 03/05 add indexes) |
| **Branch** | `feat/graph-providers-08-index-discovery` (reactor) + `reactory-core` module PR |

## 1. Objective

Agents can only search what they can name. Today the only project-aware entry point is
`searchProject` (derives `reactor_graph_<ns>_<name>` itself); the generic `searchContent`
macro falls back to **hard-coded BookTutor indices** (`macro.ts` ~L228) when the model
passes no index, and there is **no way to enumerate indexes at any layer**:

- `ISearchProvider` / `IReactorySearchServiceExt` (`reactory-core/services/search/types.ts`)
  expose search/index/create/delete/count — **no `listIndexes`** (both backends support it:
  MeiliSearch `client.getIndexes()`, ElasticSearch `cat.indices`).
- `GetIndexStatsParams` exists in `ai/macro/data/search/macro.ts` (~L41) but **no macro
  implements it** (dead type).
- Hygiene gap found during analysis: graph GC deletes nodes but **never deletes their
  searchables** — only whole-project deletion drops the index
  (`ReactorProjectService.ts:645`). Deleted files keep surfacing as synthetic fallback
  hits in `searchNodes`.

This session adds enumeration bottom-up (provider → service → curated catalog → macros →
persona instructions) and closes the searchable-GC gap.

## 2. Out of scope

- Cross-index federated ranking / a global index (fan-out stays the model's choice)
- Embedding/semantic search
- Changing `searchProject` / `searchGraph` (already project-aware)

## 3. Allowed files

**`reactory-core` module (separate repo — its own PR):**
- `services/search/types.ts` — `listIndexes?(): Promise<SearchIndexInfo[]>` on
  `ISearchProvider`; `listIndexes()` + `getIndexStats(index)` on `IReactorySearchServiceExt`;
  `SearchIndexInfo = { name, documentCount?, updatedAt?, primaryKey? }`
- `services/search/providers/MeiliSearchProvider.ts` (paginate `getIndexes`),
  `ElasticSearchProvider.ts` (`cat.indices` json)
- `services/ReactorySearchService.ts` — delegate via the existing `requireCapability` guard
- provider tests

**`reactory-reactor` module:**
- `services/SystemGraphManager.ts` — `getSearchIndexCatalog(opts)`
- `ai/macro/data/search/macro.ts` — `listSearchIndexes` + `getIndexStats` macros;
  `searchContent` fallback change
- `ai/persona/booktutor/**` — move book indices to persona defaults
- persona base instructions (where macro guidance is assembled)
- `BaseProjectProcessor.ts` / GC path — searchable deletion parity
- Tests: `services/graph/SearchIndexCatalog.test.ts`, macro tests
- `SystemGraphManager.README.md`

## 4. Design

### 4.1 Curated catalog, not raw backend listing (tenancy)

`SystemGraphManager.getSearchIndexCatalog({ partnerId? })` returns what the **caller may
search**, never the backend's full index list (other tenants/apps share the engine):

```ts
interface SearchIndexCatalogEntry {
  index: string;             // reactor_graph_<ns>_<name>
  kind: 'project' | 'module';
  title: string;             // project fqn / friendly name
  description?: string;      // project.description — this is what the LLM reads
  lastSync?: Date;
  documentCount?: number;    // from provider stats when listIndexes available
  exists: boolean;           // cross-checked against provider listing (stale registration visible)
}
```

Sources: (a) `ReactorProject` records, tenant-filtered like other manager queries —
covers repo, Jira and DB sources uniformly since providers/01 registration also creates
projects; (b) a small static registry hook for module-owned indexes (kb, book-*) so
other modules can contribute entries. Provider `listIndexes` (when the capability
exists) only *annotates* — counts + `exists` — it never *adds* entries.

### 4.2 Macros

- **`listSearchIndexes`** — returns the catalog; `instructions` block teaches the model
  the `reactor_graph_<ns>_<name>` convention and points at `searchContent(indices: […])` /
  `searchProject` for follow-up. `safeForAutoExecution: true`.
- **`getIndexStats`** — implement the dead type: per-index `count` + provider stats.
- **`searchContent` fallback fix** — remove the hard-coded book array. Resolution order
  when no `index`/`indices` given: ① persona-configured default indices (agent yaml /
  persona options via chatState), ② otherwise a **guidance result** (not an error-throw):
  "no index specified — call `listSearchIndexes`", including the catalog's top entries
  inline when cheap. BookTutor keeps its behaviour via ① (persona config), not via a
  global default that silently misroutes every other agent.
- Tool description for `searchContent`'s `index` param updated to name the convention
  and `listSearchIndexes`.

### 4.3 Persona instructions

Add one shared instruction snippet (persona base / macro-suite assembly) for agents
with search tools: *"Never guess index names. Use `listSearchIndexes` to discover
searchable indexes, or `searchProject(projectName)` when you know the project."*
Personas that pin indices (booktutor) declare them in their own config.

### 4.4 Searchable GC parity (hygiene)

Where `process()` GC deletes file/document nodes, also call
`searchService.deleteDocuments(indexName, [logicalKeys of deleted FILE/DOCUMENT nodes])`
(capability-guarded; warn-and-continue when unsupported). Derive logical keys from the
GC'd nodes' persisted `key`/`data.relativePath` — ids in the search index are logicalKey
strings, not numeric ids. Add the same parity to external providers' template
(providers/01 `BaseExternalGraphProvider`) so Jira/DB searchables are GC'd too.

## 5. TDD

- provider fakes: `listIndexes` capability present/absent → service guard behaviour
- catalog: two projects (one other-tenant) + fake provider listing → tenant filtering,
  `exists`/count annotation, module-registry entries
- `searchContent` with no index: persona default honoured; no persona default → guidance
  result, **never** the book indices
- `listSearchIndexes` macro output shape + instructions
- GC parity: process run where a file disappears → `deleteDocuments` called with its
  logicalKey; provider without the capability → warn, no throw
- regression: booktutor flows (existing search tests) still green

## 6. Acceptance criteria

- [ ] `listIndexes` implemented on both providers, capability-guarded on the service
- [ ] `getSearchIndexCatalog` is tenant-filtered and never leaks unknown backend indexes
- [ ] Agents without index knowledge can discover → search in two tool calls
- [ ] Hard-coded book fallback removed; booktutor unaffected (persona config)
- [ ] Deleted files no longer produce stale search hits (GC parity test)
- [ ] README updated (§ search section + provider table note)

## Agent Notes

_(fill in when done)_
