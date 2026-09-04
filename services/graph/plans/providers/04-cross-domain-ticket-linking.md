# Session 04 — Cross-Domain Ticket Linking (docs/code ↔ Jira)

| Field | Value |
|-------|--------|
| **ID** | providers/04 |
| **Priority** | P1 |
| **Estimate** | M |
| **Depends on** | providers/03 (and root sessions 12, 13 as templates) |
| **Branch** | `feat/graph-providers-04-ticket-links` |

## 1. Objective

The joined-graph payoff: connect catalogued repos/docs to catalogued Jira tickets.
Three linkers, all idempotent, all emitting edges **only when the target ticket's
Jira source is catalogued** (I4/P6 — no stub creation from this side):

1. **Ticket-key mentions in documents** — `WR-1234` in prose/inline-code →
   `MENTIONS` edge (section-or-document → ticket), confidence metadata.
2. **RESOURCE URL upgrade** — existing `RESOURCE` nodes whose normalized URL matches
   `https://<site>/browse/<KEY-123>` (or `/jira/software/.../issues/<KEY>`) →
   `REFERENCE` edge resource → ticket.
3. **`project.tasksUrl`** — repo project root → `REFERENCE` → Jira project node.

## 2. Out of scope

- Commit/branch/PR mention scanning (no git-history graph yet — note as future)
- Creating ticket nodes from mentions (registration is the only creator, P3)
- Confluence links

## 3. Allowed files

- `SystemGraphManager.ts` — `linkTicketMentions(projectId?)` (mirror `linkExternalProjects`)
- `services/ReactorProjectProcessors/BaseProjectProcessor.ts` — mention scan hook in the
  doc pass (guarded by `linkTicketMentions: boolean` option, default **true**)
- `graphql/resolvers/ReactorSystemGraph.ts` + schema — `ReactorLinkTicketMentions` mutation (additive)
- Tests: `services/graph/TicketLinking.test.ts`
- `SystemGraphManager.README.md`

## 4. Design

### 4.1 Ticket index (the "publisher index" analogue)

Once per link pass, build from catalogued Jira sources:
```
projectKeyUpper → { site, jiraProjectNodeId }
```
Sources: `ReactorProject` records where `source.scheme === 'jira'`, reading
`source.sourceKey` + `options.projectKeys`. A mention emits an edge iff its key
prefix is in this index; the ticket node id is **computed** —
`nodeId(sourceLogicalKey('jira', site, KEY, KEY-123))` — never fetched.

Precision guard: an in-scope prefix does **not** guarantee the specific ticket was
synced (out of JQL window). Emit anyway but stamp `data.resolved: false` when the
target node is absent at link time; the edge id is deterministic, so a later sync
"heals" it. Alternative (stricter, rejected): check node existence per edge —
O(mentions) queries. Batch-check with one `$in` query instead and stamp accurately.

### 4.2 Mention pass (session-13 discipline)

- Regex `\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b` over document text, matched in
  **inline-code** (`confidence: 0.95, match: 'inline-code'`) and **prose**
  (`confidence: 0.85, match: 'prose'`).
- Origin = containing SECTION node when there is one, else the DOCUMENT node
  (same rule as doc links).
- Denylist non-ticket lookalikes (`UTF-8`, `ISO-8601`, `SHA-256`, `RFC-2119`,
  `TLS-1.2`-style): reject when the prefix is in a stopword set
  (`UTF, ISO, SHA, RFC, TLS, MD, AES, RSA, GPT, EC` …) — the ticket index check
  already excludes most, keep the denylist for defense in depth.
- Runs where session 13's symbol-mention pass runs (post-process linker phase);
  edges stamped with the current runId → GC'd naturally with the doc project.

### 4.3 RESOURCE upgrade + tasksUrl

`linkTicketMentions` also scans `RESOURCE` nodes (`data.url`) of the target project
(or all, when called without projectId) against registered site hosts, and repo
projects' `tasksUrl` against Jira project browse URLs. Edges `runId: 'manual'`
when created outside a catalog run (session 12 precedent). Runs automatically at
the end of `catalogProject` (after `linkExternalProjects`) and on demand via the
mutation.

## 5. TDD

- fixture: markdown project mentioning `WR-1`, `FAKE-9` (unregistered), `UTF-8`;
  registered fake Jira source with `projectKeys: ['WR']` → exactly one MENTIONS
  edge, computed target id, correct origin section
- resource node `https://site/browse/WR-1` → REFERENCE edge; unrelated URL → none
- tasksUrl → project-root edge
- idempotence (re-run: same edge ids), GC survival semantics
- `resolved` stamping: synced vs unsynced ticket

## 6. Acceptance criteria

- [ ] Doc mentioning a registered ticket key links to the ticket node in the explorer
- [ ] No edges for unregistered prefixes or denylisted lookalikes
- [ ] Mutation + auto-run wired; README updated

## Agent Notes

**Done 2026-09-04.** As designed, with these specifics:
- Shared helpers in `services/graph/ticketLinking.ts`: `TICKET_KEY_RE`, prefix denylist,
  `buildTicketSourceIndex` (from `source.scheme: 'jira'` projects), `ticketNodeIdFor` /
  `jiraProjectNodeIdFor` (computed ids, P1), `parseJiraUrl` (browse + software URLs),
  `scanTicketMentions` (outline-aware: section attribution by innermost line range,
  inline-code by backtick parity or fenced-block range, per-section dedupe).
- Mention pass = a third pass in `BaseProjectProcessor.process` (after session 13's
  symbol mentions), option `linkTicketMentions` default **true**; hooks
  `loadTicketSourceIndex` / `loadExistingNodeIds` are protected and test-overridable.
  Edges carry current runId → GC'd with the doc project naturally.
- `resolved` stamping via one `$in` existence query per pass (both in-process and
  manager passes) — emitted regardless, healed by later Jira syncs (deviation from a
  strict per-edge check, as the plan recommended).
- Manager pass covers RESOURCE URLs + tasksUrl only (doc text is not persisted, so
  document scanning belongs to process()); runs in `processProject.onAfterAll` after
  `linkExternalProjects`, and via `ReactorLinkTicketMentions` (schema parse verified).
- Commit/branch/PR mention scanning remains future work (no git-history graph).
- Tests: `services/graph/TicketLinking.test.ts` (14) — helper units, Markdown-processor
  integration (real temp fixture), manager pass with mocked models.
