# External Graph Providers Program — Agent Session Plans

> **Audience:** Isolated coding agents (~256k context) — same conventions as `../00-README.md`.
> **Goal:** Extend the SystemGraph beyond on-disk sources: graph **Jira projects, boards, sprints and tickets**, **database systems** (schemas, tables, views, columns, FKs) and future external sources, and **link them to the code + documentation graph**.
> **Source analysis date:** 2026-09-03
> **Code root:** `reactory-express-server/src/modules/reactory-reactor/`

---

## Why this program

The engine now graphs any on-disk source (code AST, documents, DevOps configs) with
deterministic identity, incremental re-index, GC, tenancy, search and async jobs
(sessions 01–15, all done). Everything an engineer touches that is **not on disk** —
the ticket the branch was cut for, the database a service reads — is still invisible,
or at best a dead-end `RESOURCE` URL node.

The payoff of this program is the *joined* graph:

- "which docs/sections/commits mention **WR-1234**?" — ticket nodes reachable from prose
- "what does this service's board look like right now?" — boards/sprints/tickets in the explorer
- "which tables does this project's datastore expose, and what references them?"

## Investigation summary (what already exists — build on it, don't reinvent)

| Capability | Where | Status |
|---|---|---|
| Provider dispatch by `node.providerId → context.getService<IProjectProcessor>()` | `SystemGraphManager.getChildren` (~L134) | ✅ the SPI seam already exists |
| `IReactorProject.repoPath` is **optional**; `processors[]` config with `options` per project | `types/service.types.ts` (~L1042, L1066) | ✅ external projects representable |
| Explicit processor config honoured in `processProject` (`getService(idOrFqn)`) | `ReactorProjectService.ts` ~L909–935 | ✅ bypasses disk detection |
| Synthetic non-fs nodes precedent (Connections node, DATASTORE root) | `ReactorProjectProcessors/TSql/TSqlProjectProcessor.ts` | ✅ pattern to copy |
| Jira REST client: issues, JQL search, projects, boards, sprints, comments, attachments (+ retry) | `modules/reactory-atlassian/services/JiraReaderService.ts`, `AtlassianConfigurationService.ts` | ✅ reuse as service dependency |
| Multi-variant DB connections per partner (`mongo/mysql/postgres/mssql/databricks`) | `src/database/connections.ts`, `database/types.ts` (`IReactoryConnectionProvider`) | ✅ reuse for DB provider |
| Persistence, GC by runId, incremental contentHash skip, search indexing, metrics, tenancy, cache busting | `BaseProjectProcessor.ts` (`process`, `persistGraph`, …) | ⚠️ exists but **fused with fs walking** — must be extracted |
| Cross-project linker precedent (publisher index → idempotent edges) | `SystemGraphManager.linkExternalProjects` (session 12) | ✅ template for ticket-mention linker |
| Doc symbol-mention pass with confidence + denylist discipline | session 13 (`BaseProjectProcessor`) | ✅ template for ticket-key mentions |
| Node types `DATASTORE`, `CONNECTION`, `RESOURCE`, `TOPIC`, `SYSTEM`, `ENDPOINT` | `types/model.types.ts` | ✅ partial vocabulary |
| Client styling maps (node colors/icons/sizes, link colors) | `reactory-pwa-client/src/components/shared/GraphExplorer/constants.ts` | ⚠️ needs new-type entries (separate repo) |
| Async catalog jobs + workflow engine + job status | session 09 (`enqueueCatalog`, `reactor.CatalogProjectGraph@1.0.0`) | ✅ external syncs ride the same rail |

### The gaps this program closes

1. **`BaseProjectProcessor` conflates graph assembly with filesystem walking.** External
   providers need persistence/GC/identity/search/metrics *without* `fs`. → Session 01
   extracts `BaseGraphProvider` (plumbing) and adds `BaseExternalGraphProvider` (batched
   remote snapshots).
2. **No identity scheme for external entities.** `npm:<pkg>` / `topic:` / `resource:` are
   the precedents; we need `jira:<site>/<KEY>` and `db:<connectionId>/<schema>/<table>#<col>`
   logical keys, computable from a reference alone (same property that makes doc anchors
   resolvable without parsing the target). → Session 01.
3. **Detection assumes disk.** External sources cannot be auto-detected; they are
   **registered** (a `ReactorProject` with a `source` spec and explicit `processors`
   config). → Sessions 01 & 07.
4. **Vocabulary.** No TICKET/BOARD/SPRINT/TABLE/COLUMN node types, no BLOCKS/FOREIGN_KEY
   link types, and the client styling maps don't know them. → Session 02.
5. **No search-index discovery.** Nothing at any layer enumerates indexes
   (`ISearchProvider` lacks `listIndexes`; the `searchContent` macro falls back to
   hard-coded BookTutor indices), and graph GC never deletes searchables. → Session 08.
6. **No cross-domain edges.** A doc that says `WR-1234`, a RESOURCE node holding a
   `…/browse/WR-1234` URL, and the ticket itself are three unconnected things. → Session 04.

---

## Non-negotiable design invariants

All of I1–I9 from `../00-README.md` still apply. This program adds:

| # | Invariant | Rationale |
|---|-----------|-----------|
| P1 | External logical keys use `scheme:<source-key>[/<entity-path>][#<fragment>]` via `GraphIdentity.sourceLogicalKey` — never ad-hoc `Hash()` calls in providers | keeps ids computable from a reference alone (cross-domain edges depend on it) |
| P2 | **No credentials or connection strings on nodes, ever.** Nodes carry a `connectionId` / setting key only; secrets resolve at runtime via partner settings (`context.partner.getSetting`) | tenancy + publicNode redaction already assume this |
| P3 | External sources are **registered, not detected**. `supportsProject` for external providers checks the project's `source`/`processors` spec, never the filesystem or the network | detection must stay cheap and side-effect free |
| P4 | Snapshots are **bounded and the bound is logged** (`maxIssues`, schema allow-list). Silent truncation is a bug | "no silent caps" |
| P5 | GraphQL/schema changes are **additive only** (new enum members, new mutations) | client is a separate repo/release train |
| P6 | An edge to an out-of-scope external entity either gets a **stub node** created by the same provider run, or is not emitted (I4 extended) | issue links routinely point outside the sync scope |

---

## Sessions & execution order

```
01 provider SPI + external identity ──────────────┐  (server refactor, no new features)
02 vocabulary + client parity ── independent ─────┤
03 jira provider ── after 01+02 ──────────────────┤
04 cross-domain ticket linking ── after 03 ───────┤
05 database provider ── after 01+02 (∥ with 03) ──┤
06 code↔db linking ── after 05 (optional/P4) ─────┤
07 orchestration + registration UX ── after 03/05 ─┤
08 search index discovery ── independent ─────────┘
```

| Wave | Sessions | Notes |
|------|----------|-------|
| A | **01**, **02**, **08** | 01 is the enabler; 02 and 08 are independent (08 spans reactory-core) |
| B | **03**, **05** | parallel — different external domains, same SPI |
| C | **04**, **07** | 04 needs ticket nodes; 07 needs at least one real provider |
| D | **06** | optional, precision-sensitive |

## Session status board

| ID | File | Priority | Est. | Status | Owner |
|----|------|----------|------|--------|-------|
| 01 | `01-provider-spi-and-identity.md` | P0 | L | done | |
| 02 | `02-graph-vocabulary-and-client-parity.md` | P0 | S | done | |
| 03 | `03-jira-graph-provider.md` | P1 | L | done | |
| 04 | `04-cross-domain-ticket-linking.md` | P1 | M | pending | |
| 05 | `05-database-graph-provider.md` | P1 | L | pending | |
| 06 | `06-code-db-linking.md` | P4 | M | pending | |
| 07 | `07-sync-orchestration-and-registration.md` | P2 | M | pending | |
| 08 | `08-search-index-discovery.md` | P1 | M | pending | |

Status values: `pending` | `in_progress` | `blocked` | `done` | `wontfix`

---

## Testing conventions

Same as `../00-README.md` (`NODE_OPTIONS=--max-old-space-size=6144 npx jest <path> --forceExit`,
`--maxWorkers=1` when memory-constrained). Additional rules for this pack:

- **No live network / no live databases in tests.** Jira tests mock `JiraReaderService`
  (inject via service override or constructor); DB tests use a fake introspection
  adapter returning canned `information_schema` rows.
- Baseline suites that must stay green when `BaseProjectProcessor` is touched:
  `GraphBuilding.test.ts`, `DocumentGraph.test.ts`, `IncrementalProcess.test.ts`,
  `ProcessOrchestration.test.ts`, all processor tests. The whole module is currently
  **69 suites / 989 tests green** — keep it that way.

## Definition of done (program level)

- [ ] `BaseGraphProvider` (persistence/GC/search/metrics) is source-agnostic; fs processors and external providers share it; zero behavior change for fs projects.
- [ ] A registered Jira source produces a browsable, searchable, incrementally-synced subgraph (projects → boards/sprints → tickets, with issue-link edges).
- [ ] `WR-1234` in a markdown doc and a `…/browse/WR-1234` RESOURCE node both resolve to REFERENCE/MENTIONS edges onto the ticket node (when that Jira source is catalogued).
- [ ] A registered database connection produces a DATASTORE subgraph (schemas → tables/views/procs → columns) with FOREIGN_KEY edges, no secrets persisted.
- [ ] External syncs run through the existing async job/workflow rail with status, metrics and scheduled re-sync.
- [ ] GraphExplorer renders every new node/link type with dedicated styling (client repo PR).
- [ ] Agents can **discover** searchable indexes (`listSearchIndexes` → curated, tenant-filtered catalog) instead of guessing; `searchContent` has no hard-coded index fallback; graph GC removes stale searchables.
