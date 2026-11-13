# HttpMacro response-header hygiene — test plan

## Defect

`HttpMacro` serialised **all** response headers into `data.headers` (`response.headers.forEach`).
`set-cookie` is a live session cookie for the fetched host and the tool result is appended to
the conversation and sent to the model provider, so fetching any authenticated page disclosed the
caller's session to the model (and into persisted history).

## Fix under test

`CREDENTIAL_RESPONSE_HEADERS` (`set-cookie`, `set-cookie2`, `authorization`,
`proxy-authorization`, `x-api-key`, `api-key`) are skipped while the rest of the header set is
preserved. Matching is case-insensitive, because header names arrive lower-cased from `undici`
but a proxy or a mock may not.

## Tests

| # | Test | Proves |
|---|------|--------|
| 1 | a 200 response carrying `content-type`, `cache-control`, two `set-cookie` spellings, `authorization` and `x-api-key` | credential headers are absent; non-credential headers survive; `JSON.stringify(result)` contains none of the cookie/token values |

`global.fetch` is stubbed with a minimal Response-shaped object; no real network call is made.
