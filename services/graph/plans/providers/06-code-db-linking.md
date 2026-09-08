# Session 06 — Code ↔ Database Linking (optional)

| Field | Value |
|-------|--------|
| **ID** | providers/06 |
| **Priority** | P4 (optional — precision-sensitive) |
| **Estimate** | M |
| **Depends on** | providers/05 (+ root session 13 as template) |
| **Branch** | `feat/graph-providers-06-code-db` |

## 1. Objective

`linkDatabaseMentions(projectId?)` — connect catalogued code/doc projects to
catalogued database tables, the DB analogue of ticket linking (providers/04):

1. **SQL string literals** in analysed code files: `FROM|JOIN|INTO|UPDATE <ident>`
   (qualified `schema.table` strongly preferred) → file/symbol →`REFERENCE`→ TABLE.
2. **TSql project objects** (`TSqlProjectProcessor` file nodes for `Tables/…`) →
   matching live TABLE nodes → `REFERENCE` (declared-vs-actual drift becomes visible).
3. **Doc mentions** of qualified table names in inline code → `MENTIONS`.

## 2. Precision rules (this is the whole session)

- Build the table index from catalogued `db` sources: `qualifiedNameLower → tableNodeId`
  (computed ids, same as providers/04 §4.1).
- **Qualified names only by default** (`schema.table` / `db.schema.table`); bare table
  names require `options.allowBareNames: true` per project AND uniqueness across the
  index; ambiguous names emit nothing (I4-style discipline).
- Stopword denylist for common words that are also table names (`users`, `orders`,
  `events`, `logs`, `data`, `state`, …) unless qualified.
- Confidence metadata on edges: `{ confidence, match: 'sql-literal' | 'tsql-object' | 'doc-inline-code' }`.
- Opt-in flag `linkDbMentions` (default **false** until precision proven in the field).

## 3. Allowed files

- `SystemGraphManager.ts` (linker), `BaseProjectProcessor.ts` (SQL-literal capture at
  analysis time into `data.sqlIdents` — regex over string literals; no SQL parser),
  GraphQL mutation `ReactorLinkDatabaseMentions`, tests `services/graph/DbLinking.test.ts`, README.

## 4. TDD

- code fixture with `SELECT * FROM billing.invoices` + catalogued fake DB source →
  one edge; bare `FROM users` with two candidate tables → none; opted-in unique bare
  name → one edge; idempotence.

## 5. Acceptance criteria

- [ ] Qualified SQL mention links file→table in explorer
- [ ] Ambiguity/denylist emit nothing; flags default off
- [ ] README updated

## Agent Notes

_(fill in when done)_
