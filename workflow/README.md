# Reactor built in workflows

## ProcessConversationWorkflow
Responsible for processing and compressing a chat session when token pressure reaches 95% Will be triggered by

## ProcessAITicket — the signed-commit invariant

### The invariant

> **A signed commit is only verifiable when the committer is the owner of the signing key.**

Git can produce a signature that is *mathematically valid* and still unattributable. GitHub
attributes a signature through the **committer's e-mail address**: if no account owns that
address, the commits API reports

```json
{ "sha": "8fed5b89", "verified": false, "reason": "no_user" }
```

even though `git log --format='%G?'` says `G`. Such a commit cannot merge into any branch that
enables `required_signatures`, and the only repair is to re-create the commits by hand with a
different committer.

Consequences that the workflow now enforces:

| Situation | Committer | Author | Result |
| --- | --- | --- | --- |
| `commit.gpgsign=true`, `user.email` set | the configured identity (the key owner) — **never overridden** | bot identity `Reactor AI <reactor@reactory.net>` for attribution | verifiable |
| `commit.gpgsign=true`, `user.email` **unset** | — | — | `commitChanges` **fails**, naming `user.email` and `user.signingkey`. It never invents an identity. |
| `commit.gpgsign=false` | configured identity, or the bot identity when nothing is configured | same | unchanged behaviour |

`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` carry the bot identity; `GIT_COMMITTER_*` is only ever set
when signing is **disabled**. `git -c user.name/user.email` cannot express "bot author, human
committer" — it sets both — which is why the identity travels as environment, not as `-c` flags.

### The three defects this replaced (PROCESS-001 / REACTORY-302016408/20261111/432598720)

1. **D1 — an invented commit identity.** `commitChanges` fell back to
   `Reactory AI <ai@reactory.net>` whenever no `user.email` was configured. That address owns no
   signing key either, so the fallback had exactly the defect it was written to avoid. It is gone:
   identity is resolved from `commit.gpgsign`, `user.signingkey`, `gpg.format`, `user.name` and
   `user.email`, and a missing owner is a hard failure.
2. **D2 — engineer-created commits were published verbatim.** The engineer is instructed never to
   commit, and it sometimes does. `detectPrematurePublish` only looks for a *pushed* branch, so
   local commits ahead of base went straight to `pushBranch`. `guardEngineerCommits` now runs
   immediately after the engineer session (after `verifyWorkspaceNote`, before the reviewer):
   it counts `<base>..HEAD`, records the offending log in `.ai-agent/engineer-commits.json`,
   `git reset --soft <base>` (index and working tree survive) and reports the violation on the
   ticket. If the reset cannot be *proven*, the run fails closed — an agent-authored commit is
   never published.
3. **D3 — nothing verified that what was pushed was verifiable.** `publishReadinessGate` only
   asserted that a commit exists. `verifyCommitSignatures` now runs between `commitChanges` and
   `readPublishReadiness`: with `commit.gpgsign=true`, every commit in `<base>..HEAD` must report
   `%G? = G`. Any other value (`N`, `B`, `U`, `X`, `Y`, `R`, `E`) blocks publication, with the SHA,
   the committer e-mail and `user.signingkey` named in the ticket comment, and the evidence written
   to `.ai-agent/commit-verification.json`. Nothing is pushed. With signing disabled the step is a
   no-op.

### Version 1.4.8 is a deliberate IN-PLACE hotfix

The workflow **version stays 1.4.8**. `version` is the workflow's identity and the runner matches
ids verbatim; `PROCESS_AI_TICKET_WORKFLOW_ID = 'core.ProcessAITicket@1.4.8'` lives in
`src/modules/reactory-core/services/supportWorkflowIds.ts`, which is a **separate nested git
repository** that a worktree of `reactory-express-server` cannot update. Bumping this body alone
would remove `@1.4.8` from the catalog and make `checkWorkflowRegistered` refuse the next dispatch,
stopping every delegated AI ticket run.

The trade-off: this body and the provisioned catalog copy must be kept in step manually until the
next coordinated release; the operator must re-provision the catalog copy of `1.4.8` for the fix to
take effect.

#### Before re-provisioning 1.4.8 in place: inventory the in-flight runs (NOT optional)

Re-provisioning `1.4.8` in place changes the body under a version id that running instances are
already pinned to, and that is not a cosmetic difference:

- `yamlDefinitionFingerprintSeed` (YamlFlowBuilder, milestone M10) is a **content digest** of the
definition. Its own test asserts that an edited body yields a **different** seed.
- `@reactorynet/workflow-es` compares that seed when it resumes an instance. A mismatch does not
re-run the instance against the new graph: it **dead-letters** the instance with
`reason: "definition-changed"` (see that package's `README.md:76`).

So every `core.ProcessAITicket@1.4.8` instance that is *running or suspended* at the moment of
re-provisioning dies silently. That includes the states this workflow deliberately parks in:
`suspended` on the `prApproval` user task, on a halt task (`findingsHaltTask`,
`reviewUnavailableTask`), and inside the merge poll. Their pull requests stay **open**, their tickets
stay **in_progress**, and nothing tells anyone why. It also includes the runs this very fix is meant
to rescue.

Do this **first**, every time, in this order:

1. **Inventory** every live `core.ProcessAITicket@1.4.8` instance — `running` and `suspended` — with
   its ticket reference and, where it has one, its pull request. Do not rely on a dashboard that
   only shows recent runs; query the instances, not the logs.
2. For each instance, pick one and record which:
   - **let it finish** on the old body (it is suspended on a human step, so it will resume when that
     human acts — re-provision *after* it completes), or
   - **plan a manual re-dispatch** on the new body (re-open the ticket so it is re-picked, or drive
     the child again from the programme path), and note the ticket + PR so the stranded PR is closed
     or reused rather than duplicated.
3. Only then re-provision the catalog copy of `1.4.8`, and say in the hand-over note how many
   instances were inventoried, how many were left to finish, and how many will be re-dispatched.

This is a **required pre-step, not a nicety**: skipping it does not "upgrade the running work", it
kills it, and the damage is invisible until someone notices a ticket that has been `in_progress`
for a week with a green CI run and no pull request.

### The reviewer findings schema (REACTORY-302016408/20261116/2437438300) — shipped in place at 1.4.8

1.4.8 resolved findings by listing synonyms of its OWN key names (`blockingFindings` /
`blocking_findings`), so a reviewer that emitted `blocking_issues` was read as having produced
nothing: `blockingissues` and `blockingfindings` are different **nouns**, and `resolveKey` compares
whole normalised names, so no casing rule could ever match. The verdict resolved (the reviewer wrote
`decision`) while every findings list came back empty, and the run was parked for a human with the
false reason "the reviewer produced no verdict".

This body now reads `review.json` through ONE published schema — a `// >>> shared review schema`
block that is byte-identical (modulo indentation) in `captureReview` and `readPublishable` and is
pinned by a test — covering `decision`, `headline`, `blocking_issues`, `non_blocking_issues`,
`required_actions_next_cycle` and `acceptance_criteria_assessment`. Three consequences:

- A rejection that carries findings is handed to the engineer as a fix cycle instead of blocking.
- A rejection that genuinely names nothing still blocks, and says so as a review, not as a parser fault.
- A findings-shaped list under a key the schema does not know is reported as a **pipeline parser
  fault** and the key is named, because that is a defect here, not a review that said nothing.

The reviewer prompts state this same shape, so the workflow no longer asks for one schema and parses
another. The pre-fix prompt drift — `{verdict, findings[], requiredChanges[]}` in the loop versus
per-finding `blocking: true|false` in the confirmation pass — is closed.

It ships **in place at 1.4.8**, not as 1.4.9, for exactly the reason in the section above: the
identity cannot move until `PROCESS_AI_TICKET_WORKFLOW_ID` and the catalog copy move with it.
A 1.4.9 bump is filed as a coordinated-release follow-up and must go through the procedure below as
one unit.

### Observation correctness — REACTORY-302016408/20261114/787370442 (shipped in place at 1.4.8)

The run on instance `6af7508c4f0cf9fef5efe44a` (WS-1 / PR #133) misdiagnosed a blocked pull request
and burned its whole post-publication fix budget on a phantom. Two defects, both in the observation,
neither in whether the loop loops.

**A — the signature verdict was read from a field that does not exist, and every unrecognised
reason was treated as a failure.** Two distinct faults, and the first caused the phantom:

1. **The wrong JSON path.** The observation read `commit.verification`, which
   `pulls/{n}/commits` never returns. Every commit therefore looked `verified: false` with no
   reason, which the code defaulted to the literal string `'unknown'`. GitHub had in fact reported
   `verified: true, reason: valid` all along.
2. **A settle model built on that fabricated value.** Because the only "not settled" state was the
   `'unknown'` default, every *real* reason was treated as a settled failure — including GitHub's
   genuinely transient ones (`gpgverify_unavailable`, `gpgverify_error`) and the unresolved
   `ocsp_pending`. A GitHub verification **outage** therefore drove a `--force-with-lease` rewrite
   of published history, which is the opposite of this ticket's invariant.

**The read path was the other half of that root cause.** `/repos/{repo}/pulls/{n}/commits` returns
REST commit objects, so the verdict is nested at `commit.commit.verification`; there is **no**
top-level `commit.verification` (verified live on PR #85: item keys are `[author, comments_url,
commit, committer, html_url, node_id, parents, sha, url]`, `has("verification")` is false). The body
read the top-level path, so it got `{}` for **every** commit, never saw `verified === true`, and
defaulted the reason to `'unknown'`. That is why the phantom always said "reason unknown", and with
only the settle-gate fixed it would have reported a genuinely verified commit as `pending` for ever.
The read is now `((commit.commit || {}).verification) || {}`, and every commit fixture in the suites
mirrors that shape — including one built from a recorded live `verified:true / reason:"valid"`
response, so the wrong shape cannot pass again.

GitHub's documented `verification.reason` values are `expired_key`, `not_signing_key`,
`gpgverify_error`, `gpgverify_unavailable`, `unsigned`, `unknown_signature_type`, `no_user`,
`unverified_email`, `bad_email`, `unknown_key`, `malformed_signature`, `invalid`, `valid` — plus
`ocsp_pending` in the schema enum. **`unknown` is not one of them**; it was this workflow's own
default for the field it could not read.

`SETTLED_FAILURE_REASONS` is therefore an explicit **allow-list**. Anything else — no reason, a
transient reason, or a reason this workflow has never heard of — is a WAIT. Waiting is recoverable;
rewriting published history is not.

| `verification` | Meaning | Finding | `repairNeeded` |
| --- | --- | --- | --- |
| `verified: true` | signature valid | none | no |
| `verified: false`, reason in the settled-failure allow-list (`unsigned`, `no_user`, `unverified_email`, `bad_email`, `unknown_key`, `expired_key`, `not_signing_key`, `invalid`, `malformed_signature`, `unknown_signature_type`) | checked and failed | `unverifiable_commit`, `settled: true`, fixable only with a signing identity | yes, when fixable |
| `verified: false`, transient (`gpgverify_unavailable`, `gpgverify_error`, `ocsp_pending`) | GitHub could not decide — **not a verdict** | `commit_verification_pending`, `transient: true`, `fixable: false` | **never** |
| `verified: false`, no reason / `unknown` / any unrecognised reason | no verdict observed | `commit_verification_pending`, `fixable: false`, `settled: false` | **never** |

`repairNeeded` (and both readers of it: `readPostPublishRepairNeed`, `resolveRepairBase`) require
`settled === true`, i.e. the reason is on the allow-list. A pending commit is a WAIT:
`postPublishWaitCause = 'verification'` and the loop re-observes. Two settle delays (20 s) run after
the initial publish and after any re-publish, before signatures are judged. If the verdict is still
unsettled when the wait budget expires the run ends **`blocked_human`** with that reason — not
`awaiting_human`, because a signature GitHub never settled cannot be approved past on a
signature-protected branch.

**B — CI was observed before it produced a conclusion.** PR #133 was observed 16 seconds BEFORE its
CI run started: `pendingChecks = 7`, zero conclusions, and the run reported "the post-publication fix
budget was exhausted" while five checks were failing at `yarn install`.

**"Is CI expected?" does not come from required checks.** Classic branch protection declares
`required_status_checks: null` on every reactorynet repository (they require reviews and signatures
only), so gating on required checks made "not scheduled yet" undetectable in production: a pre-CI
observation classified **clean** and the run reached the success arm having read zero conclusions.
Expectation is now derived from evidence these repositories actually have, in
`checks.expectedEvidence`:

1. classic protection `required_status_checks` (contexts and checks);
2. **ruleset**-required checks — `repos/{r}/rules/branches/{b}`, which never appear in protection;
3. check runs on the **base tip** — the only concrete source of the check *names* a pull request is
   expected to produce;
4. a `.github/workflows/*.{yml,yaml}` in the worktree declaring a `pull_request` trigger;
5. check runs already present on this head.

| `checks.state` | Meaning | Loop behaviour |
| --- | --- | --- |
| `not_scheduled` | CI is expected but **nothing** has been created for this head | wait 15 s, bound `postPublishSchedulingWaitBound` = 20 (5 min) |
| `running` | a check is unfinished, **or** expected names are missing and no Actions check has concluded (`checks.settling`) | wait 60 s, bound `postPublishWaitBound` = 6 (unchanged) |
| `finished` | no check unfinished and no expected name missing | judge it; failures are fixable `check_run` findings |

The `settling` state is what closes the fast-app gap the review found: GitGuardian and the CodeQL
summary run finish in 1–2 s, so a head can look `finished` before the Actions jobs exist. A missing
expected name keeps the state `running` **until an `github-actions` conclusion lands** — after that a
name that only ever runs on the default branch (Dependabot, a master-only `analysis` job) can no
longer hold the loop open.

`recordPostPublishCoverage` accumulates `post-publish-ci-coverage.json`, **keyed by head SHA** so a
re-published head cannot inherit the previous head's coverage, and persisting `expected`. It emits:

| output | Meaning |
| --- | --- |
| `some` | at least one check conclusion has been evaluated for this head |
| `none` | CI is **expected** and no conclusion was ever read |
| `not_expected` | no CI evidence at all — a CI-less repository is never told CI failures may be hiding |

Any terminal point reached with `none` reports `checks_unobserved` (or the never-observed reason in
`describePostPublishBlock`) — *"ended without observing any CI conclusion; failing checks may exist
and were never read"* — and names the expectation evidence. A CI-less repository keeps the
`exhausted`/budget wording, because there the budget really is the cause. The pre-publish
`reviewCycleBound` is untouched; Defect B is confined to the post-publication loop.

Verification: `workflow/__tests__/ProcessAITicket.signatureAndCiObservation.test.ts` executes the
shipped scripts against recorded payloads and throwaway git repositories, and additionally guards its
own file integrity (0 TypeScript parse diagnostics; no `it` outside a `describe`) because ts-jest's
`isolatedModules` transpile let a syntactically invalid version of that file pass as a green suite on
PR #85. `no_user` remains the positive control — the SPEECH-010 invariant is unchanged — and
`gpgverify_unavailable` is the transient control.

### Coordinated version-bump procedure (do this instead of editing `version:` alone)

1. Edit `workflow/ProcessAITicket.yaml` (`nameSpace: core`, `name: ProcessAITicket`).
2. Set `version:` to the new value in the same commit as the body change.
3. Update `REACTOR_YAML_WORKFLOWS` in `../index.ts` — it derives the catalog destination from
   **its** version, so a mismatch provisions the new body into the previous version's directory.
4. Update the PR-body footer assertion in `__tests__/ProcessAITicket.contract.test.ts` /
   `ProcessAITicket.behaviour.test.ts` only if they hard-code the number (they derive it from the
   YAML, so normally they do not).
5. Land the companion pin in `reactory-core`'s `services/supportWorkflowIds.ts`
   (`PROCESS_AI_TICKET_WORKFLOW_ID`) in the **same release window**. Its guard test compares the
   constant to the body, and `checkWorkflowRegistered` refuses to dispatch an unresolvable id.
6. Re-provision `reactory-data/workflows/catalog/core/ProcessAITicket/<version>/` **after** the
   in-flight inventory in the pre-step above, and run `__tests__/WorkflowRegistry.test.ts` plus both
   `ProcessAITicket.*.test.ts` suites before dispatching a real ticket. Re-provisioning with live
   instances on the old fingerprint dead-letters them (`definition-changed`) whether the version
   number moved or not.

Never bump this body alone: the failure mode is silent — every delegated AI ticket run stops
dispatching until a human fixes the pin.

### Verification recipe for this workflow

`reactory-reactor` ships the worktree test harness:

```bash
REACTORY_SERVER_ROOT=<express-server checkout> \
  node scripts/ai/run-worktree-tests.js workflow/__tests__/ProcessAITicket.contract.test.ts \
       workflow/__tests__/ProcessAITicket.behaviour.test.ts
```

`ProcessAITicket.behaviour.test.ts` executes the real `cli_command` scripts against throwaway git
repositories. The signing tests **do not require a working GPG key**: the refusal path, the
signing-disabled path and the non-`G` verification path are all exercisable offline.

## PROCESS-002 — the PR is not the finish line

`REACTORY-302016408/20261112/3114388954`. PROCESS-001 fixed the *first* publication. Two
gaps remained, both observed on SPEECH-010 (PR reactorynet/reactory-speech-service#18).

### 1. The integrity guards now run on every revision, not once

`guardEngineerCommits` and `verifyCommitSignatures` used to protect only the single commit the
pipeline creates after the first engineer session. When the reviewer rejected, `handBack`
re-entered the **same** engineer session and the revision path never returned through either
guard. On SPEECH-010 the guard fired once (resetting `10343ed`); the engineer then committed
twice more (`b46bcd6`, `67ffdc`) with committer `Reactor AI <reactor@reactory.net>`. GitHub
reported `verified:false`, `reason:no_user`, and a human had to re-create both commits before
the PR could merge.

Now:

| Call site | When | Base it resets to |
| --- | --- | --- |
| `guardEngineerCommits` | after the first engineer session | the repository base |
| `guardRevisionCommits` | after **every** `handBack` + `reCaptureReport` | the repository base (nothing is published yet — the publish path runs after the loop) |
| `guardPostPublishCommits` | after each post-publication fix hand-back | the **published tip** (`BASE_REF`) |

All three run the *same* anchored script, so they cannot drift. Each writes its own evidence
artefact with `stage` and `cycle` (`engineer-commits.json`,
`engineer-commits-revision-<n>.json`, `post-publish-commits-<n>.json`). A reset that cannot be
**proven** is a block, not a warning: `integrityBlocked` vetoes the publish decision
(`integrityVetoGate`) so an approval cannot publish a branch that still carries an
agent-authored commit.

`verifyCommitSignatures` also enforces the invariant rather than assuming it. `%G? = G` only
proves the signature is mathematically valid; GitHub attributes it through the **committer**, so
the SPEECH-010 commits were locally `G` and remotely `no_user`. A commit is now verifiable only
when **both** hold: `%G? = G` **and** the committer e-mail is the configured key owner
(`user.email`). When an observation finds already-published commits GitHub reports
`verified:false` *and* a signing identity is configured, `republishCommit` may soft-reset to the
publication base and re-create the commit with the key-owner committer (`REPAIR_BASE_REF`) —
byte-identical tree, exactly the repair a human performed by hand on PR #18.

### 2. The workflow reads the pull request after it opens

Nothing used to read `pulls/{n}/comments`, `pulls/{n}/reviews` or `reviewThreads`. CodeQL
findings arrive as review threads *after* the PR exists (16 on PR #13, 3 on #18), failing checks
only exist once the PR exists, and human review comments reached nobody.

`observePullRequest` (all `gh api` against the repository already in use — no paid dependency, no
hosted service) collects merge state, reviews, review threads, failing check runs, commit
verification and branch protection, and classifies the PR into one of:

* `clean` — nothing an agent can fix and nothing still running (CLEAN/UNSTABLE with finished
  checks/BEHIND). Keep waiting for the human approval/merge, as before.
* `pending` — required checks are still **running** (`queued`, `in_progress`, `requested`,
  `waiting`, `pending`, or no conclusion). The loop waits and re-observes, bounded by
  `postPublishWaitBound` (6 × 60s) and never consuming the fix budget. Running out of waits is
  `awaiting_human` — never a "branch-protection policy" verdict.
* `fixable` — unresolved review threads, `CHANGES_REQUESTED`, failing checks, a merge conflict, or
  an unverifiable published commit **when a signing identity is configured**.
* `human_only` — `required_signatures` with no configured key, `REVIEW_REQUIRED`, `BLOCKED` with
  no agent-fixable finding (an unidentified branch-protection rule), or a CLOSED PR.

Routing, when `fixable`:

1. `preparePostPublishReview` builds a briefing that carries every finding body **verbatim**.
2. `postPublishReview` (QualityQuinn, `reviewerId`) decides, per finding, **fix** or **dismiss**.
   It writes the same `requiredChanges` shape the pre-publish reviewer uses, plus `dismissals`
   (each with `justification`, `dismissedReason`, `dismissedComment`) and `resolvedFindingIds`.
   The judgement stays in the quality agent: 3 of 16 CodeQL findings on PR #13 were false
   positives, so no YAML heuristic decides what is actionable.
3. `capturePostPublishReview` refuses an unjustified dismissal (`state: invalid`, loop stops for a
   human) and records a structured per-cycle log (`post-publish-log.json`: observed, judged,
   fixed, dismissed-with-justification).
4. `applyPostPublishDecisions` writes a code-scanning dismissal as
   `gh api -X PATCH .../code-scanning/alerts/{n} -f state=dismissed -f dismissed_reason=...
   -f dismissed_comment=<justification>` (the justification lands in `dismissed_comment`, not only
   in our report). The repository is resolved inside the step (observation → `origin` →
   `gh repo view`) because the workflow supplies only `WT` and `PR_NUMBER`; if none resolves, the
   step reports `not-applied` and says so in the PR comment instead of claiming a dismissal.
   Only threads whose finding was **dismissed** are closed through
   `resolveReviewThread`; a thread whose finding is still a required change stays OPEN until the
   fix has been re-published and re-observed. Every dismissal is summarised in one PR comment.
5. `postPublishHandBack` hands the work back to the **same** engineer session
   (`variables.engineerSessionId`).
6. The revision goes through `guardPostPublishCommits` → `republishCommit` →
   `verifyPostPublishSignatures` → `readRepublishReadiness` → `republishPush`
   (`--force-with-lease`, and only when the published tip is an ancestor) → observe again.

`human_only` never loops: it sets `postPublishContinue=false`, records the exact reason and raises
one human task. Looping on required signatures with no key can never make the PR mergeable.

The loop is bounded by `maxPostPublishFixCycles` (default **2**), a counter
(`postPublishCycle`) and budget gate that is entirely separate from `reviewCycleBound`; the
pre-publish loop's semantics are unchanged. Exhaustion is reported explicitly.

### 3. Honest terminal states

`runStatus=completed` is now set **only** in the branch where the PR was observed mergeable, and
it is accompanied by `publishState=awaiting_human` — "published, verified, mergeable, awaiting
human". A PR that is open but unmergeable sets `publishState=blocked_needs_human` and
`runStatus=blocked`, keeps the workspace note in progress, raises a human task naming the reason,
and reports `failed` to the programme reconciler. "AI delivered a PR" and "a human can merge that
PR" are no longer the same state.

### Version

Still **1.4.8**, in place, for exactly the reason above: `PROCESS_AI_TICKET_WORKFLOW_ID` is pinned
to `core.ProcessAITicket@1.4.8` in `reactory-core` (a separate repository). This body and the
provisioned catalog copy must be kept in step manually until the next coordinated release; use
the procedure above, do not bump this body alone.

### Verification

```bash
node scripts/ai/run-worktree-tests.js \
  workflow/__tests__/WorkflowRegistry.test.ts \
  workflow/__tests__/ProcessAITicket.contract.test.ts \
  workflow/__tests__/ProcessAITicket.behaviour.test.ts
```

The PROCESS-002 suites fail against the pre-change YAML (the step ids do not exist), which is how
they prove they cannot pass vacuously.

### Review round 2 — what the first pass got wrong

Five defects survived the first implementation. They are recorded here because each one is a
trap the next editor can fall into.

1. **The published tip was resolved once, outside the loop.** `resolvePublishedTip` ran before
   `postPublishLoop`, so cycle 1 measured `rev-list --count` against the tip cycle 0 had already
   replaced: it saw a phantom commit even when the engineer had committed nothing, posted a false
   PROCESS VIOLATION and `git reset --soft` to the stale tip — discarding a commit origin already
   had. `republishPush` then refused to rewrite the tip, so any PR needing two fix cycles ended
   `blocked_needs_human` after a false accusation. The tip is now re-resolved as the FIRST step of
   every iteration (and written to `post-publish-tip-<cycle>.json`), so the guard, the lease and
   the push all see what origin has now.
2. **The repair could never be published.** A commit repair re-creates the commits on the
   publication base, so the old tip is *expected* not to be an ancestor — but `republishPush`
   refused every non-fast-forward before it reached the force-push. The two rules are now
   separate: a normal fix must fast-forward; a repair may rewrite, with the lease bound
   explicitly to the tip the observation saw
   (`--force-with-lease=refs/heads/<branch>:<observedTip>`), refusing only when origin no longer
   matches. `resolveRepairBase` also resolves the **publication base** (observation base →
   `publish-readiness.json` → `origin/HEAD` → main/master/develop/trunk), never the published tip,
   which would have repaired nothing.
3. **An unreadable observation was reported as success.** The route asked "is this `human_only`?"
   and sent everything else — including `unavailable` — to `awaiting_human`, so a gh outage set
   `runStatus=completed` for a pull request nobody had read. The test is now positive: only
   `clean` reaches `awaiting_human`; `human_only` **and** `unavailable` take the blocked arm, with
   `readPostPublishBlockReason` stating that mergeability is UNKNOWN.
4. **A `CHANGES_REQUESTED` review could never converge.** The same review was re-reported as a
   fresh finding every cycle, so the budget always exhausted. Reviews now carry `commit_id`; a
   review of an **older** commit is not agent-actionable — it is recorded in `staleReviews` and a
   fresh review is requested (`POST .../requested_reviewers`), so `reviewDecision` can leave
   `CHANGES_REQUESTED`. A review ON the current head is still a blocking finding.
   `REVIEW_REQUIRED` is a human wait, not a `human_only` block.
5. **The judgement had no provenance, and no alert number.** `preparePostPublishReview` now opens
   a window (`post-publish-review-window.json`, cycle + nonce) and clears the previous verdict;
   `capturePostPublishReview` refuses a file that predates the window, belongs to another cycle,
   or is missing, and always writes the invalid record so the reader cannot pick up cycle *n-1*.
   `observePullRequest` also reads
   `repos/{repo}/code-scanning/alerts?state=open&ref=refs/pull/{n}/merge`, so findings carry a
   real `alertNumber`; when a number genuinely cannot be
   resolved the PR comment says **"NO GitHub dismissal was written"** instead of implying one.

Verification for these five is mutation-tested: pinning the tip back to a once-only resolution
makes exactly the two cycle tests fail (`converges across TWO fix cycles`,
`reports a cycle where the engineer committed nothing as clean`).

### Review round 3 — the wiring that was never exercised

Three defects survived round 2 because no test ran the LIVE wiring.

1. **A PR waiting for CI was called a policy block.** Only terminal check failures were findings,
   so a `queued`/`in_progress` required check was invisible; `BLOCKED` + no finding became
   "human-only branch-protection policy", and every PR against a repository with required status
   checks ended `blocked_needs_human` before CI finished. There is now a `pending` verdict:
   `postPublishPendingGate` waits (60s, bounded by `postPublishWaitBound`) and re-observes,
   consuming no fix budget; exhausting the waits is `awaiting_human`, never a policy verdict.
   Only `BLOCKED` with no fixable finding, **no running check** and **no awaited review** may
   claim a policy block.
2. **`applyPostPublishDecisions` never had a repository.** The workflow supplies `WT` and
   `PR_NUMBER` only, and the script read `PR_REPO` with no fallback, so the dismissal PATCH, the
   audit comment and the review re-request were all inert. The step now resolves the repository
   itself (observation → `origin` → `gh repo view`) and reports `not-applied` + a stderr warning
   if none resolves. The test drives it with exactly the workflow's env and a fake `gh`.
3. **A no-op cycle counted as a fix.** `readRepublishResult` logged `fixed:[{pushed:true}]` even
   when `republishCommit` returned `committed:false`, so an unaddressed required change could
   reach `awaiting_human`. It now returns `pushed` only when BOTH committed and pushed, logs
   `committed` and `pushed`, and `republishNoChangeGate` stops the run with
   "the engineering session produced no change" instead of reporting success. A review thread is
   also only closed for a finding that was **dismissed**, never one that is still required.

Also fixed: the CLOSED check reads the LIVE `pr.state` (not the creation-time `PR_STATE`), the
unscoped code-scanning fallback only attributes alerts whose instance ref/commit is this PR, and
a `changes_required` verdict with an empty `requiredChanges` is `invalid` rather than `no_action`.

### Review round 4 — the loop could not converge

The integrity half held; the post-publication loop could not finish what it started. Three
defects, all reproduced by executing the workflow's own scripts.

1. **A thread the reviewer FIXED was never resolved.** `applyPostPublishDecisions` closed a thread
   only when the finding was also in `dismissals`, and `requiredForThread` was dead code because
   `capturePostPublishReview` JSON-stringified `requiredChanges`, so `change.findingId` never
   existed. A fixed thread was therefore deferred for ever and re-observed on every cycle.
   Now:
   * `capturePostPublishReview` keeps `requiredChangeIds` structurally (object `findingId`, or a
     `kind:id` token quoted in a prose change).
   * `applyPostPublishDecisions` closes a thread only when nothing is owed — the finding was
     **dismissed**, or the verdict was **no_action**. Every other thread is deferred with a reason.
   * `resolveAddressedThreads` (reached ONLY from the "committed AND pushed" arm) closes the
     deferred threads once the fix is actually on origin, and records the closure in
     `post-publish-log.json`. A dismissal is not required to close a fixed thread; *dismiss* means
     "not a real defect".
2. **A dismiss-all cycle was pushed through commit/push.** The false-positive case (3 of 16 on PR
   #13) has nothing to commit, so `commitChanges` returned `worktree clean`,
   `readRepublishResult` said `no_change`, and `republishNoChangeGate` stopped the run
   `blocked_human` — **without ever re-observing the PR whose findings it had just dismissed**.
   The commit/push chain now lives inside `postPublishHandBackGate.then` (`changes_required`
   only). The `no_action` arm applies the dismissals, then bumps a separately-bounded
   `postPublishReobserveCount` (`postPublishReobserveBound`, default 3) and returns to the
   observation, so the dismissed threads are seen as resolved and the run reaches
   `awaiting_human`. Exhausting the re-observes is a human stop, never a success.
   A no-op *fix* cycle (`changes_required` + nothing committed) still stops: the engineer owed
   work and did not do it.
3. **The blocked outcome still fell through into approval and merge polling.** `dependsOn` is
   ordering-only in this engine, not a skip, so `prApprovalGate` (gated only on `resolveSignoff`)
   and `pollMerge` ran for an unmergeable PR: a second "Approve and merge" activity and a merge
   poll, exactly the human-intervention path requirement B forbids. `prApprovalGate`, `pollMerge`
   and `mergeOutcome` are now **inside** `postPublishOutcomeGate.then`, whose condition is
   `variables.postPublishOutcome === 'awaiting_human'`. The blocked arm ends at
   `postPublishBlockedTask`; there is no structural path from it to the merge path.

Verification for these three is mutation-tested: making `resolveAddressedThreads` close nothing
fails the fixed-thread test; letting `no_action` enter the commit arm fails the "does not force a
commit" contract; loosening the terminal gate's condition fails the "cannot reach approval"
contract.

### PR #53 review — twelve comments
Two were CodeQL duplicate alerts (`354`, `355`) on one line of a test fixture whose inner single
quotes closed the string literal; `tsc` reports it as TS1005. The other ten were real defects in
the post-publication loop.

| # | Defect | Fix |
| --- | --- | --- |
| 3 | A failed `gh` read left empty arrays, which classified the PR `clean` — an expired token reported success for a PR nobody had read. | Every live read is recorded in `readProblems`; any failure makes the observation `unavailable`. `pr`/`reviews`/threads/commits/check-runs are required; protection and code scanning stay optional (they legitimately 404). |
| 4 | `applyPostPublishDecisions` ran before the judgement gate, so an `invalid` review still PATCHed its valid-looking dismissals, resolved threads, re-requested reviews and commented — while the invalid arm claimed "nothing was dismissed". | The step exits immediately, with a `skipped` result and a stderr warning, when `record.state === 'invalid'`. |
| 5 | `MERGED` landed in `humanOnly`, so a PR a human merged mid-wait was reported `blocked_needs_human`, the ticket never resolved. | New `merged` verdict → `postPublishMergedGate` → `postPublishOutcome = merged`; the terminal gate accepts it, `publishState = merged`, and `prMergePathGate` (`prState !== 'MERGED'`) skips approval and polling so `mergeOutcome` resolves the ticket. |
| 6 | The repair soft-reset to the base branch's **tip**, so its diff reverted every upstream commit merged since the branch was cut — and then force-pushed it. | `resolveRepairBase` returns `git merge-base <base> HEAD`; the repaired commit is parented on the merge base and the PR diff is byte-identical. |
| 7 | A `no_action` verdict closed every `resolvedFindingIds` thread even with no dismissal — a human's thread closed silently. | Only a **dismissed** finding closes a thread here. Anything else is deferred with a reason and left for the published fix. |
| 8 | The repair lived only in the `changes_required` arm, so a repair-only PR (unverifiable commit, no code change) never got repaired and ended `blocked_human`. | `postPublishHandBackGate` also runs when `postPublishRepairNeeded === 'true'`; a nested `postPublishEngineerGate` keeps the *engineer* engaged only for `changes_required`. |
| 9 | Thread closures were logged against the already-incremented cycle, so the record never matched an entry. | `resolveAddressedThreads` writes to the **last** log entry (the one capture wrote for this cycle) and records `resolvedThreadsCycle`. |
| 10 | The check-wait budget was global (a fix's CI starved), and `maxIterations: 12` sat inside the worst-case budget, exiting as `observing` with no reason. | `resetPostPublishWaitCount` on the pushed arm; `maxIterations: 30` (worst case 13); `postPublishObservingReasonGate` names an iteration-cap exit. |
| 11 | `check-runs`, `pulls/{n}/commits` and `pulls/{n}/reviews` used the REST default of 30 per page; `reviewThreads(first:100)` had no paging. A failed check or unverifiable commit beyond page 1 was invisible. | `gh api --paginate` + `per_page=100`, and cursor paging for `reviewThreads`; a truncated read is a `readProblems` failure. |
| 12 | The ref-scoped code-scanning query ran twice, so the flag could disagree with the data used. | One `scopedAlerts` read; `alertsRefScoped` is derived from it. |

## PROCESS-003 — the post-publication budget (REACTORY-302016408/20261118/1057091601)

Observed on instance `6afc1e1d7f79240adc312634` (ticket `REACTORY-302016408/20261117/4204285766`,
PR reactorynet/reactory-reactor#74) with `maxPostPublishFixCycles=2`:

```
11:23:59  reviewer APPROVED (pre-publication) -> publish
11:24:14  review requested on the PR             (reviewDecision becomes REVIEW_REQUIRED)
11:24:28  observation 0: BLOCKED / REVIEW_REQUIRED, findings=[unverifiable_commit],
          judged=no_action, requiredChanges=0, dismissals=1
11:26:37  observation 1: IDENTICAL
11:27:48  step 350 'Stop the loop when the budget is exhausted'
11:27:50  step 460 'Raise the human task for the unmergeable pull request' -> Waiting for Event
13:20:36  a real CHANGES_REQUESTED with a blocking finding arrives (never observed)
07:12:03  (+19h44m) the instance resumed and completed 327/327
```

Four defects, all in this body. The root cause of the first two is the same mistake: the loop
charged and parked on the wrong question.

1. **A no-op observation consumed a FIX cycle (blocking).** `bumpPostPublishCycle` sat on the
   "the re-publish reached origin" arm, which the commit-**repair** path also enters
   (`postPublishHandBackGate` runs for `postPublishRepairNeeded === 'true'` as well as
   `changes_required`). So a cycle the reviewer judged `no_action` — every finding dismissed with
   evidence, nothing for the engineer to do — still re-published a repaired commit and incremented
   the *fix* budget. The counter was per-PUSH, not per required change: two observations 2m09s
   apart drained a budget of 2.
   *Fix:* the counter is charged **only** when the cycle yielded required changes
   (`postPublishDecision === 'changes_required'` — the judgement the engineer had to act on and a
   commit that carried it). Any other re-publish (repair-only, no-op) is a **poll** and is charged
   to the re-observe budget (`postPublishReobserveCount` / `postPublishReobserveBound`), which
   already existed for exactly "a cycle with nothing to fix". A poll never spends
   `maxPostPublishFixCycles`.
2. **`REVIEW_REQUIRED` was treated as a terminal block (blocking).** Two causes, both fixed:
   * the observation classifies a PR with *any* fixable finding as `fixable`, and the exhaustion
     arm then wrote `postPublishOutcome=exhausted` without ever asking what the remaining findings
     were or whether a human action was still awaited. The `awaitingReview` flag existed but no
     exhaustion path read it;
   * nothing compared the observation against the **judgement**: the `unverifiable_commit` had been
     DISMISSED with evidence (`verification.verified=true, reason=valid`), yet it still counted as
     an outstanding blocker.
   *Fix:* a new `readPostPublishExhaustionVerdict` step asks the positive question — *is anything
   left that an agent could act on, once findings dismissed with a justification are removed?* It
   is consulted by all three exhaustion points (fix budget, repair-poll budget and re-observe
   budget) and yields `awaiting` → poll, or `outstanding` → park. `awaiting` switches the loop into
   awaiting mode instead of stopping it, and it never writes `blocked_human`.
   **What the machine state still does:** when the awaiting window finally closes with nothing
   actionable, the run parks exactly like a blocked pull request — `runStatus=blocked`,
   `publishState=blocked_needs_human` — and raises the same human task. Only the WORDS differ
   (`AWAITING HUMAN` and an awaited-review reason, instead of `CANNOT BE MERGED` and an outstanding
   finding). That is deliberate: a `BLOCKED` / `REVIEW_REQUIRED` pull request genuinely cannot be
   merged, so operator dashboards counting it as unmergeable is correct; the defect was the run
   reporting it as a code block while accusing itself of an iteration cap.
3. **The park was unbounded and its wake path was unrecorded (blocking).** `postPublishBlockedTask`
   waits on `workflow.task.completed` correlated by task id, with no deadline, and nothing wrote
   down what published that event. `readPostPublishWake` fills that gap: on resume the step
   records the task id, the event name/key, and the server-stamped `completedByEmail` /
   `completedAt`, in `.ai-agent/post-publish-wake.json` and on the ticket.
   *Fix:* (a) the automatic wait is bounded in the loop — `postPublishAwaitBound` = **40 polls at
   180s, i.e. 120 minutes** — after which the run parks with an accurate "still awaiting a human
   action" reason. That bound is sized from THIS incident, not from taste: the review on PR #74
   arrived 1h56m (11:24:14 → 13:20:36) after publication, and the first version of this fix used a
   60-minute window that closed 56 minutes before it, so the recorded run would still have parked
   and still never seen it. 120 minutes covers the observed latency with minutes to spare, and the
   loop's `maxIterations` is 70 (worst case 53 iterations) so the window is actually usable;
   (b) the task carries a `timeout` (1h) so an unattended park shows as overdue;
   (c) the wake is recorded and reported (`postPublishWakeProbe` → `postPublishWakeComment`).
   **What the wake path actually is:** `workflow.task.completed` is published in exactly one place
   — `completeWorkflowTask` in `reactory-core/resolvers/Task/TaskResolver.ts` — when a human marks
   the task complete; the identity is stamped server-side from the authenticated context. There is
   **no sweeper**: `dueDate` alone resumes nothing, so an overdue task does not wake a run. The
   run observed on this ticket therefore woke because the task was completed, 19h44m after it was
   raised. **A bounded poll does not make that latency irrelevant** - it only reduces the chance of
   needing it. What this body now guarantees is: a review that arrives within **120 minutes** of
   publication is observed automatically, with no human action at all; a review that arrives after
   the window closes is NOT observed by that instance, and only a human completing the raised task
   resumes it (and that resume does not restart the loop). This step now records the attribution
   instead of leaving it to be inferred from a timestamp.
4. **A dismissed finding was listed as outstanding (blocking).** `describePostPublishBlock` printed
   every observation finding and never read `post-publish-review-normalised.json`, so the block
   comment listed the very finding the run had dismissed with evidence. It now removes dismissed
   findings from *Outstanding findings* (saying "none - no agent-actionable finding remains" when
   that empties the list), lists them under *Dismissed this run* with their justification, and
   names an awaited review as an awaited review rather than as an unmergeable pull request.

5. **The repair-poll budget parked without asking (blocking, found in review).** The first version of
   this fix charged a repair-only re-publish to the poll budget (correct) but left that budget's
   exhaustion arm as three unconditional writes - `blocked_human`, a reason, `continue=false`. It
   asked nothing. Since the recorded run took the repair path on EVERY cycle (the only finding was
   the dismissed false positive), the run still parked, now at the third repair instead of the
   second, and still never saw the review. Fixed by consulting the same verdict at all three
   exhaustion points (see the budget table below), and by skipping the reviewer entirely while the
   verdict is `awaiting` so the 40-poll window is one `gh` read every 3 minutes rather than 40 more
   Quality Quinn invocations.
6. **The comment and the verdict could disagree (found in review).** `describePostPublishBlock`
   re-derived the classification and did not apply the verdict's `fixable === false` filter, so an
   observation with a non-fixable finding plus `REVIEW_REQUIRED` produced a verdict of `awaiting`
   and a comment that said `CANNOT BE MERGED`. It now READS `post-publish-exhaustion.json`
   (`verdict`, `actionable`, `dismissed`) and falls back to the same rule only when the record is
   missing or predates the observation it describes.

7. **The poll budget still parked a real fix (blocking, found in review 2).** Charging a repair-only
   re-publish to the poll budget was right, but the arm that `postPublishPushPollGate` guarded ran
   after EVERY re-publish, including a `changes_required` one. So the reachable sequence was: three
   repair re-publishes spend the poll budget → a human submits `CHANGES_REQUESTED` → the reviewer
   returns `changes_required` → the engineer fixes it and the push succeeds → `Number(3) < Number(3)`
   is false → the verdict (`outstanding`, computed from the PRE-FIX observation) routes to the
   parking arm → `blocked_human` **before the fix was ever re-observed**, with a reason that denied
   the judgement had been `changes_required`.
   *Fix:* the gate now short-circuits on the judgement —
   `variables.postPublishDecision === 'changes_required' || Number(postPublishReobserveCount) < Number(postPublishReobserveBound)`.
   The fix budget (`postPublishCycle` vs `maxPostPublishFixCycles`) already bounds real fixes, so the
   poll budget can only stop a cycle that produced NO required change — which is also what lets the
   parking arm's reason describe the judgement truthfully. That reason is now **derived** by
   `describePostPublishPushPollReason` from the judgement and the exhaustion record, and it says
   `INTERNAL CONTRADICTION` if a `changes_required` cycle ever reaches it, instead of asserting a
   claim that can be false.
8. **The acceptance window did not cover the incident's own latency (blocking, found in review 2).**
   The first version polled 20 × 180s = 60 minutes and the README claimed that made the observed
   19h44m latency irrelevant. The review on PR #74 arrived 1h56m after publication — 56 minutes
   after that window closed — so the recorded run would still have parked and still never seen it.
   *Fix:* `postPublishAwaitBound` is 40 (120 minutes), `postPublishLoop.maxIterations` is 70
   (worst case 53 iterations), and the README states the residual plainly: a review that arrives
   inside 120 minutes is observed automatically; one that arrives later is not, and only a completed
   task resumes the instance. There is no waiver in this body because the window now covers the
   latency that produced the ticket.
9. **The test file did not compile (blocking, found in review 2).** It shipped an unmatched `});`
   and an outer `describe` closed at the first group boundary, so B1/D2/D3/D4 ran as top-level
   groups. Jest passed only because the server config transpiles with `isolatedModules` and
   recovers from syntax errors; `tsc` rejected the file. *Fix:* one closing brace removed (which
   repaired the nesting too), and the suite now asserts its own integrity:
   `ts.createSourceFile(...).parseDiagnostics` must be empty and the outer `describe` must be the
   only top-level group.

10. **The awaiting hand-off was undone by its own siblings (blocking, found in review 3).** In the
    previous revision the three terminal steps sat BESIDE `postPublishPushPollVerdictGate` inside
    `postPublishPushPollGate.elseSteps`, so entering awaiting mode was immediately followed by
    `setPostPublishPushPollContinue` (`postPublishContinue='false'`). `postPublishContinue` is not a
    skip, so the rest of the iteration ran and the loop then exited: on the repair path — the
    ticket's OWN path, where the dismissed `unverifiable_commit` re-publishes every cycle — the run
    performed **zero** awaiting polls, parked with `postPublishOutcome` still `observing`, and
    reported *"the observation loop stopped without reaching a terminal state (its iteration cap was
    hit)"*. The suite was green throughout, because it asserted the verdict gate's own arms were
    clean and never asserted the terminal steps were nested INSIDE its else arm.
    *Fix:* `postPublishPushPollGate.elseSteps` is now exactly `[postPublishPushPollVerdictGate]`, the
    three terminal steps live in that gate's else arm, and two structural tests pin both facts — plus
    a third that walks the whole poll arm and asserts `postPublishContinue` is written nowhere
    outside the verdict gate's else arm.
11. **The park was decided before the evidence (blocking, found in review 3).** `postPublishAwaitBudgetGate`
    wrote `awaiting_review` + `continue=false` at the TOP of the iteration, and `continue` is not a
    skip. If a review landed during the final poll the route re-opened, the reviewer returned
    `changes_required`, the engineer pushed the fix — and the loop then exited on the already-set
    `continue=false`, abandoning the fix unobserved.
    *Fix:* the budget gate now only records `postPublishAwaitSpent='true'`. The terminal decision is
    taken at the END of the same iteration, after the observation and the verdict
    (`postPublishAwaitSpentGate`): spent + `awaiting` → park as `awaiting_review`; spent but
    something actionable → clear the marker, leave awaiting mode, and let the normal route re-observe
    the fix. The false "iteration cap" reason is now unreachable, because the outcome is no longer
    `observing` when the run parks.

### The four budgets around a published pull request

| Variable | Bound | Charged by | Exhaustion |
| --- | --- | --- | --- |
| `postPublishCycle` | `maxPostPublishFixCycles` (2) | ONLY a cycle whose judgement was `changes_required` that then pushed a commit | verdict `outstanding` → `exhausted`, parked with the findings named; verdict `awaiting` → enters the awaiting poll |
| `postPublishReobserveCount` | `postPublishReobserveBound` (3) | every other re-publish and every dismiss-all cycle: a **poll**, including the repair-only path (the dismissed `unverifiable_commit` false positive) | verdict `outstanding` → parked; verdict `awaiting` → enters the awaiting poll |
| `postPublishWaitCount` | `postPublishWaitBound` (6) | required checks still running (one minute each) | `awaiting_human` |
| `postPublishAwaitCount` | `postPublishAwaitBound` (40) | a poll where nothing agent-actionable remains and a human action is awaited (3 minutes each = **120 minutes**, sized from the 1h56m latency on PR #74) | `awaiting_review` → parked, honestly labelled as an awaited human action |

All three loop-stopping budgets (fix, repair-poll, re-observe) consult ONE decision before they
stop: `readPostPublishExhaustionVerdict` (top of each iteration) / `readPostPublishPushPollVerdict`
(after each judgement) publish `awaiting` or `outstanding` into `postPublishExhaustionVerdict` /
`postPublishJudgedVerdict`, and the three gates read those variables. The scripts are byte-identical
modulo indentation and pinned by a test, the way the shared review-schema block is pinned. This is
the fix for reviewer B1: before it, the repair-poll arm stopped the run as `blocked_human` without
asking anything, so the recorded run - which took the repair path on every cycle - still parked
before its first review.

The awaiting poll is also **cheap**: while `postPublishAwaiting === 'true'` and the verdict is
`awaiting`, `postPublishRoute` is skipped, so the iteration is one 3-minute delay and one `gh` read -
no Quality Quinn invocation (`agent_conversation`, maxAttempts 4) and no GitHub dismissal writes.
At most 40 polls would otherwise have meant 40 extra reviewer calls per run. A review that lands
flips the verdict to `outstanding`, which re-opens the full route with the fix budget intact.

The await budget is per **run**, not per awaited episode, and the loop's `maxIterations` is 60
(53 iterations of the worst case: 1 + 6 + 2 + 3 + 40 + 1; the cap is 70).

### Verification

```bash
env -u OPENAI_API_KEY node scripts/ai/run-worktree-tests.js \
  workflow/__tests__/ProcessAITicket.postPublishBudget.test.ts \
  workflow/__tests__/ProcessAITicket.contract.test.ts \
  workflow/__tests__/ProcessAITicket.reviewerSchema.test.ts \
  workflow/__tests__/WorkflowRegistry.test.ts \
  workflow/__tests__/ProcessAITicket.behaviour.test.ts
```

`ProcessAITicket.postPublishBudget.test.ts` is 20 tests. Each one either fails against the
pre-change body for the *actual* defect or is a wiring pin that cannot pass vacuously. The red
outputs name the defects: `Expected "0", Received "1"` for a `no_action` cycle (D1); the
repair-poll arm being exactly `[setPostPublishPushPollBlocked, setPostPublishPushPollReason,
setPostPublishPushPollContinue]` (B1); `Expected "awaiting", Received "outstanding"` when the
verdict consult is mutated out (D2); `Expected: > 0, Received: NaN` for the park deadline (D3);
and `AWAITING HUMAN` vs `BLOCKED ... CANNOT BE MERGED` for the comment/verdict agreement (D4/N1).
The two copies of the exhaustion verdict script are pinned to be identical
(whitespace-normalised), the same way the shared review-schema block is pinned, and the awaiting
poll's bound is pinned at exactly 40 x 180000 ms = 120 minutes, with the incident's 116-minute
latency asserted to be inside it, so the window can neither silently shrink nor grow past
`maxIterations`.

### Delivery note (required)

`1.4.8` still ships **in place**. After this merges, the catalog copy at
`reactory-data/workflows/catalog/core/ProcessAITicket/1.4.8/ProcessAITicket.yaml` **must be
re-synced**, and the "inventory the in-flight runs" pre-step above **must be performed first**:
re-provisioning changes the definition fingerprint and dead-letters every `running`/`suspended`
`core.ProcessAITicket@1.4.8` instance with `reason: "definition-changed"`. That includes instance
`6afc1e1d7f79240adc312634`, which is deliberately left parked.