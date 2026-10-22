/**
 * Behaviour tests for core.ProcessAITicket.
 *
 * The contract test pins the wiring; these tests execute the actual
 * `cli_command` scripts the workflow runs, against throwaway git repositories
 * and fixture reports/reviews. That matters because every defect this suite
 * guards against was a runtime behaviour, not a shape:
 *
 *  - a report with `status: "complete"` silently produced no pull request
 *  - a snake_case `review.json` silently discarded six findings
 *  - `gh pr create --body-file` bypassed the repository template
 *  - persona workspace notes landed wherever the agent felt like
 *  - a submodule checkout corrupted the primary clone, and the guard that was
 *    meant to catch it snapshot the wrong repository (defect 6)
 */

import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { YamlFlowParser } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/YamlFlowParser';

const WORKFLOW_FILE = path.resolve(__dirname, '..', 'ProcessAITicket.yaml');

interface IStep {
  id: string;
  type: string;
  config?: Record<string, any>;
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

const scriptOf = (id: string): string => String(byId(id).config.args[1]);

const runScript = (script: string, env: Record<string, string>, cwd: string): any => {
  const stdout = execFileSync(process.execPath, ['-e', script], {
    cwd,
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return stdout;
};

const runJson = (script: string, env: Record<string, string>, cwd: string): any => JSON.parse(runScript(script, env, cwd));

const sh = (command: string, cwd: string): string =>
  execFileSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const tempDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// `fs.rmSync` is newer than this repo's @types/node; wrap it so the test stays
// type-clean without raising the toolchain floor for a test helper.
const removeDir = (dir: string): void => {
  try {
    (fs as unknown as { rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void }).rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // best effort: the OS temp directory will be reclaimed anyway
  }
};

const initRepo = (dir: string): void => {
  sh('git init -q -b master .', dir);
  sh('git config user.email test@example.com', dir);
  sh('git config user.name Test', dir);
  sh('git config commit.gpgsign false', dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  sh('git add -A && git commit -qm base', dir);
};

/** A repo with a base commit, a feature branch and one commit of work. */
const repoWithWork = (): string => {
  const dir = tempDir('pa-repo-');
  initRepo(dir);
  sh('git checkout -q -b feature/test', dir);
  fs.mkdirSync(path.join(dir, 'src', 'modules', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'modules', 'fixture', 'index.ts'), 'export const value = 2;\n', 'utf8');
  fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
  sh('git add -A && git commit -qm "AI engineering run: REF-1"', dir);
  return dir;
};

const writeReport = (dir: string, report: any): void => {
  fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ai-agent', 'report.json'), JSON.stringify(report), 'utf8');
};

const writeReview = (dir: string, review: any): void => {
  fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ai-agent', 'review.json'), JSON.stringify(review), 'utf8');
};

describe('ProcessAITicket report status normalisation (all four paths)', () => {
  const capture = scriptOf('captureReport');
  const read = scriptOf('readReportStatus');

  const CASES: Array<{ report: any; expected: string }> = [
    { report: { status: 'complete', summary: 's', files: ['a.ts'] }, expected: 'completed' },
    { report: { status: '  COMPLETED  ', summary: 's', changes: [{ file: 'a', description: 'd' }] }, expected: 'completed' },
    { report: { status: 'done', summary: 's' }, expected: 'completed' },
    { report: { status: 'finished', summary: 's' }, expected: 'completed' },
    { report: { status: 'success', summary: 's' }, expected: 'completed' },
    { report: { status: 'succeeded', summary: 's' }, expected: 'completed' },
    { report: { status: 'resolved', summary: 's' }, expected: 'completed' },
    { report: { status: 'block', summary: 's' }, expected: 'blocked' },
    { report: { status: 'stalled', summary: 's' }, expected: 'blocked' },
    { report: { status: 'error', summary: 's' }, expected: 'failed' },
    { report: { status: 'fail', summary: 's' }, expected: 'failed' },
    // No ticket.status, no changes array - only `files`. This is ORG-004.
    { report: { status: 'complete', summary: 's', files: [{ file: 'a.ts', description: 'd' }] }, expected: 'completed' },
    { report: { summary: 's', implementation: 'did the work' }, expected: 'completed' },
    { report: { summary: 's', acceptanceCriteria: ['AC1'] }, expected: 'completed' },
    { report: { summary: 's', ticket: { status: 'resolved' } }, expected: 'completed' },
  ];

  it.each(CASES)('agrees across capture, re-capture and both readers: %j', ({ report, expected }) => {
    const dir = repoWithWork();
    try {
      writeReport(dir, report);

      const firstCapture = runJson(capture, { WT: dir }, dir).status;
      const firstRead = runScript(read, { WT: dir }, dir);
      const secondCapture = runJson(capture, { WT: dir }, dir).status;
      const secondRead = runScript(read, { WT: dir }, dir);

      expect(firstCapture).toBe(expected);
      expect(firstRead).toBe(expected);
      expect(secondCapture).toBe(expected);
      expect(secondRead).toBe(expected);
    } finally {
      removeDir(dir);
    }
  });

  it('does not treat a missing report as a completed run', () => {
    const dir = repoWithWork();
    try {
      const result = runJson(capture, { WT: dir }, dir);
      expect(result.usable).toBe(false);
      expect(result.status).toBe('blocked');
      // The commit evidence is still recorded so the caller can fail loudly.
      expect(result.runEvidence.commitCount).toBeGreaterThan(0);
      expect(runScript(read, { WT: dir }, dir)).toBe('blocked');
    } finally {
      removeDir(dir);
    }
  });

  it('shares one implementation: the two capture scripts are byte-identical', () => {
    expect(scriptOf('captureReport')).toBe(scriptOf('reCaptureReport'));
    expect(scriptOf('readReportStatus')).toBe(scriptOf('reReadReportStatus'));
    expect(scriptOf('readReportStatus')).not.toContain('STATUS_SYNONYMS');
  });
});

describe('ProcessAITicket PR template merge', () => {
  const script = scriptOf('createPullRequest');

  const TEMPLATE = [
    '<!-- author guidance that must be stripped -->',
    '',
    '## Summary',
    '',
    '<!-- one or two sentences -->',
    '',
    '- **Ticket / issue:** `REACTORY-…`',
    '- **Related PRs / commits:**',
    '- **Reviewer focus:**',
    '',
    '## Type of change',
    '',
    '- [ ] Feature',
    '- [ ] Bug fix',
    '- [ ] Refactor (no functional change)',
    '- [ ] Documentation',
    '',
    '## What changed',
    '',
    '-',
    '-',
    '',
    '## How was this tested?',
    '',
    '### Automated',
    '',
    '- [ ] Type check (`yarn typecheck`)',
    '- [ ] Lint (`yarn lint`)',
    '- [ ] Unit tests (`yarn test`) — suites touched:',
    '- [ ] Integration tests (`yarn test:integration`)',
    '',
    '### Manual verification',
    '',
    '1.',
    '2.',
    '',
    '**Result:**',
    '',
    '## Impact analysis',
    '',
    '| Area | Impact |',
    '| --- | --- |',
    '| Server modules affected | e.g. `src/modules/core` |',
    '| Client components / plugins affected | |',
    '| GraphQL schema / resolver changes | |',
    '| Database migrations | |',
    '| Config or environment variables | |',
    '| Submodule version bumps | |',
    '| Cross-repo dependency | |',
    '| i18n key changes | |',
    '',
    '## Security considerations',
    '',
    '- [ ] No secrets, tokens or credentials committed (reviewed `git diff` and `.env*` files)',
    '- [ ] Authorisation and permission checks reviewed for new endpoints, resolvers or menu entries',
    '- [ ] Not applicable — rationale:',
    '',
    '## Author checklist',
    '',
    '- [ ] Ticket reference present in the title or description',
    '',
    '## Reviewer checklist',
    '',
    '- [ ] Behaviour matches the stated intent and the linked ticket',
    '',
  ].join('\n');

  const fakeGh = (dir: string): string => {
    const bin = path.join(dir, '.fake-bin');
    fs.mkdirSync(bin, { recursive: true });
    const bodyPath = path.join(dir, '.fake-bin', 'body.md');
    fs.writeFileSync(
      path.join(bin, 'gh'),
      [
        '#!/bin/sh',
        'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
        '  prev=""',
        '  for arg in "$@"; do',
        '    if [ "$prev" = "--body-file" ]; then cp "$arg" ' + JSON.stringify(bodyPath) + '; fi',
        '    prev="$arg"',
        '  done',
        '  echo "https://github.com/example/repo/pull/42"',
        '  exit 0',
        'fi',
        'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
        '  echo \'{"url":"https://github.com/example/repo/pull/42","number":42,"state":"OPEN","mergedAt":null}\'',
        '  exit 0',
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

  const runCreate = (dir: string, extraEnv: Record<string, string> = {}): { result: any; body: string } => {
    const bin = fakeGh(dir);
    const result = runJson(
      script,
      Object.assign({
        WT: dir,
        BRANCH: 'feature/test',
        REF: 'REACTORY-302016408/20261021/3847124067',
        REQUEST: 'Fixture ticket',
        REQUEST_TYPE: 'bug',
        CYCLES: '1',
        REVIEWER: 'QualityQuinn',
        TICKET_ID: 'fixture-ticket-id',
        PATH: bin + ':' + process.env.PATH,
      }, extraEnv),
      dir,
    );
    const body = fs.readFileSync(path.join(dir, '.fake-bin', 'body.md'), 'utf8');
    return { result, body };
  };

  it('keeps every template heading, in order, verbatim', () => {
    const dir = repoWithWork();
    try {
      fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.github', 'pull_request_template.md'), TEMPLATE, 'utf8');
      writeReport(dir, { status: 'completed', summary: 'Did the work.', findings: [] });

      const { result, body } = runCreate(dir);
      expect(result.templateUsed).toBe(true);
      expect(result.templatePath).toBe('.github/pull_request_template.md');

      const headings = body.split('\n').filter((line) => /^##\s+\S/.test(line));
      expect(headings).toEqual([
        '## Summary',
        '## Type of change',
        '## What changed',
        '## How was this tested?',
        '## Impact analysis',
        '## Security considerations',
        '## Author checklist',
        '## Reviewer checklist',
      ]);
      expect(body).not.toContain('<!--');
      expect(body).toContain('Generated by core.ProcessAITicket@1.4.5');
    } finally {
      removeDir(dir);
    }
  });

  it('ticks exactly the type of change derived from requestType, and only evidence-backed boxes', () => {
    const dir = repoWithWork();
    try {
      fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.github', 'pull_request_template.md'), TEMPLATE, 'utf8');
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        testsRun: [
          { command: 'npm run typecheck', result: 'passed' },
          { command: 'npx jest fixture', result: 'passed' },
        ],
      });

      const { body } = runCreate(dir);
      expect(body).toContain('- [x] Bug fix');
      expect(body).toContain('- [ ] Feature');
      expect(body).toContain('- [x] Type check');
      expect(body).toContain('- [x] Unit tests');
      expect(body).toContain('- [ ] Lint');
      expect(body).toContain('- [x] Ticket reference present in the title or description');
      // Nothing under reviewer checklist is ticked by the pipeline.
      expect(body).toContain('- [ ] Behaviour matches the stated intent and the linked ticket');
      // Server-only change: the section is kept but no box is ticked and the
      // heading is not deleted. (This fixture has no UI section; assert the
      // impact table still names the module.)
      expect(body).toContain('| Server modules affected | `src/modules/fixture` |');
    } finally {
      removeDir(dir);
    }
  });

  it('discovers a case-variant template in docs/ when .github/ has none', () => {
    const dir = repoWithWork();
    try {
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'docs', 'PULL_REQUEST_TEMPLATE.MD'), TEMPLATE, 'utf8');
      writeReport(dir, { status: 'completed', summary: 'Did the work.' });

      const { result, body } = runCreate(dir);
      expect(result.templateUsed).toBe(true);
      expect(result.templatePath).toBe('docs/PULL_REQUEST_TEMPLATE.MD');
      expect(body).toContain('## Type of change');
    } finally {
      removeDir(dir);
    }
  });

  it('falls back to the generated body, and warns, when the template is missing', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, { status: 'completed', summary: 'Did the work.' });
      const { result, body } = runCreate(dir);
      expect(result.templateUsed).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(body).toContain('## AI engineering run');
      expect(body).toContain('PR template not applied');
      expect(body).toContain('Generated by core.ProcessAITicket@1.4.5');
      // The warning is also written into the completion report.
      const report = JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'report.json'), 'utf8'));
      expect(report.prBody.templateUsed).toBe(false);
      expect(report.prBody.warnings.length).toBeGreaterThan(0);
    } finally {
      removeDir(dir);
    }
  });

  it('falls back, and warns, when the template has no parseable sections', () => {
    const dir = repoWithWork();
    try {
      fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.github', 'pull_request_template.md'), 'just prose, no headings\n', 'utf8');
      writeReport(dir, { status: 'completed', summary: 'Did the work.' });

      const { result, body } = runCreate(dir);
      expect(result.templateUsed).toBe(false);
      expect(result.warnings.join(' ')).toContain('no level-2 headings');
      expect(body).toContain('PR template not applied');
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket review key casing', () => {
  const capture = scriptOf('captureReview');
  const briefing = scriptOf('handBackBriefing');

  const camel = {
    verdict: 'rejected',
    summary: 'Needs work',
    requiredChanges: ['Move the queries into a hook', 'Fix the FQN documentation'],
    blockingFindings: ['Role gating is missing'],
    acceptanceCriteria: ['Detail panel uses the hook'],
    findings: ['Observed a duplicated query'],
  };

  const snake = {
    verdict: 'rejected',
    summary: 'Needs work',
    required_changes: camel.requiredChanges,
    blocking_findings: camel.blockingFindings,
    acceptance_criteria: camel.acceptanceCriteria,
    findings: camel.findings,
  };

  it('produces the same normalised review for camelCase and snake_case', () => {
    const dir = repoWithWork();
    try {
      writeReview(dir, camel);
      const first = runJson(capture, { WT: dir }, dir);
      writeReview(dir, snake);
      const second = runJson(capture, { WT: dir }, dir);

      expect(second.verdict).toBe(first.verdict);
      expect(second.requiredChanges).toEqual(first.requiredChanges);
      expect(second.blockingFindings).toEqual(first.blockingFindings);
      expect(second.acceptanceCriteria).toEqual(first.acceptanceCriteria);
      expect(second.findings).toEqual(first.findings);
      expect(second.findingsResolved).toBe(true);
    } finally {
      removeDir(dir);
    }
  });

  it('hands the findings to the engineer as structured text', () => {
    const dir = repoWithWork();
    try {
      writeReview(dir, snake);
      runJson(capture, { WT: dir }, dir);
      const text = runScript(briefing, { WT: dir }, dir);

      expect(text).toContain('Reviewer verdict: REJECTED');
      expect(text).toContain('## Required changes (2)');
      expect(text).toContain('Move the queries into a hook');
      expect(text).toContain('Fix the FQN documentation');
      expect(text).toContain('## Blocking findings (1)');
      expect(text).toContain('Role gating is missing');
      expect(text).toContain('## Findings observed by the reviewer (1)');
      // The generic "no specific required changes" string must never appear.
      expect(text).not.toContain('listed no specific required changes');
    } finally {
      removeDir(dir);
    }
  });

  it('reports a rejected verdict with no resolvable findings as unresolved (so the run blocks)', () => {
    const dir = repoWithWork();
    try {
      writeReview(dir, { verdict: 'rejected', summary: 'Nope' });
      const result = runJson(capture, { WT: dir }, dir);
      expect(result.verdict).toBe('rejected');
      expect(result.findingsResolved).toBe(false);
      expect(String(result.blockedReason)).toContain('no findings could be resolved');

      const text = runScript(briefing, { WT: dir }, dir);
      expect(text).toContain('No actionable findings could be resolved');
      expect(text).toContain('blocked for a human');
    } finally {
      removeDir(dir);
    }
  });

  it('recognises kebab-case keys too', () => {
    const dir = repoWithWork();
    try {
      writeReview(dir, { verdict: 'changes_requested', 'required-changes': ['Fix the kebab case'] });
      const result = runJson(capture, { WT: dir }, dir);
      expect(result.verdict).toBe('rejected');
      expect(result.requiredChanges).toEqual(['Fix the kebab case']);
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket workspace notes', () => {
  const noteScript = scriptOf('openWorkspaceNote');

  const setup = () => {
    const dir = repoWithWork();
    const data = tempDir('pa-data-');
    fs.mkdirSync(path.join(data, 'profiles', 'reactor', 'personas', 'FixturePersona'), { recursive: true });
    writeReport(dir, { status: 'completed', summary: 'Did the work.' });
    const env = {
      WT: dir,
      REACTORY_DATA: data,
      REF: 'REACTORY-302016408/20261021/3847124067',
      TICKET_ID: '6ad846a888ed8d058f51d88a',
      REPO: dir,
      BRANCH: 'feature/test',
      PERSONA: 'FixturePersona',
    };
    const workspace = path.join(data, 'profiles', 'reactor', 'personas', 'FixturePersona', 'workspace');
    const notePath = path.join(workspace, 'in-progress', 'reactory-302016408-20261021-3847124067.md');
    return { dir, data, env, workspace, notePath };
  };

  it('creates in-progress/<slug>.md with the required front matter at engineer start', () => {
    const ctx = setup();
    try {
      const result = runJson(noteScript, Object.assign({ MODE: 'open' }, ctx.env), ctx.dir);
      expect(result.ok).toBe(true);
      expect(result.notePath).toBe(ctx.notePath);

      const text = fs.readFileSync(ctx.notePath, 'utf8');
      expect(text).toContain('status: in_progress');
      expect(text).toContain('reference: REACTORY-302016408/20261021/3847124067');
      expect(text).toContain('persona: FixturePersona');
      expect(text).toContain('branch: feature/test');
      expect(text).toContain('started:');
      expect(text).toContain('## Plan');
      // The note must live outside the worktree so it cannot enter the PR diff.
      expect(ctx.notePath.startsWith(ctx.dir + path.sep)).toBe(false);
    } finally {
      removeDir(ctx.dir);
      removeDir(ctx.data);
    }
  });

  it('reuses the same slug for the same ticket and never overwrites an unrelated note', () => {
    const ctx = setup();
    try {
      runJson(noteScript, Object.assign({ MODE: 'open' }, ctx.env), ctx.dir);
      const again = runJson(noteScript, Object.assign({ MODE: 'open' }, ctx.env), ctx.dir);
      expect(again.alreadyExisted).toBe(true);

      const inProgress = path.dirname(ctx.notePath);
      fs.writeFileSync(path.join(inProgress, 'reactory-302016408-20261021-9999999999.md'), '---\nreference: someone-else\n---\n', 'utf8');
      const other = runJson(
        noteScript,
        Object.assign({ MODE: 'open' }, ctx.env, { REF: 'REACTORY-302016408/20261021/9999999999' }),
        ctx.dir,
      );
      expect(other.slug).toBe('reactory-302016408-20261021-9999999999-2');
    } finally {
      removeDir(ctx.dir);
      removeDir(ctx.data);
    }
  });

  it('recreates a missing note after the engineer session instead of failing the run', () => {
    const ctx = setup();
    try {
      const result = runJson(noteScript, Object.assign({ MODE: 'verify' }, ctx.env), ctx.dir);
      expect(result.ok).toBe(true);
      expect(fs.existsSync(ctx.notePath)).toBe(true);
      expect(result.warnings.join(' ')).toContain('recreated');
    } finally {
      removeDir(ctx.dir);
      removeDir(ctx.data);
    }
  });

  it('moves the note to complete/ with the PR url and verification on success', () => {
    const ctx = setup();
    try {
      runJson(noteScript, Object.assign({ MODE: 'open' }, ctx.env), ctx.dir);
      const result = runJson(
        noteScript,
        Object.assign({ MODE: 'close', PR_URL: 'https://github.com/example/repo/pull/42', CYCLES: '2' }, ctx.env),
        ctx.dir,
      );
      expect(result.moved).toBe(true);
      expect(fs.existsSync(ctx.notePath)).toBe(false);

      const complete = path.join(ctx.workspace, 'complete', path.basename(ctx.notePath));
      const text = fs.readFileSync(complete, 'utf8');
      expect(text).toContain('status: completed');
      expect(text).toContain('https://github.com/example/repo/pull/42');
      expect(text).toContain('## Files touched');
      expect(text).toContain('## Review cycles');
      expect(text).toContain('src/modules/fixture/index.ts');
    } finally {
      removeDir(ctx.dir);
      removeDir(ctx.data);
    }
  });

  it('moves a completed note back to in-progress when a later cycle rejects', () => {
    const ctx = setup();
    try {
      runJson(noteScript, Object.assign({ MODE: 'open' }, ctx.env), ctx.dir);
      runJson(noteScript, Object.assign({ MODE: 'close', PR_URL: 'https://example.test/pr/1' }, ctx.env), ctx.dir);

      const reopened = runJson(noteScript, Object.assign({ MODE: 'reopen', CYCLES: '2' }, ctx.env), ctx.dir);
      expect(reopened.moved).toBe(true);
      expect(fs.existsSync(ctx.notePath)).toBe(true);
      expect(fs.readFileSync(ctx.notePath, 'utf8')).toContain('status: in_progress');
      expect(fs.existsSync(path.join(ctx.workspace, 'complete', path.basename(ctx.notePath)))).toBe(false);
    } finally {
      removeDir(ctx.dir);
      removeDir(ctx.data);
    }
  });

  it('leaves the note in progress with status blocked on a blocked run', () => {
    const ctx = setup();
    try {
      runJson(noteScript, Object.assign({ MODE: 'open' }, ctx.env), ctx.dir);
      const result = runJson(
        noteScript,
        Object.assign({ MODE: 'retain', NOTE_STATUS: 'blocked', REASON: 'Stranded commits' }, ctx.env),
        ctx.dir,
      );
      expect(result.status).toBe('blocked');
      const text = fs.readFileSync(ctx.notePath, 'utf8');
      expect(text).toContain('status: blocked');
      expect(text).toContain('Stranded commits');
      expect(fs.existsSync(path.join(ctx.workspace, 'complete', path.basename(ctx.notePath)))).toBe(false);
    } finally {
      removeDir(ctx.dir);
      removeDir(ctx.data);
    }
  });

  it('refuses to write a note that resolves inside the worktree', () => {
    const ctx = setup();
    try {
      const insideData = path.join(ctx.dir, 'profiles');
      fs.mkdirSync(path.join(insideData, 'reactor', 'personas', 'FixturePersona'), { recursive: true });
      const result = runJson(noteScript, Object.assign({ MODE: 'open' }, ctx.env, { REACTORY_DATA: ctx.dir }), ctx.dir);
      expect(result.ok).toBe(false);
      expect(result.warnings.join(' ')).toContain('inside the git worktree');
      expect(fs.existsSync(path.join(ctx.dir, 'profiles', 'reactor', 'personas', 'FixturePersona', 'workspace', 'in-progress'))).toBe(false);
    } finally {
      removeDir(ctx.dir);
      removeDir(ctx.data);
    }
  });

  it('unstages a workspace path that reached the index', () => {
    const ctx = setup();
    try {
      const relativeNote = path.join('profiles', 'reactor', 'personas', 'FixturePersona', 'workspace', 'in-progress', 'leak.md');
      fs.mkdirSync(path.dirname(path.join(ctx.dir, relativeNote)), { recursive: true });
      fs.writeFileSync(path.join(ctx.dir, relativeNote), 'leaked note\n', 'utf8');
      sh('git add -A', ctx.dir);

      const guard = scriptOf('workspaceDiffGuard');
      const result = runJson(
        guard,
        {
          WT: ctx.dir,
          NOTE: JSON.stringify({ workspace: path.join(ctx.dir, 'profiles', 'reactor', 'personas', 'FixturePersona', 'workspace') }),
        },
        ctx.dir,
      );
      expect(result.ok).toBe(false);
      expect(result.removed.join(' ')).toContain('leak.md');
      expect(sh('git diff --cached --name-only', ctx.dir)).not.toContain('leak.md');
    } finally {
      removeDir(ctx.dir);
      removeDir(ctx.data);
    }
  });
});

describe('ProcessAITicket primary checkout / submodule safety', () => {
  const guard = scriptOf('submoduleGuardSnapshot');

  const repoWithSubmodule = (): { dir: string; sub: string; first: string; second: string } => {
    const dir = tempDir('pa-super-');
    initRepo(dir);
    // The nested repository must live at the gitlink path inside the primary
    // checkout, otherwise the guard has nothing to inspect.
    const sub = path.join(dir, 'packages', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    initRepo(sub);
    const first = sh('git rev-parse HEAD', sub);
    fs.writeFileSync(path.join(sub, 'second.txt'), 'second\n', 'utf8');
    sh('git add -A && git commit -qm second', sub);
    const second = sh('git rev-parse HEAD', sub);
    sh('git checkout -q --detach "' + first + '"', sub);

    // Register the nested repository as a gitlink without needing a network or
    // `git submodule add` (which refuses file:// URLs by default).
    sh('git update-index --add --cacheinfo 160000,' + first + ',packages/sub', dir);
    sh('git commit -qm "add submodule"', dir);
    return { dir, sub, first, second };
  };

  /**
   * The topology that broke in production (ORG-011) and that the previous test
   * did not model.
   *
   * `plugin` is the repository the pipeline runs in (REPO). It owns no
   * submodules. `consumer` mounts it at `vendor/plugin` as a real 160000
   * gitlink. A run that checks its branch out inside the mount mutates the
   * CONSUMER, and REPO's `git ls-files -s` cannot see that: the mount is not a
   * submodule *of* REPO, it is REPO itself, mounted elsewhere.
   *
   * The consumer's gitlink is deliberately committed at `other` while the mount
   * is checked out at `original`, reproducing the pre-existing drift the guard
   * must neither disturb nor commit.
   */
  const consumerTopology = (): {
    root: string;
    plugin: string;
    consumer: string;
    mount: string;
    original: string;
    other: string;
  } => {
    const root = tempDir('pa-topo-');

    // repo A - the "plugin" worktree repo the run operates in.
    const plugin = path.join(root, 'plugin');
    fs.mkdirSync(plugin, { recursive: true });
    initRepo(plugin);
    sh('git remote add origin git@github.com:fixture/plugin.git', plugin);
    const original = sh('git rev-parse HEAD', plugin);
    fs.writeFileSync(path.join(plugin, 'second.txt'), 'second\n', 'utf8');
    sh('git add -A && git commit -qm second', plugin);
    const other = sh('git rev-parse HEAD', plugin);

    // repo B - the "consumer" that mounts A at vendor/plugin.
    const consumer = path.join(root, 'consumer');
    fs.mkdirSync(consumer, { recursive: true });
    initRepo(consumer);

    // A local clone is a real working copy with its own origin, which is what
    // `git submodule update --init` leaves behind for the developer.
    sh('git clone -q "' + plugin + '" vendor/plugin', consumer);
    const mount = path.join(consumer, 'vendor', 'plugin');
    sh('git remote set-url origin git@github.com:fixture/plugin.git', mount);
    sh('git checkout -q --detach "' + original + '"', mount);

    fs.writeFileSync(
      path.join(consumer, '.gitmodules'),
      '[submodule "vendor/plugin"]\n\tpath = vendor/plugin\n\turl = git@github.com:fixture/plugin.git\n',
      'utf8',
    );

    sh('git update-index --add --cacheinfo 160000,' + other + ',vendor/plugin', consumer);
    sh('git add .gitmodules && git commit -qm "mount plugin"', consumer);

    return { root, plugin, consumer, mount, original, other };
  };

  it('snapshots a 160000 gitlink and restores the submodule SHA if it moved', () => {
    const ctx = repoWithSubmodule();
    try {
      fs.mkdirSync(path.join(ctx.dir, '.ai-agent'), { recursive: true });
      const snapshot = runJson(guard, { MODE: 'snapshot', WT: ctx.dir, REPO: ctx.dir }, ctx.dir);
      expect(snapshot.count).toBe(1);
      expect(snapshot.submodules[0].path).toBe('packages/sub');

      // Simulate exactly what the bad verification recipe did: check out inside
      // the submodule of the primary checkout.
      sh('git checkout -q "' + ctx.second + '"', ctx.sub);

      const verify = runJson(guard, { MODE: 'verify', WT: ctx.dir, REPO: ctx.dir }, ctx.dir);
      expect(verify.ok).toBe(false);
      expect(verify.mutated.length).toBe(1);
      expect(verify.mutated[0].restored).toBe(true);
      expect(sh('git rev-parse HEAD', ctx.sub)).toBe(ctx.first);
    } finally {
      removeDir(ctx.dir);
    }
  });

  it('snapshots a consumer working copy that mounts the worktree repo', () => {
    const ctx = consumerTopology();
    try {
      fs.mkdirSync(path.join(ctx.plugin, '.ai-agent'), { recursive: true });

      // REPO is the plugin. It owns no gitlinks - which is exactly why the
      // 1.4.3 guard captured `submodules: []` and did nothing.
      expect(sh('git ls-files -s', ctx.plugin)).not.toContain('160000');

      const snapshot = runJson(guard, { MODE: 'snapshot', WT: ctx.plugin, REPO: ctx.plugin }, ctx.plugin);

      // The assertion that would have caught the production bug: the baseline
      // contains the CONSUMER's mount, not an empty array.
      expect(snapshot.submodules).toEqual([
        expect.objectContaining({
          consumer: ctx.consumer,
          path: 'vendor/plugin',
          headSha: ctx.original,
        }),
      ]);
      expect(snapshot.consumerCount).toBe(1);

      // What the agent did: checked its branch out inside the mount and left a
      // directory behind.
      sh('git checkout -q --detach "' + ctx.other + '"', ctx.mount);
      fs.mkdirSync(path.join(ctx.mount, 'organization-management'), { recursive: true });
      fs.writeFileSync(path.join(ctx.mount, 'organization-management', 'index.ts'), 'export {};\n', 'utf8');

      const verify = runJson(guard, { MODE: 'verify', WT: ctx.plugin, REPO: ctx.plugin }, ctx.plugin);

      expect(verify.ok).toBe(false);
      expect(verify.mutated).toEqual([
        expect.objectContaining({
          consumer: ctx.consumer,
          path: 'vendor/plugin',
          before: ctx.original,
          after: ctx.other,
          restored: true,
        }),
      ]);

      // Restored to the SHA it started from, with no run artefacts left behind.
      expect(sh('git rev-parse HEAD', ctx.mount)).toBe(ctx.original);
      expect(fs.existsSync(path.join(ctx.mount, 'organization-management'))).toBe(false);
      expect(verify.cleaned.join(' ')).toContain('organization-management');

      // The pre-existing gitlink drift is neither disturbed nor committed: the
      // index still points at `other` while the mount sits at `original`.
      expect(sh('git ls-files -s vendor/plugin', ctx.consumer)).toContain('160000 ' + ctx.other);
      expect(sh('git status --porcelain', ctx.consumer)).toContain('M vendor/plugin');
    } finally {
      removeDir(ctx.root);
    }
  });

  it('reports a clean no-op only after checking consumer working copies', () => {
    const ctx = consumerTopology();
    try {
      fs.mkdirSync(path.join(ctx.plugin, '.ai-agent'), { recursive: true });

      // The mount now points at a different repository, so nothing mounts REPO.
      sh('git remote set-url origin git@github.com:fixture/some-other-plugin.git', ctx.mount);

      const snapshot = runJson(guard, { MODE: 'snapshot', WT: ctx.plugin, REPO: ctx.plugin }, ctx.plugin);

      expect(snapshot.count).toBe(0);
      // The consumer was inspected before "nothing to do" was concluded.
      expect(snapshot.consumersScanned).toBeGreaterThanOrEqual(1);
      expect(snapshot.warnings.join(' ')).toMatch(/nothing to protect/);

      const verify = runJson(guard, { MODE: 'verify', WT: ctx.plugin, REPO: ctx.plugin }, ctx.plugin);
      expect(verify.ok).toBe(true);
      expect(verify.mutated).toEqual([]);
    } finally {
      removeDir(ctx.root);
    }
  });

  it('honours an explicit CONSUMERS list, including without .gitmodules', () => {
    const ctx = consumerTopology();
    try {
      fs.mkdirSync(path.join(ctx.plugin, '.ai-agent'), { recursive: true });

      // Auto-discovery skips siblings without .gitmodules (one index dump per
      // repo is expensive). An operator-provided list must still work.
      sh('git rm -q --cached .gitmodules && git commit -qm "drop gitmodules"', ctx.consumer);

      const snapshot = runJson(
        guard,
        { MODE: 'snapshot', WT: ctx.plugin, REPO: ctx.plugin, CONSUMERS: ctx.consumer },
        ctx.plugin,
      );

      expect(snapshot.consumerCount).toBe(1);
      expect(snapshot.submodules[0]).toEqual(
        expect.objectContaining({ consumer: ctx.consumer, path: 'vendor/plugin', headSha: ctx.original }),
      );
    } finally {
      removeDir(ctx.root);
    }
  });

  it('is a no-op on a repository without submodules and without consumers', () => {
    const dir = repoWithWork();
    try {
      fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
      const snapshot = runJson(guard, { MODE: 'snapshot', WT: dir, REPO: dir }, dir);
      expect(snapshot.count).toBe(0);
      const verify = runJson(guard, { MODE: 'verify', WT: dir, REPO: dir }, dir);
      expect(verify.ok).toBe(true);
      expect(verify.mutated).toEqual([]);
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket worktree base is the remote default branch (WORKFLOW-002)', () => {
  const script = scriptOf('prepareWorktree');

  /**
   * A repository with a real `origin`, two commits on master, and a clone whose
   * local master can be moved behind origin/master.
   *
   * The defect is only reproducible with a remote-tracking ref to compare
   * against: the old code ran `git worktree add <path> -b <branch>` with no
   * commit-ish, so the worktree inherited HEAD of this clone.
   */
  const repoWithRemote = (): { root: string; remote: string; repo: string; base: string; tip: string } => {
    const root = tempDir('pa-base-');
    const remote = path.join(root, 'origin.git');
    // `-b master` is required: init.defaultBranch is `main` on this machine, and a
    // bare repo whose HEAD is an unborn `main` clones to no local branch at all.
    sh('git init -q --bare -b master "' + remote + '"', root);

    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed, { recursive: true });
    initRepo(seed);
    const base = sh('git rev-parse HEAD', seed);
    fs.writeFileSync(path.join(seed, 'second.txt'), 'second\n', 'utf8');
    sh('git add -A && git commit -qm second', seed);
    const tip = sh('git rev-parse HEAD', seed);
    sh('git remote add origin "' + remote + '"', seed);
    sh('git push -q origin master', seed);

    const repo = path.join(root, 'repo');
    sh('git clone -q "' + remote + '" "' + repo + '"', root);
    sh('git config user.email test@example.com', repo);
    sh('git config user.name Test', repo);
    sh('git config commit.gpgsign false', repo);
    return { root, remote, repo, base, tip };
  };

  const prepare = (cwd: string, ref: string, requestType = 'bug'): any =>
    runJson(script, { CWD: cwd, REF: ref, REQUEST_TYPE: requestType, TASK_TYPE: 'feature' }, cwd);

  it('bases the worktree on origin/<default> when the local master is stale', () => {
    const ctx = repoWithRemote();
    try {
      // The live failure: local master five commits behind origin/master.
      sh('git reset --hard "' + ctx.base + '"', ctx.repo);
      expect(sh('git rev-parse master', ctx.repo)).toBe(ctx.base);

      const out = prepare(ctx.repo, 'REACTORY-1/20260101/1');

      expect(out.baseRef).toBe('origin/master');
      expect(out.baseSha).toBe(ctx.tip);
      expect(out.fetchOk).toBe(true);
      expect(out.remoteDefault).toBe('master');
      // The worktree is on the remote tip, not on the stale local master.
      expect(sh('git rev-parse HEAD', out.worktreePath)).toBe(ctx.tip);
      expect(sh('git rev-parse --abbrev-ref HEAD', out.worktreePath)).toBe('bug/REACTORY-1-20260101-1');
    } finally {
      removeDir(ctx.root);
    }
  });

  it('bases the worktree on origin/<default> when the checkout is on a feature branch', () => {
    const ctx = repoWithRemote();
    try {
      sh('git checkout -q -b feature/unrelated', ctx.repo);
      fs.writeFileSync(path.join(ctx.repo, 'wip.txt'), 'unrelated work in progress\n', 'utf8');
      sh('git add -A && git commit -qm wip', ctx.repo);
      const featureSha = sh('git rev-parse HEAD', ctx.repo);

      const out = prepare(ctx.repo, 'REACTORY-2/20260101/2');

      expect(out.headBranch).toBe('feature/unrelated');
      expect(out.headSha).toBe(featureSha);
      expect(out.baseRef).toBe('origin/master');
      expect(out.baseSha).toBe(ctx.tip);
      // The unrelated commit must not reach the worktree.
      expect(sh('git rev-parse HEAD', out.worktreePath)).toBe(ctx.tip);
      expect(fs.existsSync(path.join(out.worktreePath, 'wip.txt'))).toBe(false);
      // ...and the checkout being off the default branch is surfaced on the ticket.
      expect(out.warnings.join(' ')).toMatch(/not 'master'/);
    } finally {
      removeDir(ctx.root);
    }
  });

  it('refuses to reuse a pre-existing local branch that does not descend from the base', () => {
    const ctx = repoWithRemote();
    try {
      const branch = 'bug/REACTORY-3-20260101-3';
      // An unrelated root commit on the ticket's branch: exactly what a pruned
      // worktree from a different base would leave behind.
      sh('git checkout -q --orphan "' + branch + '"', ctx.repo);
      sh('git rm -rfq . && git commit -q --allow-empty -m orphan', ctx.repo);
      sh('git checkout -q master', ctx.repo);

      let stderr = '';
      try {
        prepare(ctx.repo, 'REACTORY-3/20260101/3');
      } catch (e) {
        const err = e as { stderr?: Buffer; message?: string };
        stderr = (err.stderr ? String(err.stderr) : '') + String(err.message || '');
      }
      expect(stderr).toMatch(/does not descend from origin\/master/);
    } finally {
      removeDir(ctx.root);
    }
  });

  it('still reports a reused worktree with its actual branch and base', () => {
    const ctx = repoWithRemote();
    try {
      const first = prepare(ctx.repo, 'REACTORY-4/20260101/4');
      const second = prepare(ctx.repo, 'REACTORY-4/20260101/4');

      expect(second.reused).toBe(true);
      expect(second.branch).toBe(first.branch);
      expect(second.baseRef).toBe('origin/master');
      expect(second.baseSha).toBe(ctx.tip);
      expect(second.derivedFromBase).toBe(true);
    } finally {
      removeDir(ctx.root);
    }
  });
});

describe('ProcessAITicket refuses a contaminated baseline (WORKFLOW-003)', () => {
  const guard = scriptOf('submoduleGuardSnapshot');

  /**
   * plugin (the repository the run operates in) + consumer that mounts it at
   * vendor/plugin, with a real origin so `origin/master` resolves.
   *
   * The consumer's gitlink is committed at a FEATURE commit while the mount sits
   * at the default branch - the pre-existing drift the guard must neither
   * disturb nor commit. The feature commit is also the "leftover" used to
   * reproduce the contaminated baseline the live run adopted.
   */
  const topologyWithDefault = (): {
    root: string;
    plugin: string;
    consumer: string;
    mount: string;
    defaultSha: string;
    featureSha: string;
  } => {
    const root = tempDir('pa-topo-default-');
    const remote = path.join(root, 'origin.git');
    sh('git init -q --bare -b master "' + remote + '"', root);

    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed, { recursive: true });
    initRepo(seed);
    const defaultSha = sh('git rev-parse HEAD', seed);
    sh('git remote add origin "' + remote + '"', seed);
    sh('git push -q origin master', seed);

    const plugin = path.join(root, 'plugin');
    sh('git clone -q "' + remote + '" "' + plugin + '"', root);
    sh('git config user.email test@example.com', plugin);
    sh('git config user.name Test', plugin);
    sh('git config commit.gpgsign false', plugin);

    // A commit on a branch that is not an ancestor of origin/master. In the live
    // incident this was ORG-031's in-flight branch commit 8cb4bdda.
    sh('git checkout -q -b feature/other', plugin);
    fs.writeFileSync(path.join(plugin, 'feature.txt'), 'feature\n', 'utf8');
    sh('git add -A && git commit -qm feature', plugin);
    const featureSha = sh('git rev-parse HEAD', plugin);
    sh('git push -q origin feature/other', plugin);
    sh('git checkout -q master', plugin);

    const consumer = path.join(root, 'consumer');
    fs.mkdirSync(consumer, { recursive: true });
    initRepo(consumer);
    sh('git clone -q "' + remote + '" vendor/plugin', consumer);
    const mount = path.join(consumer, 'vendor', 'plugin');
    sh('git checkout -q --detach "' + defaultSha + '"', mount);

    fs.writeFileSync(
      path.join(consumer, '.gitmodules'),
      '[submodule "vendor/plugin"]\n\tpath = vendor/plugin\n\turl = ' + remote + '\n',
      'utf8',
    );
    // The index points at the feature commit while the mount is on master: the
    // standing gitlink drift from the live checkout.
    sh('git update-index --add --cacheinfo 160000,' + featureSha + ',vendor/plugin', consumer);
    sh('git add .gitmodules && git commit -qm "mount plugin"', consumer);

    return { root, plugin, consumer, mount, defaultSha, featureSha };
  };

  it('accepts a mount on the default branch, takes the lock, and records gitlink drift', () => {
    const ctx = topologyWithDefault();
    try {
      fs.mkdirSync(path.join(ctx.plugin, '.ai-agent'), { recursive: true });

      const snapshot = runJson(guard, { MODE: 'snapshot', WT: ctx.plugin, REPO: ctx.plugin, RUN_ID: 'run-a' }, ctx.plugin);

      expect(snapshot.baselineReady).toBe(true);
      expect(snapshot.violations).toEqual([]);
      expect(snapshot.submodules[0]).toEqual(expect.objectContaining({
        consumer: ctx.consumer,
        path: 'vendor/plugin',
        headSha: ctx.defaultSha,
        defaultRef: 'origin/master',
        headShaClean: true,
        headShaDirty: false,
        indexDrift: true,
      }));

      // Per-consumer lock, held for the run and released by verify.
      expect(snapshot.locks.length).toBe(1);
      expect(fs.existsSync(snapshot.locks[0])).toBe(true);

      const verify = runJson(guard, { MODE: 'verify', WT: ctx.plugin, REPO: ctx.plugin, RUN_ID: 'run-a' }, ctx.plugin);
      expect(verify.ok).toBe(true);
      expect(fs.existsSync(snapshot.locks[0])).toBe(false);
    } finally {
      removeDir(ctx.root);
    }
  });

  it('rejects a baseline whose headSha is not an ancestor of origin/<default>', () => {
    const ctx = topologyWithDefault();
    try {
      fs.mkdirSync(path.join(ctx.plugin, '.ai-agent'), { recursive: true });

      // The mount is already a leftover before the run starts.
      sh('git checkout -q --detach "' + ctx.featureSha + '"', ctx.mount);

      const snapshot = runJson(guard, { MODE: 'snapshot', WT: ctx.plugin, REPO: ctx.plugin, RUN_ID: 'run-a' }, ctx.plugin);

      expect(snapshot.baselineReady).toBe(false);
      expect(snapshot.ok).toBe(false);
      expect(snapshot.submodules[0].headShaDirty).toBe(true);
      expect(snapshot.violations.join(' ')).toMatch(/not origin\/master or an ancestor of it/);
      expect(snapshot.violations.join(' ')).toMatch(/leftover, not a pre-run state/);
    } finally {
      removeDir(ctx.root);
    }
  });

  it('never restores to a baseline that was not a legitimate pre-run state', () => {
    const ctx = topologyWithDefault();
    try {
      fs.mkdirSync(path.join(ctx.plugin, '.ai-agent'), { recursive: true });

      sh('git checkout -q --detach "' + ctx.featureSha + '"', ctx.mount);
      runJson(guard, { MODE: 'snapshot', WT: ctx.plugin, REPO: ctx.plugin, RUN_ID: 'run-a' }, ctx.plugin);

      // The engineer ignores the enforced recipe and moves the mount again.
      sh('git checkout -q --detach "' + ctx.defaultSha + '"', ctx.mount);

      const verify = runJson(guard, { MODE: 'verify', WT: ctx.plugin, REPO: ctx.plugin, RUN_ID: 'run-a' }, ctx.plugin);

      expect(verify.ok).toBe(false);
      expect(verify.unsafeBaselines.length).toBe(1);
      expect(verify.mutated[0]).toEqual(expect.objectContaining({ restored: false, dirtyBaseline: true }));
      expect(verify.violations.join(' ')).toMatch(/not a restore target/);
      // It is NOT dragged back to the leftover commit.
      expect(sh('git rev-parse HEAD', ctx.mount)).toBe(ctx.defaultSha);
    } finally {
      removeDir(ctx.root);
    }
  });

  it('restores the mount byte-identically even when the gitlink index was already drifted', () => {
    const ctx = topologyWithDefault();
    try {
      fs.mkdirSync(path.join(ctx.plugin, '.ai-agent'), { recursive: true });

      runJson(guard, { MODE: 'snapshot', WT: ctx.plugin, REPO: ctx.plugin, RUN_ID: 'run-a' }, ctx.plugin);

      sh('git checkout -q --detach "' + ctx.featureSha + '"', ctx.mount);
      fs.mkdirSync(path.join(ctx.mount, 'organization-management'), { recursive: true });
      fs.writeFileSync(path.join(ctx.mount, 'organization-management', 'index.ts'), 'export {};\n', 'utf8');

      const verify = runJson(guard, { MODE: 'verify', WT: ctx.plugin, REPO: ctx.plugin, RUN_ID: 'run-a' }, ctx.plugin);

      expect(verify.mutated[0]).toEqual(expect.objectContaining({
        before: ctx.defaultSha,
        after: ctx.featureSha,
        restored: true,
      }));
      expect(sh('git rev-parse HEAD', ctx.mount)).toBe(ctx.defaultSha);
      expect(fs.existsSync(path.join(ctx.mount, 'organization-management'))).toBe(false);
      // Drift is reported, never "restored" and never committed.
      expect(verify.warnings.join(' ')).toMatch(/pre-existing gitlink drift/);
      expect(sh('git ls-files -s vendor/plugin', ctx.consumer)).toContain('160000 ' + ctx.featureSha);
    } finally {
      removeDir(ctx.root);
    }
  });

  it('refuses to share one consumer mount with a concurrent run', () => {
    const ctx = topologyWithDefault();
    let holder: ReturnType<typeof spawn> | null = null;
    try {
      fs.mkdirSync(path.join(ctx.plugin, '.ai-agent'), { recursive: true });

      const first = runJson(guard, { MODE: 'snapshot', WT: ctx.plugin, REPO: ctx.plugin, RUN_ID: 'run-a' }, ctx.plugin);
      const lockFile = first.locks[0];
      expect(fs.existsSync(lockFile)).toBe(true);

      // A live holder: another ProcessAITicket run against the same mount. Its pid
      // must be alive for the lock to be honoured, so it runs in the background.
      const holderScript =
        'const fs=require("fs");' +
        'fs.writeFileSync(' + JSON.stringify(lockFile) + ', JSON.stringify({ pid: process.pid, runId: "run-b", at: new Date().toISOString() }));' +
        'setTimeout(function(){}, 20000);';
      holder = spawn(process.execPath, ['-e', holderScript], { cwd: ctx.root, stdio: 'ignore' });

      const lockPid = (): number => {
        try { return Number(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid); } catch (e) { return 0; }
      };
      for (let i = 0; i < 100 && lockPid() !== holder.pid; i += 1) sh('sleep 0.05', ctx.root);

      const second = runJson(guard, { MODE: 'snapshot', WT: ctx.plugin, REPO: ctx.plugin, RUN_ID: 'run-c' }, ctx.plugin);

      expect(second.baselineReady).toBe(false);
      expect(second.violations.join(' ')).toMatch(/held by another ProcessAITicket run/);
    } finally {
      if (holder) holder.kill();
      removeDir(ctx.root);
    }
  });
});
