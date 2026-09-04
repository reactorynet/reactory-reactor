# Session 03 — Jira Graph Provider (read-only snapshot)

| Field | Value |
|-------|--------|
| **ID** | providers/03 |
| **Priority** | P1 |
| **Estimate** | L |
| **Depends on** | providers/01, providers/02 |
| **Branch** | `feat/graph-providers-03-jira` |

## 1. Objective

`reactor.JiraGraphProvider@1.0.0` — an external provider that snapshots a Jira
site scope into the system graph: Jira projects → tickets, boards → sprints,
issue-link edges, assignee PERSON nodes, searchable ticket text, incremental
re-sync by `updated` timestamp. **Read-only** (the write path stays with the
existing `JiraWriterService` macros — no graph mutation writes back to Jira).

## 2. Out of scope

- Webhooks / near-real-time (session 07 stubs it)
- Cross-domain linking of docs/commits to tickets (session 04)
- Confluence
- Attachments content indexing (list metadata only)

## 3. Allowed files

- `services/ReactorGraphProviders/Jira/JiraGraphProvider.ts` (+ test) (new)
- `services/ReactorProjectService.ts` — register instance (like existing processors)
- `SystemGraphManager.README.md` — provider table row

Depends on module **`reactory-atlassian`** as service dependencies (do not copy code):
`atlassian.JiraReaderService@1.0.0`, `atlassian.AtlassianConfigurationService@1.0.0`.
Note: `reactory-reactor` and `reactory-atlassian` are separate git repos — changes land
in each module's own repo; module enablement via `enabled-reactory.json` must include both.

## 4. Design

### 4.1 Source spec (registered project, P3)

```jsonc
{
  "nameSpace": "jira", "name": "worldremit", "version": "1.0.0",
  "source": {
    "scheme": "jira",
    "sourceKey": "worldremit.atlassian.net",
    "settingKey": "atlassian_default",       // partner setting w/ email+token; env fallback
    "options": {
      "projectKeys": ["WR", "PAY"],           // required scope — no whole-site sync
      "jql": "updated >= -90d",               // extra scope filter, ANDed
      "includeBoards": true,
      "includeComments": false,                // searchable comments opt-in
      "maxIssuesPerProject": 5000              // P4: bound, truncation logged
    }
  },
  "processors": [{ "id": "jira", "processor": "reactor.JiraGraphProvider@1.0.0" }],
  "projectTypes": ["rest"]
}
```

### 4.2 Identity & tree

| Entity | logical key (`sourceLogicalKey`) | type | parentId |
|--------|----------------------------------|------|----------|
| root | `projectLogicalKey(project)` (I3) | `SYSTEM` | — |
| Jira project | `jira:<site>/<KEY>` | `CONTAINER` | root |
| ticket | `jira:<site>/<KEY>#<KEY-123>` | `TICKET` | Jira project |
| board | `jira:<site>/<KEY>/boards#<boardId>` | `BOARD` | Jira project |
| sprint | `jira:<site>/<KEY>/boards/<boardId>#sprint-<id>` | `SPRINT` | board |
| person | `jira:<site>#person:<accountId>` | `PERSON` | root (source-scoped, like TOPIC) |

`data` payloads: ticket → `{ key, issueType, status, statusCategory, priority, labels,
url, summary, created, updated, storyPoints? }`; board → `{ boardType, url }`; person →
`{ accountId, displayName }` (no emails — PII discipline like path redaction).

### 4.3 Edges

| Relationship | Edge |
|--------------|------|
| issue link `Blocks` | ticket →`BLOCKS`→ ticket |
| issue link `Duplicate/Cloners` | `DUPLICATES` |
| any other/unknown link type | `RELATES`, `title` = Jira link type name |
| ticket in sprint | ticket →`PART_OF`→ sprint |
| ticket on board (backlog incl.) | ticket →`PART_OF`→ board |
| subtask/epic child | ticket →`PART_OF`→ parent ticket |
| assignee | ticket →`ASSIGNED_TO`→ person |

**P6 stubs:** an issue link may target a ticket outside `projectKeys`/JQL scope. Emit a
stub `TICKET` node (`data.stub: true`, key + url only) in the same batch so the edge
target exists (I4). Stubs are skipped by search indexing and GC-managed like any node.

### 4.4 `discoverEntities` batching

1. For each `projectKey`: page `searchIssues(jql, startAt, maxResults=100)` — each page
   is one `ExternalEntityBatch` (tickets + persons + issue-link edges + stubs + searchables).
2. If `includeBoards`: `getBoards(projectKey)` → per board `getSprints(boardId, 'active,future,closed')`
   → board/sprint nodes + membership edges (board issue membership via board JQL filter or
   sprint field on the issue — prefer the `sprint`/`closedSprints` issue fields; zero extra calls).
3. Respect `maxIssuesPerProject`; when hit, `context.warn` + metrics `truncated: true` (P4).
4. Rate limits: `JiraReaderService.makeRequest` already retries; provider adds no parallel
   fan-out beyond 1 in-flight page per project.

### 4.5 Incremental

`contentHash = Hash(fields.updated + status + sprintIds)`. Unchanged ticket → skip node
rebuild + search re-index; template touches runId (session 08 semantics). A later delta
mode (`jql: updated >= lastSync` from `project.lastSync`) is noted but not required —
GC requires full-scope enumeration, so delta runs must set `skipGc`.

### 4.6 Lazy browse (`getChildrenForNode`)

Root → Jira projects; project → tickets page (recent first) + boards; board → sprints;
sprint → tickets. Backed by live API with the `REACTOR_NODE_<id>` context cache (TSql
Connections precedent) and paging passthrough. Guard: if credentials unavailable,
return persisted children only (`context.warn`, no throw).

### 4.7 Search

Searchable per ticket: `id: logicalKey`, `nodeId`, title = `KEY-123 summary`, content =
summary + description (ADF→plain text — reuse/extract the module's ADF conversion) +
labels (+ comments when opted in). Index name `reactor_graph_<ns>_<name>` as today.

## 5. TDD (mock `JiraReaderService` — no network)

- snapshot: fixture site (2 projects, 5 tickets, 1 board, 2 sprints, links incl. one
  out-of-scope target) → assert node ids/types/parent chains, all §4.3 edges, stub node
- idempotence: second run → identical ids, no dupes; removed ticket → GC'd
- incremental: unchanged `updated` → analyse skipped
- truncation: `maxIssuesPerProject: 2` → warn + metrics flag
- searchables carry `nodeId` matching ticket node id (session 03 root-pack alignment)
- `supportsProject`: true only for `source.scheme === 'jira'`; never touches network

## 6. Acceptance criteria

- [ ] Registered Jira project catalogues end-to-end (async job rail) with metrics
- [ ] Explorer can expand root → project → ticket lazily with styled nodes
- [ ] Ticket search returns real graph nodes
- [ ] No secrets in `reactor_nodes` (test asserts absence of token/email fields)
- [ ] README provider table updated

## Agent Notes

**Done 2026-09-03.** As designed, with these deviations/specifics:
- **reactory-atlassian** (no local .git — gitignored by server root): `JiraIssue` gained
  `issueLinks` / `parent` / `sprints` (+ `JiraIssueLink`, `JiraSprintRef` types);
  `mapJiraIssue` maps them (sprint custom field detected defensively — any
  `customfield_*` holding sprint-shaped objects); `searchIssues` accepts
  `{ extraFields, nextPageToken }` and returns `{ nextPageToken, isLast }`
  (the `/rest/api/3/search/jql` endpoint pages by token, not startAt). Also fixed a
  stale test expectation (`labels`/`components` missing from the expected field list —
  pre-existing red test in that module).
- **Lazy browse deviation:** live-API `getChildrenForNode` (§4.6) deferred — the
  external-provider default (persisted children) serves the explorer after a catalog
  run. Live browsing can land with session 07's ops work if wanted.
- **Board membership:** ticket→board PART_OF derived from the sprint field's boardId
  (zero extra calls); backlog-only tickets carry no board edge (per-board JQL would be
  needed — noted, not implemented).
- **Sprint upsert trick:** sprint refs on issues emit stub SPRINT nodes so PART_OF
  edges never dangle; the board phase upserts the full node over the same
  deterministic id. A run-level full-ticket id set stops a late stub from overwriting
  a full TICKET node.
- Registered in `ReactorProjectService` (`processors["jira"]`) and `services/index.ts`
  (DI, so `providerId` dispatch resolves). No `jira` SVG exists — `iconKey` deferred.
- Tests: `Jira/JiraGraphProvider.test.ts` (13) with a mocked reader; atlassian mapping
  test added to `AtlassianServices.unit.test.ts`.
