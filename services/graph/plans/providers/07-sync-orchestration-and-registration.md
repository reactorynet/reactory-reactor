# Session 07 — Sync Orchestration, Scheduling & Registration UX

| Field | Value |
|-------|--------|
| **ID** | providers/07 |
| **Priority** | P2 |
| **Estimate** | M |
| **Depends on** | providers/03 or providers/05 (at least one real provider) |
| **Branch** | `feat/graph-providers-07-orchestration` |

## 1. Objective

Make external sources operable: register them through the API/UI, sync them on a
schedule through the existing async job rail, and observe them.

## 2. Design

### 2.1 Registration (GraphQL + form)

- Mutation `ReactorRegisterExternalSource(input: { nameSpace, name, scheme, sourceKey,
  settingKey, options, syncSchedule })` → creates/updates the `ReactorProject` with
  `source` spec + `processors` config (validated: scheme has a registered provider,
  settingKey resolves for the partner — **without** logging its value), then enqueues
  the first catalog job. Companion query `ReactorExternalSources` (list + lastSync +
  job status) and `ReactorRemoveExternalSource` (archives project; graph GC'd on a
  final empty-scope run or explicit `deleteMany({projectId})` — pick one, document it).
- Admin form under `forms/` (module convention — see `forms/providerConfig`,
  `forms/projects`): register/list external sources, show sync state, "Sync now".

### 2.2 Scheduled re-sync

- Verify external projects flow through `enqueueCatalog` → `reactor.CatalogProjectGraph@1.0.0`
  unchanged (they should after providers/01 — this session proves it e2e).
- `syncSchedule` (cron expr) on the source spec; a maintenance workflow enumerates due
  external sources and enqueues catalog jobs (idempotent re-enqueue semantics from
  session 09 apply). Default: daily for `db`, hourly for `jira`.

### 2.3 Observability & resilience

- `GraphProcessMetrics` gains `source: { scheme, sourceKey, truncated, apiCalls, rateLimited }`.
- Failure isolation: a provider throw marks the job FAILED with the error on the
  processing entry; **no GC runs on a failed/partial snapshot** (guard: GC only after
  the discover generator completes — add an explicit test; a half-enumerated Jira scope
  must not delete the other half).
- Jira webhook stub: routed endpoint recorded in the plan but behind a disabled flag —
  full delta sync is future work.

## 3. Allowed files

- `graphql/**` (schema + `ReactorSystemGraph.ts` or a new `ReactorExternalSources.ts` resolver)
- `SystemGraphManager.ts` / `ReactorProjectService.ts` (registration + due-sync enumeration)
- `workflow/` (maintenance workflow yaml)
- `forms/externalSources/` (new)
- Tests: `services/graph/ExternalSourceRegistration.test.ts` (+ partial-failure GC test)
- `SystemGraphManager.README.md`

## 4. Acceptance criteria

- [ ] Register → first sync → browsable graph, all through GraphQL, no server restart
- [ ] Scheduled re-sync enqueues due sources; re-enqueue while active is idempotent
- [ ] Partial-failure run performs **no GC** (test)
- [ ] Metrics visible per source; secrets never logged
- [ ] README updated

## Agent Notes

**Done 2026-09-04.** As designed, with these specifics/deviations:
- **2026-09-04 follow-up:** agent macros landed —
  `ai/macro/projects/ExternalSources.macro.ts`: `listExternalSources` /
  `registerExternalSource` (safeForAutoExecution: false, settingKey-only — the
  tool schema is test-asserted to accept no credential parameters) /
  `syncExternalSource` (targeted or all-due). Registered on the reactor persona
  allowlist alongside listSearchIndexes/getIndexStats. Tests:
  `ai/macro/projects/__tests__/ExternalSources.test.ts` (10).
- **Bug found & fixed:** the async catalog workflow (`CatalogProjectGraph.yaml`) passes
  only id/name — `catalogProject`'s guard threw for source-only projects before
  lookup. The guard now resolves id/fqn-addressed projects first and accepts them
  when the persisted record carries repoPath/repoUrl/source; lookup prefers
  repoPath → repoUrl → id → fqn (repo-project behaviour unchanged).
- Removal semantics chosen: **archive** the project record (audit trail) +
  purge graph nodes/edges and the search index by default (`purgeGraph: false`
  keeps the last snapshot browsable).
- Scheduling: `syncSchedule` cron (cron-parser v5, validated at registration)
  evaluated against `lastSync`; sources without a schedule are never auto-due.
  `reactor.SyncExternalSources@1.0.0` workflow wraps `syncDueExternalSources` —
  wire it to the engine's scheduler tick or call the mutation from any cron.
- Partial-failure GC guard was already implemented + tested in providers/01
  (`ExternalProvider.test.ts` "does NOT GC on a partial snapshot"); this session
  added no further code for it.
- Metrics: `GraphProcessMetrics.sourceScheme/sourceKey` stamped by
  `BaseExternalGraphProvider` (`apiCalls`/`rateLimited` counters deferred —
  the reader owns retries and exposes no counters yet).
- Jira webhook stub: **not implemented** (no dead routes); recorded as future work.
- Form `reactor.ExternalSources@1.0.0` registers via the mutation; a richer
  list/manage panel is client work, out of module scope.
- Tests: `services/graph/ExternalSourceRegistration.test.ts` (15).
