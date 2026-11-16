# ToolResultProcessor credential redaction — test plan

## Defect

`ToolResultProcessor.process()` bounded **size** only. There was no notion of a sensitive field,
so a tool result that happened to carry a serialised User document — password hash, `salt`,
`sessionInfo[].jwtPayload.refresh`, `authentications[].props.accessToken` — was:

1. returned verbatim, therefore appended to the conversation and sent to the external model
   provider; and
2. when larger than `maxOutputSize`, written to `<tool>-output-<ts>.json` in the agent
   workspace — a persisted credential artefact.

## Behaviour under test

1. **Always redact**, on both the under-threshold and the offload path. Redaction runs at the top
   of `process()`, before the payload is measured and before the offload branch, so the
   file-on-disk guarantee follows from the same pass.
2. **Key-based redaction** for `SENSITIVE_KEYS`: `password`, `salt`, `sessionInfo`,
   `authentications`, `memberships`, `jwtToken`, `jwtPayload`, `jwtPayloadJson`, `refresh`,
   `refreshToken`, `accessToken`, `apiKey`, `secret`, `clientSecret`, `authorization`,
   `set-cookie` (plus `x-api-key`/`proxy-authorization`, whose prefixes normalisation keeps).
   Matching is case- and punctuation-insensitive (`set-cookie` == `setCookie` == `SET_COOKIE`).
3. **Value replaced in place** with `[REDACTED]`, key preserved — shape stability matters because
   existing consumers read `metadata.user`, `data.status` etc.
4. **All three surfaces**: `data`, `metadata` and the echoed `params`.
5. **String results take a text path.** A structural walk cannot see inside a string, and a
   string result is a normal shape here (graphql/data return `JSON.stringify(...)`, shell returns
   raw output). A JSON string is parsed, redacted structurally and re-serialised; anything else is
   scrubbed by `key: value` pairs and credential-shaped values. A string result above
   `maxOutputSize` must produce a clean `.log` file.
6. **Safety**: cycles become `[Circular]` (walk terminates, `JSON.stringify` still succeeds);
   a document referenced twice is walked at both references; Dates and Buffers pass through.
7. **The depth ceiling is fail-closed.** A subtree deeper than `MAX_REDACTION_DEPTH` is replaced
   with `[DEPTH-LIMIT]`; it is never returned uninspected.

## Tests

| # | Test | Proves |
|---|------|--------|
| 1 | under-threshold result carrying a populated user document | `password`/`salt`/`sessionInfo`/`authentications`/`memberships` are `[REDACTED]`, names/status unchanged, keys retained |
| 2 | the same payload with `maxOutputSize` forced below its size | redaction precedes the file write: the file read back contains `[REDACTED]` and **none** of the credential values |
| 3 | request headers in `params` (`authorization`, `set-cookie`, nested `clientSecret`) | echoed request payloads are redacted too |
| 4 | cyclic object | terminates; `JSON.stringify` succeeds |
| 5 | one user document referenced by both `createdBy` and `updatedBy` | shared (non-cyclic) references are both redacted, not collapsed to `[Circular]` |
| 6 | `isSensitiveKey` normalisation | `set-cookie` / `setCookie` / `SET_COOKIE` equivalence |
| 7 | benign result | no false positives |
| 8 | **JSON string above `maxOutputSize`** (the F1 regression) | the offloaded `.log` contains no `pbkdf2`/salt/refresh value and still parses as JSON with the shape intact |
| 9 | plain-text string with `password: hunter2`, `clientSecret=abc123` and a benign pair | key/value scrubbing leaves the benign pair alone and removes both secrets before offload |
| 10 | secret nested just inside vs well beyond the ceiling | at depth 11 the key is redacted; beyond it the subtree is `[DEPTH-LIMIT]` and the secret is absent |

## Revert proof (negative control, executed)

Temporarily replacing the string branch with a bare `redactSensitive()` call and the
`DEPTH_LIMIT` return with `return node` makes tests 8, 9 and 10 fail (tests 1–5 still pass). The
failures name the literal `pbkdf2`/`salty-salt`/`hunter2`/`deep-secret` values, i.e. the
assertions are load-bearing rather than decorative.
