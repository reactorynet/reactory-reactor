/**
 * REACTORY-302016408/20261114/787370442 — two observation defects on
 * core.ProcessAITicket@1.4.8 (instance 6af7508c4f0cf9fef5efe44a / PR #133).
 *
 * DEFECT A — async signature verification read as a failure.
 *   GitHub verifies commit signatures ASYNCHRONOUSLY. For a window after a push
 *   `verification.verified` is false with `reason: "unknown"`, which means NOT YET
 *   CHECKED. The observation treated it as a terminal negative, routed it to the
 *   engineer as a fixable `unverifiable_commit`, and `repairNeeded` drove a
 *   force-rewrite of published history once per cycle. `unknown` and a settled
 *   reason such as `no_user` must not share a code path or a message.
 *
 * DEFECT B — CI observed before it has produced any conclusion.
 *   The run observed PR #133 sixteen seconds BEFORE its CI run started: zero check
 *   conclusions existed, and the run still reported "the post-publication fix
 *   budget was exhausted" instead of "CI was never read". "No check scheduled",
 *   "checks running" and "checks finished" are three states, and a terminal reason
 *   that never saw a conclusion must say so.
 *
 * These tests execute the SHIPPED `cli_command` scripts against recorded payloads
 * (the `OBSERVATION_FIXTURE` seam) and real git fixtures, the same discipline the
 * rest of this suite follows. They fail against the pre-fix body.
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
    env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, env),
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

/**
 * A published branch: origin/feature/test is the published tip, `.ai-agent/`
 * exists and `origin` is this repository.
 */
const publishedRepo = (): string => {
  const dir = tempDir('pa-obs-');
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

// `observePullRequest` treats a configured signing identity as: user.signingkey
// set OR commit.gpgsign=true. Only the KEY is set here - enabling gpgsign would
// make the fixture's own `git commit` fail (there is no real private key).
/**
 * A published checkout whose `origin` is a REAL bare repository, so the local
 * branch can be rewritten (amended) without moving the published ref. The
 * same-repo `origin` fixture above cannot express that: `git ls-remote origin`
 * would report the amended local branch as the remote tip.
 */
const publishedClone = (): { dir: string; origin: string } => {
  const origin = tempDir('pa-obs-origin-');
  sh('git init -q --bare -b master .', origin);
  const seed = tempDir('pa-obs-seed-');
  try {
    sh('git init -q -b master .', seed);
    sh('git config user.email owner@example.com', seed);
    sh('git config user.name "Key Owner"', seed);
    sh('git config commit.gpgsign false', seed);
    fs.writeFileSync(path.join(seed, 'README.md'), '# fixture\n', 'utf8');
    sh('git add -A && git commit -qm base', seed);
    sh(`git remote add origin ${origin}`, seed);
    sh('git push -q origin master', seed);
    sh('git checkout -q -b feature/test', seed);
    fs.writeFileSync(path.join(seed, 'work.ts'), 'export const v = 1;\n', 'utf8');
    sh('git add -A && git commit -qm "AI engineering run: REF-1"', seed);
    sh('git push -q origin feature/test', seed);
  } finally {
    removeDir(seed);
  }

  const dir = tempDir('pa-obs-clone-');
  sh(`git clone -q ${origin} .`, dir);
  sh('git checkout -q feature/test', dir);
  sh('git config user.email owner@example.com', dir);
  sh('git config user.name "Key Owner"', dir);
  // A developer machine's global commit.gpgsign must not leak into the fixture:
  // the signing identity is configured below, and there is no real private key.
  sh('git config commit.gpgsign false', dir);
  fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
  return { dir, origin };
};

const withSigningKey = (dir: string): void => {
  sh('git config user.signingkey ABCDEF0123456789', dir);
};

const SHA_PENDING = '6f003d2c5540aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_SETTLED = 'b46bcd6f00d0bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const EMPTY_THREADS = { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } };

/** A recorded observation payload: nothing blocks except the commits/checks under test. */
const payload = (overrides: Record<string, any> = {}): Record<string, any> =>
  Object.assign(
    {
      pr: { number: 133, state: 'OPEN', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', url: 'https://x/pull/133' },
      reviews: [],
      reviewThreads: EMPTY_THREADS,
      checkRuns: { check_runs: [] },
      commits: [],
      protection: { required_signatures: { enabled: true } },
    },
    overrides,
  );

const writePayload = (dir: string, body: Record<string, any>): string => {
  const file = path.join(dir, '.ai-agent', 'observation-fixture.json');
  fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body), 'utf8');
  return file;
};

const observe = (dir: string, body: Record<string, any>, extra: Record<string, string> = {}): any =>
  runJson(
    scriptOf('observePullRequest'),
    Object.assign({ WT: dir, PR_NUMBER: '133', PR_STATE: 'OPEN', CYCLE: '0', OBSERVATION_FIXTURE: writePayload(dir, body) }, extra),
    dir,
  );

/**
 * EVERY commit fixture below uses the shape /pulls/{n}/commits ACTUALLY returns.
 *
 * That endpoint yields REST commit objects, so the signature verdict lives at
 * `commit.commit.verification`; there is NO top-level `commit.verification`.
 * The pre-fix body read the top-level path, got `{}` for every commit, never saw
 * `verified === true`, and defaulted the reason to 'unknown' - the real root cause
 * of PR #133's phantom, and of a genuinely verified commit being reported as
 * permanently 'pending'. Encoding the wrong shape here is what let that pass, so
 * these fixtures deliberately mirror the API contract.
 */

/** `unknown` means GitHub has NOT CHECKED YET — the phantom of Defect A. */
const unsettledCommit = (): Record<string, any> => ({
  sha: SHA_PENDING,
  commit: {
    committer: { email: 'owner@example.com' },
    verification: { verified: false, reason: 'unknown' },
  },
});

/** `no_user` is the genuine SPEECH-010 shape: checked and failed, actionably. */
const settledUnverifiableCommit = (): Record<string, any> => ({
  sha: SHA_SETTLED,
  commit: {
    committer: { email: 'reactor@reactory.net' },
    verification: { verified: false, reason: 'no_user' },
  },
});

/**
 * A RECORDED LIVE response item (PR #85, commit 07d2e189201e), with the base64
 * signature/payload blobs trimmed. GitHub reports this commit verified:true /
 * reason "valid" verified_at 2026-11-23T14:15:15Z, and the item carries NO
 * top-level `verification` - the verdict is under `commit.verification`.
 */
const recordedVerifiedCommit = (): Record<string, any> => ({
  sha: '07d2e189201e41da0b408478b4ed8ab441cab03d',
  node_id: 'C_kwDOJ0abcd9kAAdZLxkg',
  commit: {
    author: { name: 'Reactor AI', email: 'reactor@reactory.net', date: '2026-11-23T14:15:00Z' },
    committer: { name: 'Werner Weber', email: 'werner.weber@gmail.com', date: '2026-11-23T14:15:00Z' },
    message: 'AI engineering run: REACTORY-302016408/20261114/787370442',
    tree: { sha: '96c5745176ebbdffb1af46dab6165069149353f4' },
    verification: {
      verified: true,
      reason: 'valid',
      signature: '-----BEGIN PGP SIGNATURE-----\n<trimmed>\n-----END PGP SIGNATURE-----',
      payload: 'tree 96c5745176ebbdffb1af46dab6165069149353f4\nparent 2db658c2...',
      verified_at: '2026-11-23T14:15:15Z',
    },
  },
  url: 'https://api.github.com/repos/reactorynet/reactory-reactor/commits/07d2e189201e41da0b408478b4ed8ab441cab03d',
  html_url: 'https://github.com/reactorynet/reactory-reactor/commit/07d2e189201e41da0b408478b4ed8ab441cab03d',
  comments_url: 'https://api.github.com/repos/reactorynet/reactory-reactor/commits/07d2e189201e41da0b408478b4ed8ab441cab03d/comments',
  author: { login: 'wernerweber', id: 1 },
  committer: { login: 'wernerweber', id: 1 },
  parents: [{ sha: '2db658c244a7c07cade43bc9847047b2d954df22' }],
});

/**
 * FILE INTEGRITY GUARD — added after CodeQL alerts 359/360 on PR #85.
 *
 * A lost `it('...', () => {` header left one test body as a BARE statement in a
 * describe. The file was still *runnable*: the worktree runner inherits the server
 * ts-jest config, which transpiles with isolatedModules and emits best-effort
 * output, so the two stray tokens never failed the suite - it reported 18 green
 * tests while TypeScript reported 2x TS1128, and the orphaned assertions ran at
 * describe-definition time without being counted as a test at all.
 *
 * A green suite is therefore NOT evidence that this file parses. These assertions
 * are: no parse diagnostics, and every `it`/`test` has a `describe` ancestor, so a
 * hoisted test cannot hide again.
 */
describe('ProcessAITicket signature/CI observation suite — file integrity', () => {
  const sourceText = (): string => fs.readFileSync(__filename, 'utf8');

  it('is valid TypeScript (parse diagnostics are the gate ts-jest does not apply)', () => {
    const sf = ts.createSourceFile(__filename, sourceText(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diagnostics = (sf.parseDiagnostics || []).map((diagnostic) => {
      const at = sf.getLineAndCharacterOfPosition(diagnostic.start || 0);
      return 'TS' + diagnostic.code + ' ' + diagnostic.messageText + ' @' + (at.line + 1) + ':' + (at.character + 1);
    });
    expect(diagnostics).toEqual([]);
  });

  it('nests every test inside a describe', () => {
    const sf = ts.createSourceFile(__filename, sourceText(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const hoisted: string[] = [];
    let topLevelDescribes = 0;
    const walk = (node: ts.Node, describeDepth: number): void => {
      if (node.kind === ts.SyntaxKind.CallExpression) {
        const callee = (node as ts.CallExpression).expression.getText(sf);
        const at = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (callee === 'describe') {
          if (describeDepth === 0) topLevelDescribes += 1;
          expect(node).toBeTruthy();
          node.forEachChild((child) => walk(child, describeDepth + 1));
          return;
        }
        if (callee === 'it' || callee === 'test') {
          if (describeDepth === 0) hoisted.push(callee + ' @line ' + at);
          node.forEachChild((child) => walk(child, describeDepth));
          return;
        }
      }
      node.forEachChild((child) => walk(child, describeDepth));
    };
    walk(sf, 0);

    // A module-level `it` is the symptom of a lost header line, and it is not
    // counted or name-selectable by the runner.
    expect(hoisted).toEqual([]);
    // This file deliberately contains exactly two groups (Defect A and Defect B);
    // the integrity guard is the third. Anything else means the nesting moved.
    expect(topLevelDescribes).toBe(3);
  });
});

describe('ProcessAITicket — Defect A: a not-yet-settled signature is not a failure', () => {
  it('does NOT produce a fixable unverifiable_commit for verified:false reason "unknown"', () => {
    const dir = publishedRepo();
    try {
      withSigningKey(dir);
      const observation = observe(dir, payload({ commits: [unsettledCommit()] }), { BASE: 'master' });

      // The phantom: no `unverifiable_commit` at all.
      expect(observation.findings.filter((f: any) => f.kind === 'unverifiable_commit')).toEqual([]);
      // ... and NOTHING fixable was invented from it.
      expect(observation.counts.fixable).toBe(0);
      expect(observation.repairNeeded).toBe(false);

      // The state is a WAIT on the verdict, not a verdict.
      expect(observation.state).toBe('pending');
      expect(observation.awaitingVerification).toBe(true);
      expect(observation.pendingVerifications).toHaveLength(1);
      // 'unknown' is a transient/no-verdict state, never a settled failure.
      expect(observation.pendingVerifications[0].status).toBe('transient');
      expect(observation.pendingVerifications[0].reason).toBe('unknown');

      // The informational finding EXISTS but is non-fixable and says "no verdict".
      const pendingFinding = observation.findings.filter((f: any) => f.kind === 'commit_verification_pending');
      expect(pendingFinding).toHaveLength(1);
      expect(pendingFinding[0].fixable).toBe(false);
      expect(pendingFinding[0].settled).toBe(false);
      expect(pendingFinding[0].transient).toBe(true);
      expect(String(pendingFinding[0].body)).toContain('SETTLED');
      expect(String(pendingFinding[0].body)).toContain('not a failed signature');
      expect(String(observation.reason)).toContain('not yet settled');
    } finally {
      removeDir(dir);
    }
  });

  it('reads the verdict from commit.commit.verification and reports NOTHING for a verified commit', () => {
    // REQUIRED CHANGE 3 (REACTORY-302016408/20261114/787370442 review): a commit
    // GitHub reports verified:true must leave the observation NON-pending, with
    // awaitingVerification false and NO commit finding of any kind.
    //
    // The fixture is a recorded live response item from PR #85 rather than a
    // hand-written shape, because a hand-written shape is what hid the read-path
    // bug: `commit.verification` is always `{}` on this endpoint, so verified:true
    // was never seen and the verdict fell through to 'unknown' for EVERY commit.
    const dir = publishedRepo();
    try {
      withSigningKey(dir);
      const item = recordedVerifiedCommit();
      // The contract itself: the endpoint does not return a top-level verdict.
      expect(Object.prototype.hasOwnProperty.call(item, 'verification')).toBe(false);
      expect(item.commit.verification.verified).toBe(true);
      expect(item.commit.verification.reason).toBe('valid');

      const observation = observe(dir, payload({ commits: [item] }), { BASE: 'master' });

      // No commit finding at all - not `commit:*`, not `commit-pending:*`.
      expect(observation.findings.filter((f: any) => String(f.kind || '').indexOf('commit') === 0)).toEqual([]);
      expect(observation.findings.filter((f: any) => String(f.id || '').indexOf('commit') === 0)).toEqual([]);
      expect(observation.pendingVerifications).toEqual([]);
      expect(observation.awaitingVerification).toBe(false);
      expect(observation.repairNeeded).toBe(false);
      // Either CLEAN (nothing else blocks) or some other non-pending state - never
      // the permanent 'pending' the pre-fix read produced for a valid signature.
      expect(observation.state).not.toBe('pending');
      expect(String(observation.reason)).not.toContain('not yet settled');
    } finally {
      removeDir(dir);
    }
  });

  it('still sees verified:true when the verdict is the ONLY thing that could block', () => {
    // A mergeable pull request whose only commit is verified must classify clean:
    // this is the exact state PR #85 was in while the run called it 'pending'.
    const dir = publishedRepo();
    try {
      withSigningKey(dir);
      const observation = observe(
        dir,
        payload({
          pr: { number: 133, state: 'OPEN', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', url: 'https://x/pull/133' },
          commits: [recordedVerifiedCommit()],
        }),
        { BASE: 'master' },
      );
      expect(observation.state).toBe('clean');
      expect(observation.checks.conclusionsEvaluated).toBe(0);
      expect(observation.awaitingVerification).toBe(false);
      expect(observation.counts.total).toBe(0);
    } finally {
      removeDir(dir);
    }
  });

  it('DOES produce a fixable unverifiable_commit once the reason is settled (no_user)', () => {
    const dir = publishedRepo();
    try {
      withSigningKey(dir);
      const observation = observe(dir, payload({ commits: [settledUnverifiableCommit()] }), { BASE: 'master' });

      expect(observation.state).toBe('fixable');
      const finding = observation.findings.filter((f: any) => f.kind === 'unverifiable_commit');
      expect(finding).toHaveLength(1);
      expect(finding[0].fixable).toBe(true);
      expect(finding[0].settled).toBe(true);
      expect(finding[0].verificationReason).toBe('no_user');
      expect(observation.repairNeeded).toBe(true);
      expect(observation.counts.fixable).toBe(1);
      // The message says CHECKED AND FAILED, not "awaiting verification".
      expect(String(finding[0].body)).toContain('SETTLED reason');
      expect(String(finding[0].body)).toContain('no_user');
      expect(observation.findings.filter((f: any) => f.kind === 'commit_verification_pending')).toEqual([]);
    } finally {
      removeDir(dir);
    }
  });

  it('treats every TRANSIENT GitHub verification reason as pending, never as a failure (R2)', () => {
    // GitHub's verification service can be down (gpgverify_unavailable) or fail
    // to communicate (gpgverify_error), and OCSP can be unresolved (ocsp_pending).
    // Before this fix every non-empty reason was a settled failure, so a GitHub
    // verification OUTAGE forced a --force-with-lease rewrite of published history.
    const transientReasons = ['gpgverify_unavailable', 'gpgverify_error', 'ocsp_pending'];
    transientReasons.forEach((reason) => {
      const dir = publishedRepo();
      try {
        withSigningKey(dir);
        const observation = observe(
          dir,
          payload({
            commits: [{
              sha: SHA_PENDING,
              commit: {
                committer: { email: 'werner.weber@gmail.com' },
                verification: { verified: false, reason: reason },
              },
            }],
          }),
          { BASE: 'master' },
        );
        const label = 'reason ' + reason;

        // NEVER fixable, NEVER a rewrite.
        expect(observation.repairNeeded).toBe(false);
        expect(observation.counts.fixable).toBe(0);
        expect(observation.findings.filter((f: any) => f.kind === 'unverifiable_commit')).toEqual([]);
        expect(label && observation.state).toBe('pending');
        expect(observation.awaitingVerification).toBe(true);
        expect(observation.pendingVerifications).toHaveLength(1);
        expect(observation.pendingVerifications[0].status).toBe('transient');
        expect(observation.pendingVerifications[0].reason).toBe(reason);

        const pendingFinding = observation.findings.filter((f: any) => f.kind === 'commit_verification_pending');
        expect(pendingFinding).toHaveLength(1);
        expect(pendingFinding[0].fixable).toBe(false);
        expect(pendingFinding[0].transient).toBe(true);
        expect(String(pendingFinding[0].body)).toContain('transient verification state');
      } finally {
        removeDir(dir);
      }
    });
  });

  it('treats an UNRECOGNISED verification reason as pending, so a new GitHub value cannot rewrite history (R2)', () => {
    const dir = publishedRepo();
    try {
      withSigningKey(dir);
      const observation = observe(
        dir,
        payload({
          commits: [{
            sha: SHA_PENDING,
            commit: {
              committer: { email: 'werner.weber@gmail.com' },
              verification: { verified: false, reason: 'a_reason_github_has_not_invented_yet' },
            },
          }],
        }),
        { BASE: 'master' },
      );
      expect(observation.repairNeeded).toBe(false);
      expect(observation.findings.filter((f: any) => f.kind === 'unverifiable_commit')).toEqual([]);
      expect(observation.pendingVerifications[0].status).toBe('not_yet_verified');
    } finally {
      removeDir(dir);
    }
  });

  it('treats a missing verification reason as unsettled, never as a failure', () => {
    const dir = publishedRepo();
    try {
      withSigningKey(dir);
      const observation = observe(
        dir,
        payload({ commits: [{ sha: SHA_PENDING, commit: { committer: { email: 'owner@example.com' }, verification: { verified: false } } }] }),
        { BASE: 'master' },
      );
      expect(observation.findings.filter((f: any) => f.kind === 'unverifiable_commit')).toEqual([]);
      expect(observation.repairNeeded).toBe(false);
      expect(observation.state).toBe('pending');
    } finally {
      removeDir(dir);
    }
  });

  it('does not set the repair flag the loop reads, and offers no repair base', () => {
    const dir = publishedRepo();
    try {
      withSigningKey(dir);
      const unsettled = observe(dir, payload({ commits: [unsettledCommit()] }), { BASE: 'master' });
      expect(unsettled.repairNeeded).toBe(false);

      // The loop's own reader must agree with the observation.
      expect(runToken(scriptOf('readPostPublishRepairNeed'), { WT: dir }, dir)).toBe('false');
      // No repair base means the re-publish path cannot rewrite history.
      expect(runToken(scriptOf('resolveRepairBase'), { WT: dir }, dir)).toBe('');

      // Positive control: the genuine case still asks for a repair.
      const settled = observe(dir, payload({ commits: [settledUnverifiableCommit()] }), { BASE: 'master' });
      expect(settled.repairNeeded).toBe(true);
      expect(runToken(scriptOf('readPostPublishRepairNeed'), { WT: dir }, dir)).toBe('true');
      expect(runToken(scriptOf('resolveRepairBase'), { WT: dir }, dir)).not.toBe('');
    } finally {
      removeDir(dir);
    }
  });

  it('refuses the history rewrite the phantom used to drive, leaving origin untouched', () => {
    const { dir, origin } = publishedClone();
    try {
      withSigningKey(dir);
      // A RE-CREATED commit: the published tip is no longer an ancestor of HEAD,
      // so a push would rewrite published history (the repair path).
      sh('git commit -q --amend -m "rewritten on the published branch"', dir);
      const rewrittenHead = sh('git rev-parse HEAD', dir);
      const publishedTip = sh(`git ls-remote origin refs/heads/feature/test`, dir).split(/\s+/)[0];

      // The observation of an unsettled signature yields NO repair base, so the
      // republish script is entered with REPAIR_BASE='' - exactly what the loop
      // does when readPostPublishRepairNeed says false.
      observe(dir, payload({ commits: [unsettledCommit()] }), { BASE: 'master' });
      const repairBase = runToken(scriptOf('resolveRepairBase'), { WT: dir }, dir);
      expect(repairBase).toBe('');

      const result = runJson(
        scriptOf('republishPush'),
        { WT: dir, BRANCH: 'feature/test', OBSERVED_TIP: publishedTip, REPAIR_BASE: repairBase },
        dir,
      );
      expect(result.ok).toBe(false);
      expect(result.mode).toBe('rewrite-refused');
      expect(String(result.error)).toContain('not a commit repair');
      // Nothing was pushed: the published tip is exactly what it was.
      expect(sh('git ls-remote origin refs/heads/feature/test', dir).split(/\s+/)[0]).toBe(publishedTip);
      expect(rewrittenHead).not.toBe(publishedTip);
    } finally {
      removeDir(dir);
      removeDir(origin);
    }
  });

  it('waits after a push before judging signatures, in both the initial and re-publish paths', () => {
    const initial = byId('postPublishInitialSettleDelay');
    expect(initial.type).toBe('delay');
    expect(Number(initial.config!.duration)).toBeGreaterThanOrEqual(15000);
    expect(String((byId('postPublishLoop') as any).dependsOn)).toBe('postPublishInitialSettleDelay');

    const republish = byId('postPublishRepublishSettleDelay');
    expect(republish.type).toBe('delay');
    expect(Number(republish.config!.duration)).toBeGreaterThanOrEqual(15000);
    // It sits inside the "the commit reached origin" arm, i.e. after every push.
    const pushedArm: IStep[] = (byId('republishResultGate').config as any).thenSteps || [];
    const ids: string[] = [];
    const collect = (steps: IStep[]): void => {
      (steps || []).forEach((step) => {
        ids.push(step.id);
        ['thenSteps', 'elseSteps', 'steps'].forEach((key) => {
          if (Array.isArray((step.config || {})[key])) collect((step.config as any)[key]);
        });
      });
    };
    collect(pushedArm);
    expect(ids).toContain('postPublishRepublishSettleDelay');
  });
});

describe('ProcessAITicket — Defect B: never end a run without observing CI', () => {
  const requiredProtection = { required_signatures: { enabled: false }, required_status_checks: { contexts: ['build', 'test'] } };

  it('distinguishes "no checks scheduled yet" from "checks running" and "checks finished"', () => {
    const dir = publishedRepo();
    try {
      // 1. Required checks exist, none scheduled: NOT clean, NOT human_only.
      const notScheduled = observe(dir, payload({ protection: requiredProtection }));
      expect(notScheduled.state).toBe('pending');
      expect(notScheduled.awaitingChecks).toBe(true);
      expect(notScheduled.checks.state).toBe('not_scheduled');
      expect(notScheduled.checks.expected).toBe(true);
      expect(notScheduled.checks.scheduled).toBe(0);
      expect(notScheduled.checks.conclusionsEvaluated).toBe(0);
      expect(String(notScheduled.reason)).toContain('have been scheduled yet');
      expect(String(notScheduled.reason)).toContain('CI is expected here');
      expect(String(notScheduled.reason)).toContain('required status check(s): build, test');
      expect(notScheduled.checks.expectedEvidence.join(' ')).toContain('required status check(s)');

      // 2. Checks scheduled and running: a WAIT, no conclusion yet.
      const running = observe(
        dir,
        payload({ protection: requiredProtection, checkRuns: { check_runs: [{ name: 'build', status: 'in_progress', conclusion: null }] } }),
      );
      expect(running.state).toBe('pending');
      expect(running.checks.state).toBe('running');
      expect(running.checks.conclusionsEvaluated).toBe(0);
      expect(String(running.reason)).toContain('still running');

      // 3. A terminal conclusion exists: the state is judged on it.
      const finished = observe(
        dir,
        payload({
          protection: requiredProtection,
          checkRuns: {
            check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }],
          },
        }),
      );
      expect(finished.checks.state).toBe('finished');
      expect(finished.checks.conclusionsEvaluated).toBe(1);
      expect(finished.state).toBe('clean');
    } finally {
      removeDir(dir);
    }
  });

  it('WAITS when CI is expected from the base tip but nothing is scheduled yet (R1)', () => {
    // THE PRODUCTION GAP. No reactorynet repository declares required checks, so
    // before this fix checksExpected was always false, this observation was
    // 'clean', and the run took the success arm with zero conclusions read.
    // The base tip's check runs are the evidence that does exist.
    const dir = publishedRepo();
    try {
      const observation = observe(
        dir,
        payload({
          pr: { number: 133, state: 'OPEN', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', url: 'https://x/pull/133' },
          protection: {},
          baseTipCheckRuns: {
            check_runs: [
              { name: 'build', conclusion: 'success', app: { slug: 'github-actions' } },
              { name: 'test', conclusion: 'success', app: { slug: 'github-actions' } },
            ],
          },
        }),
      );
      // NOT clean, NOT a human_only policy block: a bounded WAIT.
      expect(observation.state).toBe('pending');
      expect(observation.checks.expected).toBe(true);
      expect(observation.checks.state).toBe('not_scheduled');
      expect(observation.checks.scheduled).toBe(0);
      expect(observation.checks.conclusionsEvaluated).toBe(0);
      expect(observation.awaitingChecks).toBe(true);
      expect(observation.checks.expectedNames).toEqual(expect.arrayContaining(['build', 'test']));
      expect(observation.checks.expectedEvidence.join(' ')).toContain('base tip');
      expect(String(observation.reason)).toContain('CI is expected');
    } finally {
      removeDir(dir);
    }
  });

  it('settles while only fast third-party checks have finished (R1 partial case)', () => {
    // GitGuardian finishes in ~1 s, so the head can look 'finished' before the
    // Actions jobs exist. A missing expected name must keep it a WAIT until an
    // ACTIONS conclusion lands - otherwise the PR is judged on GitGuardian alone.
    const dir = publishedRepo();
    try {
      const observation = observe(
        dir,
        payload({
          pr: { number: 133, state: 'OPEN', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', url: 'https://x/pull/133' },
          protection: {},
          baseTipCheckRuns: { check_runs: [{ name: 'build', app: { slug: 'github-actions' } }] },
          checkRuns: {
            check_runs: [
              { name: 'GitGuardian Security Checks', status: 'completed', conclusion: 'success', app: { slug: 'gitguardian' } },
            ],
          },
        }),
      );
      expect(observation.checks.state).toBe('running');
      expect(observation.checks.settling).toBe(true);
      expect(observation.checks.actionsConclusions).toBe(0);
      expect(observation.checks.missingExpectedNames).toEqual(['build']);
      expect(observation.awaitingChecks).toBe(true);
      expect(observation.state).toBe('pending');
      expect(String(observation.reason)).toContain('Actions jobs have not been created yet');
    } finally {
      removeDir(dir);
    }
  });

  it('stops settling once an Actions conclusion lands, even if a base-tip name never reappears (R1)', () => {
    // Without this, a name that only ever runs on the default branch (Dependabot,
    // a master-only `analysis` job) would hold every run open for 5 minutes.
    const dir = publishedRepo();
    try {
      const observation = observe(
        dir,
        payload({
          pr: { number: 133, state: 'OPEN', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', url: 'https://x/pull/133' },
          protection: {},
          baseTipCheckRuns: { check_runs: [{ name: 'Dependabot', app: { slug: 'github-actions' } }] },
          checkRuns: {
            check_runs: [
              { name: 'Analyze (javascript-typescript)', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
            ],
          },
        }),
      );
      expect(observation.checks.settling).toBe(false);
      expect(observation.checks.state).toBe('finished');
      expect(observation.checks.actionsConclusions).toBe(1);
      expect(observation.awaitingChecks).toBe(false);
    } finally {
      removeDir(dir);
    }
  });

  it('is clean when the repository has NO CI evidence at all', () => {
    // The other half of R1: a genuinely CI-less repository must not be parked,
    // and (R3(a)) must not later be told that CI failures may be hiding.
    const dir = publishedRepo();
    try {
      const observation = observe(
        dir,
        payload({ pr: { number: 133, state: 'OPEN', mergeStateStatus: 'CLEAN', reviewDecision: '', url: 'https://x/pull/133' }, protection: {} }),
      );
      expect(observation.state).toBe('clean');
      expect(observation.checks.state).toBe('not_scheduled');
      expect(observation.checks.expected).toBe(false);
      expect(observation.checks.expectedEvidence).toEqual([]);
      expect(observation.awaitingChecks).toBe(false);
    } finally {
      removeDir(dir);
    }
  });

  it('surfaces a failing required check, once scheduled, as a fixable finding', () => {
    const dir = publishedRepo();
    try {
      const observation = observe(
        dir,
        payload({
          protection: requiredProtection,
          checkRuns: {
            check_runs: [
              { name: 'build', status: 'completed', conclusion: 'failure', output: { summary: 'yarn install failed: canvas/node-gyp on Node 24' } },
              { name: 'test', status: 'completed', conclusion: 'failure' },
            ],
          },
        }),
      );
      expect(observation.state).toBe('fixable');
      const checks = observation.findings.filter((f: any) => f.kind === 'check_run');
      expect(checks).toHaveLength(2);
      expect(checks[0].fixable).toBe(true);
      expect(String(checks[0].body)).toContain('canvas');
      expect(observation.checks.conclusionsEvaluated).toBe(2);
      expect(observation.counts.fixable).toBe(2);
    } finally {
      removeDir(dir);
    }
  });

  it('names an unsettled signature as the wait cause once the checks have finished (R3b)', () => {
    const dir = publishedRepo();
    try {
      withSigningKey(dir);
      // CI has FINISHED (a completed success) and a signature verdict is pending.
      // The old rule returned 'running' because something was scheduled, so the
      // terminal reason became "its required checks had still not finished".
      const observation = observe(
        dir,
        payload({
          pr: { number: 133, state: 'OPEN', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', url: 'https://x/pull/133' },
          protection: {},
          checkRuns: {
            check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }],
          },
          commits: [unsettledCommit()],
        }),
        { BASE: 'master' },
      );
      expect(observation.checks.conclusionsEvaluated).toBe(1);
      expect(observation.checks.pending).toBe(0);
      expect(observation.pendingVerifications).toHaveLength(1);
      expect(observation.state).toBe('pending');
      expect(runToken(scriptOf('readPostPublishWaitCause'), { WT: dir }, dir)).toBe('verification');
    } finally {
      removeDir(dir);
    }
  });

  it('records the wait cause so the loop picks the right window', () => {
    const dir = publishedRepo();
    try {
      observe(dir, payload({ protection: requiredProtection }));
      expect(runToken(scriptOf('readPostPublishWaitCause'), { WT: dir }, dir)).toBe('not_scheduled');

      observe(
        dir,
        payload({ protection: requiredProtection, checkRuns: { check_runs: [{ name: 'build', status: 'in_progress' }] } }),
      );
      expect(runToken(scriptOf('readPostPublishWaitCause'), { WT: dir }, dir)).toBe('running');

      withSigningKey(dir);
      observe(dir, payload({ commits: [unsettledCommit()] }), { BASE: 'master' });
      expect(runToken(scriptOf('readPostPublishWaitCause'), { WT: dir }, dir)).toBe('verification');
    } finally {
      removeDir(dir);
    }
  });

  it('reports not_expected for a CI-less repository instead of none (R3a)', () => {
    const dir = publishedRepo();
    try {
      const writeObservation = (body: Record<string, any>): void => {
        fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.ai-agent', 'post-publish-observation.json'), JSON.stringify(body), 'utf8');
      };
      writeObservation({
        state: 'fixable',
        headSha: 'a'.repeat(40),
        checkedAt: '2026-11-23T21:00:00.000Z',
        checks: { state: 'not_scheduled', expected: false, expectedEvidence: [], scheduled: 0, required: 0, conclusionsEvaluated: 0 },
        counts: { pendingChecks: 0, pendingVerifications: 0 },
      });
      // `none` would make the terminal reporting blame a CI failure that cannot
      // exist; the budget is the real cause on this repository.
      expect(runToken(scriptOf('recordPostPublishCoverage'), { WT: dir }, dir)).toBe('not_expected');
      const record = JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'post-publish-ci-coverage.json'), 'utf8'));
      expect(record.expected).toBe(false);
      expect(record.anyConclusionEvaluated).toBe(false);
    } finally {
      removeDir(dir);
    }
  });

  it('reports none when CI is expected and no conclusion was ever read (R3a)', () => {
    const dir = publishedRepo();
    try {
      fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.ai-agent', 'post-publish-observation.json'),
        JSON.stringify({
          state: 'pending',
          headSha: 'b'.repeat(40),
          checkedAt: '2026-11-23T21:01:00.000Z',
          checks: { state: 'running', expected: true, expectedEvidence: ['base tip master has check run(s): build'], scheduled: 2, required: 0, conclusionsEvaluated: 0 },
          counts: { pendingChecks: 2, pendingVerifications: 0 },
        }),
        'utf8',
      );
      expect(runToken(scriptOf('recordPostPublishCoverage'), { WT: dir }, dir)).toBe('none');
      const record = JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'post-publish-ci-coverage.json'), 'utf8'));
      expect(record.expected).toBe(true);
      expect(record.lastCiExpectedEvidence.join(' ')).toContain('base tip');
    } finally {
      removeDir(dir);
    }
  });

  it('discards coverage accumulated for a DIFFERENT head (NB2)', () => {
    const dir = publishedRepo();
    try {
      const dirAi = path.join(dir, '.ai-agent');
      fs.mkdirSync(dirAi, { recursive: true });
      // A previous head's record says a conclusion WAS seen.
      fs.writeFileSync(
        path.join(dirAi, 'post-publish-ci-coverage.json'),
        JSON.stringify({ headSha: 'c'.repeat(40), observations: 6, anyConclusionEvaluated: true, conclusionsEvaluated: 3, expected: true }),
        'utf8',
      );
      const newHead = 'd'.repeat(40);
      fs.writeFileSync(
        path.join(dirAi, 'post-publish-observation.json'),
        JSON.stringify({
          state: 'pending',
          headSha: newHead,
          checkedAt: '2026-11-23T21:02:00.000Z',
          checks: { state: 'not_scheduled', expected: true, expectedEvidence: ['base tip'], scheduled: 0, required: 0, conclusionsEvaluated: 0 },
          counts: { pendingChecks: 0, pendingVerifications: 0 },
        }),
        'utf8',
      );
      // The fixed head inherits NOTHING: a conclusion read on the old head must not
      // make this one look covered.
      expect(runToken(scriptOf('recordPostPublishCoverage'), { WT: dir }, dir)).toBe('none');
      const record = JSON.parse(fs.readFileSync(path.join(dirAi, 'post-publish-ci-coverage.json'), 'utf8'));
      expect(record.headSha).toBe(newHead);
      expect(record.observations).toBe(1);
      expect(record.anyConclusionEvaluated).toBe(false);
      expect(record.conclusionsEvaluated).toBe(0);
    } finally {
      removeDir(dir);
    }
  });

  it('accumulates CI coverage across observations instead of overwriting it', () => {
    const dir = publishedRepo();
    try {
      const writeObservation = (body: Record<string, any>): void => {
        fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.ai-agent', 'post-publish-observation.json'), JSON.stringify(body), 'utf8');
      };
      const HEAD = 'e'.repeat(40);
      const noConclusion = {
        state: 'pending',
        headSha: HEAD,
        checkedAt: '2026-11-13T21:26:44.000Z',
        checks: { state: 'running', expected: true, scheduled: 7, required: 5, conclusionsEvaluated: 0 },
        counts: { pendingChecks: 7, pendingVerifications: 0 },
      };
      const oneConclusion = {
        state: 'fixable',
        headSha: HEAD,
        checkedAt: '2026-11-13T21:30:00.000Z',
        checks: { state: 'finished', expected: true, scheduled: 7, required: 5, conclusionsEvaluated: 2 },
        counts: { pendingChecks: 0, pendingVerifications: 0 },
      };

      writeObservation(noConclusion);
      expect(runToken(scriptOf('recordPostPublishCoverage'), { WT: dir }, dir)).toBe('none');
      const first = JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'post-publish-ci-coverage.json'), 'utf8'));
      expect(first.observations).toBe(1);
      expect(first.anyConclusionEvaluated).toBe(false);
      expect(first.requiredChecks).toBe(5);

      writeObservation(oneConclusion);
      expect(runToken(scriptOf('recordPostPublishCoverage'), { WT: dir }, dir)).toBe('some');
      const second = JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'post-publish-ci-coverage.json'), 'utf8'));
      expect(second.observations).toBe(2);
      expect(second.anyConclusionEvaluated).toBe(true);
      expect(second.conclusionsEvaluated).toBe(2);
      expect(second.anyChecksScheduled).toBe(true);
    } finally {
      removeDir(dir);
    }
  });

  const writeArtefacts = (
    dir: string,
    coverage: Record<string, any> | null,
    observationPatch: Record<string, any> = {},
  ): void => {
    fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.ai-agent', 'post-publish-observation.json'),
      JSON.stringify(Object.assign({
        state: 'pending',
        checkedAt: '2026-11-13T21:26:44.000Z',
        mergeStateStatus: 'BLOCKED',
        // NOT REVIEW_REQUIRED: this suite is about the CI cause. A review still
        // awaited would (correctly) render AWAITING HUMAN for the heading; the
        // never-observed CI REASON must take precedence either way, which is what
        // the assertions below pin.
        reviewDecision: 'CHANGES_REQUESTED',
        awaitingReview: false,
        awaitingChecks: true,
        findings: [],
        pendingChecks: [{ name: 'build', status: 'queued' }],
        reason: '7 check(s) still running; 0 check conclusion(s) evaluated',
      }, observationPatch)),
      'utf8',
    );
    if (coverage) {
      fs.writeFileSync(path.join(dir, '.ai-agent', 'post-publish-ci-coverage.json'), JSON.stringify(coverage), 'utf8');
    }
  };

  it('reports "never observed a CI conclusion" instead of "fix budget exhausted"', () => {
    const dir = publishedRepo();
    try {
      writeArtefacts(dir, {
        observations: 2,
        anyConclusionEvaluated: false,
        conclusionsEvaluated: 0,
        anyChecksScheduled: true,
        requiredChecks: 5,
        expected: true,
        lastCiExpectedEvidence: ['base tip master has check run(s): build, test'],
        lastChecksState: 'running',
        lastScheduledChecks: 7,
      });
      const comment = runScript(
        scriptOf('describePostPublishBlock'),
        { WT: dir, OUTCOME: 'exhausted', REASON: '', PR_URL: 'https://x/pull/133', BOUND: '2' },
        dir,
      );
      expect(comment).toContain('WITHOUT OBSERVING ANY CI CONCLUSION');
      expect(comment).toContain('failing checks may exist and were never read');
      expect(comment).toContain('7 scheduled at the last observation');
      expect(comment).toContain('CI expected because base tip master has check run(s): build, test');
      expect(comment).toContain('5 required check(s)');
      // The misdiagnosis must be gone.
      expect(comment).not.toContain('budget was exhausted');
      // The coverage line makes the absence visible, not implied.
      expect(comment).toContain('CI observed: 2 observation(s), 0 check conclusion(s) evaluated');
    } finally {
      removeDir(dir);
    }
  });

  it('says the same when the loop records the distinct checks_unobserved outcome', () => {
    const dir = publishedRepo();
    try {
      writeArtefacts(dir, {
        observations: 1,
        anyConclusionEvaluated: false,
        conclusionsEvaluated: 0,
        anyChecksScheduled: false,
        requiredChecks: 4,
        expected: true,
        lastCiExpectedEvidence: ['.github/workflows declares a pull_request trigger'],
      });
      const comment = runScript(
        scriptOf('describePostPublishBlock'),
        { WT: dir, OUTCOME: 'checks_unobserved', REASON: '', PR_URL: 'https://x/pull/133', BOUND: '2' },
        dir,
      );
      expect(comment).toContain('WITHOUT OBSERVING ANY CI CONCLUSION');
      expect(comment).not.toContain('budget was exhausted');
    } finally {
      removeDir(dir);
    }
  });

  it('keeps the exhausted-budget wording for a repository with NO CI (R3a)', () => {
    const dir = publishedRepo();
    try {
      writeArtefacts(dir, {
        observations: 3,
        anyConclusionEvaluated: false,
        conclusionsEvaluated: 0,
        anyChecksScheduled: false,
        requiredChecks: 0,
        expected: false,
        lastChecksState: 'not_scheduled',
        lastScheduledChecks: 0,
      }, { pendingChecks: [], awaitingChecks: false, awaitingReview: false, reviewDecision: '' });
      const comment = runScript(
        scriptOf('describePostPublishBlock'),
        { WT: dir, OUTCOME: 'exhausted', REASON: '', PR_URL: 'https://x/pull/133', BOUND: '2' },
        dir,
      );
      // Before R3(a) this said "WITHOUT OBSERVING ANY CI CONCLUSION ... failing
      // checks may exist", which is impossible on a repository with no CI.
      expect(comment).toContain('budget was exhausted');
      expect(comment).not.toContain('WITHOUT OBSERVING ANY CI CONCLUSION');
    } finally {
      removeDir(dir);
    }
  });

  it('STILL reports an exhausted fix budget when a CI conclusion WAS observed', () => {
    const dir = publishedRepo();
    try {
      writeArtefacts(dir, {
        observations: 4,
        anyConclusionEvaluated: true,
        conclusionsEvaluated: 2,
        anyChecksScheduled: true,
        requiredChecks: 5,
        expected: true,
        lastChecksState: 'finished',
        lastScheduledChecks: 7,
      }, { pendingChecks: [], awaitingChecks: false });
      const comment = runScript(
        scriptOf('describePostPublishBlock'),
        { WT: dir, OUTCOME: 'exhausted', REASON: '', PR_URL: 'https://x/pull/133', BOUND: '2' },
        dir,
      );
      expect(comment).toContain('budget was exhausted');
      expect(comment).not.toContain('WITHOUT OBSERVING ANY CI CONCLUSION');
      expect(comment).toContain('CI observed: 4 observation(s), 2 check conclusion(s) evaluated');
    } finally {
      removeDir(dir);
    }
  });

  it('words the human task with the never-observed cause, not fix cycles', () => {
    const dir = publishedRepo();
    try {
      writeArtefacts(dir, {
        observations: 2,
        anyConclusionEvaluated: false,
        conclusionsEvaluated: 0,
        requiredChecks: 5,
        expected: true,
        lastCiExpectedEvidence: ['base tip master has check run(s): build'],
        lastScheduledChecks: 7,
      });
      fs.writeFileSync(
        path.join(dir, '.ai-agent', 'post-publish-park.json'),
        JSON.stringify({ awaitPolls: 3, fixCycles: 0, fixBound: '2' }),
        'utf8',
      );
      const message = runScript(
        scriptOf('postPublishTaskMessage'),
        { WT: dir, OUTCOME: 'checks_unobserved', PR_URL: 'https://x/pull/133' },
        dir,
      );
      expect(message).toContain('WITHOUT OBSERVING ANY CI CONCLUSION');
      expect(message).toContain('never read');
      expect(message).toContain('not an exhausted fix budget');
    } finally {
      removeDir(dir);
    }
  });

  it('gives the CI-scheduling gap its own wider window and keeps the iteration cap above it', () => {
    expect(Number(byId('seedPostPublishSchedulingWaitBound').config!.value)).toBe(20);
    expect(Number(byId('postPublishSchedulingWait').config!.duration)).toBe(15000);
    // 20 x 15s = 5 minutes of scheduling window.
    expect((Number(byId('seedPostPublishSchedulingWaitBound').config!.value) * Number(byId('postPublishSchedulingWait').config!.duration)) / 60000).toBe(5);
    // The check-wait budget is unchanged.
    expect(Number(byId('seedPostPublishWaitBound').config!.value)).toBe(6);
    // 1 initial + 20 scheduling + 6 running + 2 fixes + 3 re-observes + 40 polls + 1 final.
    expect(Number(byId('postPublishLoop').config!.maxIterations)).toBeGreaterThanOrEqual(73);
  });

  it('keeps the pre-publish review cycle bound untouched', () => {
    // Defect B is confined to the post-publish loop; the pre-publish bound is a
    // different variable, seeded from its own input, and must not be re-purposed.
    const reviewBound = byId('setCycleBound');
    expect(reviewBound.config!.key).toBe('reviewCycleBound');
    expect(reviewBound.config!.sourcePath).toBe('resolveCycleBound.outputs.stdout');
    // ... and the post-publish fix bound still comes from its own input.
    expect(byId('setPostPublishBound').config!.key).toBe('postPublishFixBound');
  });
});
