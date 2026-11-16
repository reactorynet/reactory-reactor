# ChatsMacro acting-user isolation — test plan

## Defect

The `chats` macro passed `state.context.user` — a full User document — into conversation query
filters and `ReactorConversationModel.create()`. That wrote a document carrying a PBKDF2 hash,
`salt`, session refresh tokens and third-party access tokens into persisted conversation state.
It now passes the acting user's **id**.

## The hazard this suite exists for

`actorUserId()` must never return `undefined`. Mongoose **drops** an undefined predicate when
casting (`find({ user: undefined }).cast()` is `{}`), so the degenerate case is not an error — it is
a query with no owner filter, i.e. every user's conversations. Returning `undefined` would
therefore convert the previous loud failure (a document either casts to its `_id` or raises a
CastError) into a silent cross-tenant read.

`actorUserId()` throws instead, and the macro's existing try/catch turns that into the normal
`{ success: false, error }` envelope.

## Tests

| # | Test | Proves |
|---|------|--------|
| 1 | state with neither `user.id` nor `context.user` | the macro fails closed (`success: false`, error names the missing acting user) **and** `ReactorConversationModel.find` is never called — the assertion that would fail if the filter were dropped |
| 2 | a document-bearing `context.user` (hash, salt, `sessionInfo`) | the query filter's `user` is a **string** equal to `_id.toString()` — no document reaches Mongoose |

Both tests assert on the arguments Mongoose actually received (`findSpy.mock.calls`), so a
regression to `user: state.context.user` fails the `typeof` assertion rather than silently
passing.
