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

/** Extract a `const NAME = (…) => { … };` declaration verbatim, brace-balanced. */
const declOf = (script: string, name: string): string => {
  const start = script.indexOf('const ' + name + ' =');
  if (start === -1) throw new Error(`declaration ${name} not found`);
  let depth = 0;
  for (let i = start; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    if (script[i] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(start, script.indexOf(';', i) + 1);
    }
  }
  throw new Error(`unterminated declaration ${name}`);
};

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

const initRepo = (dir: string, baseBranch: string = 'master'): void => {
  sh('git init -q -b ' + baseBranch + ' .', dir);
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

/** The PR body is built by `createPullRequest`; these helpers drive that script
 *  against a throwaway repository with a fake `gh` on PATH. */
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
    scriptOf('createPullRequest'),
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

describe('ProcessAITicket PR template merge', () => {
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
      expect(body).toContain('Generated by core.ProcessAITicket@1.4.6');
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
      expect(body).toContain('Generated by core.ProcessAITicket@1.4.6');
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

/**
 * The reviewer emits structured findings ({id, severity, title, detail}), but the
 * fixtures above use string arrays only — which is why the object shape was never
 * exercised. `String(item)` on an object yields '[object Object]', and that single
 * flaw caused two failures at once:
 *
 *  - captureReview pushed the RENDERED string, so the finding was written to
 *    review-normalised.json as the literal '[object Object]'. The content was
 *    destroyed, not merely mis-rendered.
 *  - every object hashed to that same dedupe key, so N findings collapsed to 1.
 *    That is why the hand-back heading read (1) when several were reported.
 *
 * And because the collapsed placeholder still counted as one actionable finding,
 * findingsResolved stayed true: the guard that exists to stop an engineer revising
 * blind was defeated by the corruption it should have caught.
 */
describe('ProcessAITicket reviewer findings are rendered losslessly', () => {
  const capture = scriptOf('captureReview');
  const briefing = scriptOf('handBackBriefing');

  const FINDINGS: Array<Record<string, any>> = [
    { id: 'F1', severity: 'high', title: 'Stale scope after org switch', detail: 'scopeRef.current is never reset.' },
    { id: 'F2', severity: 'medium', title: 'Missing regression test', detail: 'no test covers the refetch.' },
    { id: 'F3', severity: 'low', title: 'Typo in the docs', detail: 'teh should be the.' },
  ];

  const normalisedFile = (dir: string): string => path.join(dir, '.ai-agent', 'review-normalised.json');
  const readNormalised = (dir: string): any => JSON.parse(fs.readFileSync(normalisedFile(dir), 'utf8'));

  /** Captures review.json, then builds the brief the engineer is handed. */
  const review = (dir: string, payload: any): { result: any; text: string } => {
    writeReview(dir, payload);
    const result = runJson(capture, { WT: dir }, dir);
    return { result, text: runScript(briefing, { WT: dir }, dir) };
  };

  it('renders object-shaped findings and acceptance criteria as readable text', () => {
    const dir = repoWithWork();
    try {
      const { text } = review(dir, {
        verdict: 'rejected',
        summary: 'Needs work',
        findings: [FINDINGS[0]],
        acceptance_criteria: [{ criterion: 'switching organization refetches', status: 'fail', evidence: 'manual check' }],
      });

      expect(text).not.toContain('[object Object]');
      expect(text).toContain('Stale scope after org switch');
      expect(text).toContain('scopeRef.current is never reset.');
      // Acceptance criteria have a different shape; key/value lines keep every field.
      expect(text).toContain('criterion: switching organization refetches');
      expect(text).toContain('status: fail');
      expect(text).toContain('evidence: manual check');
    } finally {
      removeDir(dir);
    }
  });

  it('keeps three distinct object findings distinct (the anti-collapse assertion)', () => {
    const dir = repoWithWork();
    try {
      const { result, text } = review(dir, { verdict: 'rejected', findings: FINDINGS });

      // A fix that renders objects but still dedupes on them passes every other
      // test in this block and still loses findings. This is the assertion that
      // catches it.
      expect(result.findings).toHaveLength(3);
      expect(text).toContain('## Findings observed by the reviewer (3)');
      FINDINGS.forEach((finding) => {
        expect(text).toContain(String(finding.title));
        expect(text).toContain(String(finding.detail));
      });
      expect(text).not.toContain('[object Object]');
    } finally {
      removeDir(dir);
    }
  });

  it('still collapses two identical object findings to one item', () => {
    const dir = repoWithWork();
    try {
      const { result, text } = review(dir, { verdict: 'rejected', findings: [FINDINGS[0], { ...FINDINGS[0] }] });

      expect(result.findings).toHaveLength(1);
      expect(text).toContain('## Findings observed by the reviewer (1)');
    } finally {
      removeDir(dir);
    }
  });

  it('renders a single finding object that was not wrapped in an array as one item', () => {
    const dir = repoWithWork();
    try {
      const { result, text } = review(dir, {
        verdict: 'rejected',
        findings: FINDINGS[1],
        acceptance_criteria: { criterion: 'only one criterion', status: 'pass' },
      });

      expect(result.findings).toHaveLength(1);
      expect(text).toContain('## Findings observed by the reviewer (1)');
      expect(text).toContain('Missing regression test');
      expect(text).toContain('criterion: only one criterion');
    } finally {
      removeDir(dir);
    }
  });

  it('renders every element of a mixed string/object array', () => {
    const dir = repoWithWork();
    try {
      const { result, text } = review(dir, {
        verdict: 'rejected',
        findings: ['plain string finding', FINDINGS[2], 42, true, null],
      });

      // null is filtered; nothing else is dropped or collapsed.
      expect(result.findings).toHaveLength(4);
      expect(text).toContain('## Findings observed by the reviewer (4)');
      expect(text).toContain('plain string finding');
      expect(text).toContain('Typo in the docs');
      expect(text).toContain('42');
      expect(text).toContain('true');
    } finally {
      removeDir(dir);
    }
  });

  it('keeps the structured finding intact in the written review-normalised.json', () => {
    const dir = repoWithWork();
    try {
      review(dir, {
        verdict: 'rejected',
        findings: FINDINGS,
        acceptance_criteria: [{ criterion: 'c', status: 'fail', evidence: 'e' }],
      });

      // Assert on the FILE, not the brief: the defect was that the brief could be
      // fixed while the stored record stayed corrupt, or vice versa.
      const record = readNormalised(dir);
      expect(record.findings).toEqual(FINDINGS);
      expect(record.acceptanceCriteria).toEqual([{ criterion: 'c', status: 'fail', evidence: 'e' }]);
      expect(JSON.stringify(record)).not.toContain('[object Object]');
    } finally {
      removeDir(dir);
    }
  });

  it('blocks for a human when every resolved finding is unrenderable', () => {
    const dir = repoWithWork();
    try {
      const { result, text } = review(dir, { verdict: 'rejected', findings: [{}, {}], required_changes: [], blocking_findings: [] });

      // The old code counted '[object Object]' as one actionable finding and let
      // the run continue. An entry that carries no renderable content is not
      // something an engineer can act on.
      expect(result.findingsResolved).toBe(false);
      expect(String(result.blockedReason)).toContain('no findings could be resolved');
      expect(text).toContain('No actionable findings could be resolved');
    } finally {
      removeDir(dir);
    }
  });

  it('never coerces a list item with String() in the review path', () => {
    // The class guard: `String(item)` is the defect, and it must not come back.
    expect(capture).not.toMatch(/String\(\s*item\s*\)/);
    expect(briefing).not.toMatch(/String\(\s*item\s*\)/);
    expect(capture).not.toContain('const asArray');
  });

  it('shares one rendering implementation rather than a third variant', () => {
    const marker = /\/\/ >>> shared findings rendering[\s\S]*?\/\/ <<< shared findings rendering/;
    const blockOf = (script: string): string => {
      const hit = script.match(marker);
      if (!hit) throw new Error('shared findings rendering block not found');
      return hit[0];
    };

    const shared = blockOf(capture);
    expect(blockOf(briefing)).toBe(shared);
    // The PR body generator is the third consumer: it must reuse the proven renderer,
    // not grow a variant of its own (that is how six defects accumulated here).
    expect(blockOf(scriptOf('createPullRequest'))).toBe(shared);

    // asText/asList are captureReport's canonical pair, copied in verbatim rather
    // than reimplemented. captureReport itself is untouched.
    const report = scriptOf('captureReport');
    expect(shared).toContain(declOf(report, 'asText'));
    expect(shared).toContain(declOf(report, 'asList'));
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

/**
 * REACTORY-302016408 - the exit condition of the review loop.
 *
 * The defect had two halves and both are executed here against real fixture
 * worktrees, because neither is a shape problem:
 *
 *  1. The loop stops at the cycle bound. On the last permitted cycle the engineer
 *     revises, but no further review runs, so `variables.reviewVerdict` still holds
 *     the rejection from BEFORE the fix and the publish gate never opens. Three
 *     consecutive runs (W6, T3, W8) finished "green" with the work stranded on a
 *     local branch and no pull request.
 *  2. A run whose review artefacts were missing reported `rejected`, which is a
 *     quality judgement it never made.
 */
describe('ProcessAITicket exit condition after the last permitted review (REACTORY-302016408)', () => {
  const assess = scriptOf('assessConfirmationNeed');
  const capture = scriptOf('captureReview');
  const readVerdict = scriptOf('readVerdict');
  const publishable = scriptOf('readPublishable');
  const bumpCycle = scriptOf('bumpCycle');

  /** Age a run artefact so the mtime comparison is deterministic, not timing luck. */
  const age = (dir: string, file: string, secondsAgo: number): void => {
    const target = path.join(dir, '.ai-agent', file);
    const stamp = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(target, stamp, stamp);
  };

  const writeRunStatus = (dir: string, status: string): void => {
    fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.ai-agent', 'run-status.json'), JSON.stringify({ status }), 'utf8');
  };

  const decisionOf = (dir: string): any =>
    JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'publish-decision.json'), 'utf8'));

  const rejectedWithBlockingFinding = {
    verdict: 'rejected',
    summary: 'One blocking problem',
    requiredChanges: ['Guard the null case'],
    findings: [{ id: 'F1', severity: 'high', title: 'null deref', blocking: true }],
  };

  it('re-reviews after a revision that landed on the last permitted cycle', () => {
    const dir = repoWithWork();
    try {
      // Cycle N: the engineer's work is reviewed and rejected.
      writeReport(dir, { status: 'completed', summary: 'first attempt', changes: [{ file: 'a.ts', description: 'd' }] });
      writeReview(dir, rejectedWithBlockingFinding);
      age(dir, 'report.json', 60);

      expect(runJson(capture, { WT: dir }, dir).verdict).toBe('rejected');
      expect(runScript(readVerdict, { WT: dir }, dir)).toBe('rejected');
      // Nothing to confirm yet: the engineer has not revised since that review.
      expect(runScript(assess, { WT: dir }, dir)).toBe('skip');
      // This is the old dead end: a rejection cannot publish.
      expect(runScript(publishable, { WT: dir }, dir)).toBe('false');

      // Cycle N (final): the engineer revises AFTER the review, and the bound is spent,
      // so the loop cannot review again. This is the exact state W6/T3/W8 ended in.
      writeReport(dir, { status: 'completed', summary: 'fixed the blocking finding', changes: [{ file: 'a.ts', description: 'd' }] });
      expect(runScript(assess, { WT: dir }, dir)).toBe('run');

      // The confirmation review now runs and its verdict is authoritative.
      writeReview(dir, { verdict: 'approved', summary: 'the fix addresses F1', findings: [] });
      expect(runJson(capture, { WT: dir }, dir).verdict).toBe('approved');
      expect(runScript(readVerdict, { WT: dir }, dir)).toBe('approved');

      // The work is publishable, which is what the old workflow refused to do.
      expect(runScript(publishable, { WT: dir }, dir)).toBe('true');
      expect(decisionOf(dir).outcome).toBe('approved');
    } finally {
      removeDir(dir);
    }
  });

  it('publishes a rejection whose only findings are explicitly non-blocking (W8)', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, { status: 'completed', summary: 'work', changes: [{ file: 'a.ts', description: 'd' }] });
      // W8 verbatim: RC-6, severity low, blocking false, and the engineer fixed it
      // six minutes after the review. Nothing here should strand the work.
      writeReview(dir, {
        verdict: 'rejected',
        summary: 'One low-severity nit',
        findings: [{ id: 'RC-6', severity: 'low', title: 'webhook error-code string mismatch', blocking: false }],
      });

      expect(runJson(capture, { WT: dir }, dir).verdict).toBe('rejected');
      expect(runScript(readVerdict, { WT: dir }, dir)).toBe('rejected');
      expect(runScript(publishable, { WT: dir }, dir)).toBe('true');

      const decision = decisionOf(dir);
      expect(decision.outcome).toBe('rejected_non_blocking');
      expect(decision.blocking).toBe(0);
      expect(decision.nonBlocking).toBe(1);
    } finally {
      removeDir(dir);
    }
  });

  it('fails closed when the blocking flag is absent, unparseable or contradicted', () => {
    const CASES: Array<{ review: any; why: string }> = [
      { review: { verdict: 'rejected', findings: [{ id: 'F1', severity: 'low', title: 'no flag at all' }] }, why: 'an absent blocking flag is not proof of non-blocking' },
      { review: { verdict: 'rejected', findings: [{ id: 'F1', title: 'garbled flag', blocking: 'maybe' }] }, why: 'an unparseable blocking flag is not proof of non-blocking' },
      { review: { verdict: 'rejected', findings: [{ id: 'F1', title: 'plain string' }] }, why: 'a string finding carries no flag' },
      { review: { verdict: 'rejected', findings: [{ id: 'F1', title: 'real blocker', blocking: true }] }, why: 'a blocking finding blocks' },
      { review: { verdict: 'rejected', requiredChanges: ['do the work'], findings: [{ id: 'F1', title: 'nit', blocking: false }] }, why: 'requiredChanges are blocking by definition' },
      { review: { verdict: 'rejected', blockingFindings: ['role gating missing'], findings: [{ id: 'F1', title: 'nit', blocking: false }] }, why: 'an explicit blockingFindings entry blocks' },
      { review: { verdict: 'rejected', summary: 'nothing actionable', findings: [] }, why: 'a rejection with no findings cannot be published' },
    ];

    CASES.forEach((testCase) => {
      const dir = repoWithWork();
      try {
        writeReport(dir, { status: 'completed', summary: 'work', changes: [{ file: 'a.ts', description: 'd' }] });
        writeReview(dir, testCase.review);
        runJson(capture, { WT: dir }, dir);
        expect(runScript(publishable, { WT: dir }, dir)).toBe('false');
        expect(decisionOf(dir).publishable).toBe(false);
      } finally {
        removeDir(dir);
      }
    });
  });

  it('never runs a confirmation review when the engineer has not revised since the last review', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, { status: 'completed', summary: 'work', changes: [{ file: 'a.ts', description: 'd' }] });
      writeReview(dir, rejectedWithBlockingFinding);
      // Report is OLDER than the review: the review is the last thing that happened.
      age(dir, 'report.json', 120);
      expect(runScript(assess, { WT: dir }, dir)).toBe('skip');
    } finally {
      removeDir(dir);
    }
  });

  it('never runs a confirmation review when the last revision did not complete', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, { status: 'completed', summary: 'work', changes: [{ file: 'a.ts', description: 'd' }] });
      writeReview(dir, rejectedWithBlockingFinding);
      age(dir, 'report.json', 120);
      // The revision attempt failed: publishing it would publish a broken report.
      writeReport(dir, { status: 'blocked', summary: 'could not finish' });
      writeRunStatus(dir, 'blocked');
      expect(runScript(assess, { WT: dir }, dir)).toBe('skip');
    } finally {
      removeDir(dir);
    }
  });

  it('reports missing review artefacts as review_unavailable, not as a rejection', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, { status: 'completed', summary: 'work', changes: [{ file: 'a.ts', description: 'd' }] });
      // T3 verbatim: report.json exists, no review.json and no review-normalised.json.
      const captured = runJson(capture, { WT: dir }, dir);

      expect(captured.verdict).toBe('review_unavailable');
      expect(captured.reviewAvailable).toBe(false);
      expect(captured.verdictSource).toBe('capture_failed');

      // The distinct outcome survives the verdict reader.
      expect(runScript(readVerdict, { WT: dir }, dir)).toBe('review_unavailable');

      // It must not be published, and the recorded outcome must say why.
      expect(runScript(publishable, { WT: dir }, dir)).toBe('false');
      expect(decisionOf(dir).outcome).toBe('review_unavailable');

      // It must not be confirmed either: there is nothing to confirm.
      expect(runScript(assess, { WT: dir }, dir)).toBe('skip');
    } finally {
      removeDir(dir);
    }
  });

  it('does not consume a review cycle when the work could not be reviewed', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, { status: 'completed', summary: 'work', changes: [{ file: 'a.ts', description: 'd' }] });
      runJson(capture, { WT: dir }, dir);

      // A capture failure is a pipeline fault, not a review: the budget is untouched.
      expect(runScript(bumpCycle, { CYCLE: '2', VERDICT: 'review_unavailable' }, dir)).toBe('2');
      // A real verdict still consumes one.
      expect(runScript(bumpCycle, { CYCLE: '2', VERDICT: 'rejected' }, dir)).toBe('3');
      expect(runScript(bumpCycle, { CYCLE: '2', VERDICT: 'approved' }, dir)).toBe('3');
    } finally {
      removeDir(dir);
    }
  });

  it('treats an unparseable review.json as review_unavailable rather than rejected', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, { status: 'completed', summary: 'work', changes: [{ file: 'a.ts', description: 'd' }] });
      fs.writeFileSync(path.join(dir, '.ai-agent', 'review.json'), '{ this is not json', 'utf8');
      expect(runJson(capture, { WT: dir }, dir).verdict).toBe('review_unavailable');
      expect(runScript(readVerdict, { WT: dir }, dir)).toBe('review_unavailable');
    } finally {
      removeDir(dir);
    }
  });

  it('tells the ticket WHY a run did not publish, distinguishing rejection from no review', () => {
    const narrative = scriptOf('readReviewOutcomeNarrative');

    const rejectedDir = repoWithWork();
    try {
      writeReport(rejectedDir, { status: 'completed', summary: 'work', changes: [{ file: 'a.ts', description: 'd' }] });
      writeReview(rejectedDir, rejectedWithBlockingFinding);
      runJson(capture, { WT: rejectedDir }, rejectedDir);
      runScript(publishable, { WT: rejectedDir }, rejectedDir);
      const text = runScript(narrative, { WT: rejectedDir, HALT: 'false', CYCLES: '3' }, rejectedDir);
      expect(text).toContain('REJECTED');
      expect(text).toContain('3 review cycle(s)');
      expect(text).not.toContain('COULD NOT BE REVIEWED');
    } finally {
      removeDir(rejectedDir);
    }

    const unavailableDir = repoWithWork();
    try {
      writeReport(unavailableDir, { status: 'completed', summary: 'work', changes: [{ file: 'a.ts', description: 'd' }] });
      runJson(capture, { WT: unavailableDir }, unavailableDir);
      runScript(publishable, { WT: unavailableDir }, unavailableDir);
      const text = runScript(narrative, { WT: unavailableDir, HALT: 'true', CYCLES: '1' }, unavailableDir);
      expect(text).toContain('COULD NOT BE REVIEWED');
      expect(text).toContain('operational fault');
      expect(text).not.toContain('REJECTED the work');
    } finally {
      removeDir(unavailableDir);
    }
  });
});
/**
 * REACTORY-302016408 review findings RC-2 / RC-3 / RC-4.
 *
 * These execute the scripts, because all three are runtime behaviours:
 *  - an engineer that pushes before the review must be REPORTED, not adopted;
 *  - the reviewer must see committed work (the evidence used to diff against HEAD);
 *  - a code change without a rewritten report must still trigger the confirmation pass.
 */
describe('ProcessAITicket review-time guards (RC-2, RC-3, RC-4)', () => {
  /** Age a run artefact so the mtime comparison is deterministic, not timing luck. */
  const age = (dir: string, file: string, secondsAgo: number): void => {
    const target = path.join(dir, '.ai-agent', file);
    const stamp = new Date(Date.now() - secondsAgo * 1000);
    fs.utimesSync(target, stamp, stamp);
  };

  /** A repo with a bare `origin` and master pushed, so remote refs are real. */
  const repoWithRemote = (): { dir: string; origin: string } => {
    const origin = tempDir('pa-origin-');
    sh('git init -q --bare -b master .', origin);
    const dir = tempDir('pa-work-');
    initRepo(dir);
    sh('git remote add origin "' + origin + '"', dir);
    sh('git push -q -u origin master', dir);
    sh('git checkout -q -b feature/test', dir);
    fs.mkdirSync(path.join(dir, 'src', 'modules', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'modules', 'fixture', 'index.ts'), 'export const value = 2;\n', 'utf8');
    fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
    sh('git add -A && git commit -qm "AI engineering run: REF-1"', dir);
    return { dir: dir, origin: origin };
  };

  it('detects a branch that already exists on origin and names the open pull request', () => {
    const detect = scriptOf('detectPrematurePublish');
    const summary = scriptOf('readPrematurePublishSummary');
    const verdict = scriptOf('readPrematurePublish');

    const clean = repoWithRemote();
    try {
      // Not pushed yet: the normal state at review time.
      const before = runJson(detect, { WT: clean.dir, BRANCH: 'feature/test' }, clean.dir);
      expect(before.remoteBranchExists).toBe(false);
      expect(before.checked).toBe(true);
      expect(runScript(verdict, { PRE: JSON.stringify(before) }, clean.dir)).toBe('no');
      expect(runScript(summary, { PRE: JSON.stringify(before) }, clean.dir)).toContain('publication has not happened yet');

      // The engineer pushes its own branch before review - this is RC-2.
      sh('git push -q -u origin feature/test', clean.dir);
      const after = runJson(detect, { WT: clean.dir, BRANCH: 'feature/test' }, clean.dir);
      expect(after.remoteBranchExists).toBe(true);
      expect(after.remoteSha).toMatch(/^[0-9a-f]{40}$/);
      expect(runScript(verdict, { PRE: JSON.stringify(after) }, clean.dir)).toBe('yes');

      const text = runScript(summary, { PRE: JSON.stringify(after) }, clean.dir);
      expect(text).toContain('ALREADY EXISTS on origin');
      expect(text).toContain('BEFORE the review ran');
      expect(text).toContain('UNREVIEWED');
    } finally {
      removeDir(clean.dir);
      removeDir(clean.origin);
    }
  });

  it('reports an unknown branch as unchecked rather than as clean', () => {
    const detect = scriptOf('detectPrematurePublish');
    const summary = scriptOf('readPrematurePublishSummary');
    const dir = repoWithWork();
    try {
      const state = runJson(detect, { WT: dir, BRANCH: '' }, dir);
      expect(state.checked).toBe(false);
      expect(state.warnings.length).toBeGreaterThan(0);
      expect(runScript(summary, { PRE: JSON.stringify(state) }, dir)).toContain('did not run');
    } finally {
      removeDir(dir);
    }
  });

  it('shows committed work to the reviewer instead of "no changes detected"', () => {
    const diffstat = scriptOf('diffstat');
    const dir = repoWithWork();
    try {
      // Everything is committed, which is exactly the state that used to report nothing.
      expect(sh('git status --porcelain -- . ":(exclude).ai-agent"', dir)).toBe('');

      const out = runScript(diffstat, { WT: dir }, dir);
      expect(out).toContain('Committed work against');
      expect(out).toContain('src/modules/fixture/index.ts');
      expect(out).not.toContain('no changes detected');
      expect(out).toContain('Uncommitted worktree changes: none');

      // An uncommitted revision is listed separately, because that is where a
      // hand-back lands until the pipeline commits it.
      fs.writeFileSync(path.join(dir, 'src', 'modules', 'fixture', 'index.ts'), 'export const value = 3;\n', 'utf8');
      const dirty = runScript(diffstat, { WT: dir }, dir);
      expect(dirty).toContain('Uncommitted worktree changes');
      expect(dirty).toContain('src/modules/fixture/index.ts');
    } finally {
      removeDir(dir);
    }
  });

  it('treats a changed file newer than the review as a revision even without a new report', () => {
    const assess = scriptOf('assessConfirmationNeed');
    const dir = repoWithWork();
    try {
      writeReport(dir, { status: 'completed', summary: 'first attempt', changes: [{ file: 'a.ts', description: 'd' }] });
      writeReview(dir, { verdict: 'rejected', findings: [{ id: 'F1', title: 'blocking', blocking: true }] });
      // The report is older than the review and nothing is dirty: no revision.
      age(dir, 'report.json', 120);
      expect(runScript(assess, { WT: dir }, dir)).toBe('skip');

      // The engineer changes a FILE but never rewrites the report. mtime-alone would
      // miss this and leave the pre-fix rejection as the authoritative verdict.
      fs.writeFileSync(path.join(dir, 'src', 'modules', 'fixture', 'index.ts'), 'export const value = 4;\n', 'utf8');
      expect(runScript(assess, { WT: dir }, dir)).toBe('run');
    } finally {
      removeDir(dir);
    }
  });
});

/**
 * Six defects in the PR body generator accumulated because the body builder is
 * inline JS inside a YAML `cli_command` and no test ever executed it. Every test
 * here runs the real script against a throwaway repository, the way
 * `ProcessAITicket reviewer findings are rendered losslessly` does.
 *
 * The root cause was one asymmetry: `changes` and `tests` handled strings and
 * objects, `risks`, `followUps`, `verification`, `implementation` and
 * `acceptanceCriteria` were cast with `String()`, which turns every object into
 * "[object Object]" — or, for `text()`, into nothing at all.
 */
describe('ProcessAITicket PR body renders the engineer report losslessly', () => {
  const prScript = scriptOf('createPullRequest');

  /** The seven distinct risk shapes found across 30 archived reports, plus a string. */
  const RISK_SHAPES: any[] = [
    'Plain string risk about the provider contract',
    { id: 'R1', impact: 'high', mitigation: 'guarded by a flag', risk: 'Provider contract drift' },
    { detail: 'retry loop could spin on a 429', id: 'R2', risk: 'Retry storm' },
    { risk: 'SMS cost overrun', why: 'no budget alarm' },
    { detail: 'env var default differs in staging', risk: 'Wiring mismatch' },
    { impact: 'medium', mitigation: 'feature flag', risk: 'Shared rate limit' },
    { dependency: 'twilio', id: 'R3', risk: 'Vendor outage', why: 'no fallback provider' },
    { detail: 'the seam is optional today', id: 'R4', resolves_with: 'ticket 2311', risk: 'Partial receipts' },
  ];

  const sectionOf = (body: string, heading: string): string => {
    const lines = body.split('\n');
    const start = lines.findIndex((line) => line.trim() === heading);
    if (start === -1) return '';
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith('## ') || line.startsWith('### ')) break;
      out.push(line);
    }
    return out.join('\n');
  };

  const bulletsOf = (section: string): string[] => section.split('\n').filter((line) => line.startsWith('- '));

  it('renders all seven observed risk shapes without dropping or collapsing any', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, { status: 'completed', summary: 'Did the work.', risks: RISK_SHAPES });

      const { body } = runCreate(dir);
      const risks = sectionOf(body, '### Risks');

      expect(body).not.toContain('[object Object]');
      expect(risks).not.toBe('');
      // Anti-collapse: eight distinct entries must stay eight bullets. The old code
      // produced one identical "[object Object]" bullet for all seven objects.
      expect(bulletsOf(risks)).toHaveLength(RISK_SHAPES.length);
      // Every headline survives...
      [
        'Plain string risk about the provider contract',
        'Provider contract drift',
        'Retry storm',
        'SMS cost overrun',
        'Wiring mismatch',
        'Shared rate limit',
        'Vendor outage',
        'Partial receipts',
      ].forEach((headline) => expect(risks).toContain(headline));
      // ...and so does every detail key the shapes carry.
      [
        'guarded by a flag',
        'retry loop could spin on a 429',
        'no budget alarm',
        'env var default differs in staging',
        'twilio',
        'no fallback provider',
        'ticket 2311',
        'the seam is optional today',
      ].forEach((detail) => expect(risks).toContain(detail));
    } finally {
      removeDir(dir);
    }
  });

  it('emits a Follow-ups section, including object-shaped follow-ups', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        followUps: ['Backfill is deliberately out of scope', { item: 'Bulk replay tooling', reason: 'not needed yet' }],
      });

      const { body } = runCreate(dir);
      const followUps = sectionOf(body, '### Follow-ups');

      expect(followUps).not.toBe('');
      expect(bulletsOf(followUps)).toHaveLength(2);
      expect(followUps).toContain('Backfill is deliberately out of scope');
      expect(followUps).toContain('Bulk replay tooling');
      expect(followUps).toContain('not needed yet');
      expect(body).not.toContain('[object Object]');
    } finally {
      removeDir(dir);
    }
  });

  it('emits Verification when verification is a nested object and there is no testsRun', () => {
    const dir = repoWithWork();
    try {
      // The W9b shape: no `testsRun` key at all, evidence only under `verification`.
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        verification: {
          baseline: { command: 'npx jest pipeline', result: 'failed: 3 tests', note: 'pre-change' },
          delta: { command: 'npx jest pipeline', result: 'passed: 16 tests' },
        },
      });

      const { body } = runCreate(dir);
      const verification = sectionOf(body, '### Verification');

      expect(verification).not.toBe('');
      expect(verification).toContain('baseline');
      expect(verification).toContain('delta');
      expect(verification).toContain('npx jest pipeline');
      expect(verification).toContain('failed: 3 tests');
      expect(verification).toContain('pre-change');
      expect(verification).toContain('passed: 16 tests');
      // The section must sit below Changes, i.e. the body does not jump straight to Risks.
      expect(body.indexOf('### Verification')).toBeGreaterThan(body.indexOf('### Changes'));
    } finally {
      removeDir(dir);
    }
  });

  it('renders Acceptance criteria for the object-map shape, with unmet visible', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        acceptanceCriteria: {
          partAExistsAndFailsWithoutSubject: 'Met. 3 tests added; two independent revert-and-observe experiments',
          partACoversThreeCases: 'Met. delivered-on-real-persisted-id, replay is a no-op',
          partBRegisteredAndResolved: { status: 'fail', evidence: 'no replay test yet' },
        },
      });

      const { body } = runCreate(dir);
      const criteria = sectionOf(body, '### Acceptance criteria');

      expect(criteria).not.toBe('');
      expect(criteria).toContain('partAExistsAndFailsWithoutSubject');
      expect(criteria).toContain('Met');
      expect(criteria).toContain('3 tests added; two independent revert-and-observe experiments');
      // The unmet criterion is the one a reviewer must see; it must not be omitted.
      expect(criteria).toContain('partBRegisteredAndResolved');
      expect(criteria).toContain('Unmet');
      expect(criteria).toContain('no replay test yet');
      expect(body).not.toContain('[object Object]');
    } finally {
      removeDir(dir);
    }
  });

  it('renders Acceptance criteria for the array shape', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        acceptanceCriteria: [
          { criterion: 'switching organization refetches', status: 'pass', evidence: 'manual check' },
          { criterion: 'stale scope is cleared', status: 'unmet' },
        ],
      });

      const { body } = runCreate(dir);
      const criteria = sectionOf(body, '### Acceptance criteria');

      expect(criteria).toContain('switching organization refetches');
      expect(criteria).toContain('manual check');
      expect(criteria).toContain('stale scope is cleared');
      expect(criteria).toContain('Unmet');
      expect(body).not.toContain('[object Object]');
    } finally {
      removeDir(dir);
    }
  });

  it('renders one report carrying every problem shape in a single body', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        risks: RISK_SHAPES,
        followUps: [{ item: 'Bulk replay tooling', reason: 'not needed yet' }],
        implementation: { approach: 'seam injected at the provider boundary', notes: ['no schema change'] },
        verification: { baseline: { command: 'npx jest', result: 'failed' }, delta: { command: 'npx jest', result: 'passed' } },
        acceptanceCriteria: { existsAndFailsWithoutSubject: 'Met. two revert-and-observe runs' },
      });

      const { body, result } = runCreate(dir);

      expect(body).not.toContain('[object Object]');
      expect(sectionOf(body, '### Risks')).not.toBe('');
      expect(sectionOf(body, '### Follow-ups')).not.toBe('');
      expect(sectionOf(body, '### Verification')).not.toBe('');
      expect(sectionOf(body, '### Acceptance criteria')).not.toBe('');
      // The scrubbing guard is a last resort: it must not have fired for this report.
      expect(result.warnings.join(' ')).not.toContain('[object Object]');
      expect(result.warnings.join(' ')).not.toContain('could not be rendered');
    } finally {
      removeDir(dir);
    }
  });

  it('renders an object-shaped implementation in the change list', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        implementation: { approach: 'seam injected at the provider boundary', files: ['services/index.ts'] },
      });

      const { body } = runCreate(dir);
      const changes = sectionOf(body, '### Changes');

      expect(changes).toContain('seam injected at the provider boundary');
      expect(body).not.toContain('[object Object]');
    } finally {
      removeDir(dir);
    }
  });

  it('never lists the previous commit when the branch has no commits of its own', () => {
    const dir = tempDir('pa-nocommit-');
    try {
      initRepo(dir);
      // A commit belonging to unrelated work: the old HEAD~1 fallback listed this file
      // for a branch that had no commits of its own (PR #12, 15 of 16 files wrong).
      fs.writeFileSync(path.join(dir, 'previous-work.ts'), 'export const previous = true;\n', 'utf8');
      sh('git add -A && git commit -qm "previous merge"', dir);
      sh('git checkout -q -b feature/test', dir);
      writeReport(dir, { status: 'completed', summary: 'Did the work.' });

      const { body } = runCreate(dir);
      const changes = sectionOf(body, '### Changes');

      expect(body).not.toContain('previous-work.ts');
      expect(changes).toContain('No commits exist on');
      // The fallback must not exist in the generator at all.
      expect(prScript).not.toContain('HEAD~1..HEAD');
    } finally {
      removeDir(dir);
    }
  });

  it('still renders a plain string-only report exactly as before', () => {
    const dir = repoWithWork();
    try {
      // The shape nine of the twelve archived reports used; the fix must not regress it.
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        changes: [{ file: 'services/index.ts', description: 'exported the receipt seam' }],
        testsRun: [
          { command: 'npx jest services', result: 'passed' },
          'yarn lint',
        ],
        verification: 'Confirmed against the staging provider sandbox.',
        risks: ['Provider contract may drift again'],
      });

      const { body } = runCreate(dir);

      expect(sectionOf(body, '### Changes')).toContain('`services/index.ts` exported the receipt seam');
      const verification = sectionOf(body, '### Verification');
      expect(verification).toContain('`npx jest services` -> passed');
      expect(verification).toContain('`yarn lint` -> not recorded');
      expect(verification).toContain('Confirmed against the staging provider sandbox.');
      expect(sectionOf(body, '### Risks')).toContain('- Provider contract may drift again');
      expect(body).not.toContain('[object Object]');
      // Sections the report did not supply are not invented.
      expect(body).not.toContain('### Follow-ups');
      expect(body).not.toContain('### Acceptance criteria');
    } finally {
      removeDir(dir);
    }
  });

  it('appends follow-ups and acceptance criteria to a rendered template, keeping its headings', () => {
    const dir = repoWithWork();
    try {
      fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.github', 'pull_request_template.md'),
        ['## Summary', '', '- **Reviewer focus:**', '', '## How was this tested?', '', '**Result:**', ''].join('\n'),
        'utf8',
      );
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        followUps: ['Backfill is out of scope'],
        verification: { baseline: { command: 'npx jest pipeline', result: 'failed' }, delta: { command: 'npx jest pipeline', result: 'passed' } },
        acceptanceCriteria: { onlyCriterion: 'Met. proved by a revert-and-observe test' },
      });

      const { result, body } = runCreate(dir);

      expect(result.templateUsed).toBe(true);
      // The template contract survives: its own level-2 headings are untouched.
      expect(body).toContain('## Summary');
      expect(body).toContain('## How was this tested?');
      // The sections a template has no heading for are appended, not dropped.
      expect(body).toContain('### Follow-ups');
      expect(body).toContain('### Acceptance criteria');
      expect(body).toContain('onlyCriterion');
      expect(body).toContain('proved by a revert-and-observe test');
      // The object-shaped verification reaches "How was this tested?".
      expect(body).toContain('npx jest pipeline');
      expect(body).not.toContain('[object Object]');
    } finally {
      removeDir(dir);
    }
  });

  it('renders prose that mentions [object Object] verbatim and invents no failure', () => {
    const dir = repoWithWork();
    try {
      // A report ABOUT this class of defect necessarily quotes the placeholder. Rewriting
      // it is not a cosmetic problem: the previous body-wide scrub corrupted six legitimate
      // strings in one archived report and raised a warning that was simply false.
      writeReport(dir, {
        status: 'completed',
        summary: 'Fixed the [object Object] corruption in the PR body generator.',
        changes: [{ file: 'workflow/ProcessAITicket.yaml', description: 'removed the [object Object] scrub' }],
        risks: [{ risk: 'prose mentioning [object Object] must survive', detail: 'the scrub rewrote it' }],
        verification: { baseline: { command: 'npx jest', result: 'passed', note: 'no [object Object] left' } },
        acceptanceCriteria: { literalPlaceholderIsProse: 'Met. a body may contain the words [object Object]' },
      });

      const { body, result } = runCreate(dir);

      // Verbatim, in every field that carried it: summary, change description, risk,
      // verification note and acceptance criterion.
      expect(body).toContain('Fixed the [object Object] corruption in the PR body generator.');
      expect(body).toContain('removed the [object Object] scrub');
      expect(body).toContain('prose mentioning [object Object] must survive');
      expect(body).toContain('no [object Object] left');
      expect(body).toContain('a body may contain the words [object Object]');
      expect(body).not.toContain('[unrenderable report value]');
      // No false renderer-failure warning.
      expect(result.warnings.join(' ')).not.toContain('[object Object]');
      expect(result.warnings.join(' ')).not.toContain('could not be rendered');
    } finally {
      removeDir(dir);
    }
  });

  it('never rewrites the body wholesale for the [object Object] placeholder', () => {
    // The class guard for F1: the promise is that no renderer can EMIT the placeholder,
    // not that every occurrence in the finished prose gets rewritten.
    expect(prScript).not.toMatch(/replace\(\/\\\[object Object\\\]\/g/);
    expect(prScript).not.toContain('[unrenderable report value]');
  });

  it('leads a {risk, detail} entry with the risk, not the detail', () => {
    const dir = repoWithWork();
    try {
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        // The shape all four W9b risks use. `detail` is the renderer's detail slot, so a
        // naively shared renderer made the long paragraph the headline.
        risks: [{ risk: 'Provider contract may drift', detail: 'the seam is versioned by hand' }],
      });

      const { body } = runCreate(dir);
      const bullets = bulletsOf(sectionOf(body, '### Risks'));

      expect(bullets).toHaveLength(1);
      // The risk is the FIRST line of the bullet; the detail follows as an indented row.
      expect(bullets[0]).toBe('- Provider contract may drift');
      const riskSection = sectionOf(body, '### Risks');
      expect(riskSection).toContain('  detail: the seam is versioned by hand');
      expect(riskSection.indexOf('Provider contract may drift')).toBeLessThan(riskSection.indexOf('the seam is versioned by hand'));
    } finally {
      removeDir(dir);
    }
  });

  it('states the no-commits fact exactly once', () => {
    const dir = tempDir('pa-nocommit-once-');
    try {
      initRepo(dir);
      sh('git checkout -q -b feature/test', dir);
      writeReport(dir, { status: 'completed', summary: 'Did the work.' });

      const { body } = runCreate(dir);
      const sentence = 'so this branch carries no change of its own';
      const occurrences = body.split(sentence).length - 1;

      expect(occurrences).toBe(1);
      expect(body).toContain('No commits exist on');
    } finally {
      removeDir(dir);
    }
  });

  it('names the field when a value has content but renders to nothing', () => {
    const dir = repoWithWork();
    try {
      // Two empty objects are content the renderer cannot express; the marker must name
      // the field rather than leaving a blank bullet or a bare placeholder.
      writeReport(dir, { status: 'completed', summary: 'Did the work.', implementation: [{}, {}] });

      const { body, result } = runCreate(dir);

      expect(body).toContain('[implementation could not be rendered');
      expect(result.warnings.join(' ')).toContain('report field "implementation" could not be rendered');
    } finally {
      removeDir(dir);
    }
  });

  it('reads an explicitly unmet criterion as Unmet in every spelling the reports use', () => {
    const dir = repoWithWork();
    try {
      // The archived W1 report records `status: "not_met"`; W3 records
      // `"not_executed_blocked"`. Neither form means met, and 'not satisfied' must never
      // reach a /\bsatisfied\b/ branch: a false Met is worse than an omission, because it
      // tells the approver the opposite of what the engineer recorded.
      // Unmet and partially-met are bolded; a plain Met is not. Either way the rendered
      // verdict must be the one the engineer recorded.
      const CASES: Array<[string, string]> = [
        ['not_met', '**Unmet**'],
        ['NOT_MET', '**Unmet**'],
        ['NOT-MET', '**Unmet**'],
        ['not met', '**Unmet**'],
        ['not-satisfied', '**Unmet**'],
        ['not satisfied', '**Unmet**'],
        ['not_executed_blocked', '**Unmet**'],
        ['unmet', '**Unmet**'],
        ['fail', '**Unmet**'],
        ['partially met', '**Partially met**'],
        ['met', 'Met'],
        ['passed', 'Met'],
      ];

      for (const [status, expected] of CASES) {
        writeReport(dir, {
          status: 'completed',
          summary: 'Did the work.',
          acceptanceCriteria: [{ criterion: 'the criterion under test', status, evidence: 'some evidence' }],
        });
        const { body } = runCreate(dir);
        const criteria = sectionOf(body, '### Acceptance criteria');
        expect(criteria).toContain('the criterion under test** — ' + expected);
      }
    } finally {
      removeDir(dir);
    }
  });

  it('never infers Met from negated evidence prose', () => {
    const dir = repoWithWork();
    try {
      // The exact W1 shape: status "not_met" plus an evidence paragraph whose last
      // sentence reads "This criterion is NOT satisfied". The old renderer matched the
      // word "satisfied" inside that sentence and printed Met underneath it.
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        acceptanceCriteria: [
          {
            criterion: 'tsc reports 0 errors for types/, services/, services/providers/, workflows/',
            status: 'not_met',
            evidence: 'types/ 0, workflows/ 0, services/providers/ 1 (SMTPProvider TS7016 nodemailer typings), services/ 28. '
              + 'Every one is pre-existing and outside W1. This criterion is NOT satisfied; it needs those work packages, not a W1 change.',
          },
        ],
      });

      const { body } = runCreate(dir);
      const criteria = sectionOf(body, '### Acceptance criteria');

      expect(criteria).toContain('**Unmet**');
      expect(criteria).not.toMatch(/— Met\b/);
      // The tally is the number an approver actually reads.
      expect(criteria).toContain('0 met, 1 unmet');
      expect(criteria).not.toContain('0 unmet');
    } finally {
      removeDir(dir);
    }
  });

  it('leaves prose with no leading verdict as "status not recorded" rather than guessing', () => {
    const dir = repoWithWork();
    try {
      // No status field at all. The evidence mentions both satisfaction and failure in
      // passing; neither may be promoted to a verdict.
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        acceptanceCriteria: [
          { criterion: 'audit the rate limiter', evidence: 'types/ 0, workflows/ 0; this criterion is NOT satisfied yet.' },
        ],
      });

      const { body } = runCreate(dir);
      const criteria = sectionOf(body, '### Acceptance criteria');

      expect(criteria).not.toMatch(/— Met\b/);
      expect(criteria).toContain('status not recorded');
      expect(criteria).toContain('1 without a recorded status');
    } finally {
      removeDir(dir);
    }
  });

  it('renders risks under a template Risks heading instead of leaving the placeholder', () => {
    const dir = repoWithWork();
    try {
      fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.github', 'pull_request_template.md'),
        ['## Summary', '', '## Risks', '', '-', '', '## How was this tested?', '', '**Result:**', ''].join('\n'),
        'utf8',
      );
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        risks: ['Provider contract may drift', { risk: 'Retry storm', detail: 'no backoff cap' }],
      });

      const { result, body } = runCreate(dir);

      expect(result.templateUsed).toBe(true);
      // The template's own heading is reused - not duplicated by an appendix.
      expect(body.split('## Risks').length - 1).toBe(1);
      const risks = sectionOf(body, '## Risks');
      expect(risks).toContain('Provider contract may drift');
      expect(risks).toContain('Retry storm');
      expect(risks).not.toMatch(/^\s*-\s*$/m);
    } finally {
      removeDir(dir);
    }
  });

  it('appends Risks when the template has no heading for them', () => {
    const dir = repoWithWork();
    try {
      fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.github', 'pull_request_template.md'),
        ['## Summary', '', '- **Reviewer focus:**', ''].join('\n'),
        'utf8',
      );
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        risks: ['Provider contract may drift'],
        verification: { baseline: { command: 'npx jest', result: 'passed' } },
      });

      const { body } = runCreate(dir);

      // No risks heading, no "How was this tested?" heading: both are appended, so the
      // report content cannot vanish behind a template.
      expect(sectionOf(body, '### Risks')).toContain('Provider contract may drift');
      expect(sectionOf(body, '### Verification')).toContain('npx jest');
    } finally {
      removeDir(dir);
    }
  });

  it('does not duplicate Verification when the template already carries the evidence', () => {
    const dir = repoWithWork();
    try {
      fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.github', 'pull_request_template.md'),
        ['## Summary', '', '## How was this tested?', '', '**Result:**', ''].join('\n'),
        'utf8',
      );
      writeReport(dir, {
        status: 'completed',
        summary: 'Did the work.',
        verification: { baseline: { command: 'npx jest pipeline', result: 'passed' } },
      });

      const { body } = runCreate(dir);

      expect(body.split('npx jest pipeline').length - 1).toBe(1);
      expect(body).not.toContain('### Verification');
    } finally {
      removeDir(dir);
    }
  });

  it('uses a revision summary when the report has no plain `summary` field', () => {
    const dir = repoWithWork();
    try {
      // Both merged W1 and W3 bodies read "No summary field supplied" while the report
      // held a full paragraph under revision_2_summary.
      writeReport(dir, {
        status: 'completed',
        revision_2_summary: 'Both blocking defects are fixed and each was proven by mutation.',
        risks: ['one risk'],
      });

      const { body } = runCreate(dir);

      expect(sectionOf(body, '### Summary')).toContain('Both blocking defects are fixed');
      expect(body).not.toContain('No summary supplied by the engineer.');
    } finally {
      removeDir(dir);
    }
  });

  it('routes the PR body through the shared renderer rather than a third variant', () => {
    // The class guard: a blind `String()` in this script is how every defect here
    // started, and `HEAD~1..HEAD` is how the file list went wrong.
    expect(prScript).toContain('// >>> shared findings rendering');
    expect(prScript).not.toContain('HEAD~1..HEAD');
    expect(prScript).not.toMatch(/\.map\(\(r\) => String\(r\)\)/);
    expect(prScript).not.toMatch(/\.map\(String\)/);
    expect(prScript).toContain('const entryText = (value) => {');
  });
});

describe('ProcessAITicket commits the work before it publishes (D1)', () => {
  const commitScript = scriptOf('commitChanges');
  const commitStep = byId('commitChanges');

  /**
   * The exact trigger condition from W4/W9b: a repository whose .gitignore contains
   * `.ai-agent/`. Without this fixture the old code passes for the wrong reason, because
   * git only rejects the negative-pathspec `git add` when the path matches an ignore rule.
   */
  const repoWithIgnoredRunArtefacts = (): string => {
    const dir = tempDir('pa-commit-');
    initRepo(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), ['.ai-agent/', ''].join('\n'), 'utf8');
    sh('git add -A && git commit -qm "ignore run artefacts"', dir);
    sh('git checkout -q -b feature/test', dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'real-work.ts'), 'export const x = 1;\n', 'utf8');
    fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.ai-agent', 'report.json'), '{"status":"completed"}\n', 'utf8');
    return dir;
  };

  it('commits the work when the repository gitignores .ai-agent (W4/W9b)', () => {
    const dir = repoWithIgnoredRunArtefacts();
    try {
      const result = runJson(commitScript, { WT: dir, REF: 'REF-1' }, dir);

      expect(result.committed).toBe(true);
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
      // The commit really happened. Before the fix `git add` exited 1, `git commit`
      // never ran, and the branch stayed identical to its base.
      expect(sh('git rev-list --count master..HEAD', dir)).toBe('1');
      const files = sh('git show --name-only --pretty=format: HEAD', dir).split('\n').filter(Boolean);
      expect(files).toContain('src/real-work.ts');
      // Run internals must still never reach the branch.
      expect(files.join(' ')).not.toContain('.ai-agent');
      // Nothing is left staged-but-uncommitted for worktree hygiene to destroy.
      expect(sh('git status --porcelain', dir)).toBe('');
    } finally {
      removeDir(dir);
    }
  });

  it('still reports a clean worktree as clean instead of inventing a commit', () => {
    const dir = tempDir('pa-commit-clean-');
    try {
      initRepo(dir);
      fs.writeFileSync(path.join(dir, '.gitignore'), ['.ai-agent/', ''].join('\n'), 'utf8');
      sh('git add -A && git commit -qm "ignore run artefacts"', dir);
      sh('git checkout -q -b feature/test', dir);
      // Only run artefacts changed, and they are ignored: there is no work to commit.
      fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.ai-agent', 'report.json'), '{}\n', 'utf8');

      const result = runJson(commitScript, { WT: dir, REF: 'REF-1' }, dir);

      expect(result.committed).toBe(false);
      expect(result.reason).toBe('worktree clean');
      expect(sh('git rev-list --count master..HEAD', dir)).toBe('0');
    } finally {
      removeDir(dir);
    }
  });

  it('fails the step loudly when the commit cannot be made', () => {
    const dir = tempDir('pa-commit-fail-');
    try {
      initRepo(dir);
      sh('git checkout -q -b feature/test', dir);
      fs.writeFileSync(path.join(dir, 'work.ts'), 'export const x = 1;\n', 'utf8');
      // Make the commit itself fail after staging succeeded - the W4 shape exactly
      // (changes staged, nothing committed).
      const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(hook, ['#!/bin/sh', 'exit 1', ''].join('\n'), 'utf8');
      fs.chmodSync(hook, 0o755);

      let failure: any = null;
      try {
        runScript(commitScript, { WT: dir, REF: 'REF-1' }, dir);
      } catch (e) {
        failure = e;
      }

      // A non-zero exit is what makes the run abort instead of pushing an empty branch.
      expect(failure).not.toBeNull();
      expect(failure.status).toBe(1);
      // The reason must be in the step OUTPUT, not only on stderr, so a failed publish
      // can be told apart from a failed pull request.
      const reported = JSON.parse(String(failure.stdout));
      expect(reported.committed).toBe(false);
      expect(reported.reason).toBe('git commit failed');
      expect(String(failure.stderr)).toContain('git commit failed');
      expect(sh('git rev-list --count master..HEAD', dir)).toBe('0');
    } finally {
      removeDir(dir);
    }
  });

  it('keeps the commit step soft so a failure cannot pin the run', () => {
    // failOnError: true was the ticket's first suggestion, but the engine terminates the
    // instance on a failed step, and this workflow has no failure handler: the ticket got
    // no comment, no human task and no terminal runStatus. The step is therefore soft and
    // publishReadinessGate routes the failure. `failOnError` is written explicitly so the
    // intent survives an engine default change.
    expect('failOnError' in (commitStep.config as any)).toBe(true);
    expect(commitStep.config?.failOnError).toBe(false);
  });

  it('hard-stops the publish path when there is no commit to publish', () => {
    // The abort is still there, just after the human side has been handled: comment,
    // human task, terminal runStatus, then a fatal step that cannot be ignored.
    expect((byId('pushBranch') as any).dependsOn).toBe('publishReadinessGate');
    expect(byId('publishBlockHalt').config?.failOnError).toBe(true);
    expect(byId('publishBlockComment').type).toBe('service_invoke');
    expect(byId('publishBlockTask').type).toBe('user_activity');
    expect(String(byId('setRunStatusPublishBlocked').config?.value)).toBe('blocked');
  });

  it('stages without the negative pathspec git rejects on an ignored path', () => {
    // The class guard: the chained form is how the commit silently stopped happening.
    expect(commitScript).not.toContain("execSync('git add -A -- . ");
    expect(commitScript).not.toContain('advice.addIgnoredFile=true');
    expect(commitScript).toContain("run('git add -A')");
    expect(commitScript).toContain('git rm -r --cached --quiet --ignore-unmatch -- .ai-agent');
    // Staging and committing must be separate invocations, so a failed add cannot
    // suppress the commit, and a failed commit cannot be mistaken for a failed push.
    expect(commitScript).toContain("execSync('git commit' + identity");
  });
});

describe('ProcessAITicket gates publication on the commit it actually made (D1c)', () => {
  const capture = scriptOf('captureReview');
  const publishable = scriptOf('readPublishable');
  const readiness = scriptOf('readPublishReadiness');
  const commitScript = scriptOf('commitChanges');

  /** The steps of the publish branch, in declaration order. */
  const outcomeThenSteps = (): any[] => ((byId('outcome').config?.thenSteps || []) as any[]);

  const decisionOf = (dir: string): any =>
    JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'publish-decision.json'), 'utf8'));
  const readinessOf = (dir: string): any =>
    JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'publish-readiness.json'), 'utf8'));

  /**
   * The real production precondition, which no fixture modelled before: a run that has
   * been reviewed and approved while the engineer's work is still UNCOMMITTED. The
   * engineer is instructed never to commit; commitChanges is what commits.
   */
  const repoWithUncommittedApprovedWork = (baseBranch: string = 'master'): string => {
    const dir = tempDir('pa-preseq-');
    initRepo(dir, baseBranch);
    fs.writeFileSync(path.join(dir, '.gitignore'), ['.ai-agent/', ''].join('\n'), 'utf8');
    sh('git add -A && git commit -qm "ignore run artefacts"', dir);
    sh('git checkout -q -b feature/test', dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'real-work.ts'), 'export const x = 1;\n', 'utf8');
    writeReport(dir, { status: 'completed', summary: 'Did the work.' });
    writeReview(dir, { verdict: 'approved', summary: 'looks right', findings: [] });
    runJson(capture, { WT: dir }, dir);
    return dir;
  };

  it('still publishes when the work is uncommitted at the publish decision (W4 sequence)', () => {
    const dir = repoWithUncommittedApprovedWork();
    try {
      // This is the state the workflow is really in when it decides: zero commits ahead
      // of base, because the commit step has not run yet.
      expect(sh('git rev-list --count master..HEAD', dir)).toBe('0');

      // 1. The review decision must NOT read git state here. An earlier revision gated
      //    on commitCount in this step and classified every normal run as 'no commits',
      //    so nothing was ever published.
      expect(runScript(publishable, { WT: dir }, dir)).toBe('true');
      expect(decisionOf(dir).outcome).toBe('approved');

      // 2. The commit step then does its job.
      const committed = runJson(commitScript, { WT: dir, REF: 'REF-1' }, dir);
      expect(committed.committed).toBe(true);
      expect(sh('git rev-list --count master..HEAD', dir)).toBe('1');

      // 3. Only now is git asked whether there is something to publish.
      expect(runScript(readiness, { WT: dir, BRANCH: 'feature/test', COMMIT: JSON.stringify(committed) }, dir)).toBe('ok');
      expect(readinessOf(dir).commitsAhead).toBe(1);
      expect(readinessOf(dir).state).toBe('ok');
    } finally {
      removeDir(dir);
    }
  });

  it('runs the readiness gate after the commit, never before it', () => {
    // The ordering IS the fix, so assert it structurally rather than by prose.
    const publishBranch = outcomeThenSteps();
    const ids = publishBranch.map((step: any) => step.id);
    expect(ids).toContain('commitChanges');
    expect(ids.indexOf('commitChanges')).toBeLessThan(ids.indexOf('readPublishReadiness'));
    expect(ids.indexOf('readPublishReadiness')).toBeLessThan(ids.indexOf('publishReadinessGate'));
    expect(ids.indexOf('publishReadinessGate')).toBeLessThan(ids.indexOf('pushBranch'));
    // ...and the review decision happens before the publish branch, so it cannot see the
    // commit. It therefore must not consult commitCount at all.
    expect(scriptOf('readPublishable')).not.toContain('commitCount');
    expect(scriptOf('readPublishable')).not.toContain('rev-list');
    expect(String(byId('outcome').config?.condition)).toBe("variables.publishable === 'true'");
  });

  it('blocks the publish path on a genuine commit failure, naming the worktree', () => {
    const dir = tempDir('pa-ready-fail-');
    try {
      initRepo(dir);
      sh('git checkout -q -b feature/test', dir);
      fs.writeFileSync(path.join(dir, 'work.ts'), 'export const x = 1;\n', 'utf8');
      const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(hook, ['#!/bin/sh', 'exit 1', ''].join('\n'), 'utf8');
      fs.chmodSync(hook, 0o755);

      let failure: any = null;
      try {
        runScript(commitScript, { WT: dir, REF: 'REF-1' }, dir);
      } catch (e) {
        failure = e;
      }
      expect(failure).not.toBeNull();

      const state = runScript(readiness, { WT: dir, BRANCH: 'feature/test', COMMIT: String(failure.stdout) }, dir);
      expect(state).toBe('blocked');

      const evidence = readinessOf(dir);
      expect(evidence.state).toBe('blocked');
      expect(evidence.committed).toBe(false);
      // A failed commit is the ONLY case allowed to tell a human to recover the worktree.
      expect(evidence.detail).toContain('FAILED');
      expect(evidence.detail).toContain(dir);
      expect(evidence.detail).toContain('Recover it before the worktree is cleaned up');
    } finally {
      removeDir(dir);
    }
  });

  it('says there was nothing to publish when the commit step found a clean worktree', () => {
    const dir = tempDir('pa-ready-clean-');
    try {
      initRepo(dir);
      fs.writeFileSync(path.join(dir, '.gitignore'), ['.ai-agent/', ''].join('\n'), 'utf8');
      sh('git add -A && git commit -qm "ignore run artefacts"', dir);
      sh('git checkout -q -b feature/test', dir);
      writeReport(dir, { status: 'completed', summary: 'no work' });

      const committed = runJson(commitScript, { WT: dir, REF: 'REF-1' }, dir);
      expect(committed.reason).toBe('worktree clean');

      expect(runScript(readiness, { WT: dir, BRANCH: 'feature/test', COMMIT: JSON.stringify(committed) }, dir)).toBe('blocked');

      const evidence = readinessOf(dir);
      expect(evidence.detail).toContain('There was nothing to publish');
      // Q2: the recovery instruction must not appear when no commit was ever attempted.
      expect(evidence.detail).not.toContain('Recover it');
      expect(evidence.detail).not.toContain('FAILED');
    } finally {
      removeDir(dir);
    }
  });

  it('resolves a non-main default branch instead of reading it as zero commits (Q3)', () => {
    const dir = repoWithUncommittedApprovedWork('develop');
    try {
      const committed = runJson(commitScript, { WT: dir, REF: 'REF-1' }, dir);
      expect(committed.committed).toBe(true);

      // Before the fix the base fell back to 'master', rev-list failed, and the failure
      // was read as 'no commits'. The candidate list is now verified, not assumed.
      expect(runScript(readiness, { WT: dir, BRANCH: 'feature/test', COMMIT: JSON.stringify(committed) }, dir)).toBe('ok');
      const evidence = readinessOf(dir);
      expect(evidence.base).toBe('develop');
      expect(evidence.baseResolved).toBe(true);
      expect(evidence.commitsAhead).toBe(1);
    } finally {
      removeDir(dir);
    }
  });

  it('fails open when the base branch cannot be resolved at all (Q3)', () => {
    const dir = tempDir('pa-ready-nobase-');
    try {
      initRepo(dir, 'work');
      sh('git checkout -q -b feature/test', dir);
      fs.writeFileSync(path.join(dir, 'work.ts'), 'x\n', 'utf8');
      sh('git add -A && git commit -qm work', dir);

      // No origin/HEAD, no gh, and 'work' is not one of the conventional names.
      const state = runScript(
        readiness,
        { WT: dir, BRANCH: 'feature/test', COMMIT: JSON.stringify({ committed: true, sha: 'deadbeef' }) },
        dir,
      );
      expect(state).toBe('ok');
      const evidence = readinessOf(dir);
      expect(evidence.baseResolved).toBe(false);
      expect(evidence.commitsAhead).toBeNull();
      // An unknown base must never be reported as a zero-commit branch.
      expect(evidence.detail).toContain('could not be resolved');
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket workspace note describes its own change (D2 follow-up)', () => {
  const noteScript = scriptOf('openWorkspaceNote');

  const noteSetup = (dir: string, data: string): Record<string, string> => {
    fs.mkdirSync(path.join(data, 'profiles', 'reactor', 'personas', 'FixturePersona'), { recursive: true });
    return {
      WT: dir,
      REACTORY_DATA: data,
      REF: 'REACTORY-302016408/20261021/3847124067',
      TICKET_ID: 'fixture-ticket-id',
      REPO: dir,
      BRANCH: 'feature/test',
      PERSONA: 'FixturePersona',
    };
  };

  it('never lists the previous commit when the branch has no commits of its own', () => {
    const dir = tempDir('pa-note-nocommit-');
    const data = tempDir('pa-note-data-');
    try {
      initRepo(dir);
      // Unrelated work from the previous ticket: the old historical-diff fallback
      // listed this file for a branch that had no commits of its own.
      fs.writeFileSync(path.join(dir, 'previous-work.ts'), 'export const previous = true;\n', 'utf8');
      sh('git add -A && git commit -qm "previous merge"', dir);
      sh('git checkout -q -b feature/test', dir);
      writeReport(dir, { status: 'completed', summary: 'Did the work.' });

      const env = noteSetup(dir, data);
      runJson(noteScript, Object.assign({ MODE: 'open' }, env), dir);
      runJson(noteScript, Object.assign({ MODE: 'close', PR_URL: 'https://example.test/pr/1', CYCLES: '1' }, env), dir);

      const complete = path.join(
        data, 'profiles', 'reactor', 'personas', 'FixturePersona', 'workspace', 'complete',
        'reactory-302016408-20261021-3847124067.md',
      );
      const text = fs.readFileSync(complete, 'utf8');

      expect(text).not.toContain('previous-work.ts');
      expect(text).toContain('No commits exist on branch feature/test ahead of master');
      // Stated once, not once per code path.
      expect(text.split('No commits exist on branch').length - 1).toBe(1);
      // The fallback must not exist in the script at all.
      expect(noteScript).not.toContain('HEAD~1');
    } finally {
      removeDir(dir);
      removeDir(data);
    }
  });

  it('still lists the branch diff when the branch does have commits', () => {
    const dir = repoWithWork();
    const data = tempDir('pa-note-data-');
    try {
      writeReport(dir, { status: 'completed', summary: 'Did the work.' });
      const env = noteSetup(dir, data);
      runJson(noteScript, Object.assign({ MODE: 'open' }, env), dir);
      runJson(noteScript, Object.assign({ MODE: 'close', PR_URL: 'https://example.test/pr/1', CYCLES: '1' }, env), dir);

      const complete = path.join(
        data, 'profiles', 'reactor', 'personas', 'FixturePersona', 'workspace', 'complete',
        'reactory-302016408-20261021-3847124067.md',
      );
      const text = fs.readFileSync(complete, 'utf8');

      expect(text).toContain('src/modules/fixture/index.ts');
      expect(text).not.toContain('No commits exist on branch');
    } finally {
      removeDir(dir);
      removeDir(data);
    }
  });
});