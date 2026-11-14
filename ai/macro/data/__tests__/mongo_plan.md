# Mongo read-side credential guard — test plan

## Defect

`MongoReadMacro` executes an arbitrary `find`/`aggregation`/raw-JSON query against an arbitrary
collection with an arbitrary projection. It had no notion of a sensitive field, so
`collection: "users"` with no projection returned User documents complete with `password`
(PBKDF2 hash), `salt`, `sessionInfo[].jwtPayload` refresh tokens and
`authentications[].props.accessToken`. The rows are formatted, cached in `state.vars`, optionally
written to a file by `saveToFile`, and returned to the model provider.

## Behaviour under test

1. **Query-side exclusion** — a `users`/`reactory_users` collection (matched by
   `USER_COLLECTION_PATTERN`, so `usage_metrics` is *not* one) is queried with
   `SENSITIVE_USER_FIELDS` excluded, whether the caller passed a filter, a raw JSON query (which
   carries no projection argument at all), or an explicit exclusion projection.
2. **Default exclusion** — a find with **no** projection gets the same exclusions on any
   collection, because an unprojected find is the shape that leaked.
3. **Inclusion projections are passed through** — MongoDB rejects mixing inclusion and exclusion
   in one projection, so `{ email: 1, password: 1 }` reaches the driver unchanged.
4. **Post-read redaction** — every row is passed through
   `ToolResultProcessor.redactSensitive()` before formatting, caching and file output, which is
   what covers aggregation output and inclusion projections.
5. **No over-reach** — a non-user collection with an explicit exclusion projection keeps exactly
   the projection the caller supplied.

## Tests

| # | Test | Proves |
|---|------|--------|
| 1 | `users`, `filter: {}`, no projection | exclusion applied to the query (`password: 0`, `salt: 0`, `sessionInfo: 0`, …) |
| 2 | `core.reactory_users` | the collection matcher handles a tenant-qualified name |
| 3 | `users` + raw JSON `query` | the raw path gets the exclusion too |
| 4 | `usage_metrics`, no projection | the default exclusion is not limited to user collections |
| 5 | `users` + `{ email: 1, password: 1 }` | projection passed through; row `password`/`salt` become `[REDACTED]`; formatted output clean |
| 6 | `users` + aggregation pipeline | aggregation rows are redacted before formatting; `state.vars` cache is clean |
| 7 | `usage_metrics` + `{ internal: 0 }` | caller's exclusion projection untouched |

`mongodb` is mocked (`MongoClient` → a fake `db.collection()` whose `find`/`aggregate` are jest
fns), so the assertions are on the actual driver arguments rather than on a reimplementation.
