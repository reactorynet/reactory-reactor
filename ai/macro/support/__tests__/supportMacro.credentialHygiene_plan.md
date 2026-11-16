# Support macros — credential hygiene test plan

## Defect

`core.ReactorySupportService` populated the ticket's user references with no field selection
and every support macro returned the service result verbatim as `data` (and stored the same
object in `state.vars`, which is persisted with the conversation). A single `getSupportTicket`
call therefore serialised, for every person on the ticket:

- `password` (PBKDF2 hash) and `salt`
- `sessionInfo[].jwtPayloadJson` / `jwtPayload` with the `refresh` token
- `authentications[].props.accessToken` (Google and other third-party OAuth tokens)
- `roles`, `memberships[].roles`, `socials`, `__v`

The tool result is appended to the conversation and sent to the model provider, so this was a
credential disclosure, not merely over-fetching.

## Fix under test

1. **At the boundary** — each macro projects through `toTicketView()` / `toPersonView()` /
   `toCommentView()`; the projection (not the document) is also what goes into `state.vars`.
2. **Allow-list, not deny-list** — `SupportTicketPersonView` has exactly `id`, `firstName`,
   `lastName`, `email`, `displayName`; a field added to the User model cannot widen it.
3. **Service layer is not trusted** — the projection happens in the macro regardless of whether
   the service ever gains a `select()`, so this ticket does not depend on the sibling change.
4. **Unpopulated references stay useful** — a raw ObjectId yields `id` (string) and null names;
   `Buffer` ids are hex-encoded, never `{"type":"Buffer"}`.

## Tests

| # | Test | Proves |
|---|------|--------|
| 1 | `getSupportTicket` with fully populated, credential-bearing users | no credential value or key anywhere in `data`, `instructions` or `vars`; author projection and comment author correct; documents projected |
| 2 | `listSupportTickets` (paged) | same, for the list path; the paging envelope is preserved |
| 3 | `createSupportTicket` | same, for the path that previously also wrote `context.user` into the document |
| 4 | `updateSupportTicket` | same, for the update path |
| 5 | `addSupportTicketComment` | comment author projected, not the populated `user` document |
| 6 | populated reference is a raw ObjectId | `id` is the string, names are null rather than invented |

Assertion predicate (the acceptance criterion): `JSON.stringify` of the result, the instructions
and `state.vars` must not contain `pbkdf2$`, the salt, the refresh token, the OAuth access token
or the keys `sessionInfo` / `authentications`.
