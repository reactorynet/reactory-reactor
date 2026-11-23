/**
 * REACTORY-302016408/20261118/1057091601 — the post-publication budget.
 *
 * The run that produced this ticket (instance 6afc1e1d7f79240adc312634, PR
 * reactory-reactor#74) had `maxPostPublishFixCycles=2`, made TWO observations two
 * minutes apart, judged `no_action` with ZERO required changes both times, and then
 * reported the pull request as "cannot be merged / budget exhausted" — while the
 * only real blocker was a human review that had not been written yet. Four defects:
 *
 *   D1  A no-op observation consumed a FIX cycle. The counter was incremented on
 *       the "the re-publish reached origin" arm, which the commit-REPAIR path also
 *       enters, so a cycle the reviewer judged `no_action` still charged the fix
 *       budget — the budget is per-PUSH, not per required change. A poll is not a
 *       fix.
 *   D2  `REVIEW_REQUIRED` was treated as a terminal block once the budget was
 *       spent: the exhaustion arm wrote `postPublishOutcome=exhausted` without ever
 *       asking whether anything agent-actionable remained, so a converged pull
 *       request reported itself as unmergeable and raised the human "unmergeable
 *       pull request" task.
 *   D3  The park had no deadline and no recorded wake path: `postPublishBlockedTask`
 *       waits on `workflow.task.completed` correlated by task id, and nothing wrote
 *       down who or what published it, so a 2-hour-late review was invisible for
 *       19h44m and the resume could not be attributed.
 *   D4  A finding the run had DISMISSED with evidence was listed under "Outstanding
 *       findings" in the block comment: `describePostPublishBlock` printed every
 *       observation finding and never consulted the judgement.
 *
 * These tests execute the shipped `cli_command` scripts — the same discipline the
 * rest of this suite follows — and they fail against the pre-fix body (the new step
 * ids do not exist, `bumpPostPublishCycle` ignores the verdict, and the block
 * comment lists dismissed findings).
 *
 * ── WHAT THIS SUITE DOES NOT COVER, STATED SO IT CANNOT BE MISTAKEN ──────────
 * A review that lands AFTER the run parks is not observed by that instance. The
 * parked `user_activity` step suspends on `workflow.task.completed` correlated by
 * task id; `UserActivityStep`'s `timeout` only writes `Task.dueDate` and there is no
 * sweeper, so a due date resumes nothing. What this body does provide is a bounded
 * in-loop poll (40 x 180s = 120 minutes, pinned by a test) that observes the pull
 * request WITHOUT any human action, so a review written while a human is looking at
 * it IS picked up and enters a fix cycle. The tests below therefore assert:
 *   - a review that arrives WHILE the loop is observing -> 'outstanding' + fix budget;
 *   - the awaiting poll's exact bound, so it cannot silently change;
 *   - the parked task's wording and deadline, NOT a wake after the park.
 * `postPublishWakeProbe` records who completed the task when the instance does
 * resume, which is attribution, not a re-entry path.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { YamlFlowParser } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/YamlFlowParser';
import * as ts from 'typescript';

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
    // best effort: the OS temp directory will be reclaimed anyway
  }
};

/** A published pull request checkout: `.ai-agent/` exists, `origin` is this repo. */
const publishedRepo = (): string => {
  const dir = tempDir('pa-budget-');
  sh('git init -q -b master .', dir);
  sh('git config user.email owner@example.com', dir);
  sh('git config user.name "Key Owner"', dir);
  sh('git config commit.gpgsign false', dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  sh('git add -A && git commit -qm base', dir);
  sh('git checkout -q -b feature/test', dir);
  fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'work.ts'), 'export const v = 1;\n', 'utf8');
  sh('git add -A && git commit -qm "AI engineering run: REF-1"', dir);
  sh('git remote add origin .', dir);
  sh('git push -q origin feature/test', dir);
  return dir;
};

const COMMIT_SHA = 'eac38992b6f8c1a1b1a1b1a1b1a1b1a1b1a1b1a1';

/**
 * The observation the run actually recorded: GitHub reported BLOCKED with
 * REVIEW_REQUIRED, and the only finding was an `unverifiable_commit` that GitHub's
 * ASYNCHRONOUS signature verification had not yet settled (the false positive of
 * REACTORY-302016408/20261114/787370442).
 */
const reviewRequiredObservation = (overrides: Record<string, any> = {}): Record<string, any> =>
  Object.assign(
    {
      state: 'fixable',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      awaitingReview: true,
      awaitingChecks: false,
      pendingChecks: [],
      pr: { number: 74, url: 'https://x/pull/74', state: 'OPEN' },
      findings: [
        {
          id: 'commit:eac38992b6f8',
          kind: 'unverifiable_commit',
          sha: COMMIT_SHA,
          body: 'GitHub reports verified:false (reason unknown) for commit eac38992b6f8',
          fixable: true,
        },
      ],
      counts: { total: 1, fixable: 1, humanOnly: 0, staleReviews: 0, pendingChecks: 0 },
    },
    overrides,
  );

/** The judgement QualityQuinn wrote in both cycles: dismiss, with evidence. */
const dismissTheCommitJudgement = (): Record<string, any> => ({
  cycle: 0,
  state: 'no_action',
  requiredChanges: [],
  requiredChangeIds: [],
  resolvedFindingIds: [],
  dismissals: [
    {
      findingId: 'commit:eac38992b6f8',
      justification:
        'gh api repos/reactorynet/reactory-reactor/commits/' +
        COMMIT_SHA +
        ' returns verification.verified=true, reason=valid, verified_at 11:24:10Z - GitHub signature verification is asynchronous and the observation read it mid-flight.',
      dismissedReason: 'false positive',
      dismissedComment: 'Verified out of band through the commits API.',
    },
  ],
});

const writeObservation = (dir: string, payload: Record<string, any>): void => {
  fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ai-agent', 'post-publish-observation.json'), JSON.stringify(payload), 'utf8');
};

const writeJudgement = (dir: string, payload: Record<string, any>): void => {
  fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.ai-agent', 'post-publish-review-normalised.json'),
    JSON.stringify(payload),
    'utf8',
  );
};

/**
 * Evaluate a real YAML `condition` expression against a stub context, exactly the
 * way the builder does (`steps.<id>.<key>` — the accessor already unwraps
 * `outputs`). Using the shipped expression is the point: a test that restated the
 * comparison could pass while the gate disagreed.
 */
const evaluate = (
  stepId: string,
  variables: Record<string, any>,
  steps: Record<string, any> = {},
): boolean => {
  const condition = String(byId(stepId).config!.condition);
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'input',
    'inputs',
    'variables',
    'env',
    'steps',
    'stepResults',
    'workflow',
    `"use strict"; return (${condition});`,
  );
  return fn({}, {}, variables, {}, steps, {}, undefined) === true;
};

/**
 * Build the TEMPLATE TEXT a workflow step's `env` value has to contain.
 *
 * Several assertions below check that a step's env entry is the engine's
 * interpolation placeholder - the literal characters `$`, `{`, the expression,
 * `}` - because the engine resolves it at run time. Writing that as a
 * single-quoted '$' + '{expr}' is correct, but CodeQL's
 * js/template-syntax-in-string-literal query flags it (correctly, in general):
 * that shape in a non-template literal is almost always a typo for a template
 * literal, and the scan cannot tell an intentional literal from a mistake
 * (alert #358 on PR #78).
 *
 * Assembling the placeholder here says what is meant - template TEXT, not a
 * template LITERAL - and keeps the security scan clean without suppressing the
 * query or weakening the assertion. The expected value is byte-identical to
 * what it was before.
 */
const asTemplate = (expression: string): string => ['$', '{', expression, '}'].join('');

const descendants = (id: string): string[] => {
  const out: string[] = [];
  const visit = (steps: IStep[]): void => {
    (steps || []).forEach((step) => {
      out.push(step.id);
      const config = step.config || {};
      ['thenSteps', 'elseSteps', 'steps'].forEach((key) => {
        if (Array.isArray(config[key])) visit(config[key]);
      });
    });
  };
  const hit = all.find((step) => step.id === id);
  if (hit) {
    visit((hit.config!.thenSteps as IStep[]) || []);
    visit((hit.config!.elseSteps as IStep[]) || []);
    visit((hit.config!.steps as IStep[]) || []);
  }
  return out;
};

describe('ProcessAITicket post-publication budget (REACTORY-302016408/20261118/1057091601)', () => {

  /**
   * B3 guard: this FILE must be valid TypeScript and must nest every group under
   * the outer describe. The reviewed revision had two parse errors (an unmatched
   * `});`) and an outer describe closed at the first group boundary, which only
   * passed because the server jest config transpiles with isolatedModules and
   * recovers from syntax errors. `tsc` rejected it.
   */
  it('is valid TypeScript and keeps every group inside this describe', () => {
    const source = fs.readFileSync(__filename, 'utf8');
    const sf = ts.createSourceFile(__filename, source, ts.ScriptTarget.Latest, true);
    expect(sf.parseDiagnostics.map((d) => d.messageText)).toEqual([]);

    // Every describe/it in this file must be nested inside the OUTER describe,
    // i.e. no `describe(` starts at column 0 below the first one.
    const strayTopLevelGroups = source
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^(describe|it)\(/.test(line))
      .map(({ line, index }) => ({ line, index: index + 1 }));
    // The outer describe itself is the only top-level group.
    expect(strayTopLevelGroups).toHaveLength(1);
    expect(strayTopLevelGroups[0].line).toContain('ProcessAITicket post-publication budget');
  });
  describe('D1 — a no-op observation is a POLL, not a fix', () => {
    it('does not charge a fix cycle for a cycle that produced no required change', () => {
      const dir = publishedRepo();
      try {
        const bump = scriptOf('bumpPostPublishCycle');
        // A no_action cycle owes the engineer nothing, so it must not advance the
        // fix budget. This is the defect: both recorded cycles judged no_action with
        // 0 required changes and each one incremented the counter.
        expect(runToken(bump, { N: '0', DECISION: 'no_action' }, dir)).toBe('0');
        expect(runToken(bump, { N: '1', DECISION: 'no_action' }, dir)).toBe('1');
        expect(runToken(bump, { N: '1', DECISION: 'invalid' }, dir)).toBe('1');
        // A cycle that DID yield required changes the engineer acted on is charged.
        expect(runToken(bump, { N: '0', DECISION: 'changes_required' }, dir)).toBe('1');
        expect(runToken(bump, { N: '1', DECISION: 'changes_required' }, dir)).toBe('2');
      } finally {
        removeDir(dir);
      }
    });

    it('charges a repair-only push to the poll budget instead', () => {
      const dir = publishedRepo();
      try {
        // The repair path (postPublishRepairNeeded) pushes a re-created commit with
        // no required change. That re-publish is a poll: it must spend the
        // re-observe budget, which is separate from maxPostPublishFixCycles.
        const poll = scriptOf('bumpPostPublishPollCycle');
        expect(runToken(poll, { N: '0', DECISION: 'no_action' }, dir)).toBe('1');
        expect(runToken(poll, { N: '2', DECISION: 'no_action' }, dir)).toBe('3');
        // A real fix is already charged to the fix budget; it must not also drain
        // the poll budget.
        expect(runToken(poll, { N: '1', DECISION: 'changes_required' }, dir)).toBe('1');
      } finally {
        removeDir(dir);
      }
    });

    it('leaves the two no-op observations unable to park the pull request', () => {
      const dir = publishedRepo();
      try {
        writeObservation(dir, reviewRequiredObservation());
        writeJudgement(dir, dismissTheCommitJudgement());

        const bump = scriptOf('bumpPostPublishCycle');
        const poll = scriptOf('bumpPostPublishPollCycle');
        let cycle = '0';
        let reobserves = '0';
        // 11:24:28 and 11:26:37 - two observations, two repair pushes, both no_action.
        for (let i = 0; i < 2; i += 1) {
          cycle = runToken(bump, { N: cycle, DECISION: 'no_action' }, dir);
          reobserves = runToken(poll, { N: reobserves, DECISION: 'no_action' }, dir);
        }

        // The fix budget is untouched (it was 2 out of 2 before the fix).
        expect(cycle).toBe('0');
        expect(reobserves).toBe('2');
        expect(evaluate('postPublishBudgetGate', { postPublishCycle: cycle, postPublishFixBound: '2' })).toBe(true);

        // ── The TERMINAL path, not just the gate ─────────────────────────────
        // Two no-ops with REVIEW_REQUIRED must not be able to produce
        // blocked_human, and the two steps that report a pull request as
        // unmergeable must be unreachable from the state they leave behind.
        const verdict = runToken(
          scriptOf('readPostPublishExhaustionVerdict'),
          { WT: dir, CYCLE: cycle, OUTCOME: 'observing', BOUND: '2', AWAITED: '0' },
          dir,
        );
        expect(verdict).toBe('awaiting');

        // The verdict routes to the awaiting poll, so no exhaustion step runs.
        expect(evaluate('postPublishAwaitingExhaustedGate', { postPublishExhaustionVerdict: verdict })).toBe(true);
        expect(evaluate('postPublishAwaitingExhaustedGate', { postPublishExhaustionVerdict: 'outstanding' })).toBe(false);

        // ── The steps that DECIDE "unmergeable" are unreachable for this state ──
        // setPostPublishExhausted (fix budget), setPostPublishPushPollBlocked
        // (repair-poll budget) and setPostPublishReobserveBlocked (re-observe
        // budget) are each inside an arm guarded by a verdict that is not
        // 'awaiting', so two no-ops with REVIEW_REQUIRED cannot reach any of them
        // and nothing writes blocked_human.
        const deciders = ['setPostPublishExhausted', 'setPostPublishPushPollBlocked', 'setPostPublishReobserveBlocked'];
        deciders.forEach((id) => {
          const trail = trailOf(id);
          const guarded = trail.some((ancestor) => ancestor === 'postPublishAwaitingExhaustedGate'
            || ancestor === 'postPublishPushPollVerdictGate'
            || ancestor === 'postPublishReobserveAwaitingGate');
          expect(guarded).toBe(true);
        });
        // The awaiting arm writes postPublishOutcome = 'awaiting_review', never
        // blocked_human: that is the acceptance statement.
        expect(valueOf('setPostPublishAwaitExhausted')).toBe('awaiting_review');
        expect(valueOf('setPostPublishAwaitExhausted')).not.toBe('blocked_human');

        // ── The terminal REPORTER is reachable by design, and that is pinned ────
        // postPublishBlockedTask / setRunStatusUnmergeable sit in the
        // postPublishOutcomeGate else arm, which every non-success outcome reaches
        // (including awaiting_review). They are not "unreachable", and asserting
        // they were would be false: a BLOCKED / REVIEW_REQUIRED pull request IS
        // literally unmergeable, so the machine state stays blocked /
        // blocked_needs_human while the human-facing wording says AWAITING HUMAN.
        // That choice is deliberate (review N3) and pinned here and in D4.
        ['postPublishBlockedTask', 'setRunStatusUnmergeable'].forEach((id) => {
          const trail = trailOf(id);
          expect(trail).toContain('postPublishOutcomeGate');
          expect(trail).not.toContain('postPublishAwaitPollGate');
        });
        expect(String(byId('postPublishOutcomeGate').config!.condition)).not.toContain("'awaiting_review'");

        // And the awaiting branch does not set the outcome to blocked_human.
        expect(['setPostPublishAwaitingOnExhaustion', 'setPostPublishAwaitingOnPushPoll', 'setPostPublishAwaitingOnReobserve']
          .every((id) => String(byId(id).config!.key) === 'postPublishAwaiting')).toBe(true);

        // The awaiting arm of the exhaustion gate contains no outcome/stop write.
        const awaitingThen = ((byId('postPublishAwaitingExhaustedGate').config!.thenSteps as IStep[]) || []).map((step) => step.id);
        const awaitingWrites = awaitingThen.reduce<string[]>((acc, id) => acc.concat([id], descendants(id)), []);
        awaitingWrites.forEach((id) => {
          const key = String((byId(id).config && (byId(id).config!.key || byId(id).config!.sourcePath)) || '');
          expect(key).not.toContain('postPublishOutcome');
          expect(key).not.toContain('postPublishContinue');
        });
      } finally {
        removeDir(dir);
      }
    });

    it('gates the re-publish arm on the poll budget, and never on the fix budget', () => {
      const gate = byId('postPublishPushPollGate');
      expect(gate.type).toBe('condition');
      const condition = String(gate.config!.condition);
      expect(condition).toContain('postPublishReobserveCount');
      expect(condition).toContain('postPublishReobserveBound');
      // B1: a real fix short-circuits the poll budget entirely, so the arm can
      // never stop a changes_required cycle (bounded by maxPostPublishFixCycles).
      expect(condition).toContain("variables.postPublishDecision === 'changes_required' ||");
      // The parking steps still exist and still park - for a cycle that owed
      // nothing (see the B1 regression test for the judgement that reaches them).
      expect(valueOf('setPostPublishPushPollBlocked')).toBe('blocked_human');
      expect(valueOf('setPostPublishPushPollContinue')).toBe('false');
      // The fix-budget gate is untouched by the re-publish arm: only a
      // changes_required cycle may charge it.
      expect(byId('bumpPostPublishCycle').config!.env.DECISION).toBe(asTemplate('variables.postPublishDecision'));
      expect(trailOf('bumpPostPublishCycle')).toContain('republishResultGate');
    });
  });

  /**
   * The recorded sequence, end to end at the DECISION level (reviewer B1).
   *
   * This is the ticket's own run, not a corner case: the only finding was an
   * `unverifiable_commit` that GitHub's asynchronous signature verification had not
   * settled, so EVERY observation was `fixable` and every cycle took the commit
   * REPAIR path. The repair path re-publishes, so it charged the poll budget - and
   * that budget's exhaustion arm stopped the run as `blocked_human` without asking
   * what remained. Three repair cycles instead of two, and the review that arrived
   * two hours later was still never seen.
   *
   * Everything here runs the SHIPPED scripts and the SHIPPED condition: the two
   * counters, the verdict, and the gate whose else-arm used to park.
   */
  describe('B1 — a repair-only loop enters the awaiting poll instead of parking', () => {
    const awaitingArmWrites = (gateId: string, arm: 'then' | 'else'): string[] => {
      const steps =
        arm === 'then'
          ? ((byId(gateId).config!.thenSteps as IStep[]) || [])
          : ((byId(gateId).config!.elseSteps as IStep[]) || []);
      const ids = steps.reduce<string[]>((acc, step) => acc.concat([step.id], descendants(step.id)), []);
      return ids.filter((id) => {
        const step = byId(id);
        const key = step.config && (step.config.key || step.config.sourcePath);
        return String(key || '').indexOf('postPublishOutcome') !== -1 || String(key || '').indexOf('postPublishContinue') !== -1;
      });
    };

    it('runs the recorded three repair cycles and then waits, instead of parking', () => {
      const dir = publishedRepo();
      try {
        writeObservation(dir, reviewRequiredObservation());
        writeJudgement(dir, dismissTheCommitJudgement());

        // ── The three repair re-publishes, exactly as the arm charges them ──
        let cycle = '0';
        let polls = '0';
        const gateAt: boolean[] = [];
        for (let i = 0; i < 3; i += 1) {
          cycle = runToken(scriptOf('bumpPostPublishCycle'), { N: cycle, DECISION: 'no_action' }, dir);
          polls = runToken(scriptOf('bumpPostPublishPollCycle'), { N: polls, DECISION: 'no_action' }, dir);
          gateAt.push(
            evaluate('postPublishPushPollGate', {
              postPublishCycle: cycle,
              postPublishFixBound: '2',
              postPublishReobserveCount: polls,
              postPublishReobserveBound: '3',
            }),
          );
        }
        // The counters behave exactly as the reviewer measured them: the fix budget
        // is untouched, the poll budget is spent after the third re-publish.
        expect(cycle).toBe('0');
        expect(polls).toBe('3');
        expect(gateAt).toEqual([true, true, false]);

        // ── The SHIPPED verdict, on the SHIPPED artefacts ──
        // THE DEFECT, named first so its failure message is the defect itself: in
        // the rejected body the spent repair-poll budget had exactly one
        // destination and it parked. Nothing in that arm asked the verdict.
        expect(
          ((byId('postPublishPushPollGate').config!.elseSteps as IStep[]) || []).map((step) => step.id),
        ).toContain('postPublishPushPollVerdictGate');

        const verdict = runToken(
          scriptOf('readPostPublishPushPollVerdict'),
          { WT: dir, CYCLE: cycle, OUTCOME: 'observing', BOUND: '2', AWAITED: '0' },
          dir,
        );
        expect(verdict).toBe('awaiting');

        // ── The arm the spent poll budget now takes ──
        expect(
          evaluate('postPublishPushPollVerdictGate', { postPublishJudgedVerdict: verdict }),
        ).toBe(true);
        expect(valueOf('setPostPublishAwaitingOnPushPoll')).toBe('true');
        expect(String(byId('setPostPublishAwaitingOnPushPoll').config!.key)).toBe('postPublishAwaiting');

        // The awaiting arm must NOT set an outcome and must NOT stop the loop: that
        // is the defect. Nothing in it - at any depth - writes postPublishOutcome or
        // postPublishContinue.
        expect(awaitingArmWrites('postPublishPushPollVerdictGate', 'then')).toEqual([]);
        // The parking arm still exists, and still parks. Its steps are SIBLINGS of
        // the verdict gate inside postPublishPushPollGate.elseSteps, so they are
        // asserted on that arm.
        const parkingArm = ((byId('postPublishPushPollGate').config!.elseSteps as IStep[]) || []).reduce<string[]>(
          (acc, step) => acc.concat([step.id], descendants(step.id)),
          [],
        );
        expect(parkingArm).toContain('postPublishPushPollVerdictGate');
        expect(parkingArm).toContain('setPostPublishPushPollBlocked');
        expect(parkingArm).toContain('setPostPublishPushPollContinue');
        // ...and the awaiting arm of the verdict gate writes no outcome at all.
        expect(awaitingArmWrites('postPublishPushPollVerdictGate', 'then')).toEqual([]);
        // The verdict gate's own else arm parks; its then arm does not write either
        // outcome or continuation.
        expect(awaitingArmWrites('postPublishPushPollVerdictGate', 'then')).toEqual([]);
        expect(valueOf('setPostPublishPushPollBlocked')).toBe('blocked_human');
        expect(valueOf('setPostPublishPushPollContinue')).toBe('false');

        // ...and with a REAL remaining finding the same gate parks, accurately.
        expect(
          evaluate('postPublishPushPollVerdictGate', { postPublishJudgedVerdict: 'outstanding' }),
        ).toBe(false);
      } finally {
        removeDir(dir);
      }
    });

    it('does not stop the repair-push arm on the fix budget, which the repair never charges', () => {
      const dir = publishedRepo();
      try {
        writeObservation(dir, reviewRequiredObservation());
        writeJudgement(dir, dismissTheCommitJudgement());
        // Three repairs, three polls, zero fix cycles: the fix budget is intact, so
        // the fix-budget gate would still allow a real fix if the review lands.
        let cycle = '0';
        for (let i = 0; i < 3; i += 1) {
          cycle = runToken(scriptOf('bumpPostPublishCycle'), { N: cycle, DECISION: 'no_action' }, dir);
          runToken(scriptOf('bumpPostPublishPollCycle'), { N: String(i), DECISION: 'no_action' }, dir);
        }
        expect(cycle).toBe('0');
        expect(evaluate('postPublishBudgetGate', { postPublishCycle: cycle, postPublishFixBound: '2' })).toBe(true);
      } finally {
        removeDir(dir);
      }
    });

    it('keeps the awaiting poll cheap: the reviewer is skipped while the verdict says awaiting', () => {
      // An awaiting iteration must not re-run QualityQuinn (agent_conversation,
      // maxAttempts 4) and must not re-write GitHub dismissals every 3 minutes; up
      // to 20 of those would be 20 extra reviewer invocations per run.
      const condition = String(byId('postPublishRoute').config!.condition);
      expect(condition).toContain("variables.postPublishState === 'fixable'");
      expect(condition).toContain("variables.postPublishAwaiting === 'true'");
      expect(condition).toContain("variables.postPublishExhaustionVerdict === 'awaiting'");
      // A review that LANDS flips the verdict to outstanding, which re-opens the
      // route with the fix budget intact - that is how the review is picked up.
      expect(
        evaluate('postPublishRoute', {
          postPublishState: 'fixable',
          postPublishAwaiting: 'true',
          postPublishExhaustionVerdict: 'awaiting',
        }),
      ).toBe(false);
      expect(
        evaluate('postPublishRoute', {
          postPublishState: 'fixable',
          postPublishAwaiting: 'true',
          postPublishExhaustionVerdict: 'outstanding',
        }),
      ).toBe(true);
      // ...and the skipped iteration is recorded, not silent.
      expect(byId('postPublishAwaitSkipGate').type).toBe('condition');
      expect(descendants('postPublishAwaitSkipGate')).toContain('postPublishAwaitSkipLog');
    });

    it('never parks a REAL fix cycle on the poll budget, even when it is already spent', () => {
      // The reachable B1 path, exactly the recorded PR #74 sequence:
      //   (1) three repair re-publishes charge the poll budget to 3/3;
      //   (2) a human then submits CHANGES_REQUESTED with a blocking thread;
      //   (3) the reviewer returns changes_required, the engineer fixes it and
      //       the re-publish succeeds.
      // The old gate saw Number(3) < Number(3) = false and parked as
      // blocked_human BEFORE re-observing the fix, and its reason text denied the
      // judgement had been changes_required - review B1, required change 3.
      const dir = publishedRepo();
      try {
        // The observation and judgement of the FIX cycle itself.
        writeObservation(
          dir,
          reviewRequiredObservation({
            reviewDecision: 'CHANGES_REQUESTED',
            awaitingReview: false,
            findings: [
              {
                id: 'thread:THREAD_1',
                kind: 'review_thread',
                path: 'src/work.ts',
                line: 12,
                body: 'R1: this path is not covered by the acceptance criteria.',
                fixable: true,
              },
            ],
            counts: { total: 1, fixable: 1, humanOnly: 0, staleReviews: 0, pendingChecks: 0 },
          }),
        );
        writeJudgement(dir, { cycle: 3, state: 'changes_required', requiredChanges: ['R1'], dismissals: [] });

        // (1) The poll budget is already spent: 3 of 3.
        const reobserves = '3';
        const bound = '3';

        // (3) The fix pushed, so the re-publish charged the FIX budget, not the poll.
        const cycleAfterFix = runToken(scriptOf('bumpPostPublishCycle'), { N: '0', DECISION: 'changes_required' }, dir);
        expect(cycleAfterFix).toBe('1');

        // The shipped gate: a real fix must take the NON-parking arm even though
        // the poll budget is exhausted.
        const variables = {
          postPublishDecision: 'changes_required',
          postPublishReobserveCount: reobserves,
          postPublishReobserveBound: bound,
          postPublishCycle: cycleAfterFix,
          postPublishFixBound: '2',
        };
        expect(Number(reobserves) < Number(bound)).toBe(false); // the poll budget IS spent
        expect(evaluate('postPublishPushPollGate', variables)).toBe(true);

        // ...so the run keeps its outcome and its loop, and the branch it takes is
        // the one that records a published fix.
        expect(evaluate('postPublishFixLandedGate', variables)).toBe(true);
        expect(String(byId('postPublishFixLandedLog').config!.message)).toContain('re-observes');

        // The parking arm is reserved for a cycle that owed nothing: with the same
        // exhausted poll budget but a no_action judgement, the gate refuses.
        expect(evaluate('postPublishPushPollGate', Object.assign({}, variables, { postPublishDecision: 'no_action' }))).toBe(false);

        // The reason text can therefore only describe a non-fix cycle, and it is
        // DERIVED from the judgement rather than asserted (required change 2).
        expect(byId('describePostPublishPushPollReason').type).toBe('cli_command');
        expect((byId('setPostPublishPushPollReason') as any).dependsOn).toBe('describePostPublishPushPollReason');
        expect(String((byId('setPostPublishPushPollReason').config as any).source)).toBe('step_output');
        expect(byId('describePostPublishPushPollReason').config!.env.DECISION).toBe(
          asTemplate('variables.postPublishDecision'),
        );
        // Run it: an honest reason names the real decision, and a contradictory one
        // (a changes_required cycle that somehow reached the arm) says so loudly
        // rather than denying the judgement.
        const honest = runScript(
          scriptOf('describePostPublishPushPollReason'),
          { WT: dir, DECISION: 'no_action', REOBSERVE: reobserves, REOBSERVE_BOUND: bound },
          dir,
        );
        expect(honest).toContain('judged this cycle no_action');
        expect(honest).not.toContain('not changes_required');
        expect(honest).toContain('3/3');
        const contradiction = runScript(
          scriptOf('describePostPublishPushPollReason'),
          { WT: dir, DECISION: 'changes_required', REOBSERVE: reobserves, REOBSERVE_BOUND: bound },
          dir,
        );
        expect(contradiction).toContain('INTERNAL CONTRADICTION');
        expect(contradiction).not.toContain('owed no required change');
      } finally {
        removeDir(dir);
      }
    });

    it('treats a merge during the awaiting poll as success, not as a park', () => {
      // The ticket names a merged PR as a valid way for a parked run to end.
      // The awaiting poll re-observes, so a merge is seen as postPublishState
      // 'merged' and routed to the resolve path.
      expect(evaluate('postPublishMergedGate', { postPublishState: 'merged' })).toBe(true);
      expect(evaluate('postPublishMergedGate', { postPublishState: 'fixable' })).toBe(false);
      expect(evaluate('postPublishAwaitPollGate', { postPublishAwaiting: 'true' })).toBe(true);
      // ...and 'merged' is one of the terminal success states the outcome gate
      // accepts, so no unmergeable task is raised for it.
      const condition = String(byId('postPublishOutcomeGate').config!.condition);
      expect(condition).toContain("variables.postPublishOutcome === 'merged'");
    });
  });


  /**
   * B4 / B6 — the awaiting hand-off must be EXCLUSIVE, and the park must be
   * decided AFTER the evidence.
   *
   * B4: the three terminal steps were SIBLINGS of postPublishPushPollVerdictGate
   * inside postPublishPushPollGate.elseSteps, so entering awaiting mode was
   * immediately followed by setPostPublishPushPollContinue (continue='false').
   * The repair path - the ticket's own path, where the dismissed
   * unverifiable_commit re-publishes on every cycle - therefore performed ZERO
   * awaiting polls, parked with postPublishOutcome still 'observing', and reported
   * "the observation loop stopped without reaching a terminal state (its iteration
   * cap was hit)". Nothing asserted the nesting, so the suite was green while the
   * defect was live: that is why these tests assert the SHAPE, not just the values.
   *
   * B6: the await-budget gate decided the park at the TOP of the iteration, before
   * the observation that can contradict it. postPublishContinue is not a skip, so a
   * review that landed on the final poll was fixed and then abandoned unobserved.
   */
  describe('B4/B6 — the awaiting hand-off is exclusive and the park is decided last', () => {
    /** Every step id at any depth of a list, including the roots. */
    const deepIds = (steps: IStep[]): string[] =>
      (steps || []).reduce<string[]>((acc, step) => acc.concat([step.id], descendants(step.id)), []);

    /** The config key a step writes, if it is a writer. */
    const writesKey = (id: string): string => {
      const step = byId(id);
      const config = (step.config || {}) as Record<string, any>;
      return String(config.key || '');
    };

    it('B4: postPublishPushPollGate.elseSteps is EXACTLY the verdict gate', () => {
      // THE defect: three sibling steps ran after the verdict gate whatever it
      // decided. Asserting the arm's contents is the only assertion that can see
      // the difference between a child of the verdict gate and a sibling.
      const arm = ((byId('postPublishPushPollGate').config!.elseSteps as IStep[]) || []).map((s) => s.id);
      expect(arm).toEqual(['postPublishPushPollVerdictGate']);
    });

    it('B4: the terminal steps are nested inside the verdict gate else arm', () => {
      const verdictElse = ((byId('postPublishPushPollVerdictGate').config!.elseSteps as IStep[]) || []).map(
        (s) => s.id,
      );
      expect(verdictElse).toContain('setPostPublishPushPollBlocked');
      expect(verdictElse).toContain('describePostPublishPushPollReason');
      expect(verdictElse).toContain('setPostPublishPushPollReason');
      expect(verdictElse).toContain('setPostPublishPushPollContinue');

      // ...and the awaiting arm writes no outcome and no continuation.
      const verdictThen = deepIds(
        (byId('postPublishPushPollVerdictGate').config!.thenSteps as IStep[]) || [],
      );
      const writes = verdictThen.map(writesKey).filter(Boolean);
      expect(writes).not.toContain('postPublishOutcome');
      expect(writes).not.toContain('postPublishContinue');
    });

    it('B4: no step at any depth of the poll arm writes postPublishContinue outside the verdict gate else arm', () => {
      const gateElse = ((byId('postPublishPushPollGate').config!.elseSteps as IStep[]) || []);
      const allIds = deepIds(gateElse);
      const allowedIds = deepIds((byId('postPublishPushPollVerdictGate').config!.elseSteps as IStep[]) || []);
      const offenders = allIds.filter(
        (id) => writesKey(id) === 'postPublishContinue' && allowedIds.indexOf(id) === -1,
      );
      // With the hand-off nested, the ONLY writer of postPublishContinue reachable
      // from the poll arm is inside the verdict gate's own else arm.
      expect(offenders).toEqual([]);
      // And the arm still HAS that writer (the parking path is intact).
      expect(allowedIds.filter((id) => writesKey(id) === 'postPublishContinue')).toEqual([
        'setPostPublishPushPollContinue',
      ]);
    });

    it('B4: after the repair-poll budget is spent the run enters awaiting mode and the poll RUNS', () => {
      const dir = publishedRepo();
      try {
        writeObservation(dir, reviewRequiredObservation());
        writeJudgement(dir, dismissTheCommitJudgement());

        // (1) Three repair re-publishes spend the poll budget: 0/1/2 -> 3.
        let polls = '0';
        for (let i = 0; i < 3; i += 1) {
          polls = runToken(scriptOf('bumpPostPublishPollCycle'), { N: polls, DECISION: 'no_action' }, dir);
        }
        expect(polls).toBe('3');
        expect(
          evaluate('postPublishPushPollGate', {
            postPublishDecision: 'no_action',
            postPublishReobserveCount: polls,
            postPublishReobserveBound: '3',
          }),
        ).toBe(false);

        // (2) The verdict is 'awaiting', so the verdict gate takes its THEN arm...
        const verdict = runToken(
          scriptOf('readPostPublishPushPollVerdict'),
          { WT: dir, CYCLE: '0', OUTCOME: 'observing', BOUND: '2', AWAITED: '0' },
          dir,
        );
        expect(verdict).toBe('awaiting');
        expect(evaluate('postPublishPushPollVerdictGate', { postPublishJudgedVerdict: verdict })).toBe(true);
        expect(valueOf('setPostPublishAwaitingOnPushPoll')).toBe('true');

        // (3) ...which leaves postPublishContinue alone, so the loop survives and
        // the awaiting poll actually executes on the NEXT iteration. This is the
        // assertion the previous revision was missing: it is not enough that the
        // then-arm is clean, the arm must be able to REACH the poll.
        expect(evaluate('postPublishAwaitPollGate', { postPublishAwaiting: 'true' })).toBe(true);
        expect(
          evaluate('postPublishAwaitBudgetGate', { postPublishAwaitCount: '0', postPublishAwaitBound: '40' }),
        ).toBe(true);
        expect(runToken(scriptOf('bumpPostPublishAwaitCount'), { N: '0' }, dir)).toBe('1');
        expect(runToken(scriptOf('bumpPostPublishAwaitCount'), { N: '39' }, dir)).toBe('40');

        // (4) Nothing on that path wrote an outcome, and the budget-exhausted arm
        // only marks the window spent - it does not park.
        const budgetElse = ((byId('postPublishAwaitBudgetGate').config!.elseSteps as IStep[]) || []).map(
          (s) => s.id,
        );
        expect(budgetElse).toEqual(['setPostPublishAwaitSpent']);
        expect(String(byId('setPostPublishAwaitSpent').config!.key)).toBe('postPublishAwaitSpent');
      } finally {
        removeDir(dir);
      }
    });

    it('B6: the final observation decides the park, so the outcome is never left observing', () => {
      // Window spent AND this iteration still sees nothing actionable: park as
      // awaiting_review - after the observation, not before it.
      expect(
        evaluate('postPublishAwaitSpentGate', {
          postPublishAwaitSpent: 'true',
          postPublishOutcome: 'observing',
          postPublishExhaustionVerdict: 'awaiting',
        }),
      ).toBe(true);
      // The old false reason is unreachable: the outcome is no longer 'observing',
      // so postPublishObservingReasonGate cannot overwrite it with "iteration cap".
      expect(
        evaluate('postPublishObservingReasonGate', { postPublishOutcome: 'awaiting_review' }),
      ).toBe(false);
      expect(valueOf('setPostPublishAwaitExhausted')).toBe('awaiting_review');
      expect(valueOf('setPostPublishAwaitExhaustedContinue')).toBe('false');
    });

    it('B6: a review that lands on the final poll keeps the loop alive so the fix is re-observed', () => {
      // Same spent window, but the observation now yields something actionable.
      // Parking here would fix the finding and abandon it unobserved.
      expect(
        evaluate('postPublishAwaitSpentGate', {
          postPublishAwaitSpent: 'true',
          postPublishOutcome: 'observing',
          postPublishExhaustionVerdict: 'outstanding',
        }),
      ).toBe(false);
      // The reset arm then leaves awaiting mode so the normal route owns it, and
      // nothing on that arm stops the loop.
      expect(evaluate('postPublishAwaitSpentResetGate', { postPublishAwaitSpent: 'true' })).toBe(true);
      expect(evaluate('postPublishAwaitSpentResetGate', { postPublishAwaitSpent: 'false' })).toBe(false);
      // deepIds takes step OBJECTS (it derives each root id itself), so pass the
      // thenSteps, not their ids.
      const resetWrites = deepIds(
        (byId('postPublishAwaitSpentResetGate').config!.thenSteps as IStep[]) || [],
      )
        .map(writesKey)
        .filter(Boolean);
      expect(resetWrites).toContain('postPublishAwaitSpent');
      expect(resetWrites).toContain('postPublishAwaiting');
      expect(resetWrites).not.toContain('postPublishContinue');
      expect(resetWrites).not.toContain('postPublishOutcome');
    });

    it('B6: the terminal decision runs after the route, in the same iteration', () => {
      // Ordering is positional in this engine, so the decision must be placed
      // AFTER postPublishRoute's subtree - that is what makes the verdict it reads
      // describe the observation it is judging.
      const ids = (parsed.workflow.steps as unknown as IStep[]);
      const loop = all.find((step) => step.id === 'postPublishLoop')!;
      const body = ((loop.config!.steps as IStep[]) || []).map((step) => step.id);
      expect(body).toContain('postPublishRoute');
      expect(body).toContain('postPublishAwaitSpentGate');
      expect(body.indexOf('postPublishAwaitSpentGate')).toBeGreaterThan(body.indexOf('postPublishRoute'));
      expect(body.indexOf('postPublishAwaitSpentGate')).toBeLessThan(body.indexOf('postPublishAwaitSkipGate'));
      expect((byId('postPublishAwaitSpentGate') as any).dependsOn).toBe('postPublishRoute');
      void ids;
    });
  });

  describe('D2 — an awaited review is not a terminal block', () => {
    it('classifies an exhausted budget with only an awaited review as awaiting', () => {
      const dir = publishedRepo();
      try {
        writeObservation(dir, reviewRequiredObservation());
        writeJudgement(dir, dismissTheCommitJudgement());
        const verdict = runToken(
          scriptOf('readPostPublishExhaustionVerdict'),
          { WT: dir, CYCLE: '2', OUTCOME: 'exhausted', BOUND: '2' },
          dir,
        );
        expect(verdict).toBe('awaiting');
        const record = JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'post-publish-exhaustion.json'), 'utf8'));
        expect(record.verdict).toBe('awaiting');
        expect(record.awaitingReview).toBe(true);
        expect(record.actionable).toEqual([]);
        expect(record.dismissed.map((entry: any) => entry.id)).toEqual(['commit:eac38992b6f8']);
      } finally {
        removeDir(dir);
      }
    });

    it('still reports a genuinely exhausted budget with a real outstanding finding', () => {
      const dir = publishedRepo();
      try {
        // CHANGES_REQUESTED with a finding the reviewer did NOT dismiss: this is the
        // blocker a human must look at, and the run must say so rather than claim
        // it is merely awaiting a review.
        writeObservation(
          dir,
          reviewRequiredObservation({
            reviewDecision: 'CHANGES_REQUESTED',
            awaitingReview: false,
            findings: [
              {
                id: 'thread:THREAD_1',
                kind: 'review_thread',
                path: 'src/work.ts',
                line: 12,
                body: 'R1: this path is not covered by the acceptance criteria.',
                fixable: true,
              },
            ],
            counts: { total: 1, fixable: 1, humanOnly: 0, staleReviews: 0, pendingChecks: 0 },
          }),
        );
        writeJudgement(dir, { cycle: 1, state: 'changes_required', requiredChanges: ['R1'], dismissals: [] });
        const verdict = runToken(
          scriptOf('readPostPublishExhaustionVerdict'),
          { WT: dir, CYCLE: '2', OUTCOME: 'exhausted', BOUND: '2' },
          dir,
        );
        expect(verdict).toBe('outstanding');
        const record = JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'post-publish-exhaustion.json'), 'utf8'));
        expect(record.actionable.map((entry: any) => entry.id)).toEqual(['thread:THREAD_1']);
      } finally {
        removeDir(dir);
      }
    });

    it('keeps ONE implementation of the exhaustion verdict, consulted by all three exhaustion points', () => {
      // The fix budget, the repair-poll budget and the re-observe budget all ask
      // the same question before they stop. It is ONE decision, so it has ONE
      // implementation per decision moment (the same instant = the same
      // computation), pinned the way the shared review-schema block is pinned:
      // whitespace-normalised equality of the shipped scripts.
      const normalise = (script: string): string =>
        script.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
      expect(normalise(scriptOf('readPostPublishPushPollVerdict'))).toBe(
        normalise(scriptOf('readPostPublishExhaustionVerdict')),
      );

      // Every reader consumes the STORED verdict, not a private re-derivation.
      const readers: Array<[string, string, string]> = [
        ['postPublishAwaitingExhaustedGate', 'setPostPublishExhaustionVerdict', 'postPublishExhaustionVerdict'],
        ['postPublishPushPollVerdictGate', 'setPostPublishJudgedVerdict', 'postPublishJudgedVerdict'],
        ['postPublishReobserveAwaitingGate', 'setPostPublishJudgedVerdict', 'postPublishJudgedVerdict'],
      ];
      readers.forEach(([gateId, verdictStep, variable]) => {
        const gate = byId(gateId);
        expect(gate.type).toBe('condition');
        expect(String(gate.config!.condition)).toBe(`variables.${variable} === 'awaiting'`);
        expect((gate as any).dependsOn).toBe(verdictStep);
      });
      expect((byId('setPostPublishExhaustionVerdict') as any).dependsOn).toBe('readPostPublishExhaustionVerdict');
      expect((byId('setPostPublishJudgedVerdict') as any).dependsOn).toBe('readPostPublishPushPollVerdict');
      // The re-observe arm's private copy is gone: one script per decision moment.
      expect(all.filter((step) => step.id === 'readPostPublishReobserveVerdict')).toEqual([]);
    });

    it('polls instead of parking once the budget is spent but a review is awaited', () => {
      // The gate that decides: awaiting -> poll, outstanding -> park.
      expect(byId('postPublishAwaitingExhaustedGate').type).toBe('condition');
      expect(String(byId('postPublishAwaitingExhaustedGate').config!.condition)).toBe(
        "variables.postPublishExhaustionVerdict === 'awaiting'",
      );

      // The awaiting arm switches the loop into polling mode...
      expect(valueOf('setPostPublishAwaitingOnExhaustion')).toBe('true');
      expect(String(byId('setPostPublishAwaitingOnExhaustion').config!.key)).toBe('postPublishAwaiting');
      // ...and it must NOT stop the loop, nor raise the unmergeable task.
      const awaitingThen = ((byId('postPublishAwaitingExhaustedGate').config!.thenSteps as IStep[]) || []).map(
        (step) => step.id,
      );
      expect(awaitingThen).toContain('setPostPublishAwaitingOnExhaustion');
      expect(awaitingThen).not.toContain('setPostPublishExhausted');
      expect(awaitingThen).not.toContain('setRunStatusUnmergeable');
      expect(awaitingThen).not.toContain('postPublishBlockedTask');
      const awaitingTrail = awaitingThen.reduce<string[]>((acc, id) => acc.concat(descendants(id)), []);
      expect(awaitingTrail).not.toContain('setPostPublishExhausted');
      expect(awaitingTrail).not.toContain('setRunStatusUnmergeable');
      expect(awaitingTrail).not.toContain('postPublishBlockedTask');

      // The poll itself: a real wait, bounded, and free of the fix budget.
      expect(byId('postPublishAwaitWait').type).toBe('delay');
      // PINNED EXACTLY: 40 polls x 180s = 120 minutes of automatic re-observation.
      // The bound is sized from the incident, not from taste: the review on PR #74
      // arrived 1h56m after publication, and the previous 60-minute window closed
      // 56 minutes before it - see B2. A future change may not silently shorten
      // that window (which is what made the run useless), nor lengthen it without
      // raising postPublishLoop.maxIterations to match.
      expect(Number(byId('postPublishAwaitWait').config!.duration)).toBe(180000);
      expect(Number(byId('seedPostPublishAwaitBound').config!.value)).toBe(40);
      expect((180000 * Number(byId('seedPostPublishAwaitBound').config!.value)) / 60000).toBe(120);
      // 120 minutes must cover the latency that produced this ticket.
      const incidentLatencyMinutes = 116; // 11:24:14 -> 13:20:36
      expect((180000 * Number(byId('seedPostPublishAwaitBound').config!.value)) / 60000).toBeGreaterThan(incidentLatencyMinutes);
      // ...and the iteration cap must sit above the whole worst-case budget, or the
      // window is not actually usable.
      // 1 initial + 6 check waits + 2 fixes + 3 re-observes + 40 awaits + 1 final = 53.
      expect(Number(byId('postPublishLoop').config!.maxIterations)).toBeGreaterThan(53);
      expect(String(byId('postPublishAwaitBudgetGate').config!.condition)).toContain('postPublishAwaitCount');
      expect(String(byId('postPublishAwaitBudgetGate').config!.condition)).toContain('postPublishAwaitBound');
      expect(Number(byId('seedPostPublishAwaitBound').config!.value)).toBeGreaterThanOrEqual(10);
      // Running out of awaits is an honest "still awaiting a human" stop.
      expect(valueOf('setPostPublishAwaitExhausted')).toBe('awaiting_review');
      expect(valueOf('setPostPublishAwaitExhaustedContinue')).toBe('false');

      // The genuinely exhausted arm is untouched and still parks.
      expect(valueOf('setPostPublishExhausted')).toBe('exhausted');
      expect(valueOf('setPostPublishExhaustedContinue')).toBe('false');
      expect(trailOf('setPostPublishExhausted')).toContain('postPublishAwaitingExhaustedGate');
    });

    // ── The residual limitation, stated so it cannot be mistaken for coverage ──
    // A review that arrives AFTER the run parks is NOT observed by this instance.
    // The parked task suspends on `workflow.task.completed` correlated by task id,
    // and `UserActivityStep`'s `timeout` only writes Task.dueDate - there is no
    // sweeper, so an overdue task resumes nothing. The bounded await poll below is
    // the only automatic re-observation; after it, only a human completing the task
    // resumes the instance, and it does not restart the loop. That is why the
    // acceptance item is met for "a review that arrives WHILE the loop is running"
    // and deliberately not claimed for "a review that arrives after the park".
    it('classifies a review that arrives while the loop is still observing as outstanding, with fix budget', () => {
      const dir = publishedRepo();
      try {
        writeObservation(dir, reviewRequiredObservation());
        writeJudgement(dir, dismissTheCommitJudgement());
        // Later in the same run a human submits CHANGES_REQUESTED with a blocking finding.
        const observe = scriptOf('observePullRequest');
        const resolvedFixture = path.join(dir, '.ai-agent', 'review-arrived.json');
        fs.writeFileSync(
          resolvedFixture,
          JSON.stringify({
            pr: {
              number: 74,
              state: 'OPEN',
              mergeStateStatus: 'BLOCKED',
              reviewDecision: 'CHANGES_REQUESTED',
              url: 'https://x/pull/74',
            },
            reviews: [
              {
                id: 'R1',
                state: 'CHANGES_REQUESTED',
                submitted_at: new Date().toISOString(),
                commit_id: sh('git rev-parse HEAD', dir),
                user: { login: 'zepzwweber' },
                body: 'R1: the playwright browser provisioning is not covered by a test.',
              },
            ],
            reviewThreads: {
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [
                        {
                          id: 'THREAD_R1',
                          isResolved: false,
                          path: 'src/work.ts',
                          line: 4,
                          comments: {
                            nodes: [
                              {
                                author: { login: 'zepzwweber' },
                                body: 'R1: the playwright browser provisioning is not covered by a test.',
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
            checkRuns: { check_runs: [] },
            commits: [
              {
                sha: sh('git rev-parse HEAD', dir),
                verification: { verified: true, reason: 'valid' },
                commit: { committer: { email: 'owner@example.com' } },
              },
            ],
            protection: null,
          }),
          'utf8',
        );
        const after = runJson(
          observe,
          {
            WT: dir,
            PR_NUMBER: '74',
            PR_STATE: 'OPEN',
            CYCLE: '0',
            OBSERVATION_FIXTURE: resolvedFixture,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
          },
          dir,
        );
        expect(after.state).toBe('fixable');
        expect(after.findings.map((finding: any) => finding.id)).toContain('thread:THREAD_R1');
        fs.writeFileSync(
          path.join(dir, '.ai-agent', 'post-publish-observation.json'),
          JSON.stringify(after),
          'utf8',
        );

        // The awaited-review classification must be GONE now: this is a real block
        // an agent can act on, so it must not be reported as merely awaiting.
        const verdict = runToken(
          scriptOf('readPostPublishExhaustionVerdict'),
          { WT: dir, CYCLE: '0', OUTCOME: 'awaiting_review', BOUND: '2' },
          dir,
        );
        expect(verdict).toBe('outstanding');

        // ...and there is fix budget left, because the two no-ops were free.
        expect(
          evaluate('postPublishBudgetGate', { postPublishCycle: '0', postPublishFixBound: '2' }),
        ).toBe(true);
        expect(runToken(scriptOf('bumpPostPublishCycle'), { N: '0', DECISION: 'changes_required' }, dir)).toBe('1');
      } finally {
        removeDir(dir);
      }
    });
  });

  describe('D3 — the park is bounded and its wake path is recorded', () => {
    it('records who and what woke the parked run', () => {
      const dir = publishedRepo();
      try {
        // The park record is written BEFORE the task is raised, so the wake can be
        // attributed to it.
        runToken(
          scriptOf('postPublishParkRecord'),
          {
            WT: dir,
            OUTCOME: 'awaiting_review',
            REASON: 'the pull request is published and awaiting a human review',
            CYCLE: '0',
            BOUND: '2',
            AWAIT_POLLS: '20',
            AWAIT_BOUND: '20',
          },
          dir,
        );
        const park = JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'post-publish-park.json'), 'utf8'));
        expect(park.wakeEvent).toBe('workflow.task.completed');
        expect(park.awaitPolls).toBe(20);
        expect(String(park.reason)).toContain('awaiting a human review');
        expect(String(park.observedIntervalMs)).toBe('180000');
        // The record states the mechanism, not a guess.
        expect(String(park.wakePublisher)).toContain('completeWorkflowTask');

        // On resume the user_activity step's own outputs carry the identity.
        const wake = runJson(
          scriptOf('postPublishWakeProbe'),
          {
            WT: dir,
            TASK_ID: '6afc3a367e9ae1c5080f51dc',
            COMPLETED_BY: 'zepzwweber',
            COMPLETED_BY_EMAIL: 'werner@reactory.net',
            COMPLETED_AT: '2026-11-18T07:12:03.000Z',
            APPROVED: 'true',
          },
          dir,
        );
        expect(wake.woken).toBe(true);
        expect(wake.eventName).toBe('workflow.task.completed');
        expect(wake.eventKey).toBe('6afc3a367e9ae1c5080f51dc');
        expect(wake.completedByEmail).toBe('werner@reactory.net');
        expect(wake.completedAt).toBe('2026-11-18T07:12:03.000Z');
        expect(wake.parkedOutcome).toBe('awaiting_review');
        const artefact = JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'post-publish-wake.json'), 'utf8'));
        expect(artefact.eventKey).toBe('6afc3a367e9ae1c5080f51dc');
      } finally {
        removeDir(dir);
      }
    });

    it('gives the parked task a deadline and records the park before it is raised', () => {
      const task = byId('postPublishBlockedTask');
      expect(task.type).toBe('user_activity');
      // A park with no deadline is what made this run useless for 19h44m.
      expect(Number(task.config!.timeout)).toBeGreaterThan(0);
      expect(Number(task.config!.timeout)).toBeLessThanOrEqual(60 * 60 * 1000);
      // The task's message is produced from the verdict (see D4), so it cannot call
      // an awaited review unmergeable; here we pin the chain that guarantees the park
      // record exists before the task can be raised.
      expect(byId('postPublishParkRecord').type).toBe('cli_command');
      expect((byId('postPublishBlockedTask') as any).dependsOn).toBe('postPublishTaskMessage');
      expect((byId('postPublishTaskMessage') as any).dependsOn).toBe('postPublishParkRecord');
      expect((byId('postPublishParkRecord') as any).dependsOn).toBe('setRunStatusUnmergeable');
      expect((byId('postPublishParkRecord') as any).dependsOn).toBe('setRunStatusUnmergeable');
      expect((byId('postPublishBlockedComment') as any).dependsOn).toBe('describePostPublishBlock');

      // The wake path is recorded, then reported on the ticket - not silent.
      expect((byId('postPublishWakeProbe') as any).dependsOn).toBe('postPublishBlockedTask');
      expect(byId('postPublishWakeProbe').config!.env.TASK_ID).toBe(asTemplate('steps.postPublishBlockedTask.outputs.taskId'));
      expect(byId('postPublishWakeProbe').config!.env.COMPLETED_BY_EMAIL).toBe(
        asTemplate('steps.postPublishBlockedTask.outputs.completedByEmail'),
      );
      expect(byId('postPublishWakeComment').type).toBe('service_invoke');
      expect((byId('postPublishWakeComment') as any).dependsOn).toBe('postPublishWakeProbe');
      expect(String(byId('postPublishWakeComment').config!.params.comment)).toContain('workflow.task.completed');
    });
  });

  describe('D4 — a dismissed finding is not outstanding', () => {
    it('does not list a dismissed finding under Outstanding findings', () => {
      const dir = publishedRepo();
      try {
        writeObservation(dir, reviewRequiredObservation());
        writeJudgement(dir, dismissTheCommitJudgement());
        const comment = runScript(
          scriptOf('describePostPublishBlock'),
          { WT: dir, OUTCOME: 'exhausted', REASON: '', PR_URL: 'https://x/pull/74', BOUND: '2' },
          dir,
        );
        const outstanding = comment.slice(comment.indexOf('Outstanding findings:'));
        const tail = outstanding.indexOf('Dismissed this run') === -1
          ? outstanding
          : outstanding.slice(0, outstanding.indexOf('Dismissed this run'));
        // THE DEFECT: the dismissed commit finding was listed as outstanding, so the
        // block comment contradicted the run's own judgement.
        expect(tail).not.toContain('unverifiable_commit');
        expect(comment).toContain('Dismissed this run');
        expect(comment).toContain('commit:eac38992b6f8');
        expect(comment).toContain('false positive');
        // Nothing actionable remains, so the comment must say that rather than
        // implying the pull request still owes code.
        expect(comment).toContain('no agent-actionable finding remains');
      } finally {
        removeDir(dir);
      }
    });

    it('still lists a finding the run did not dismiss', () => {
      const dir = publishedRepo();
      try {
        writeObservation(
          dir,
          reviewRequiredObservation({
            reviewDecision: 'CHANGES_REQUESTED',
            awaitingReview: false,
            findings: [
              {
                id: 'thread:THREAD_1',
                kind: 'review_thread',
                path: 'src/work.ts',
                line: 12,
                body: 'R1: this path is not covered by the acceptance criteria.',
                fixable: true,
              },
              {
                id: 'commit:eac38992b6f8',
                kind: 'unverifiable_commit',
                sha: COMMIT_SHA,
                body: 'GitHub reports verified:false (reason unknown) for commit eac38992b6f8',
                fixable: true,
              },
            ],
          }),
        );
        writeJudgement(dir, dismissTheCommitJudgement());
        const comment = runScript(
          scriptOf('describePostPublishBlock'),
          { WT: dir, OUTCOME: 'exhausted', REASON: '', PR_URL: 'https://x/pull/74', BOUND: '2' },
          dir,
        );
        const outstanding = comment.slice(comment.indexOf('Outstanding findings:'));
        const tail = outstanding.indexOf('Dismissed this run') === -1
          ? outstanding
          : outstanding.slice(0, outstanding.indexOf('Dismissed this run'));
        expect(tail).toContain('review_thread');
        expect(tail).toContain('R1: this path is not covered');
        expect(tail).not.toContain('unverifiable_commit');
        expect(comment).toContain('budget was exhausted');
      } finally {
        removeDir(dir);
      }
    });

    it('agrees with the exhaustion verdict when a non-fixable finding is all that remains', () => {
      // Reviewer N1: the verdict filters `fixable === false` out of `actionable`, and
      // the block comment did not, so the two disagreed in exactly the state the
      // verdict calls 'awaiting'. describePostPublishBlock now READS the verdict
      // artefact; when there is no fresh artefact it applies the same rule.
      const dir = publishedRepo();
      try {
        writeObservation(dir, reviewRequiredObservation({
          findings: [
            {
              id: 'commit:eac38992b6f8',
              kind: 'unverifiable_commit',
              sha: COMMIT_SHA,
              body: 'GitHub reports verified:false (reason unknown) for commit eac38992b6f8',
              fixable: false,
            },
          ],
          counts: { total: 1, fixable: 0, humanOnly: 0, staleReviews: 0, pendingChecks: 0 },
        }));
        writeJudgement(dir, { cycle: 0, state: 'no_action', requiredChanges: [], dismissals: [] });

        const verdict = runToken(
          scriptOf('readPostPublishExhaustionVerdict'),
          { WT: dir, CYCLE: '0', OUTCOME: 'observing', BOUND: '2', AWAITED: '0' },
          dir,
        );
        expect(verdict).toBe('awaiting');

        // No `outcome` is passed: the comment must reach AWAITING HUMAN from the
        // artefacts alone, i.e. from the same decision the loop made.
        const comment = runScript(
          scriptOf('describePostPublishBlock'),
          { WT: dir, OUTCOME: '', REASON: '', PR_URL: 'https://x/pull/74', BOUND: '2', AWAITED: '0' },
          dir,
        );
        expect(comment).toContain('AWAITING HUMAN');
        expect(comment).not.toContain('CANNOT BE MERGED');
        expect(comment).toContain('Outstanding findings: none');
        // The non-fixable finding is not an outstanding finding, in either output.
        const outstanding = comment.slice(comment.indexOf('Outstanding findings:'));
        expect(outstanding).not.toContain('unverifiable_commit');
      } finally {
        removeDir(dir);
      }
    });

    it('reads the persisted verdict rather than re-deriving it', () => {
      const dir = publishedRepo();
      try {
        // An observation that carries NO reviewDecision, and a verdict artefact that
        // does: only a reader of the artefact can reach AWAITING HUMAN here.
        writeObservation(dir, {
          state: 'fixable',
          mergeStateStatus: 'BLOCKED',
          reviewDecision: '',
          findings: [],
          checkedAt: '2026-11-18T11:24:28.000Z',
        });
        fs.writeFileSync(
          path.join(dir, '.ai-agent', 'post-publish-exhaustion.json'),
          JSON.stringify({
            verdict: 'awaiting',
            reviewDecision: 'REVIEW_REQUIRED',
            awaitingReview: true,
            awaitingChecks: false,
            actionable: [],
            dismissed: [{ id: 'commit:eac38992b6f8', kind: 'unverifiable_commit', justification: 'verified out of band' }],
            generatedAt: '2026-11-18T11:26:40.000Z',
          }),
          'utf8',
        );
        const comment = runScript(
          scriptOf('describePostPublishBlock'),
          { WT: dir, OUTCOME: '', REASON: '', PR_URL: 'https://x/pull/74', BOUND: '2', AWAITED: '4' },
          dir,
        );
        expect(comment).toContain('AWAITING HUMAN');
        expect(comment).toContain('review decision REVIEW_REQUIRED');
        expect(comment).toContain('Dismissed this run');
        expect(comment).toContain('commit:eac38992b6f8');
      } finally {
        removeDir(dir);
      }
    });

    it('words the human task to match the verdict, so an awaited review is not called unmergeable', () => {
      const dir = publishedRepo();
      try {
        writeObservation(dir, reviewRequiredObservation());
        fs.writeFileSync(
          path.join(dir, '.ai-agent', 'post-publish-park.json'),
          JSON.stringify({ awaitPolls: 20, fixCycles: 0 }),
          'utf8',
        );
        fs.writeFileSync(
          path.join(dir, '.ai-agent', 'post-publish-exhaustion.json'),
          JSON.stringify({ verdict: 'awaiting', reviewDecision: 'REVIEW_REQUIRED' }),
          'utf8',
        );
        const awaitingMessage = runScript(
          scriptOf('postPublishTaskMessage'),
          { WT: dir, OUTCOME: 'awaiting_review', PR_URL: 'https://x/pull/74' },
          dir,
        );
        expect(awaitingMessage).toContain('awaiting a HUMAN action');
        expect(awaitingMessage).not.toContain('not mergeable');

        // A real, unfixable block still says what it is.
        fs.writeFileSync(
          path.join(dir, '.ai-agent', 'post-publish-exhaustion.json'),
          JSON.stringify({ verdict: 'outstanding', reviewDecision: 'CHANGES_REQUESTED' }),
          'utf8',
        );
        const blockedMessage = runScript(
          scriptOf('postPublishTaskMessage'),
          { WT: dir, OUTCOME: 'blocked_human', PR_URL: 'https://x/pull/74' },
          dir,
        );
        expect(blockedMessage).toContain('not mergeable');
        expect(blockedMessage).not.toContain('awaiting a HUMAN action');

        // The task uses that message, and it carries a deadline.
        expect(String(byId('postPublishBlockedTask').config!.message)).toBe(
          asTemplate('steps.postPublishTaskMessage.outputs.stdout'),
        );
        expect(Number(byId('postPublishBlockedTask').config!.timeout)).toBe(3600000);
      } finally {
        removeDir(dir);
      }
    });

    it('names the awaited review instead of claiming the budget is the problem', () => {
      const dir = publishedRepo();
      try {
        writeObservation(dir, reviewRequiredObservation());
        writeJudgement(dir, dismissTheCommitJudgement());
        const comment = runScript(
          scriptOf('describePostPublishBlock'),
          {
            WT: dir,
            OUTCOME: 'awaiting_review',
            REASON: '',
            PR_URL: 'https://x/pull/74',
            BOUND: '2',
            AWAITED: '20',
          },
          dir,
        );
        expect(comment.toLowerCase()).toContain('awaiting');
        // REVIEW_REQUIRED is a human wait, not an unmergeable pull request.
        expect(comment).toContain('review decision REVIEW_REQUIRED');
        expect(comment).not.toContain('budget was exhausted');
      } finally {
        removeDir(dir);
      }
    });
  });

  /**
   * B7/B8 — the awaiting window must actually RUN.
   *
   * Every other test in this file evaluates ONE gate or ONE script in isolation.
   * That is exactly why 30 green tests could not see the defect the reviewer
   * found: `postPublishRoute`'s condition is deliberately FALSE while the run
   * awaits a human action, and every arm beneath it terminated the loop, so an
   * awaiting iteration exited on its FIRST pass with `postPublishContinue =
   * 'false'`. `postPublishAwaitCount` never advanced, so the 40 x 180s window
   * could run ZERO polls and every "120 minutes of automatic re-observation"
   * claim in the README was false.
   *
   * These tests walk the SHIPPED `postPublishLoop.config.steps` in order and
   * execute the SHIPPED conditions and set_variables, so they assert the one
   * property that makes the window real: after an awaiting iteration,
   * `postPublishContinue` is still 'true' and `postPublishOutcome` is still
   * 'observing'.
   */
  describe('B7 — an awaiting iteration is a pure POLL, not a decision', () => {


    /**
     * Walk the loop body the way YamlFlowBuilder actually emits it.
     *
     * The naive version of this helper evaluated each condition ONCE and took
     * one arm. That is not what the engine does, and the difference hid a real
     * bug (review R3 on PR #78): R1 shipped with a state-blind gate and this
     * walker not only passed, it defended the bug.
     *
     * The engine emits `.if(cond) { then }` followed by `.if(!cond) { else }`,
     * so `cond` is RE-EVALUATED after the then-arm has run. When the then-arm
     * flips the very variable the condition reads, BOTH arms execute in one
     * iteration. This body does that deliberately:
     *   - postPublishAwaitBudgetGate's else-arm sets postPublishAwaitSpent, and
     *   - postPublishAwaitSpentGate then reads postPublishAwaitSpent.
     * Simulating one arm per condition cannot represent the final poll.
     *
     * Also faithful:
     *   - each scope is topoSort-ed by dependsOn (the authored order happens to
     *     be valid, but the helper must not depend on that);
     *   - `set_variable` with `source: step_output` reads the captured stdout of
     *     the step named in `sourcePath`, so the counters below feed the
     *     variables they are supposed to feed;
     *   - the budget counter scripts are EXECUTED rather than assumed, so the
     *     window is driven to its bound by the real
     *     bumpPostPublishAwaitCount instead of by injecting "spent".
     */
    const baseVariables = (overrides: Record<string, any> = {}): Record<string, any> =>
      Object.assign(
        {
          postPublishContinue: 'true',
          postPublishOutcome: 'observing',
          postPublishState: 'fixable',
          postPublishAwaiting: 'true',
          postPublishExhaustionVerdict: 'awaiting',
          postPublishAwaitSpent: 'false',
          postPublishAwaitCount: '0',
          postPublishAwaitBound: '40',
          postPublishCycle: '0',
          postPublishFixBound: '2',
          postPublishRepairNeeded: 'false',
          postPublishDecision: 'no_action',
          postPublishJudgedVerdict: 'awaiting',
          postPublishReobserveCount: '0',
          postPublishReobserveBound: '3',
          postPublishWaitCount: '0',
          postPublishWaitBound: '6',
        },
        overrides,
      );

    /** Scripts whose RESULT matters for the awaiting path, executed for real. */
    const COUNTER_SCRIPTS = new Set([
      'bumpPostPublishAwaitCount',
      'bumpPostPublishCycle',
      'bumpPostPublishPollCycle',
    ]);

    /** The observation is modelled by the variables; its steps are not re-run. */
    const OBSERVATION_STEPS = new Set([
      'resolvePublishedTip',
      'observePullRequest',
      'readPostPublishObservation',
      'setPostPublishState',
      'readPostPublishRepairNeed',
      'setPostPublishRepairNeeded',
      'readPostPublishExhaustionVerdict',
      'setPostPublishExhaustionVerdict',
    ]);

    /** Topological sort of one scope by dependsOn, falling back to authored order. */
    const topoSort = (steps: IStep[]): IStep[] => {
      const byIdMap = new Map(steps.map((s) => [s.id, s]));
      const visited = new Set<string>();
      const out: IStep[] = [];
      const visit = (step: IStep): void => {
        if (visited.has(step.id)) return;
        visited.add(step.id);
        // dependsOn may be a single id or a list, depending on the parser.
        const raw = (step as any).dependsOn;
        const deps: string[] = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
        deps.forEach((d) => {
          const dep = byIdMap.get(d);
          if (dep) visit(dep);
        });
        out.push(step);
      };
      steps.forEach(visit);
      return out;
    };

    interface Walk {
      variables: Record<string, any>;
      reached: string[];
      outputs: Record<string, string>;
    }

    /**
     * Execute one iteration of postPublishLoop. `dir` is a scratch worktree the
     * counter scripts can run against.
     */
    const runLoopIteration = (overrides: Record<string, any> = {}, dir?: string): Walk & { exits: boolean } => {
      const variables = baseVariables(overrides);
      const reached: string[] = [];
      const outputs: Record<string, string> = {};

      const interpolate = (value: string): string =>
        String(value).replace(/\$\{variables\.([A-Za-z0-9_]+)\}/g, (_m, name) => String(variables[name] ?? ''));

      const execScope = (steps: IStep[] | undefined): void => {
        topoSort(steps || []).forEach((step) => {
          if (OBSERVATION_STEPS.has(step.id)) return;
          const config = (step.config || {}) as any;

          if (step.type === 'condition') {
            reached.push(step.id);
            // .if(cond) { then }
            if (evaluate(step.id, variables)) execScope(config.thenSteps as IStep[]);
            // .if(!cond) { else } - RE-EVALUATED, so both arms can run
            if (!evaluate(step.id, variables)) execScope(config.elseSteps as IStep[]);
            return;
          }

          if (step.type === 'set_variable') {
            if (config.source === 'step_output' && config.sourcePath) {
              variables[config.key] = outputs[String(config.sourcePath)] ?? '';
            } else if (config.value !== undefined) {
              variables[config.key] = config.value;
            }
            reached.push(step.id);
            return;
          }

          if (step.type === 'cli_command' && COUNTER_SCRIPTS.has(step.id) && dir) {
            const env: Record<string, string> = {};
            Object.entries(config.env || {}).forEach(([k, v]) => {
              env[k] = interpolate(String(v));
            });
            outputs[`${step.id}.outputs.stdout`] = runToken(scriptOf(step.id), env, dir);
            reached.push(step.id);
          }
        });
      };

      execScope(byId('postPublishLoop').config!.steps as IStep[]);
      return { variables, reached, outputs, exits: variables.postPublishContinue !== 'true' };
    };

    /** Drive the loop until it exits or `max` iterations pass, using the real counters. */
    const runToSettle = (
      overrides: Record<string, any> = {},
      max = 60,
    ): { variables: Record<string, any>; iterations: number; dir: string } => {
      const dir = tempDir('pw-loop-');
      let state = baseVariables(overrides);
      let iterations = 0;
      try {
        while (state.postPublishContinue === 'true' && iterations < max) {
          iterations += 1;
          const walk = runLoopIteration(state, dir);
          state = walk.variables as any;
        }
        return { variables: state, iterations, dir };
      } finally {
        removeDir(dir);
      }
    };


    it('walks the shipped loop body (the walk itself cannot pass vacuously)', () => {
      const { reached } = runLoopIteration();
      // If the loop body stops containing these, this suite is testing nothing.
      expect(reached).toContain('postPublishRoute');
      expect(reached).toContain('postPublishAwaitPurePollGate');
      expect(reached).toContain('postPublishAwaitSpentGate');
    });

    it('enters the pure-poll arm ONLY for a fixable observation', () => {
      // R1 (review): this used to assert the gate fired for clean and human_only too,
      // which enshrined a regression. The gate runs BEFORE the merged/pending/mergeable
      // chain, so a state-blind condition held EVERY observation for the whole 40-poll
      // window - including a MERGED pull request. Only 'fixable' is the case the gate
      // exists for: findings exist, every one was dismissed, nothing agent-actionable
      // remains. Everything else must fall through to the chain that handled it before.
      const { variables, exits, reached } = runLoopIteration({ postPublishState: 'fixable' });
      expect(reached).toContain('postPublishAwaitPurePollGate');
      expect(exits).toBe(false);
      expect(variables.postPublishContinue).toBe('true');
      expect(variables.postPublishOutcome).toBe('observing');
    });

    it('does NOT hold the loop for merged, clean or human_only (R1)', () => {
      // A merged pull request must stop at once, not be polled for 120 minutes.
      const merged = runLoopIteration({ postPublishState: 'merged' });
      expect(merged.exits).toBe(true);
      expect(merged.variables.postPublishOutcome).toBe('merged');
      expect(merged.reached).not.toContain('postPublishAwaitPurePollLog');

      // A mergeable, BLOCKED+REVIEW_REQUIRED pull request is awaiting_human on the
      // FIRST iteration - it is published and correct, it just needs approval.
      const clean = runLoopIteration({ postPublishState: 'clean' });
      expect(clean.exits).toBe(true);
      expect(clean.variables.postPublishOutcome).toBe('awaiting_human');
      expect(clean.reached).not.toContain('postPublishAwaitPurePollLog');

      // A block only a human can clear is blocked_human, immediately.
      const humanOnly = runLoopIteration({ postPublishState: 'human_only' });
      expect(humanOnly.exits).toBe(true);
      expect(humanOnly.variables.postPublishOutcome).toBe('blocked_human');
      expect(humanOnly.reached).not.toContain('postPublishAwaitPurePollLog');
    });

    it('does NOT descend into the merged / mergeable chain while awaiting', () => {
      const { reached } = runLoopIteration({ postPublishState: 'fixable' });
      // These are the steps that used to end the loop on the first pass.
      expect(reached).not.toContain('postPublishMergedGate');
      expect(reached).not.toContain('postPublishMergeableGate');
      expect(reached).not.toContain('setPostPublishHumanContinue');
      expect(reached).not.toContain('setPostPublishAwaitingContinue');
    });

    it('parks with awaiting_review once the window is spent', () => {
      const { variables, exits } = runLoopIteration({
        postPublishState: 'fixable',
        postPublishAwaitSpent: 'true',
        postPublishAwaitCount: '40',
      });
      expect(exits).toBe(true);
      expect(variables.postPublishOutcome).toBe('awaiting_review');
      expect(variables.postPublishContinue).toBe('false');
    });

    it('parks a spent window on a clean observation as awaiting_human, not awaiting_review (R1)', () => {
      // A 'clean' observation never enters the poll arm, so the window being spent
      // must not relabel it. Master reported awaiting_human on iteration 1; that is
      // still the answer once the window is spent.
      const { variables, exits } = runLoopIteration({
        postPublishState: 'clean',
        postPublishAwaitSpent: 'true',
        postPublishAwaitCount: '40',
      });
      expect(exits).toBe(true);
      expect(variables.postPublishOutcome).toBe('awaiting_human');
    });

    it('re-opens the fix route when a review lands (verdict flips to outstanding)', () => {
      // The gate must not hold the run in polling once something is actionable.
      expect(
        evaluate('postPublishAwaitPurePollGate', baseVariables({ postPublishExhaustionVerdict: 'outstanding' })),
      ).toBe(false);
      // ... and the route's own condition must open so the fix path runs.
      expect(
        evaluate(
          'postPublishRoute',
          baseVariables({ postPublishExhaustionVerdict: 'outstanding', postPublishState: 'fixable' }),
        ),
      ).toBe(true);
    });

    it('leaves non-awaiting behaviour untouched', () => {
      // Not in awaiting mode: a mergeable observation must still stop the loop.
      const clean = runLoopIteration({ postPublishAwaiting: 'false', postPublishState: 'clean' });
      expect(clean.exits).toBe(true);
      expect(clean.variables.postPublishOutcome).toBe('awaiting_human');

      // A merged pull request must still stop the loop.
      const merged = runLoopIteration({ postPublishAwaiting: 'false', postPublishState: 'merged' });
      expect(merged.exits).toBe(true);
      expect(merged.variables.postPublishOutcome).toBe('merged');
    });

    it('drives the window to its bound with the REAL counter, no injection (R3)', () => {
      // The previous version of this suite injected `postPublishAwaitSpent='true'`
      // to reach the spent case, which assumed the answer it was testing. Driving
      // the loop with the shipped bumpPostPublishAwaitCount makes "spent" a
      // measured consequence of the bound instead.
      //
      // Both-arms matters here: on the iteration where the count reaches the
      // bound, postPublishAwaitBudgetGate's then-arm runs (count 39 -> 40) and the
      // re-evaluated condition is then false, so its else-arm sets
      // postPublishAwaitSpent in the SAME iteration. A one-arm walker cannot
      // represent that.
      const settled = runToSettle({ postPublishState: 'fixable' });

      expect(settled.variables.postPublishAwaitCount).toBe('40');
      expect(settled.iterations).toBe(40);
      expect(settled.variables.postPublishContinue).toBe('false');
      expect(settled.variables.postPublishOutcome).toBe('awaiting_review');

      // Both-arms visible: postPublishAwaitSpentGate's THEN-arm parks the run, and
      // because the engine then re-evaluates the condition it goes false on the
      // re-read (outcome is no longer 'observing'), so the ELSE-arm runs too and
      // clears the marker. The terminal state is correct either way; recording it
      // here so the interaction is not a surprise to the next reader.
      expect(settled.variables.postPublishAwaitSpent).toBe('false');
    });

    it('a review landing mid-window stops the polling and re-opens the route (R3)', () => {
      // Drive 5 polls, then hand the loop an 'outstanding' verdict - what a real
      // review arriving would produce - and assert the loop leaves awaiting mode
      // instead of running out the window.
      const dir = tempDir('pw-loop-mid-');
      try {
        let state: Record<string, any> = baseVariables({ postPublishState: 'fixable' });
        for (let i = 0; i < 5; i += 1) state = runLoopIteration(state, dir).variables as any;
        expect(state.postPublishAwaitCount).toBe('5');
        expect(state.postPublishContinue).toBe('true');

        // The review lands: verdict flips, findings become actionable.
        const after = runLoopIteration(
          Object.assign({}, state, { postPublishExhaustionVerdict: 'outstanding' }),
          dir,
        );
        expect(after.reached).toContain('postPublishRoute');
        // The pure-poll arm must NOT swallow it once something is actionable.
        expect(after.variables.postPublishOutcome).not.toBe('awaiting_review');
      } finally {
        removeDir(dir);
      }
    });

    it('pins the awaiting window the README depends on', () => {
      // 40 x 180s = 120 minutes. The incident review landed at 116 minutes, so a
      // 60-minute window would still have missed it.
      const bound = Number(valueOf('seedPostPublishAwaitBound'));
      const wait = Number((byId('postPublishAwaitWait').config as any).duration);
      expect(wait).toBe(180000);
      expect(bound).toBe(40);
      expect((bound * wait) / 60000).toBeGreaterThanOrEqual(116);
    });
  });

  /**
   * B9 — the block comment must agree with the verdict it prints.
   *
   * In the incident state the comment said, in one breath:
   *   Outstanding findings: none - no agent-actionable finding remains.
   *   Reason: 1 agent-fixable finding(s): unverifiable_commit
   * The Reason line was the RAW pre-judgement observation reason, recorded
   * before the reviewer dismissed anything. A dismissed finding is not
   * outstanding, so the message contradicted itself.
   */
  describe('B9 — the block reason agrees with the exhaustion verdict', () => {
    const writeVerdict = (dir: string, payload: Record<string, any>): void => {
      fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.ai-agent', 'post-publish-exhaustion.json'),
        JSON.stringify(payload),
        'utf8',
      );
    };

    it('does not claim an agent-fixable finding when the verdict is awaiting', () => {
      const dir = tempDir('pw-b9-awaiting-');
      try {
        writeObservation(dir, reviewRequiredObservation());
        writeVerdict(dir, {
          verdict: 'awaiting',
          reviewDecision: 'REVIEW_REQUIRED',
          awaitingReview: true,
          awaitingChecks: false,
          actionable: [],
          dismissed: [{ id: 'commit:eac38992b6f8', kind: 'unverifiable_commit', justification: 'verified:true' }],
          reason:
            'nothing agent-actionable remains; the only remaining blocker is an awaited human action (review decision REVIEW_REQUIRED)',
          generatedAt: new Date().toISOString(),
        });

        const out = runToken(scriptOf('readPostPublishBlockReason'), { WT: dir, STATE: 'fixable' }, dir);

        // The verdict's own wording wins ...
        expect(out).toMatch(/awaited human action/i);
        // ... and the raw pre-judgement reason must NOT leak through.
        expect(out).not.toMatch(/agent-fixable finding/i);
      } finally {
        removeDir(dir);
      }
    });

    it('still names the unaddressed finding when the verdict is outstanding', () => {
      const dir = tempDir('pw-b9-outstanding-');
      try {
        writeObservation(dir, reviewRequiredObservation({ reason: '1 agent-fixable finding(s): unverifiable_commit' }));
        writeVerdict(dir, {
          verdict: 'outstanding',
          reviewDecision: 'REVIEW_REQUIRED',
          awaitingReview: true,
          awaitingChecks: false,
          actionable: [{ id: 'commit:eac38992b6f8', kind: 'unverifiable_commit' }],
          dismissed: [],
          reason: '1 agent-actionable finding(s) remain unaddressed',
          generatedAt: new Date().toISOString(),
        });

        const out = runToken(scriptOf('readPostPublishBlockReason'), { WT: dir, STATE: 'fixable' }, dir);

        // A genuine outstanding block must still say WHAT is outstanding.
        expect(out).toMatch(/agent-fixable finding/i);
      } finally {
        removeDir(dir);
      }
    });
  });


  describe('R4 — the exhaustion verdict decides by STATE', () => {
    /** A closed, unreviewed pull request: no findings, review never given. */
    const closedObservation = (state: string): Record<string, any> =>
      reviewRequiredObservation({
        state,
        mergeStateStatus: 'UNKNOWN',
        pr: { number: 74, url: 'https://x/pull/74', state: 'CLOSED' },
        reason: 'the pull request is CLOSED, so there is nothing left to fix or merge',
        findings: [],
        counts: { total: 0, fixable: 0, humanOnly: 0, staleReviews: 0, pendingChecks: 0 },
        // describePostPublishBlock only trusts a verdict record it can prove
        // describes the SAME observation: `generatedAt >= checkedAt`. Without a
        // checkedAt the record looks stale, the freshness check fails, and the
        // heading falls back to the raw awaitingReview flag - which is precisely
        // the path R2(a) removed for a closed pull request. The verdict scripts
        // stamp generatedAt at run time, so an observation from a moment earlier
        // is the realistic shape.
        checkedAt: new Date(Date.now() - 1000).toISOString(),
      });

    /** Both copies of the verdict must agree, so both are exercised. */
    const VERDICT_SCRIPTS = ['readPostPublishExhaustionVerdict', 'readPostPublishPushPollVerdict'];

    it.each(VERDICT_SCRIPTS)('%s calls a CLOSED observation outstanding, not awaiting', (scriptId) => {
      const dir = tempDir('pw-r4-closed-');
      try {
        writeObservation(dir, closedObservation('human_only'));
        writeJudgement(dir, { cycle: 0, state: 'no_action', requiredChanges: [], dismissals: [] });

        const verdict = runToken(scriptOf(scriptId), { WT: dir }, dir);

        expect(verdict).toBe('outstanding');
        // ... and the record explains itself rather than claiming 0 findings remain.
        const record = JSON.parse(
          fs.readFileSync(path.join(dir, '.ai-agent', 'post-publish-exhaustion.json'), 'utf8'),
        );
        expect(record.reason).toMatch(/not an awaited human action/i);
        expect(record.reason).not.toMatch(/^0 agent-actionable/);
      } finally {
        removeDir(dir);
      }
    });

    it.each(VERDICT_SCRIPTS)('%s calls the SAME observation awaiting when state is fixable', (scriptId) => {
      // Everything else identical: no findings, review still REVIEW_REQUIRED.
      // Only the state differs, so the state is the deciding factor.
      const dir = tempDir('pw-r4-fixable-');
      try {
        writeObservation(dir, closedObservation('fixable'));
        writeJudgement(dir, { cycle: 0, state: 'no_action', requiredChanges: [], dismissals: [] });

        expect(runToken(scriptOf(scriptId), { WT: dir }, dir)).toBe('awaiting');
      } finally {
        removeDir(dir);
      }
    });

    it('renders a CLOSED pull request as BLOCKED, not AWAITING HUMAN', () => {
      // The heading follows the verdict, so a state-blind verdict told a human to
      // wait for a review on a pull request nobody can review.
      const dir = tempDir('pw-r4-heading-');
      try {
        writeObservation(dir, closedObservation('human_only'));
        writeJudgement(dir, { cycle: 0, state: 'no_action', requiredChanges: [], dismissals: [] });
        runToken(scriptOf('readPostPublishExhaustionVerdict'), { WT: dir }, dir);

        const block = runToken(
          scriptOf('describePostPublishBlock'),
          { WT: dir, STATE: 'human_only', OUTCOME: 'blocked_human', PR_URL: 'https://x/pull/74' },
          dir,
        );
        expect(block).toContain('BLOCKED');
        expect(block).not.toContain('AWAITING HUMAN');
        expect(block).toContain('CLOSED');
      } finally {
        removeDir(dir);
      }
    });
  });
});

// ── helpers that walk the parsed definition ────────────────────────────────────

function valueOf(stepId: string): string {
  return String(byId(stepId).config!.value);
}

function trailOf(stepId: string): string[] {
  const trail: string[] = [];
  const parents = new Map<string, string[]>();
  const visit = (steps: IStep[], ancestors: string[]): void => {
    (steps || []).forEach((step) => {
      parents.set(step.id, ancestors);
      const config = step.config || {};
      ['thenSteps', 'elseSteps', 'steps'].forEach((key) => {
        if (Array.isArray(config[key])) visit(config[key], ancestors.concat([step.id]));
      });
    });
  };
  visit(parsed.workflow.steps, []);
  const walkUp = (id: string): void => {
    const deps = parents.get(id) || [];
    deps.forEach((dep) => {
      trail.push(dep);
      walkUp(dep);

  /**
   * R4 — the verdict's STATE guard must be pinned.
   *
   * R1 and R2(a) both turned on one expression:
   *
   *   const awaitingState = observationState === 'fixable' || observationState === 'pending';
   *   const verdict = (actionable.length === 0 && awaitingHuman && awaitingState && ...)
   *
   * R1's loop outcomes are protected by the pure-poll gate's own
   * `state === 'fixable'` term, which the B7 tests pin. The TEXT consistency that
   * R2(a) restored is not: the heading and the task for a CLOSED pull request
   * follow this verdict alone. Deleting `&& awaitingState` from both copies left
   * this whole suite green, so nothing was guarding it.
   *
   * These tests run the SHIPPED verdict scripts rather than synthesising the
   * record, so the guard is exercised where it actually lives.
   */

    });
  };
  walkUp(stepId);
  return trail;
}
