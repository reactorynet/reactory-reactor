# Session 05 — Database Graph Provider (schema introspection)

| Field | Value |
|-------|--------|
| **ID** | providers/05 |
| **Priority** | P1 |
| **Estimate** | L |
| **Depends on** | providers/01, providers/02 (parallel with 03) |
| **Branch** | `feat/graph-providers-05-database` |

## 1. Objective

`reactor.DatabaseGraphProvider@1.0.0` — snapshot a **live database's structure**
(never row data) into the graph: DATASTORE root → SCHEMA → TABLE/VIEW/PROCEDURE →
COLUMN, with FOREIGN_KEY and view-dependency edges, incremental by definition hash.
Complements (does not replace) `TSqlProjectProcessor`, which graphs SQL *project
files* on disk.

## 2. Out of scope

- Row data, sampling, profiling (explicitly never — compliance)
- Query-log lineage
- Code↔table linking (session 06)
- MongoDB collection inference (variant left as a follow-up; SQL variants first)

## 3. Allowed files

- `services/ReactorGraphProviders/Database/DatabaseGraphProvider.ts` (new)
- `services/ReactorGraphProviders/Database/introspection/{mysql,postgres,mssql,databricks}.ts`
  (new — per-variant `IIntrospectionAdapter`)
- `services/ReactorProjectService.ts` — register instance
- Tests: `services/ReactorGraphProviders/Database/DatabaseGraphProvider.test.ts`
- `SystemGraphManager.README.md`

Uses core `src/database/connections.ts` (`getConnection(connectionId, context)` — resolves
per-partner settings, variants `mysql | postgres | mssql | databricks`) and
`IReactoryConnectionProvider`. **P2:** the project stores only `connectionId`; credentials
live in partner settings.

## 4. Design

### 4.1 Source spec

```jsonc
{
  "source": {
    "scheme": "db",
    "sourceKey": "sales-dwh",              // = connectionId
    "options": {
      "variant": "postgres",
      "schemas": ["public", "billing"],    // allow-list; default: all non-system, logged (P4)
      "includeViews": true,
      "includeRoutines": true,
      "maxTablesPerSchema": 2000
    }
  },
  "processors": [{ "id": "db", "processor": "reactor.DatabaseGraphProvider@1.0.0" }],
  "projectTypes": ["postgresql"]
}
```

### 4.2 Introspection adapter (testable seam)

```ts
interface IIntrospectionAdapter {
  listSchemas(): Promise<string[]>;
  listRelations(schema): Promise<RelationMeta[]>;   // tables + views (+ comment, type)
  listColumns(schema, relation): Promise<ColumnMeta[]>; // name, dataType, nullable, default, ordinal, comment, isPk
  listForeignKeys(schema): Promise<FkMeta[]>;       // constraintName, src/dst schema.table.column[]
  listRoutines(schema): Promise<RoutineMeta[]>;     // name, kind, args signature, comment
  listViewDependencies?(schema): Promise<ViewDepMeta[]>; // where the variant supports it
}
```
Implemented over `information_schema` (+ `pg_catalog` comments for postgres,
`sys.*` + extended properties for mssql, `SHOW`/`information_schema` for databricks).
Provider logic is adapter-agnostic → unit tests run against a fake adapter, variant
SQL builders get their own string-level tests. **Read-only:** adapters run SELECT-only
statements; recommend a read-only DB account in the README row.

### 4.3 Identity & tree

| Entity | logical key | type | parentId |
|--------|-------------|------|----------|
| root | `projectLogicalKey(project)` | `DATASTORE` | — |
| connection info | synthetic child (TSql precedent) | `CONNECTION` | root |
| schema | `db:<connectionId>/<schema>` | `SCHEMA` | root |
| table / view | `db:<connectionId>/<schema>/<relation>` | `TABLE` / `VIEW` | schema |
| column | `db:<connectionId>/<schema>/<relation>#<column>` | `COLUMN` | table/view |
| routine | `db:<connectionId>/<schema>/routines#<name(signature)>` | `PROCEDURE` | schema |

`data`: table → `{ relationKind, comment, columnCount, pkColumns }`; column →
`{ dataType, nullable, default, ordinal, isPk, comment }`. `publicNode` redaction:
never expose host/port — `data.connectionId` only (extend the path-redaction test).

### 4.4 Edges

- FK: column →`FOREIGN_KEY`→ referenced column **and** table →`FOREIGN_KEY`→ referenced
  table (`title: constraintName`, deduped by linkId). Cross-schema FKs fine (same source).
- View deps (where available): view →`DEPENDENCY`→ table.
- FK targeting a non-allow-listed schema → stub TABLE node (`data.stub: true`, P6).

### 4.5 Batching, incremental, search, lazy browse

- `discoverEntities`: one batch per schema (columns+FKs together); bounded by
  `maxTablesPerSchema` with logged truncation (P4).
- `contentHash` per relation = hash of ordered column tuples (+ view definition hash
  when retrievable); unchanged relation skips rebuild/re-index (session 08 semantics).
- Searchables: qualified name + column names + comments; title `schema.table`.
- `getChildrenForNode`: persisted-first; live introspection refresh only on explicit
  re-catalog (DBs are slow/priv-sensitive — do **not** hit the DB per tree expand;
  differs from Jira's live browse, note in README).

## 5. TDD (fake adapter — no live DB)

- fixture: 2 schemas, 3 tables (composite-key FK, cross-schema FK to non-listed schema),
  1 view + dependency, 1 routine → node tree, both FK edge levels, stub node
- idempotence + GC (dropped table disappears next run)
- incremental: identical column set → skipped; added column → re-analysed
- redaction: no host/user/password anywhere in persisted nodes (assert)
- variant SQL builders: statement snapshots for mysql/postgres/mssql

## 6. Acceptance criteria

- [ ] Registered connection catalogues to a browsable, searchable DATASTORE subgraph
- [ ] FK edges render in explorer; columns lazy-expand from persisted graph
- [ ] Zero secrets persisted; SELECT-only statements (grep-level test on adapters)
- [ ] README provider table updated

## Agent Notes

_(fill in when done)_
