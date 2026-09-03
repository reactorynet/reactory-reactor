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

_(fill in when done)_
