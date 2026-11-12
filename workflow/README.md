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
6. Re-provision `reactory-data/workflows/catalog/core/ProcessAITicket/<version>/` and run
   `__tests__/WorkflowRegistry.test.ts` plus both `ProcessAITicket.*.test.ts` suites before
   dispatching a real ticket.

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
