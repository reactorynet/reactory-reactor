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
