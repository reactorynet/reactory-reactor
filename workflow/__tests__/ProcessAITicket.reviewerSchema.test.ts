/**
 * REACTORY-302016408/20261116/2437438300 — the reviewer's ACTUAL schema.
 *
 * 1.4.8 resolved findings by listing synonyms of its OWN key names
 * (`blockingFindings` / `blocking_findings`). A reviewer that emitted
 * `blocking_issues` was read as having given nothing, because
 * `blocking_issues` is not a casing variant of `blockingFindings` — it is a
 * different noun, and `resolveKey` compares WHOLE normalised names. The verdict
 * resolved (via `verdict`/`decision`) while every findings list came back empty,
 * so a complete, actionable critique was thrown away and the run was parked for
 * a human with the false claim "the reviewer produced no verdict".
 *
 * The fixtures below are the REAL review.json files from the two runs that were
 * falsely blocked. They are byte-for-byte copies, pinned by sha256, because a
 * hand-written fixture would only encode the shape the parser already
 * understands — the exact trap that let this class of defect ship twice.
 *
 * These tests execute the shipped `cli_command` scripts, so they can only pass
 * against code that actually reads the reviewer's keys.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
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

const parsedTest = new YamlFlowParser({ validateSchema: true }).parseFromFile(WORKFLOW_FILE) as any;
if (!parsedTest.success) throw new Error('ProcessAITicket.yaml failed to parse: ' + JSON.stringify(parsedTest.errors));

const allSteps: IStep[] = [];
const walkSteps = (steps: IStep[]): void => {
  (steps || []).forEach((step) => {
    allSteps.push(step);
    const config = step.config || {};
    ['thenSteps', 'elseSteps', 'steps'].forEach((key) => {
      if (Array.isArray(config[key])) walkSteps(config[key]);
    });
  });
};
walkSteps(parsedTest.workflow.steps);

const stepById = (id: string): IStep => {
  const hit = allSteps.find((step) => step.id === id);
  if (!hit) throw new Error(`step "${id}" not found`);
  return hit;
};

const scriptFor = (id: string): string => String(stepById(id).config!.args[1]);

const runScript = (script: string, env: Record<string, string>, cwd: string): string =>
  execFileSync(process.execPath, ['-e', script], {
    cwd,
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const runJson = (script: string, env: Record<string, string>, cwd: string): any =>
  JSON.parse(runScript(script, env, cwd));

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

/** A throwaway repository that looks like a prepared worktree. */
const repoWithWork = (): string => {
  const dir = tempDir('pa-schema-');
  sh('git init -q -b master .', dir);
  sh('git config user.email test@example.com', dir);
  sh('git config user.name Test', dir);
  sh('git config commit.gpgsign false', dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  sh('git add -A && git commit -qm base', dir);
  sh('git checkout -q -b feature/test', dir);
  fs.mkdirSync(path.join(dir, '.ai-agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ai-agent', 'report.json'), JSON.stringify({ status: 'completed', summary: 'work' }), 'utf8');
  sh('git add -A && git commit -qm "AI engineering run: REF-1"', dir);
  return dir;
};

/**
 * Install a verdict exactly the way the pipeline does: open the review window,
 * write the reviewer's file, stamp it. captureReview only accepts a verdict the
 * pipeline stamped, so every fixture must go through this path.
 */
const installReview = (dir: string, review: unknown): void => {
  runScript(scriptFor('prepareReview'), { WT: dir, CYCLE: '0', REVIEWER: 'QualityQuinn' }, dir);
  fs.writeFileSync(path.join(dir, '.ai-agent', 'review.json'), JSON.stringify(review), 'utf8');
  const stamp = runJson(scriptFor('stampReview'), { WT: dir, CYCLE: '0', REVIEWER: 'QualityQuinn', ATTEMPT: '1' }, dir);
  if (stamp.accepted !== true) {
    throw new Error('fixture review was not accepted by the pipeline: ' + String(stamp.reason));
  }
};

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures');

const loadFixture = (name: string): { review: any; sha256: string } => {
  const bytes = fs.readFileSync(path.join(FIXTURE_DIR, name));
  return { review: JSON.parse(bytes.toString('utf8')), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
};

const FIXTURE_A = 'review-6af7304d-blocking-issues.json';
const FIXTURE_B = 'review-6afaefaf-blocking-issues.json';

describe('ProcessAITicket reviewer schema — the two real artefacts that were falsely blocked', () => {
  const capture = scriptFor('captureReview');

  it('ships the real review.json bytes from both runs, pinned by sha256', () => {
    // These are the artefacts named in REACTORY-302016408/20261116/2437438300.
    // If a future edit "fixes" a fixture instead of the parser, this fails.
    expect(loadFixture(FIXTURE_A).sha256).toBe('aa7edc250d0f128cedd08f2837217c05c64ab36c947cd4cd8368feb510ddb640');
    expect(loadFixture(FIXTURE_B).sha256).toBe('204d1ba5d86e2be80df2302ad3e15ef37405aad3fbeb5626a883ccbecf0481bd');
  });

  it.each([FIXTURE_A, FIXTURE_B])('resolves the blocking finding in %s instead of reporting none', (name) => {
    const { review } = loadFixture(name);
    const dir = repoWithWork();
    try {
      installReview(dir, review);
      const result = runJson(capture, { WT: dir }, dir);

      // The verdict always resolved; that asymmetry was the bug.
      expect(result.verdict).toBe('rejected');
      expect(result.verdictSource).toBe('changes_requested');

      // ...and now so do the findings.
      expect(result.findingsResolved).toBe(true);
      expect(result.blockedReason).toBeUndefined();

      // Assert the CONTENT, not the count: a finding can land with an empty
      // title and no file and still satisfy a length check.
      const blocking = result.blockingFindings;
      expect(Array.isArray(blocking)).toBe(true);
      expect(blocking.length).toBe(1);
      expect(blocking[0].id).toBe('B1');
      expect(String(blocking[0].file)).toContain(
        name === FIXTURE_A ? 'ai/openai/chat/questions/factory.ts' : 'AnthropicService.wireParity.test.ts',
      );
      expect(String(blocking[0].severity).length).toBeGreaterThan(0);

      // The reviewer's other lists travel with it.
      expect(result.requiredChanges.length).toBeGreaterThan(0);
      expect(result.nonBlockingFindings.length).toBeGreaterThan(0);
      // The single most useful sentence in the file is carried VERBATIM, not summarised.
      expect(String(result.headline)).toBe(String(review.headline));
      expect(String(result.headline).length).toBeGreaterThan(40);
      expect(result.summary).toBe(result.headline);
    } finally {
      removeDir(dir);
    }
  });

  it.each([FIXTURE_A, FIXTURE_B])('hands %s to the engineer as text a fix cycle can act on', (name) => {
    const { review } = loadFixture(name);
    const dir = repoWithWork();
    try {
      installReview(dir, review);
      runJson(capture, { WT: dir }, dir);
      const brief = runScript(scriptFor('handBackBriefing'), { WT: dir }, dir);

      expect(brief).toContain('Reviewer verdict: REJECTED');
      // The carried finding's identity and location must reach the engineer.
      expect(brief).toContain('B1');
      expect(brief).toContain(
        name === FIXTURE_A ? 'ai/openai/chat/questions/factory.ts' : 'AnthropicService.wireParity.test.ts',
      );
      expect(brief).toContain('## Blocking findings (1)');
      expect(brief).toContain('## Required changes');
      // The false "nothing readable" sentence must never be emitted for these.
      expect(brief).not.toContain('No actionable findings could be resolved');
    } finally {
      removeDir(dir);
    }
  });

  it.each([FIXTURE_A, FIXTURE_B])('does not publish %s past a real blocking finding', (name) => {
    const { review } = loadFixture(name);
    const dir = repoWithWork();
    try {
      installReview(dir, review);
      runJson(capture, { WT: dir }, dir);
      expect(runScript(scriptFor('readPublishable'), { WT: dir }, dir)).toBe('false');
      const decision = JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'publish-decision.json'), 'utf8'));
      expect(decision.outcome).toBe('rejected');
      expect(decision.blocking).toBeGreaterThanOrEqual(1);
      expect(decision.parseFault).toBe(false);
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket reviewer schema — genuinely empty and genuinely unreadable are different', () => {
  const capture = scriptFor('captureReview');
  const reasonOf = (dir: string): any =>
    JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'review-normalised.json'), 'utf8'));

  it('still blocks a review that honestly reported nothing, and says so as a review', () => {
    const dir = repoWithWork();
    try {
      installReview(dir, {
        decision: 'changes_requested',
        headline: 'The change does not address the ticket.',
        blocking_issues: [],
        non_blocking_issues: [],
        required_actions_next_cycle: [],
        acceptance_criteria_assessment: [],
      });
      const result = runJson(capture, { WT: dir }, dir);

      expect(result.verdict).toBe('rejected');
      expect(result.findingsResolved).toBe(false);
      expect(result.findingsUnresolvedReason).toBe('reviewer_reported_none');
      // Accurate: no verdict claim is contradicted, and no parser blame is invented.
      expect(String(result.headline)).toBe('The change does not address the ticket.');
      expect(String(result.blockedReason)).toContain('changes_requested');
      expect(String(result.blockedReason)).toContain('no findings could be resolved');
      expect(result.unrecognisedFindingKeys).toEqual([]);
    } finally {
      removeDir(dir);
    }
  });

  it('reports a findings-shaped key it does not know as a PARSER fault, not a missing review', () => {
    const dir = repoWithWork();
    try {
      // The next reviewer invents another noun. The parser must not silently
      // claim the reviewer said nothing: it must say the PARSER failed.
      installReview(dir, {
        decision: 'changes_requested',
        headline: 'Two blockers.',
        issues_blocking: [{ id: 'B1', severity: 'critical', title: 'broker ignores the topic ACL', file: 'src/acl.ts:12' }],
        required_actions_next_cycle: [],
      });
      const result = runJson(capture, { WT: dir }, dir);

      expect(result.verdict).toBe('rejected');
      expect(result.findingsResolved).toBe(false);
      expect(result.findingsUnresolvedReason).toBe('parser_defect');
      expect(result.unrecognisedFindingKeys).toContain('issues_blocking');
      expect(String(result.blockedReason)).toContain('PARSER');
      expect(reasonOf(dir).findingsUnresolvedReason).toBe('parser_defect');
    } finally {
      removeDir(dir);
    }
  });

  it('records which keys the review actually had, so a future mismatch is diagnosable', () => {
    const dir = repoWithWork();
    try {
      const { review } = loadFixture(FIXTURE_A);
      installReview(dir, review);
      const result = runJson(capture, { WT: dir }, dir);
      expect(result.keysSeen).toContain('blocking_issues');
      expect(result.keysSeen).toContain('required_actions_next_cycle');
      expect(result.schemaProblems).toEqual([]);
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket reviewer schema — the block message tells the truth', () => {
  const capture = scriptFor('captureReview');

  it('names the resolved verdict, the reason and the headline in one message', () => {
    const dir = repoWithWork();
    try {
      const { review } = loadFixture(FIXTURE_A);
      installReview(dir, { ...review, blocking_issues: [], required_actions_next_cycle: [] });
      runJson(capture, { WT: dir }, dir);

      const text = runScript(scriptFor('findingsHaltBrief'), { WT: dir }, dir);
      // It may never claim there was no verdict.
      expect(text).not.toContain('no verdict');
      expect(text).not.toContain('produced no verdict');
      expect(text).toContain('REJECTED');
      expect(text).toContain('changes_requested');
      // The reviewer's own sentence, verbatim.
      expect(text).toContain(String(review.headline).slice(0, 60));
      // ...and an accurate reason.
      expect(text).toContain('no blocking issue');
    } finally {
      removeDir(dir);
    }
  });

  it('escalates a parser fault as a pipeline defect, not as the engineer revising blind', () => {
    const dir = repoWithWork();
    try {
      installReview(dir, { decision: 'changes_requested', headline: 'Blockers.', issues_blocking: [{ id: 'B1', title: 'x' }] });
      runJson(capture, { WT: dir }, dir);
      const text = runScript(scriptFor('findingsHaltBrief'), { WT: dir }, dir);
      expect(text).toContain('PARSER FAULT');
      expect(text).toContain('issues_blocking');
      expect(text).toContain('Human attention required');
    } finally {
      removeDir(dir);
    }
  });

  it('feeds the block comment from the brief, so the ticket cannot restate the old false reason', () => {
    const comment = String(stepById('findingsHaltComment').config!.params.comment);
    expect(comment).toContain('steps.findingsHaltBrief.outputs.stdout');
    expect(comment).not.toContain('camelCase');
    expect(comment).not.toContain('no findings could be resolved from');
  });
});

describe('ProcessAITicket reviewer schema — one table, both call sites, one prompt', () => {
  /**
   * The WHOLE shared block, whitespace-normalised: the two scripts are indented
   * differently, so pinning it requires normalisation. Pinning only the
   * `REVIEW_SCHEMA` table would leave the helpers that give the table its
   * meaning (schemaValue, the unknown-key detector and its stem regex) free to
   * drift independently in the two call sites.
   */
  const SCHEMA_OPEN = '// >>> shared review schema';
  const SCHEMA_CLOSE = '// <<< shared review schema';
  const schemaBlock = (script: string): string => {
    const start = script.indexOf(SCHEMA_OPEN);
    expect(start).toBeGreaterThan(-1);
    const end = script.indexOf(SCHEMA_CLOSE, start);
    expect(end).toBeGreaterThan(start);
    return script
      .slice(start, end + SCHEMA_CLOSE.length)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  };

  it('uses the identical schema block in the capture path and the publish gate', () => {
    expect(schemaBlock(scriptFor('readPublishable'))).toBe(schemaBlock(scriptFor('captureReview')));
  });

  it('pins the whole block, helpers included, not just the key table', () => {
    const block = schemaBlock(scriptFor('captureReview'));
    // The table alone would be pinned by a substring check; these are the parts
    // that decide what an unknown key MEANS, so they must be pinned with it.
    expect(block).toContain('const REVIEW_SCHEMA = {');
    expect(block).toContain('const schemaAliases = (name) => REVIEW_SCHEMA[name] || [];');
    expect(block).toContain('const schemaValue = (obj, name) => {');
    expect(block).toContain('const FINDINGS_STEM =');
    expect(block).toContain('const unknownFindingKeys = (obj) => {');
    expect(block.indexOf(SCHEMA_OPEN)).toBe(0);
    expect(block.endsWith(SCHEMA_CLOSE)).toBe(true);
  });

  it('declares the canonical reviewer keys, not synonyms of the old names', () => {
    const block = schemaBlock(scriptFor('captureReview'));
    ['blocking_issues', 'non_blocking_issues', 'required_actions_next_cycle', 'acceptance_criteria_assessment', 'headline', 'decision'].forEach(
      (key) => {
        expect(block).toContain(key);
      },
    );
  });

  it('tells the reviewer the same shape the parser accepts', () => {
    const prompt = String(stepById('review').config!.instructions);
    ['blocking_issues', 'non_blocking_issues', 'required_actions_next_cycle', 'acceptance_criteria_assessment', 'headline'].forEach((key) => {
      expect(prompt).toContain(key);
    });
    // The old prompt asked for a shape the parser's OTHER vocabulary expected.
    expect(prompt).not.toContain('"requiredChanges"');
    expect(prompt).not.toContain('"verdict": "approved"');

    // The confirmation pass must ask for the same shape, not per-finding
    // `blocking: true|false` — that third shape is what drifted in the first place.
    const confirmation = String(stepById('confirmationReview').config!.message);
    expect(confirmation).toContain('blocking_issues');
    expect(confirmation).toContain('non_blocking_issues');
    expect(confirmation).not.toContain('blocking true or false');
  });
});
