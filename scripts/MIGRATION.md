# Conversation message store migration — operator runbook

Moving conversation **messages** out of the Mongo `history` array on the conversation document into the
Postgres table `reactor_conversation_messages`. The session document stays in Mongo; only the
append-heavy message log moves.

## Why

The embedded array grows without bound and is approaching the 16 MB BSON limit.

| | before | after |
|---|---|---|
| Worst conversation document | **15.97 MB** (99.8% of the 16 MB ceiling, ~30 KB headroom) | ~1.5 MB |
| Documents over 8 MB | 12 | 0 |
| Total conversation data | 537.9 MB | 36.2 MB (-93%) |

Truncation and compaction also stop rewriting a multi-megabyte document: a displaced message becomes
an `archived = true` row rather than an entry appended to an ever-growing `truncatedHistory`.

## Instances this applies to

The scripts in this directory are written for **any** instance, including ones that have never been
migrated. They resolve their connections from the environment and **never guess a database name**; on
an instance where the message store does not exist they report `NOT APPLICABLE` rather than failing,
and any script that would *write* **refuses** (exit 2) instead of running against a store that is not
there.

Connection resolution, in precedence order:

- Postgres: `REACTORY_POSTGRES_HOST/PORT/USER/PASSWORD/DB` → `POSTGRES_*`
- Mongo: `MONGOOSE` / `MONGODB_URI` / `MONGO_URI`, else built from `MONGO_HOST` / `MONGO_PORT` / `MONGO_DB` / `MONGO_USER` / `MONGO_PASSWORD`

## The switch

```
REACTOR_MESSAGES_SOURCE=postgres   # or the accepted alias REACTOR_MESSAGE_SOURCE
```

- Absent or anything other than `postgres` → `mongo`. A typo therefore degrades to today's behaviour
  rather than producing an empty transcript.
- Resolved **per call**, so rollback is an env change plus a restart — no rebuild.
- Read at both ends: the same value decides the read source *and* whether the embedded array is
  written, so the two cannot drift apart.

## Phases

| phase | what it does | state |
|---|---|---|
| **3a** | additive: entity, migration, dual-write, backfill | **done** |
| **3b** | cut reads over behind the flag | **done** |
| **3c-step1** | stop writing the array; model context reads the store | **done** |
| **3c-step2** | `$unset history` + `truncatedHistory` across `reactor_conversations` | **NOT DONE** |
| **3c-step3** | retire the flag and the Mongo fallback | after step 2 |

### Step 2 preconditions — all met

1. Appends no longer write the array (verified: `array+0` while `store+N` on live traffic).
2. Truncation/compaction displacements land in the store as archived rows plus a summary.
3. Reads — UI and model context — come from the store.
4. Backups exist and are verified readable.
5. No conversation in the store lacks an owning Mongo document (see `checkOrphanConversations`).

### Step 2 warning

`$unset` is **not reversible from Mongo**. Restore from the pre-3c backup (taken before step 1) if it
has to be undone. After step 1 the embedded array is authoritative only for messages written *before*
the cutover, so pointing reads back at `mongo` serves a silently short transcript. The application logs
a warning for that combination — see "Staleness guard" below.

## Scripts

All are run the same way:

```
TS_NODE_TRANSPILE_ONLY=true NODE_PATH=./ ./node_modules/.bin/env-cmd --no-override -f ./.env \
  node -r ts-node/register -r tsconfig-paths/register \
  src/modules/reactory-reactor/scripts/<script>.ts [options]
```

`bin/migrate-conversation-messages.sh` wraps the backfill/reconcile entry points; `bin/migrate-typeorm.sh`
runs the schema migration.

### Writing scripts (refuse with exit 2 if the store is absent or unreachable)

| script | dry run behaviour | purpose |
|---|---|---|
| `backfillConversationMessages.ts` | reports pending rows | copy Mongo messages into the store; idempotent, resumable |
| `reconcileConversationMessages.ts` | reports what it would change | repair content, numbering and archive flags |
| `repairMirrorGaps.ts` | reports missing rows | insert-only repair of messages never mirrored |

### Checks (read-only)

| script | what it proves |
|---|---|
| `checkMirrorCompleteness.ts` | every Mongo message has a row, split by timestamp against a `--since` boundary |
| `checkWindowParity.ts` | the paged window is identical from either source |
| `checkSearchParity.ts` | nothing Mongo's search matched is lost by the SQL predicate |
| `checkArchiveParity.ts` | the `archived` flag agrees with Mongo's `truncatedHistory` |
| `checkProviderContextParity.ts` | the model receives the same transcript from either source |
| `checkWritePathLive.ts` | on real traffic: rows appear and the array does **not** grow |
| `checkOrphanConversations.ts` | every store conversation still has an owning Mongo document |
| `checkNewChatReuse.ts` | a conversation that looks blank but holds messages is never handed back as a new chat |

### Analysis (read-only, no verdict)

| script | what it does |
|---|---|
| `sweepEmbeddedHistory.ts` | finds every consumer of the `history` / `truncatedHistory` arrays — reads, query filters, writes, projections and read-modify-writes — so the work still outstanding before retiring the array is a number rather than a guess. Re-run it after each fix; the count should fall. Each hit is a candidate and needs triage (browser `window.history`, Slack API paths and the project-history form all match the pattern) |

### Pilots (write a throwaway, then delete it)

| script | what it proves |
|---|---|
| `pilotWritePath.ts` | an append writes the store and does not re-create the array — with a `source=mongo` control that *must* grow the array, so the instrument can be shown to detect growth |
| `pilotCompaction.ts` | truncation archives the right rows (system prompt stays active) and the compaction summary lands immediately before the kept messages |

`scripts/lib/instanceProbe.ts` is shared by all of them: connection resolution, store/Mongo probes that
never throw, `deriveWriteExpectations` (what the write path *should* do on this instance), and the
`Reporter` used for PASS / FAIL / NOT APPLICABLE verdicts.

## Verdict semantics

- `NOT APPLICABLE` is neither a pass nor a failure: on an un-migrated instance a check may legitimately
  have nothing to do. It exit 0 by default and is excluded from the applicable count, so a green run
  cannot overstate what was verified.
- `--require-applicable` turns an all-NOT-APPLICABLE run into a failure, for environments where the
  check is expected to apply.
- A vacuous pass is called out explicitly: if nothing was examined (for example every conversation has
  already had its array retired) the tools say so, with `NOTHING WAS EXAMINED`, rather than reporting a
  clean result.

## State-dependent behaviour

Read this before interpreting output on an unfamiliar instance.

| instance state | `writesArray` | `writesStore` | note |
|---|---|---|---|
| un-migrated | yes | no | array is authoritative; store checks report N/A |
| dual-write (`mongo` + store present) | yes | yes | mirrors write *both* stores |
| cut over (`postgres` + store present) | **no** | yes | array retired |
| `postgres` with no usable store | yes | no | **MISCONFIGURED** — the service fails open to Mongo |

Two things that surprise people:

- **A frozen array is normal after the cutover.** The conversation document keeps its pre-cutover
  history while the store keeps growing, so Postgres legitimately holds more messages than Mongo. Those
  extra rows are reported as **post-cutover rows** and are never pruned. They are not drift.
- **New conversations keep a one-item `history` array** (the system message). That is a deliberate
  exemption: the compaction summary's temporary conversation is read back through its own array because
  it has no rows.

## Staleness guard

When the source resolves to `mongo`, the application logs — once per process — that the embedded array
is authoritative only for messages written before the cutover, and is louder if a message store is also
configured in the same process. This exists so that a rollback which looks clean but is silently short
cannot be made without a signal.

## Invariants worth checking after any operation

```
duplicate (conversation_id, seq) rows     : 0
rows with seq < 1                         : 0
orphaned conversations                    : 0   (checkOrphanConversations)
window / search parity, archive parity    : 0 divergences
```

## Two correctness properties that are easy to lose

Both were found by running the tools rather than by reading them, and both have dedicated checks:

1. **Post-cutover messages are not orphans.** `reconcile` prunes "active rows Mongo does not own". After
   the cutover Mongo owns nothing written since, so without a discriminator it would delete exactly the
   newest messages. The discriminator is that `mongo_id` is a time-ordered ObjectId: a candidate sorting
   above every known id is newer than anything the array carried. Verified by before/after dry run —
   `orphans=303` before the fix, `0 prunable / 303 post-cutover` after.
2. **A deleted conversation must take its rows with it.** `deleteChatSession` and the compaction
   temporary conversation both remove the document; both now also remove the rows, but **only when the
   document delete actually happened**, so a mis-targeted delete cannot destroy a transcript that still
   has an owner. `checkOrphanConversations` is the gate.

## Reading the embedded array as a QUERY PREDICATE

Once the array stops being written it is not just stale data — it is a stale **predicate**. Any
query that filters on `history` (rather than reading `history` as a property) silently changes
meaning, and a grep for `.history` property access will not find it.

Two were found this way:

| site | status |
|---|---|
| `getConversations` search, `{ history.content: { $regex } }` | correctly branched to the store |
| `getNewConversation` reuse filter, `{ history: { $size: 0 } }` | **was not** — see below |

### The `new chat` defect

`getNewConversation` re-uses an existing **blank** conversation so that opening and abandoning a chat
does not leave empty conversations behind. It decided blankness from the array. After the cutover the
array is never written, so a conversation with hundreds of messages still reads as `history: []` —
the predicate is permanently true, and `new chat` returned the same conversation forever, dropping the
user into an existing transcript.

The fix asks the store (`conversationsWithContent`) which candidates actually hold a transcript, and
excludes them. Failure direction is deliberate: if the store cannot answer, every candidate is treated
as used, so the outcome is one extra blank conversation rather than a silently re-used transcript.

`checkNewChatReuse.ts` guards it, and was shown to *fail* against the pre-fix code — a guard that
cannot fail is not evidence.

## Context

This work was carried out against development and test instances; there are no production deployments.
The verification standard applied throughout was that a check must be able to *fail* on the thing it
claims to cover — several early "passing" results were false because the check could not fail, and the
design log records each of those corrections.
