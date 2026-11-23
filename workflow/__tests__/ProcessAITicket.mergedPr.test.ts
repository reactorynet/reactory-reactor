/**
 * REACTORY-302016408/20261108/378847235 — a run whose pull request is ALREADY
 * MERGED must terminate, resolve its ticket, and raise NO approval task.
 *
 * The recorded incident (instance 6af004863542e9a7f9bada9f, express-server#108):
 * the pull request was merged at 05:26:58Z, the publish tail re-ran at 05:55:38Z,
 * `createPullRequest` failed because the squash-merge had deleted the branch, that
 * failure carried NO state, `readCreatedPrState` failed OPEN to 'OPEN', and the
 * approval gate raised a task for a merge that had already happened. The run then
 * parked on it for ever (status Pending, prState 'OPEN', prPollCount 0).
 *
 * These tests execute the shipped `cli_command` scripts and evaluate the SHIPPED
 * gate conditions, so they fail against the pre-fix body:
 *   - `prMergePathGate` was `variables.prState !== 'MERGED'` and consumed a cached
 *     `prState`, not a live read;
 *   - `readCreatedPrState` defaulted to 'OPEN';
 *   - `createPullRequest`'s failure arm carried no state at all;
 *   - `pushBranch` happily re-pushed (recreated) a deleted branch behind a merge;
 *   - nothing between `prematurePublishGate` and `reviewLoop` looked at the PR.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { YamlFlowParser } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/YamlFlowParser';

const WORKFLOW_FILE = path.resolve(__dirname, '..', 'ProcessAITicket.yaml');

interface IStep {
  id: string;
  name?: string;
  type: string;
  config?: Record<string, any>;
  dependsOn?: string | string[];
}

const parsed = new YamlFlowParser({ validateSchema: true }).parseFromFile(WORKFLOW_FILE) as any;
if (!parsed.success) throw new Error('ProcessAITicket.yaml failed to parse: ' + JSON.stringify(parsed.errors));

const all: IStep[] = [];
const walk = (steps: IStep[]): void => {
  (steps || []).forEach((step) => {
    all.push(step);
    const config = step.config || {};
    ['thenSteps', 'elseSteps', 'steps'].forEach((key) => {
      if (Array.isArray(config[key])) walk(config[key]);
    });
  });
};
walk(parsed.workflow.steps);

const byId = (id: string): IStep => {
  const hit = all.find((step) => step.id === id);
  if (!hit) throw new Error(`step "${id}" not found`);
  return hit;
};
const scriptOf = (id: string): string => String(byId(id).config!.args[1]);

const runScript = (script: string, env: Record<string, string>, cwd: string): string =>
  execFileSync(process.execPath, ['-e', script], {
    cwd,
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const runJson = (script: string, env: Record<string, string>, cwd: string): any =>
  JSON.parse(runScript(script, env, cwd));
const runToken = (script: string, env: Record<string, string>, cwd: string): string =>
  runScript(script, env, cwd).trim();
const sh = (command: string, cwd: string): string =>
  execFileSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const tempDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const removeDir = (dir: string): void => {
  try {
    (fs as unknown as { rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void }).rmSync(dir, {
      recursive: true,
      force: true,
    });
  } catch (e) {
    // best effort
  }
};

/**
 * A repository shaped like the published worktree: a base commit on master, one
 * commit on the ticket branch, `origin` = this repo and `origin/master` present (the
 * steps resolve the base from it).
 */
const repo = (): { dir: string; base: string; head: string } => {
  const root = tempDir('pa-merged-');
  const origin = path.join(root, 'origin.git');
  sh('git init -q --bare "' + origin + '"', root);
  const dir = path.join(root, 'work');
  fs.mkdirSync(dir, { recursive: true });
  sh('git init -q -b master .', dir);
  sh('git config user.email test@example.com', dir);
  sh('git config user.name Test', dir);
  sh('git config commit.gpgsign false', dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  sh('git add -A && git commit -qm base', dir);
  const base = sh('git rev-parse HEAD', dir);
  sh('git checkout -q -b feature/test', dir);
  fs.writeFileSync(path.join(dir, 'work.ts'), 'export const v = 1;\n', 'utf8');
  fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
  sh('git add -A && git commit -qm "AI engineering run: REF-1"', dir);
  const head = sh('git rev-parse HEAD', dir);
  // A SEPARATE bare origin: `git ls-remote` must reflect what was actually pushed,
  // and the ticket branch deliberately is NOT on it (the squash-delete shape).
  sh('git remote add origin "' + origin + '"', dir);
  sh('git push -q origin master', dir);
  sh('git fetch -q origin', dir);
  fs.writeFileSync(
    path.join(dir, '.ai-agent', 'report.json'),
    JSON.stringify({ status: 'completed', summary: 'Did the work.', changes: [{ file: 'work.ts', description: 'changed' }] }),
    'utf8',
  );
  return { dir, base, head };
};

/**
 * A fake `gh` that DISTINGUISHES the target it was given, exactly as gh does.
 *
 * A number or a url resolves the pull request ($GH_VIEW_JSON / $GH_VIEW_EXIT). A
 * BRANCH answers `no pull requests found for branch <b>` unless
 * $GH_BRANCH_VIEW_JSON is supplied - which is the real behaviour after a
 * squash-merge DELETED the head branch, and the reason the shared reader resolves
 * number -> url -> branch instead of branch-only. A stub that answered for any
 * target could not tell a branch-only resolver from a correct one.
 *
 * `create` is recorded in $GH_MARKER before it fails, so a test can assert the pull
 * request was never re-created.
 */
const fakeGh = (dir: string): string => {
  const bin = path.join(dir, '.fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/bin/sh',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      '  target="$3"',
      '  case "$target" in',
      '    "") kind=branch ;;',
      '    http://*|https://*) kind=url ;;',
      '    *[!0-9]*) kind=branch ;;',
      '    *) kind=number ;;',
      '  esac',
      '  if [ "$kind" = "branch" ]; then',
      '    if [ -n "$GH_BRANCH_VIEW_JSON" ]; then echo "$GH_BRANCH_VIEW_JSON"; exit 0; fi',
      '    echo "no pull requests found for branch \"$target\"" >&2',
      '    exit 1',
      '  fi',
      '  if [ -n "$GH_VIEW_ERR" ]; then echo "$GH_VIEW_ERR" >&2; fi',
      '  if [ -n "$GH_VIEW_JSON" ]; then echo "$GH_VIEW_JSON"; fi',
      '  exit ${GH_VIEW_EXIT:-0}',
      'fi',
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      '  if [ -n "$GH_MARKER" ]; then echo "create" >> "$GH_MARKER"; fi',
      '  echo "fatal: Head ref must be a branch" >&2',
      '  exit 1',
      'fi',
      'if [ "$1" = "repo" ]; then echo master; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  return bin;
};

const MERGED_108 = JSON.stringify({
  state: 'MERGED',
  mergedAt: '2026-11-08T05:26:58Z',
  url: 'https://github.com/reactorynet/reactory-express-server/pull/108',
  number: 108,
});

const withGh = (dir: string, env: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> =>
  Object.assign({ PATH: fakeGh(dir) + ':' + process.env.PATH }, env, extra);

// ─────────────────────────────────────────────────────────────────────────────
// The live read is the ONLY source of the value the gates consume.
// ─────────────────────────────────────────────────────────────────────────────
describe('ProcessAITicket live pull request state read', () => {
  const approvalRead = scriptOf('readPrStateForApproval');
  const reviewRead = scriptOf('readPrStateBeforeReview');

  it('uses ONE implementation for the review-entry and approval reads', () => {
    expect(reviewRead).toBe(approvalRead);
    // The read is a live gh call, not a parse of a cached step output.
    expect(approvalRead).toContain('gh pr view');
    expect(approvalRead).toContain('--json state,mergedAt,url,number');
    expect(approvalRead).not.toContain('process.env.PR_STATE');
  });

  it.each([
    ['MERGED', MERGED_108],
    ['CLOSED', JSON.stringify({ state: 'CLOSED', url: 'https://x/pull/9', number: 9 })],
    ['OPEN', JSON.stringify({ state: 'OPEN', url: 'https://x/pull/9', number: 9 })],
  ])('reports %s from the live read', (expected, payload) => {
    const ctx = repo();
    try {
      const out = runJson(
        approvalRead,
        withGh(ctx.dir, { WT: ctx.dir, BRANCH: 'feature/test', PR_NUMBER: '9' }, { GH_VIEW_JSON: payload }),
        ctx.dir,
      );
      expect(out.ok).toBe(true);
      expect(out.state).toBe(expected);
    } finally {
      removeDir(ctx.dir);
    }
  });

  it('distinguishes "no pull request exists" from "the state could not be read"', () => {
    const ctx = repo();
    try {
      const none = runJson(
        approvalRead,
        withGh(ctx.dir, { WT: ctx.dir, BRANCH: 'feature/test' }, { GH_VIEW_EXIT: '1', GH_VIEW_ERR: 'no pull requests found for branch "feature/test"' }),
        ctx.dir,
      );
      expect(none.state).toBe('NONE');

      const unreadable = runJson(
        approvalRead,
        withGh(ctx.dir, { WT: ctx.dir, BRANCH: 'feature/test', PR_NUMBER: '9' }, { GH_VIEW_EXIT: '1', GH_VIEW_ERR: 'HTTP 502: Bad Gateway' }),
        ctx.dir,
      );
      expect(unreadable.ok).toBe(false);
      expect(unreadable.state).toBe('UNKNOWN');
      expect(String(unreadable.reason)).toContain('could not be read');
    } finally {
      removeDir(ctx.dir);
    }
  });

  it('never answers OPEN when the state is absent, unrecognised, or an unresolved template', () => {
    const ctx = repo();
    try {
      const absent = runJson(
        approvalRead,
        withGh(ctx.dir, { WT: ctx.dir, BRANCH: 'feature/test', PR_NUMBER: '9' }, { GH_VIEW_JSON: '{}' }),
        ctx.dir,
      );
      expect(absent.state).toBe('UNKNOWN');

      // An unrun step's output reaches env as the literal template. It is not a value:
      // the reader falls through to the branch instead of treating it as a PR identity.
      const template = runJson(
        approvalRead,
        withGh(
          ctx.dir,
          { WT: ctx.dir, BRANCH: 'feature/test', PR_NUMBER: '${steps.readPrNumber.outputs.stdout}', PR_URL: '${steps.readPrUrl.outputs.stdout}' },
          { GH_VIEW_EXIT: '1', GH_VIEW_ERR: 'no pull requests found for branch "feature/test"' },
        ),
        ctx.dir,
      );
      expect(template.state).toBe('NONE');
      expect(template.state).not.toBe('OPEN');
    } finally {
      removeDir(ctx.dir);
    }
  });

  it('reports an UNREADABLE state as UNKNOWN and names the reason', () => {
    const ctx = repo();
    try {
      const record = {
        ok: false,
        state: 'UNKNOWN',
        reason: 'the pull request state could not be read: HTTP 502: Bad Gateway',
      };
      const reason = runToken(scriptOf('readPrStateForApprovalReason'), { RAW: JSON.stringify(record) }, ctx.dir);
      expect(reason).toContain('HTTP 502');
      expect(runToken(scriptOf('readPrStateForApprovalValue'), { RAW: JSON.stringify(record) }, ctx.dir)).toBe('UNKNOWN');
      // An absent reason still says so rather than emitting an empty comment.
      expect(runToken(scriptOf('readPrStateForApprovalReason'), { RAW: '{}' }, ctx.dir)).toContain('no reason was recorded');
    } finally {
      removeDir(ctx.dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The shipped gate conditions, evaluated exactly the way ConditionStep does.
// ─────────────────────────────────────────────────────────────────────────────
const evalCondition = (id: string, scope: Record<string, any>): boolean => {
  const condition = String(byId(id).config!.condition);
  // Same sandbox shape as YamlFlowBuilder.evalExpression, which is the engine that
  // actually evaluates these conditions: `steps` is the step-output accessor.
  const fn = new Function(
    'input', 'inputs', 'variables', 'env', 'steps', 'stepResults', 'workflow',
    `"use strict"; try { return Boolean(${condition}); } catch (e) { return false; }`,
  );
  const inputs = scope.input || {};
  return fn(inputs, inputs, scope.variables || {}, scope.env || {}, scope.steps || {}, scope.steps || {}, {});
};

interface IGateOutcome {
  task: boolean;
  claim?: 'new' | 'reuse';
  merged?: boolean;
  closed?: boolean;
  unreadable?: boolean;
  prState: string;
}

const children = (id: string, key: 'thenSteps' | 'elseSteps'): string[] =>
  ((byId(id).config || {})[key] || []).map((step: IStep) => step.id);

/**
 * Walk the SHIPPED gate structure for one pass. Every branch decision is the step's
 * own condition, evaluated exactly as the engine evaluates it, and the claim flag is
 * READ FROM THE SHIPPED STEPS (`setPrApprovalTaskClaimed` / `prApprovalClaimGate`),
 * not passed in as a literal - a rename on either side fails here.
 */
const driveGate = (liveState: string, pass: 'first' | 'second' = 'first'): IGateOutcome => {
  const variables: Record<string, any> = {
    prState: '',
    prApproved: 'false',
    // 'first' is the value the run SEEDS (`seedPrApprovalTaskClaimed`); 'second' is the
    // value the run RECORDS before raising the task (`setPrApprovalTaskClaimed`). Both
    // are read from the shipped steps, so renaming either one breaks these tests.
    prApprovalTaskClaimed: pass === 'second' ? prApprovalTaskClaimed : String(byId('seedPrApprovalTaskClaimed').config!.value),
    prApprovalClaim: '',
    prApprovalOpen: '',
  };
  const steps = { resolveSignoff: { stdout: 'true' } };
  const scope = { variables, steps };

  const recorded = runToken(
    scriptOf('readPrStateForApprovalValue'),
    { RAW: JSON.stringify({ state: liveState }) },
    os.tmpdir(),
  );
  variables.prState = recorded;
  const outcome: IGateOutcome = { task: false, prState: recorded };

  const walkArm = (ids: string[]): string | null => {
    for (const id of ids) {
      const step = byId(id);
      if (step.type !== 'condition') continue;
      if (id === 'claimPrApprovalGate') {
        if (!evalCondition(id, scope)) continue;
        const reuse = evalCondition('prApprovalClaimGate', scope);
        // The shipped writers: `setPrApprovalClaimNew|Reuse` are the values the run
        // actually records, so read them instead of assuming. A reuse pass keeps
        // observing (setPrApprovalOpenReuse) and never records an approval.
        variables.prApprovalClaim = reuse
          ? String(byId('setPrApprovalClaimReuse').config!.value)
          : String(byId('setPrApprovalClaimNew').config!.value);
        if (reuse) variables.prApprovalOpen = String(byId('setPrApprovalOpenReuse').config!.value);
        outcome.claim = reuse ? 'reuse' : 'new';
        continue;
      }
      if (id === 'prApprovalGate') {
        outcome.task = evalCondition(id, scope);
        if (outcome.task) return 'task';
        continue;
      }
      if (id === 'prMergedPathGate') {
        if (evalCondition(id, scope)) { outcome.merged = true; return 'merged'; }
        const inner = walkArm(children(id, 'elseSteps'));
        if (inner) return inner;
        continue;
      }
      if (id === 'prClosedPathGate') {
        if (evalCondition(id, scope)) { outcome.closed = true; return 'closed'; }
        const inner = walkArm(children(id, 'elseSteps'));
        if (inner) return inner;
        continue;
      }
      if (id === 'prStateUnknownPathGate') {
        if (evalCondition(id, scope)) { outcome.unreadable = true; return 'unreadable'; }
        continue;
      }
      const inner = walkArm(children(id, evalCondition(id, scope) ? 'thenSteps' : 'elseSteps'));
      if (inner) return inner;
    }
    return null;
  };

  const openGate = evalCondition('prMergePathGate', scope);
  walkArm(children('prMergePathGate', openGate ? 'thenSteps' : 'elseSteps'));
  if (!openGate && !outcome.merged && !outcome.closed && !outcome.unreadable) {
    throw new Error('no gate arm matched state ' + liveState);
  }
  return outcome;
};

/** The claim the run RECORDS on its first pass, read from the shipped step. */
const prApprovalTaskClaimed = String(byId('setPrApprovalTaskClaimed').config!.value);

/**
 * Execute the shipped `reportBranch` body (the completed-report arm) against a
 * variable set, descending into the arm each condition selects and skipping a
 * `while` whose condition is false. Returns the ids that actually run.
 *
 * This is what makes the publish veto testable: a condition step is NOT a
 * terminator, so "the guard ran" says nothing about whether pushBranch runs.
 */
const simulateCompletedPath = (variables: Record<string, any>, steps: Record<string, any>): string[] => {
  const executed: string[] = [];
  const scope = { variables, steps };
  const run = (ids: string[]): void => {
    for (const id of ids) {
      const step = byId(id);
      if (id === 'reportBranch') continue;
      if (step.type === 'condition') {
        run(children(id, evalCondition(id, scope) ? 'thenSteps' : 'elseSteps'));
        continue;
      }
      if (step.type === 'while') {
        executed.push(id + ':condition=' + String(evalCondition(id, scope)));
        if (evalCondition(id, scope)) run(((step.config || {}).steps || []).map((s: IStep) => s.id));
        continue;
      }
      executed.push(id);
    }
  };
  run(children('reportBranch', 'thenSteps'));
  return executed;
};

describe('ProcessAITicket approval gate: four-way outcome, no task for a terminal PR', () => {
  it('arms the human task only for a LIVE OPEN pull request', () => {
    const open = driveGate('OPEN');
    expect(open.task).toBe(true);
    expect(open.claim).toBe('new');
    expect(open.prState).toBe('OPEN');
  });

  it('raises NO task for MERGED and records the fresh MERGED state (not a stale OPEN)', () => {
    const merged = driveGate('MERGED');
    expect(merged.task).toBe(false);
    expect(merged.merged).toBe(true);
    expect(merged.prState).toBe('MERGED');
    // The merged arm records the lifecycle state and leaves resolution to mergeOutcome.
    expect(String(byId('setPublishStateMergedAtApproval').config!.value)).toBe('merged');
    expect(String(byId('mergeOutcome').config!.condition)).toBe("variables.prState === 'MERGED'");
    expect(String(byId('resolveTicket').config!.params.status)).toBe('resolved');
  });

  it('raises NO task for CLOSED, with its own distinct terminal reason', () => {
    const closed = driveGate('CLOSED');
    expect(closed.task).toBe(false);
    expect(closed.closed).toBe(true);
    expect(String(byId('setPrTerminalReasonClosed').config!.value)).toBe('pull_request_closed');
    expect(String(byId('setRunStatusClosedAtApproval').config!.value)).toBe('blocked');
    expect(String(byId('setPublishStateClosedAtApproval').config!.value)).toBe('closed');
  });

  it('raises NO task for an UNREADABLE state and says it could not be determined', () => {
    const unknown = driveGate('UNKNOWN');
    expect(unknown.task).toBe(false);
    expect(unknown.unreadable).toBe(true);
    expect(String(byId('setPrTerminalReasonUnreadable').config!.value)).toBe('pull_request_state_unreadable');
    expect(String(byId('prStateUnknownComment').config!.params.comment)).toContain('could not be confirmed');
    // No approval task anywhere in the unreadable arm.
    expect(JSON.stringify(byId('prStateUnknownPathGate'))).not.toContain('user_activity');
  });

  // ── criterion 5, tightened: read the SHIPPED claim, never a literal ──────
  it('writes and tests ONE shipped claim key, so a rename cannot silently re-mint a task', () => {
    // The writer.
    expect(byId('setPrApprovalTaskClaimed').config!.key).toBe('prApprovalTaskClaimed');
    expect(String(byId('setPrApprovalTaskClaimed').config!.value)).toBe('true');
    // The reader - the exact condition string the engine evaluates.
    expect(String(byId('prApprovalClaimGate').config!.condition)).toBe("variables.prApprovalTaskClaimed === 'true'");
    // The reuse decision the second pass records.
    expect(byId('setPrApprovalClaimReuse').config!.key).toBe('prApprovalClaim');
    expect(String(byId('setPrApprovalClaimReuse').config!.value)).toBe('reuse');
    expect(byId('setPrApprovalClaimNew').config!.key).toBe('prApprovalClaim');
    expect(String(byId('setPrApprovalClaimNew').config!.value)).toBe('new');
    // The claim is written BEFORE the gate reads it.
    expect(byId('prApprovalGate').dependsOn).toBe('claimPrApprovalGate');
  });

  it('is idempotent: a second pass over the tail cannot mint a second task', () => {
    // Pass 1: the pull request is OPEN and the run has not asked yet -> ONE task.
    const first = driveGate('OPEN');
    expect(first.task).toBe(true);
    expect(first.claim).toBe('new');

    // Pass 2: the run carries the claim that setPrApprovalTaskClaimed writes (the
    // walker reads that value from the shipped step) -> reuse, NO second task.
    const second = driveGate('OPEN', 'second');
    expect(second.task).toBe(false);
    expect(second.claim).toBe('reuse');
    // A reuse pass keeps OBSERVING (never approving): its poll condition is explicit.
    const pollCondition = String(byId('pollMerge').config!.condition);
    expect(pollCondition).toContain("variables.prApprovalOpen === 'true'");
    expect(pollCondition).not.toContain('prApproved = true');
  });

  it('a REUSE pass never records an approval nobody gave', () => {
    // The gate is false on a reuse pass, so it must not take the
    // "requireSignoff=false" bypass - that arm is the ONLY place that records
    // prApproved=true without a human, and it is nested behind its own condition.
    expect((byId('prApprovalGate').config!.elseSteps || []).map((step: IStep) => step.id)).toEqual([
      'prSignoffBypassGate',
    ]);
    expect(String(byId('prSignoffBypassGate').config!.condition)).toBe("steps.resolveSignoff.stdout !== 'true'");
    expect((byId('prSignoffBypassGate').config!.thenSteps || []).map((step: IStep) => step.id)).toEqual([
      'logNoSignoff',
      'setPrApprovedNoSignoff',
    ]);
    // Nothing in the claim/reuse arm writes prApproved.
    expect(JSON.stringify(byId('prApprovalClaimGate'))).not.toContain('prApproved');
    expect(JSON.stringify(byId('setPrApprovalOpenReuse'))).not.toContain('prApproved');
  });

  it('the recorded incident chain can no longer arm a gate', () => {
    // The real chain from instance 6af004863542e9a7f9bada9f: `gh pr create` failed
    // (the squash-merge deleted the branch) while the pull request state could not be
    // read. Pre-fix the failure carried NO state, readCreatedPrState defaulted it to
    // OPEN, and the gate armed a task for the already-merged pull request.
    const ctx = repo();
    try {
      const pr = runJson(
        scriptOf('createPullRequest'),
        withGh(ctx.dir, createEnv(ctx.dir), { GH_VIEW_EXIT: '1', GH_VIEW_ERR: 'HTTP 502: Bad Gateway' }),
        ctx.dir,
      );
      expect(pr.ok).toBe(false);
      const recorded = runToken(scriptOf('readCreatedPrState'), { PR: JSON.stringify(pr) }, ctx.dir);
      // Pre-fix this was 'OPEN'.
      expect(recorded).not.toBe('OPEN');
      expect(recorded).toBe('UNKNOWN');

      // And the gate refuses to arm for that recorded state: no task a human could
      // only truthfully answer with "it is already merged".
      const outcome = driveGate(recorded);
      expect(outcome.task).toBe(false);
      expect(outcome.unreadable).toBe(true);
    } finally {
      removeDir(ctx.dir);
    }
  });

  it('regression: the tail driven TWICE with the merge in between raises exactly ONE task and ends MERGED', () => {
    // Pass 1 - before the human merged.
    const pass1 = driveGate('OPEN');
    expect(pass1.task).toBe(true);
    let tasks = pass1.task ? 1 : 0;

    // The human merges. The publish tail re-enters (reviewCycle 2) carrying the claim
    // that setPrApprovalTaskClaimed wrote.
    const pass2 = driveGate('MERGED');
    tasks += pass2.task ? 1 : 0;

    expect(tasks).toBe(1);
    expect(pass2.merged).toBe(true);
    expect(pass2.prState).toBe('MERGED');
    // The merged arm cannot leave a terminal-adjacent park: nothing in it waits.
    expect(JSON.stringify(byId('prMergedPathGate'))).not.toContain('waitForEvent');
    expect(JSON.stringify(byId('prMergedPathGate'))).not.toContain('user_activity');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B1: the guard is not a terminator, so the PUBLISH ARM is vetoed as well.
// ─────────────────────────────────────────────────────────────────────────────
describe('ProcessAITicket publish veto for a run that ended before review (B1)', () => {
  /** Variables as they stand when the exhausted/merged-before-review pass reaches `outcome`. */
  const vetoVariables = (terminal: string): Record<string, any> => ({
    // readPublishable re-derives true from the accepted review of the cycle that
    // opened the pull request; that is exactly the value that re-entered the tail.
    publishable: 'true',
    reviewEntryTerminal: terminal,
    reviewVerdict: 'approved',
    runHalt: 'false',
    confirmationReview: 'false',
    reviewCycle: 2,
    integrityBlocked: 'false',
    prState: terminal === 'merged' ? 'MERGED' : terminal === 'closed' ? 'CLOSED' : 'unknown',
    prApproved: 'false',
    runStatus: 'pending',
  });

  const vetoSteps = (): Record<string, any> => ({
    readReportStatus: { stdout: 'completed' },
    readReviewOutcomeNarrative: { stdout: 'ended because the pull request was already MERGED' },
    readExhaustedNoteMode: { stdout: 'close' },
    readExhaustedNotePrUrl: { stdout: 'https://github.com/x/y/pull/108' },
    readExhaustedPrState: { stdout: 'MERGED' },
    readExhaustedRunStatus: { stdout: 'completed' },
    readExhaustedCommentTail: { stdout: 'nothing left to do' },
    readExhaustedNotifyEvent: { stdout: 'ticket.resolved' },
    readAcceptanceNarrative: { stdout: 'reviewed and APPROVED by the reviewer' },
    readPublishable: { stdout: 'true' },
  });

  it.each(['merged', 'closed'])('vetoes the publish arm when reviewEntryTerminal is %s', (terminal) => {
    // The veto is on the ONLY gate into the publish arm...
    expect(String(byId('outcome').config!.condition)).toBe(
      "variables.publishable === 'true' && variables.reviewEntryTerminal === ''",
    );
    // ...and the engine's own evaluation of it is false even with publishable=true.
    const variables = vetoVariables(terminal);
    expect(evalCondition('outcome', { variables, steps: vetoSteps() })).toBe(false);
    // Without the terminal it is true: the veto is the terminal, not a broken gate.
    expect(evalCondition('outcome', { variables: Object.assign({}, variables, { reviewEntryTerminal: '' }), steps: vetoSteps() })).toBe(true);

    // Now walk the SHIPPED completed path: no publish-arm step may run.
    const executed = simulateCompletedPath(variables, vetoSteps());
    const forbidden = [
      'commitChanges',
      'verifyCommitSignatures',
      'readPublishReadiness',
      'pushBranch',
      'createPullRequest',
      'prPublishedGate',
      'postPublishLoop',
      'postPublishBlockedTask',
      'observePullRequest',
      'acceptedLog',
      'acceptedComment',
    ];
    forbidden.forEach((id) => expect(executed).not.toContain(id));
    // ...and the truthful terminal path DOES run.
    expect(executed).toContain('retainWorkspaceNoteExhausted');
    expect(executed).toContain('setRunStatusExhausted');
    expect(executed).toContain('setPrStateNotOpenedExhausted');
    expect(executed).toContain('exhaustedComment');
  });

  it('the terminal state of that path comes from the truthful readers', () => {
    const merged = vetoVariables('merged');
    // runStatus: completed because the pull request merged; prState MERGED; note closed.
    expect(runToken(scriptOf('readExhaustedRunStatus'), { TERMINAL: merged.reviewEntryTerminal }, os.tmpdir())).toBe('completed');
    expect(runToken(scriptOf('readExhaustedPrState'), { TERMINAL: merged.reviewEntryTerminal }, os.tmpdir())).toBe('MERGED');
    expect(runToken(scriptOf('readExhaustedNoteMode'), { TERMINAL: merged.reviewEntryTerminal }, os.tmpdir())).toBe('close');
    // Exactly ONE note close on this path, and it carries the pull request url.
    expect(byId('retainWorkspaceNoteExhausted').config!.env.MODE).toBe('${steps.readExhaustedNoteMode.outputs.stdout}');
    expect(byId('retainWorkspaceNoteExhausted').config!.env.PR_URL).toBe('${steps.readExhaustedNotePrUrl.outputs.stdout}');
    const url = runToken(
      scriptOf('readExhaustedNotePrUrl'),
      { TERMINAL: 'merged', LIVE: JSON.stringify({ state: 'MERGED', url: 'https://github.com/x/y/pull/108' }) },
      os.tmpdir(),
    );
    expect(url).toBe('https://github.com/x/y/pull/108');
    // A rejected run (no terminal) keeps 'Not opened.' semantics: empty url.
    expect(runToken(scriptOf('readExhaustedNotePrUrl'), { TERMINAL: '', LIVE: '{}' }, os.tmpdir())).toBe('');
    // Exactly ONE note writer runs on this path, and it is the sourced exhausted one.
    const executed = simulateCompletedPath(vetoVariables('merged'), vetoSteps());
    const noteWriters = executed.filter((id) => /WorkspaceNote/.test(id));
    expect(noteWriters).toEqual(['retainWorkspaceNoteExhausted']);
  });

  it('a merged-before-review run announces resolution exactly once', () => {
    const event = (terminal: string): string =>
      runToken(scriptOf('readExhaustedNotifyEvent'), { TERMINAL: terminal }, os.tmpdir());
    expect(event('merged')).toBe('ticket.resolved');
    expect(event('closed')).toBe('ticket.comment.added');
    expect(event('')).toBe('ticket.comment.added');
    expect(byId('exhaustedNotify').dependsOn).toBe('readExhaustedNotifyEvent');
    expect(byId('exhaustedNotify').config!.params.event).toBe('${steps.readExhaustedNotifyEvent.outputs.stdout}');
    // The guard arm no longer raises its own notification or note close.
    ['notifyMergedBeforeReview', 'closeWorkspaceNoteMergedBeforeReview', 'setRunStatusMergedBeforeReview'].forEach((id) => {
      expect(all.map((step) => step.id)).not.toContain(id);
    });
  });

  it('the ONE note close records the pull request, not "Not opened."', () => {
    // End-to-end through the shipped note script: a merged run's permanent memory note
    // must name the pull request it merged. Before this, the guard closed the note and
    // the exhausted arm closed it AGAIN with no PR_URL, rewriting the section to
    // 'Not opened.' (N1).
    const data = tempDir('pa-note-');
    const work = repo();
    try {
      const persona = 'FixturePersona';
      const workspace = path.join(data, 'profiles', 'reactor', 'personas', persona, 'workspace');
      fs.mkdirSync(path.join(workspace, 'in-progress'), { recursive: true });
      fs.mkdirSync(path.join(workspace, 'complete'), { recursive: true });
      const env = {
        WT: work.dir,
        REACTORY_DATA: data,
        REF: 'REACTORY-302016408/20261108/2077440061',
        TICKET_ID: 'fixture-ticket-id',
        REPO: work.dir,
        BRANCH: 'feature/test',
        PERSONA: persona,
        CYCLES: '2',
        NOTE_STATUS: 'blocked',
        REASON: 'recorded',
      };
      runScript(scriptOf('openWorkspaceNote'), Object.assign({ MODE: 'open' }, env), work.dir);

      const noteMode = runToken(scriptOf('readExhaustedNoteMode'), { TERMINAL: 'merged' }, work.dir);
      const noteUrl = runToken(
        scriptOf('readExhaustedNotePrUrl'),
        { TERMINAL: 'merged', LIVE: JSON.stringify({ state: 'MERGED', url: 'https://github.com/x/y/pull/108' }) },
        work.dir,
      );
      expect(noteMode).toBe('close');
      expect(noteUrl).toBe('https://github.com/x/y/pull/108');

      const closed = runJson(
        scriptOf('retainWorkspaceNoteExhausted'),
        Object.assign({}, env, { MODE: noteMode, PR_URL: noteUrl }),
        work.dir,
      );
      expect(closed.ok).toBe(true);
      expect(closed.moved).toBe(true);
      expect(closed.warnings || []).toEqual([]);
      const text = fs.readFileSync(closed.notePath, 'utf8');
      expect(text).toContain('status: completed');
      expect(text).toContain('https://github.com/x/y/pull/108');
      expect(text).not.toContain('Not opened.');
      // ONE note exists, in complete/, and nothing is left in progress/.
      expect(fs.readdirSync(path.join(workspace, 'complete')).length).toBe(1);
      expect(fs.readdirSync(path.join(workspace, 'in-progress')).length).toBe(0);
    } finally {
      removeDir(data);
      removeDir(work.dir);
    }
  });

  it('readPublishable itself refuses to re-derive an approval for a terminated run', () => {
    const ctx = repo();
    try {
      fs.mkdirSync(path.join(ctx.dir, '.ai-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(ctx.dir, '.ai-agent', 'run-identity.json'),
        JSON.stringify({ runId: 'run-1', ticketReference: 'REF-1' }),
        'utf8',
      );
      const out = runToken(scriptOf('readPublishable'), { WT: ctx.dir, TERMINAL: 'merged', REF: 'REF-1', HALT: 'false' }, ctx.dir);
      expect(out).toBe('false');
      const decision = JSON.parse(fs.readFileSync(path.join(ctx.dir, '.ai-agent', 'publish-decision.json'), 'utf8'));
      expect(decision.publishable).toBe(false);
      expect(decision.outcome).toBe('terminal_before_review');
      expect(String(decision.basis)).toContain('already merged');
      expect(decision.runId).toBe('run-1');
    } finally {
      removeDir(ctx.dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPullRequest / pushBranch: never re-create or re-push behind a merge.
// ─────────────────────────────────────────────────────────────────────────────
const createEnv = (dir: string): Record<string, string> => ({
  WT: dir,
  BRANCH: 'feature/test',
  REF: 'REACTORY-302016408/20261108/2077440061',
  REQUEST: 'Fixture ticket',
  REQUEST_TYPE: 'bug',
  CYCLES: '2',
  REVIEWER: 'QualityQuinn',
  TICKET_ID: 'fixture-ticket-id',
  // The recorded identity the shipped `env` supplies: a squash-merge deletes the head
  // branch, so the preflight must be able to resolve the pull request without it.
  PR_NUMBER: '108',
  PR_URL: 'https://github.com/reactorynet/reactory-express-server/pull/108',
});

describe('ProcessAITicket createPullRequest with a merged pull request', () => {
  it('reports the LIVE MERGED state, creates nothing, and is not a failure', () => {
    const ctx = repo();
    try {
      const marker = path.join(ctx.dir, '.fake-bin', 'create-called');
      const out = runJson(
        scriptOf('createPullRequest'),
        withGh(ctx.dir, createEnv(ctx.dir), { GH_VIEW_JSON: MERGED_108, GH_MARKER: marker }),
        ctx.dir,
      );
      expect(out.ok).toBe(true);
      expect(out.created).toBe(false);
      expect(out.state).toBe('MERGED');
      expect(String(out.prUrl)).toContain('/pull/108');
      // `gh pr create` was NEVER invoked: the pull request was not re-created.
      expect(fs.existsSync(marker)).toBe(false);
      // It resolved the recorded NUMBER, not the (deleted) branch name.
      expect(byId('createPullRequest').config!.env.PR_NUMBER).toBe('${steps.readPrNumber.outputs.stdout}');
      expect(byId('createPullRequest').config!.env.PR_URL).toBe('${steps.readPrUrl.outputs.stdout}');
    } finally {
      removeDir(ctx.dir);
    }
  });

  it('carries the live state on the failure arm instead of no state at all', () => {
    const ctx = repo();
    try {
      const out = runJson(
        scriptOf('createPullRequest'),
        withGh(ctx.dir, createEnv(ctx.dir), { GH_VIEW_EXIT: '1', GH_VIEW_ERR: 'HTTP 502: Bad Gateway' }),
        ctx.dir,
      );
      expect(out.ok).toBe(false);
      // The pre-fix arm had NO state field; readCreatedPrState then defaulted it to OPEN.
      expect(out.state).toBe('UNKNOWN');
      expect(out.state).not.toBe('OPEN');
      expect(String(out.error)).toContain('gh pr create failed');
    } finally {
      removeDir(ctx.dir);
    }
  });

  it('readCreatedPrState never fails open', () => {
    const ctx = repo();
    try {
      const read = (pr: any): string => runToken(scriptOf('readCreatedPrState'), { PR: JSON.stringify(pr) }, ctx.dir);
      expect(read({})).toBe('UNKNOWN');
      expect(read({ state: 'weird' })).toBe('UNKNOWN');
      expect(read({ state: 'merged' })).toBe('MERGED');
      expect(read({ state: 'CLOSED' })).toBe('CLOSED');
      expect(read({ state: 'OPEN' })).toBe('OPEN');
    } finally {
      removeDir(ctx.dir);
    }
  });
});

describe('ProcessAITicket pushBranch with a merged pull request', () => {
  it('does not push at all, so a squash-deleted branch is not recreated', () => {
    // The branch does NOT exist on origin (the squash-delete shape), and the fake gh
    // answers 'no pull requests found for branch ...' for a BRANCH target. The step
    // therefore only stays safe by resolving the recorded NUMBER first.
    const ctx = repo();
    try {
      const out = runJson(
        scriptOf('pushBranch'),
        withGh(ctx.dir, { WT: ctx.dir, BRANCH: 'feature/test', PR_NUMBER: '108', PR_URL: 'https://github.com/x/y/pull/108' }, { GH_VIEW_JSON: MERGED_108 }),
        ctx.dir,
      );
      expect(out.ok).toBe(true);
      expect(out.pushed).toBe(false);
      expect(out.skipped).toBe(true);
      expect(out.state).toBe('MERGED');
      // Nothing reached origin.
      expect(sh('git ls-remote --heads origin feature/test', ctx.dir)).toBe('');
    } finally {
      removeDir(ctx.dir);
    }
  });

  it('cannot see a deleted branch by name alone - which is why the number is threaded', () => {
    // Without the recorded number/url the preflight is branch-only, and gh resolves
    // nothing after a squash-merge. This documents the limitation the threading fixes.
    const ctx = repo();
    try {
      const out = runJson(
        scriptOf('pushBranch'),
        withGh(ctx.dir, { WT: ctx.dir, BRANCH: 'feature/test' }, { GH_VIEW_JSON: MERGED_108 }),
        ctx.dir,
      );
      expect(out.state).toBe('NONE');
      expect(out.pushed).toBe(true);
      // The shipped step wires the recorded identity in, so production is never this.
      expect(byId('pushBranch').config!.env.PR_NUMBER).toBe('${steps.readPrNumber.outputs.stdout}');
      expect(byId('pushBranch').config!.env.PR_URL).toBe('${steps.readPrUrl.outputs.stdout}');
    } finally {
      removeDir(ctx.dir);
    }
  });

  it('still pushes an OPEN pull request (re-publication after a fix cycle)', () => {
    const ctx = repo();
    try {
      const out = runJson(
        scriptOf('pushBranch'),
        withGh(ctx.dir, { WT: ctx.dir, BRANCH: 'feature/test', PR_NUMBER: '9' }, {
          GH_VIEW_JSON: JSON.stringify({ state: 'OPEN', url: 'https://x/pull/9', number: 9 }),
        }),
        ctx.dir,
      );
      expect(out.ok).toBe(true);
      expect(out.pushed).toBe(true);
      expect(out.state).toBe('OPEN');
      expect(sh('git ls-remote --heads origin feature/test', ctx.dir)).not.toBe('');
    } finally {
      removeDir(ctx.dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A review cycle that starts after the merge terminates instead of re-publishing.
// ─────────────────────────────────────────────────────────────────────────────
describe('ProcessAITicket review entry after the pull request merged', () => {
  it('guards the review loop with a LIVE read, before the loop', () => {
    const order = all.map((step) => step.id);
    expect(order.indexOf('readPrStateBeforeReview')).toBeLessThan(order.indexOf('prMergedBeforeReviewGate'));
    expect(order.indexOf('prMergedBeforeReviewGate')).toBeLessThan(order.indexOf('reviewLoop'));
    expect(order.indexOf('prematurePublishGate')).toBeLessThan(order.indexOf('readPrStateBeforeReview'));
    // The loop cannot run once the guard recorded a terminal reason.
    expect(String(byId('reviewLoop').config!.condition)).toContain("variables.reviewEntryTerminal === ''");
    // ...and the guard's own condition is the state the live read wrote.
    expect(String(byId('prMergedBeforeReviewGate').config!.condition)).toBe("variables.prState === 'MERGED'");
    expect(byId('prMergedBeforeReviewGate').dependsOn).toBe('setPrStateBeforeReview');
    expect(byId('setPrStateBeforeReview').config!.sourcePath).toBe('readPrStateBeforeReviewValue.outputs.stdout');
  });

  it('resolves the ticket and leaves the terminal state to the single terminal path', () => {
    expect(String(byId('resolveTicketMergedBeforeReview').config!.params.status)).toBe('resolved');
    expect(String(byId('setPublishStateMergedBeforeReview').config!.value)).toBe('merged');
    expect(String(byId('settleReviewLoopMergedBeforeReview').config!.value)).toBe('true');
    expect(String(byId('setReviewEntryTerminalMerged').config!.value)).toBe('merged');
    // The guard is a SIBLING of the rest of the body, not a terminator, so this arm does
    // only the pre-terminal work; runStatus/prState/note/comment/notify come from the
    // exhausted arm (asserted in the publish-veto suite).
    expect(all.map((step) => step.id)).not.toContain('closeWorkspaceNoteMergedBeforeReview');
    expect(all.map((step) => step.id)).not.toContain('notifyMergedBeforeReview');
    // Nothing in that arm itself can push, publish, review or gate.
    const arm = JSON.stringify(byId('prMergedBeforeReviewGate'));
    ['pushBranch', 'createPullRequest', 'user_activity', 'observePullRequest', 'reviewLoop'].forEach((forbidden) => {
      expect(arm).not.toContain('"' + forbidden + '"');
    });
  });

  it('a CLOSED pull request gets its own distinct reason and does not resolve the ticket', () => {
    expect(String(byId('prClosedBeforeReviewGate').config!.condition)).toBe("variables.prState === 'CLOSED'");
    expect(String(byId('setPrTerminalReasonClosedBeforeReview').config!.value)).toBe('pull_request_closed_before_review');
    expect(JSON.stringify(byId('prClosedBeforeReviewGate'))).not.toContain('updateStatus');
  });

  it('the terminal writers follow the recorded reason instead of hard-coding blocked', () => {
    const runStatus = (terminal: string): string =>
      runToken(scriptOf('readExhaustedRunStatus'), { TERMINAL: terminal }, os.tmpdir());
    expect(runStatus('merged')).toBe('completed');
    expect(runStatus('closed')).toBe('blocked');
    expect(runStatus('')).toBe('blocked');

    const prState = (terminal: string): string =>
      runToken(scriptOf('readExhaustedPrState'), { TERMINAL: terminal }, os.tmpdir());
    expect(prState('merged')).toBe('MERGED');
    expect(prState('closed')).toBe('CLOSED');
    expect(prState('')).toBe('NOT_OPENED');

    const noteMode = (terminal: string): string =>
      runToken(scriptOf('readExhaustedNoteMode'), { TERMINAL: terminal }, os.tmpdir());
    expect(noteMode('merged')).toBe('close');
    expect(noteMode('closed')).toBe('retain');
    expect(noteMode('')).toBe('retain');

    const tail = (terminal: string): string =>
      runToken(scriptOf('readExhaustedCommentTail'), { TERMINAL: terminal, BRANCH: 'bug/REF-1' }, os.tmpdir());
    expect(tail('merged')).toContain('already been merged');
    expect(tail('closed')).toContain('already been closed');
    // The rejection wording is untouched.
    expect(tail('')).toContain('Human review required');
  });

  it('the narrative distinguishes merged/closed from a rejection', () => {
    const narrative = (terminal: string): string =>
      runToken(
        scriptOf('readReviewOutcomeNarrative'),
        {
          WT: os.tmpdir(),
          HALT: 'false',
          CYCLES: '2',
          TERMINAL: terminal,
        },
        os.tmpdir(),
      );
    expect(narrative('merged')).toContain('already MERGED');
    expect(narrative('closed')).toContain('CLOSED');
    expect(narrative('')).toContain('NOT accepted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW ROUND 1 (REACTORY-302016408/20261108/378847235)
//
// R1: a branch is keyed on the TICKET REFERENCE, so an EARLIER dispatch's pull
// request lives on it and `gh pr view <branch>` returns that one once it is closed
// or merged. A terminal answer is therefore honoured only when it CARRIES this
// run's work (the local HEAD is an ancestor of the PR's head). Without this, a
// re-dispatch of a ticket whose PR was closed/merged could never publish again.
//
// R2: the approval-gate read must tolerate a transient gh failure instead of
// turning a publishable run into a taskless block.
// ─────────────────────────────────────────────────────────────────────────────

/** A gh stub that FAILS the first `pr view` call and succeeds afterwards. */
const flakyGh = (dir: string, json: string): string => {
  const bin = path.join(dir, '.flaky-bin');
  fs.mkdirSync(bin, { recursive: true });
  const counter = path.join(dir, '.gh-calls');
  const payload = path.join(dir, '.gh-payload.json');
  fs.writeFileSync(payload, json, 'utf8');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/bin/sh',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      '  n=0',
      '  [ -f "' + counter + '" ] && n=$(cat "' + counter + '")',
      '  n=$((n+1))',
      '  echo "$n" > "' + counter + '"',
      '  if [ "$n" -le 1 ]; then',
      '    echo "HTTP 502: bad gateway" >&2',
      '    exit 1',
      '  fi',
      '  cat "' + payload + '"',
      '  exit 0',
      'fi',
      'if [ "$1" = "repo" ]; then echo master; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  return bin + ':' + process.env.PATH;
};

describe('ProcessAITicket stale pull request on a ticket branch (review R1)', () => {
  const readEnv = (dir: string): Record<string, string> => ({
    WT: dir,
    BRANCH: 'feature/test',
    PR_URL: '',
    PR_NUMBER: '',
  });

  it('publishes a fresh pull request when an EARLIER dispatch MERGED pull request does not carry this run', () => {
    const { dir, base, head } = repo();
    try {
      // The PR on this branch merged an OLDER commit; the local branch has moved on.
      expect(head).not.toBe(base);
      const earlier = JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-10-24T08:48:00Z',
        url: 'https://github.com/reactor/pr/26',
        number: 26,
        headRefOid: base,
      });
      const out = runJson(
        scriptOf('readPrStateBeforeReview'),
        withGh(dir, readEnv(dir), { GH_BRANCH_VIEW_JSON: earlier }),
        dir,
      );
      // NOT terminal: the run must publish its own work (the #26 -> #27 precedent).
      expect(out.ok).toBe(true);
      expect(out.state).toBe('NONE');
      expect(out.stalePr && out.stalePr.state).toBe('MERGED');
      expect(String(out.reason)).toContain('does not carry this run work');
    } finally {
      removeDir(dir);
    }
  });

  it('publishes a fresh pull request when an EARLIER dispatch CLOSED pull request does not carry this run', () => {
    const { dir, base } = repo();
    try {
      const earlier = JSON.stringify({ state: 'CLOSED', url: 'https://github.com/reactor/pr/73', number: 73, headRefOid: base });
      const out = runJson(
        scriptOf('readPrStateBeforeReview'),
        withGh(dir, readEnv(dir), { GH_BRANCH_VIEW_JSON: earlier }),
        dir,
      );
      expect(out.state).toBe('NONE');
      expect(out.stalePr && out.stalePr.state).toBe('CLOSED');
    } finally {
      removeDir(dir);
    }
  });

  it('STILL treats a MERGED pull request as terminal when it carries this run s head', () => {
    const { dir, head } = repo();
    try {
      const sameRun = JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-11-08T05:26:58Z',
        url: 'https://github.com/reactor/pr/108',
        number: 108,
        headRefOid: head,
      });
      const out = runJson(
        scriptOf('readPrStateBeforeReview'),
        withGh(dir, readEnv(dir), { GH_BRANCH_VIEW_JSON: sameRun }),
        dir,
      );
      // The incident shape must stay terminal: express-server#108's head WAS the local HEAD.
      expect(out.state).toBe('MERGED');
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket approval gate read tolerates a transient gh failure (review R2)', () => {
  it('retries and returns the real state instead of UNKNOWN on a single failure', () => {
    const { dir, head } = repo();
    try {
      const openJson = JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/reactor/pr/1',
        number: 1,
        headRefOid: head,
      });
      const out = runJson(
        scriptOf('readPrStateForApproval'),
        { PATH: flakyGh(dir, openJson), WT: dir, BRANCH: 'feature/test', PR_URL: '', PR_NUMBER: '' },
        dir,
      );
      // One transient failure must NOT become a taskless block.
      expect(out.state).toBe('OPEN');
      expect(Number(fs.readFileSync(path.join(dir, '.gh-calls'), 'utf8').trim())).toBeGreaterThan(1);
    } finally {
      removeDir(dir);
    }
  });

  it('still answers UNKNOWN when every attempt fails', () => {
    const { dir } = repo();
    try {
      // A NUMBER target (not a branch): a branch with no pull request legitimately answers
      // NONE, so only a recorded number exercises the "every attempt failed" path.
      const out = runJson(
        scriptOf('readPrStateForApproval'),
        withGh(dir, { WT: dir, BRANCH: 'feature/test', PR_URL: '', PR_NUMBER: '123' }, { GH_VIEW_EXIT: '1', GH_VIEW_ERR: 'HTTP 502: bad gateway' }),
        dir,
      );
      expect(out.state).toBe('UNKNOWN');
    } finally {
      removeDir(dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW ROUND 2 (REACTORY-302016408/20261108/378847235)
//
// R3: the "carries this run's work" discriminator must apply ONLY to a BRANCH
// target. A recorded number/url came from this run's own createPullRequest, so a
// human rebasing/force-pushing that PR must not make it look like a predecessor's
// pull request (which produced "no pull request exists" for a MERGED PR).
//
// R4: the round-1 discriminator existed in three copies but only the anchor was
// tested - removing the pushBranch or createPullRequest copy left the suite green.
// These tests drive the SHIPPED pushBranch and createPullRequest scripts against a
// stale-PR stub, so a future edit cannot quietly restore the round-1 blocker.
// ─────────────────────────────────────────────────────────────────────────────

describe('ProcessAITicket approval read: own PR by number is never stale (review R3)', () => {
  it('reports MERGED for a recorded NUMBER whose head no longer contains local HEAD', () => {
    const { dir, base } = repo();
    try {
      // Our own PR, rebased by a human: its head is NOT a descendant of local HEAD.
      const rebased = JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-11-08T05:26:58Z',
        url: 'https://github.com/reactor/pr/27',
        number: 27,
        headRefOid: base,
      });
      const out = runJson(
        scriptOf('readPrStateForApproval'),
        withGh(dir, { WT: dir, BRANCH: 'feature/test', PR_URL: '', PR_NUMBER: '27' }, { GH_VIEW_JSON: rebased }),
        dir,
      );
      // A number is this run's own PR by construction: never downgraded to NONE.
      expect(out.state).toBe('MERGED');
      expect(out.readBy).toBe('number');
    } finally {
      removeDir(dir);
    }
  });

  it('reports CLOSED for a recorded NUMBER rather than NONE', () => {
    const { dir, base } = repo();
    try {
      const closed = JSON.stringify({ state: 'CLOSED', url: 'https://github.com/reactor/pr/27', number: 27, headRefOid: base });
      const out = runJson(
        scriptOf('readPrStateForApproval'),
        withGh(dir, { WT: dir, BRANCH: 'feature/test', PR_URL: '', PR_NUMBER: '27' }, { GH_VIEW_JSON: closed }),
        dir,
      );
      expect(out.state).toBe('CLOSED');
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket pushBranch/createPullRequest share the stale-PR rule (review R4)', () => {
  /**
   * A gh stub that answers a BRANCH target with the supplied (stale) JSON, and - once
   * `gh pr create` has been called - answers the branch with the NEW pull request.
   * That is what real gh does after a create: the branch gains an OPEN PR, so a
   * later `pr view <branch>` returns the new one, not the predecessor.
   */
  const branchGh = (dir: string, json: string, marker: string): string => {
    const bin = path.join(dir, '.branch-bin');
    fs.mkdirSync(bin, { recursive: true });
    const payload = path.join(dir, '.branch-payload.json');
    const created = path.join(dir, '.created-payload.json');
    fs.writeFileSync(payload, json, 'utf8');
    fs.writeFileSync(created, JSON.stringify({ state: 'OPEN', url: 'https://github.com/reactor/pull/999', number: 999, headRefOid: 'deadbeef' }), 'utf8');
    fs.writeFileSync(
      path.join(bin, 'gh'),
      [
        '#!/bin/sh',
        'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
        '  if [ -f "' + marker + '" ]; then cat "' + created + '"; else cat "' + payload + '"; fi',
        '  exit 0',
        'fi',
        'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
        '  echo "create" >> "' + marker + '"',
        '  echo "https://github.com/reactor/pull/999"',
        '  exit 0',
        'fi',
        'if [ "$1" = "repo" ]; then echo master; exit 0; fi',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    return bin + ':' + process.env.PATH;
  };

  it('pushBranch PUSHES when the branch carries a stale CLOSED pull request (R4)', () => {
    const { dir, base } = repo();
    try {
      const stale = JSON.stringify({ state: 'CLOSED', url: 'https://github.com/reactor/pr/26', number: 26, headRefOid: base });
      const out = runJson(
        scriptOf('pushBranch'),
        { PATH: branchGh(dir, stale, path.join(dir, '.mk1')), WT: dir, BRANCH: 'feature/test' },
        dir,
      );
      // Removing the discriminator from this copy made it skip the push.
      expect(out.pushed).toBe(true);
      expect(out.state).toBe('NONE');
    } finally {
      removeDir(dir);
    }
  });

  it('pushBranch SKIPS the push when the stale pull request carries this run (control)', () => {
    const { dir, head } = repo();
    try {
      const ours = JSON.stringify({ state: 'MERGED', url: 'https://github.com/reactor/pr/108', number: 108, headRefOid: head });
      const out = runJson(
        scriptOf('pushBranch'),
        { PATH: branchGh(dir, ours, path.join(dir, '.mk2')), WT: dir, BRANCH: 'feature/test' },
        dir,
      );
      expect(out.pushed).toBe(false);
      expect(out.skipped).toBe(true);
      expect(out.state).toBe('MERGED');
    } finally {
      removeDir(dir);
    }
  });

  it('createPullRequest CREATES a pull request when the branch carries a stale CLOSED one (R4)', () => {
    const { dir, base } = repo();
    try {
      const marker = path.join(dir, '.create-marker');
      const stale = JSON.stringify({ state: 'CLOSED', url: 'https://github.com/reactor/pr/26', number: 26, headRefOid: base });
      const out = runJson(
        scriptOf('createPullRequest'),
        {
          PATH: branchGh(dir, stale, marker),
          WT: dir,
          BRANCH: 'feature/test',
          REF: 'REF-1',
          REQUEST: 'do the thing',
          CYCLES: '1',
          REVIEWER: 'QualityQuinn',
          REQUEST_TYPE: 'bug',
          TICKET_ID: 't1',
        },
        dir,
      );
      // The round-1 blocker reappeared here silently: created:false + the OLD pr url.
      expect(out.created).toBe(true);
      expect(String(out.prUrl)).toContain('/pull/999');
    } finally {
      removeDir(dir);
    }
  });
});
