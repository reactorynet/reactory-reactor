# Session 02 — Graph Vocabulary & Client Parity

| Field | Value |
|-------|--------|
| **ID** | providers/02 |
| **Priority** | P0 |
| **Estimate** | S |
| **Depends on** | — (independent; must land before 03/05) |
| **Branch** | `feat/graph-providers-02-vocabulary` (server) + client PR |

## 1. Objective

Additive vocabulary for external domains, mirrored in all three places that must
agree: server enums, GraphQL enums, client `GraphExplorer` styling maps.

## 2. New members

### `ReactorNodeType` (`types/model.types.ts`)

| Member | Meaning | Domain |
|--------|---------|--------|
| `TICKET` | a work item (Jira issue, story, bug, epic — `data.issueType` disambiguates) | jira |
| `BOARD` | an agile board (scrum/kanban) | jira |
| `SPRINT` | a sprint / iteration | jira |
| `PERSON` | a user/assignee referenced by external entities (source-scoped, like `TOPIC`) | shared |
| `SCHEMA` | a database schema/namespace | db |
| `TABLE` | a table | db |
| `VIEW` | a view | db |
| `COLUMN` | a column | db |
| `PROCEDURE` | stored procedure / function / routine | db |

(`DATASTORE` and `CONNECTION` already exist and are reused as the DB root/connection.)

### `ReactorLinkType`

| Member | Meaning | Notes |
|--------|---------|-------|
| `BLOCKS` | A blocks B | Jira "Blocks" link |
| `DUPLICATES` | A duplicates B | Jira "Cloners/Duplicate" |
| `RELATES` | A relates to B | Jira "Relates" + unknown link types (title = raw name) |
| `PART_OF` | A is a member of B (ticket→sprint, ticket→epic, ticket→board) | **not** CONTAINS (I8: CONTAINS stays synthesized-from-parentId only) |
| `ASSIGNED_TO` | ticket → PERSON | |
| `FOREIGN_KEY` | column→column and table→table FK | `data.constraintName` |

Each with the same doc-comment style as `DOCUMENTS`/`MENTIONS`.

## 3. Allowed files

- `types/model.types.ts` — enum members + comments
- `graphql/**` — mirror both enums (additive only, P5); find the schema files that
  declare `ReactorNodeType` / `ReactorLinkType`
- **client repo** `reactory-pwa-client/src/components/shared/GraphExplorer/constants.ts`
  (+ `types.ts` if it enumerates types): node **color / icon / size** map entries and
  link **color** entries for every member above. Follow the existing palette voice
  (comments like `// silkscreen white`); suggested icons: ticket→`task_alt`,
  board→`view_kanban`, sprint→`sprint`/`timer`, person→`person`, schema→`schema`,
  table→`table_chart`, view→`table_view`, column→`view_column`, procedure→`functions`.
- Client `NeuralGraphViewer` adapter if it re-declares maps (check parity note in
  `GraphExplorer` — one engine, 2D+3D renderers share the maps).

## 4. Rules

- Additive only; no renames, no re-ordering that changes serialized values.
- Unknown-type fallback styling must keep working (nodes with types the client
  doesn't know yet should already render with a default — verify, don't break).
- Server and client are **separate repos/release trains**: server enums first,
  client PR alongside; the GraphQL enum addition is backward-compatible for old clients.

## 5. Acceptance criteria

- [ ] Server + GraphQL enums compile; existing suites green
- [ ] Client styling maps cover all new members in 2D and 3D renderers
- [ ] A hand-inserted TICKET node (mongo shell / test fixture) renders styled in GraphExplorer

## Agent Notes

**Done 2026-09-03.**
- Server: 9 node types + 6 link types added to `types/model.types.ts` (doc-commented)
  and mirrored in `graphql/schema/ReactorSystemGraph/types.graphql` (fragment parse
  verified). Additive only.
- Drift guard: `services/graph/EnumParity.test.ts` asserts the GraphQL enums equal
  the TS enums exactly (3 tests).
- Client (`reactory-pwa-client`): `GraphExplorer/types.ts` unions +
  `GraphExplorer/constants.ts` NODE color/icon/radius maps and LINK color map;
  `PART_OF`/`ASSIGNED_TO`/`RELATES` added to `DASHED_LINK_TYPES` (annotative).
  Palette: tracker family = status-LED amber/indigo/green/pink; DB family = cyan
  DATASTORE lineage. Both 2D and 3D renderers consume these shared maps with
  `?? UNKNOWN` fallback; `NeuralGraphViewer` reuses the same engine — no second map.
  Parity is compiler-enforced (`Record<GraphNodeType, ...>`): scoped tsc exit 0,
  GraphExplorer suites 62/62, neuralGraph 16/16.
- Visual check of a hand-inserted TICKET node left to manual verification (needs a
  running client).
