# Session 01 — Provider SPI Extraction & External Identity

| Field | Value |
|-------|--------|
| **ID** | providers/01 |
| **Priority** | P0 |
| **Estimate** | L |
| **Depends on** | root program 01–15 (done) |
| **Branch** | `feat/graph-providers-01-spi` |

---

## 1. Objective

Make "a graph source that is not a folder on disk" a first-class concept:

1. **Extract** the source-agnostic plumbing out of `BaseProjectProcessor` into an
   abstract **`BaseGraphProvider`**: `persistGraph`, `indexSearchables`,
   `loadPreviousNodes` / `loadDescendantNodeIds` / `loadEdgeIdsTouching`, runId
   stamping + GC, `GraphProcessMetrics` emission, node-cache invalidation, tenancy
   stamping, `getProjectNode` (root construction), icon plumbing.
   `BaseProjectProcessor extends BaseGraphProvider` keeps the fs walking,
   `listFiles`, realpath handling, folder chains and `analyseFileFull` exactly as
   they are. **Zero behavior change for fs projects.**
2. Add **`BaseExternalGraphProvider extends BaseGraphProvider`** — a template
   `process()` for remote snapshots (see §4.2).
3. Add **`GraphIdentity.sourceLogicalKey`** — the external-entity identity scheme.
4. Make **registered (repoPath-less) projects** flow through
   `detectProjectProcessors` / `processProject` / `catalogProject` cleanly.

## 2. Out of scope

- Any concrete provider (Jira = session 03, DB = session 05).
- New node/link enum members (session 02).
- Registration UX / GraphQL mutations (session 07).

## 3. Allowed files

- `services/ReactorGraphProviders/BaseGraphProvider.ts` (new)
- `services/ReactorGraphProviders/BaseExternalGraphProvider.ts` (new)
- `services/ReactorProjectProcessors/BaseProjectProcessor.ts` (extraction only — moved code, no logic edits)
- `services/graph/GraphIdentity.ts`
- `services/ReactorProjectService.ts` (detection path for registered sources)
- `types/service.types.ts`, `types/model.types.ts` (source spec types)
- `models/ReactorProject.ts` (persist `source` spec)
- New tests: `services/ReactorGraphProviders/ExternalProvider.test.ts`
- `SystemGraphManager.README.md` (§ new provider architecture bullet)

## 4. Design

### 4.1 External identity (`GraphIdentity`)

```ts
/** Logical key for an entity in an external source.
 *  scheme      short registry name: 'jira' | 'db' | …
 *  sourceKey   stable source identifier (site host, connectionId)
 *  entityPath  slash path inside the source ('WR', 'sales/dbo/orders')
 *  fragment    leaf entity ('WR-123', column name)
 *  → 'jira:worldremit.atlassian.net/WR#WR-123'
 *  → 'db:sales-dwh/dbo/orders#customer_id'
 */
export const sourceLogicalKey = (
  scheme: string, sourceKey: string, entityPath?: string, fragment?: string
): string =>
  `${scheme}:${sourceKey}` +
  (entityPath ? `/${normalizeRelative(entityPath)}` : "") +
  (fragment ? `${SYMBOL_SEP}${fragment}` : "");
```

Properties preserved: id = `nodeId(sourceLogicalKey(...))` is a pure function of the
*reference*, so a doc-mention linker can compute the ticket node id from `WR-123` +
the registered site without fetching anything (mirrors doc-anchor design). The
project **root** node keeps `projectLogicalKey` (fqn) — invariant I3 untouched;
external entities hang under it via `parentId`.

### 4.2 `BaseExternalGraphProvider`

```ts
export interface ExternalEntityBatch {
  nodes: Partial<ReactorNode>[];
  edges: ReactorNodeLink[];
  searchables?: Reactory.Models.ISearchable[];
}
abstract class BaseExternalGraphProvider extends BaseGraphProvider {
  /** scheme + sourceKey for identity; read from project.source */
  abstract sourceScheme(): string;
  abstract sourceKeyFor(project: Partial<IReactorProject>): string;
  /** stream the snapshot in bounded batches (paged API calls) */
  abstract discoverEntities(
    project: Partial<IReactorProject>, options: ProcessOptions
  ): AsyncGenerator<ExternalEntityBatch>;
}
```

`process()` template: root node → for-await each batch → stamp + **persist per
batch** (memory-bounded, unlike the in-memory fs pipeline) → collect seen ids →
GC with runId exactly as today. Incremental skip: providers set
`node.contentHash` from a source version (`updated` timestamp, DDL hash); the
template compares against `loadPreviousNodes` and skips unchanged subtrees,
touching descendants/edges with the current runId (same semantics as session 08).

### 4.3 Registered sources (`IReactorProject.source`)

```ts
export interface IReactorProjectSourceSpec {
  scheme: string;            // 'jira' | 'db'
  sourceKey: string;         // site host / connectionId
  settingKey?: string;       // partner setting holding credentials (P2: never inline)
  options?: any;             // provider-specific scope (projectKeys, jql, schemas…)
}
// IReactorProject: source?: IReactorProjectSourceSpec;
```

`detectProjectProcessors`: when `project.repoPath` is absent and
`project.processors?.length > 0`, return the configured processors verbatim
(validated against the registry) — do not run fs `supportsProject` probes.
External providers implement `supportsProject` as
`project.source?.scheme === this.sourceScheme()` (P3: no network, no fs).

### 4.4 Refactor rules

- Move code verbatim; `BaseProjectProcessor` keeps its public surface so all
  processors and `SystemGraphManager` dispatch compile untouched.
- `getProjectNode` gets the root type/source from overridable hooks
  (`rootNodeType()` exists; add `rootSource(project)` defaulting to `repoPath`).
- No `fs` import in `BaseGraphProvider` / `BaseExternalGraphProvider`.

## 5. TDD

`ExternalProvider.test.ts` with a `FakeTicketProvider` (canned 2-batch generator):
- builds root + entities with `sourceLogicalKey` ids; re-run idempotent (same ids)
- per-batch persistence (spy: persist called ≥ 2×), GC removes entities absent
  from the second run, `runId: 'manual'` edges survive
- incremental: unchanged `contentHash` skips node rebuild, touches runId
- registered project (no repoPath) resolves configured processor through
  `detectProjectProcessors` and `processProject`
- **regression:** full existing suite green (`GraphBuilding`, `IncrementalProcess`,
  `ProcessOrchestration`, all processor tests)

## 6. Acceptance criteria

- [ ] `BaseGraphProvider` has no `fs`/`path`-walk code; fs behavior unchanged (69/989 baseline green)
- [ ] `sourceLogicalKey` exported + unit-tested (separators, normalization, no collisions with `pathLogicalKey` space)
- [ ] Repo-path-less registered project catalogues end-to-end via FakeTicketProvider
- [ ] `SystemGraphManager.README.md` gains a "Provider SPI" bullet

## Agent Notes

_(fill in when done)_
