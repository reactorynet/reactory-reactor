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

/* ---------------------------------------------------------------------------
 * PR review of the reviewer-schema parser: B1-B4, N1 and N3.
 *
 * The fixtures above are REAL artefacts and are pinned by sha256. The ones below
 * are shapes the parser is supposed to understand but did not, so they are written
 * by hand and named after the defect each one reproduces: a capitalised `Decision`,
 * an empty alias shadowing a populated one, a verdict from another vocabulary, a
 * scalar where a list belongs, an object where a sentence belongs, and a rejection
 * that asks for no work at all.
 * ------------------------------------------------------------------------- */

const FIXTURE_CAPITAL_DECISION = 'review-capital-decision-approved.json';
const FIXTURE_VERDICT_CONFLICT = 'review-decision-and-verdict-conflict.json';
const FIXTURE_EMPTY_ALIAS = 'review-empty-alias-with-blockers.json';
const FIXTURE_UNRECOGNISED_VERDICT = 'review-unrecognised-verdict.json';
const FIXTURE_SCALAR_LIST = 'review-scalar-blocking-issues.json';
const FIXTURE_OBJECT_HEADLINE = 'review-object-headline.json';
const FIXTURE_NON_BLOCKING_ONLY = 'review-non-blocking-only-rejection.json';

const publishDecisionOf = (dir: string): any =>
  JSON.parse(fs.readFileSync(path.join(dir, '.ai-agent', 'publish-decision.json'), 'utf8'));

describe('ProcessAITicket reviewer schema — B1 one verdict resolver, three call sites', () => {
  const capture = scriptFor('captureReview');
  const readVerdict = scriptFor('readVerdict');
  const publishable = scriptFor('readPublishable');

  it('reads {"Decision":"approved"} as an approval in all three scripts', () => {
    const { review } = loadFixture(FIXTURE_CAPITAL_DECISION);
    const dir = repoWithWork();
    try {
      installReview(dir, review);
      expect(runJson(capture, { WT: dir }, dir).verdict).toBe('approved');

      // captureReview always resolved this through normaliseKey. readVerdict read
      // `rv.verdict || rv.decision` by EXACT name, so it resolved '' and defaulted
      // to 'rejected'; the side-car (written from the SAME bytes) said approved, so
      // it printed "... says approved but the stamped review.json says rejected -
      // refusing both" and the run halted as review_unavailable.
      expect(runScript(readVerdict, { WT: dir }, dir).trim()).toBe('approved');

      // readPublishable read the same two keys the same wrong way, so a valid
      // approval was reported as rejected and could never publish.
      expect(runScript(publishable, { WT: dir }, dir).trim()).toBe('true');
      expect(publishDecisionOf(dir).outcome).toBe('approved');
      expect(publishDecisionOf(dir).verdict).toBe('approved');
    } finally {
      removeDir(dir);
    }
  });

  it('gives `decision` the same precedence everywhere when a review carries both keys', () => {
    const { review } = loadFixture(FIXTURE_VERDICT_CONFLICT);
    const dir = repoWithWork();
    try {
      installReview(dir, review);
      // `decision` is the canonical key and it says changes_requested; `verdict` is
      // its alias and it says approved. captureReview took `decision`; the two gates
      // read `verdict` FIRST. Same file, opposite verdicts - and the gate published.
      expect(runJson(capture, { WT: dir }, dir).verdict).toBe('rejected');
      expect(runScript(readVerdict, { WT: dir }, dir).trim()).toBe('rejected');
      expect(runScript(publishable, { WT: dir }, dir).trim()).toBe('false');
      const decision = publishDecisionOf(dir);
      expect(decision.outcome).toBe('rejected');
      // TWO, not one: the gate counts the blocking issue AND the required action, since
      // "requiredChanges are blocking by definition". The count is not what this test is
      // about - the point is that all three readers now agree it is REJECTED.
      expect(decision.blocking).toBe(2);
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket reviewer schema — B2 an empty alias must not shadow a populated one', () => {
  const capture = scriptFor('captureReview');

  it('reads `blockers` when `blocking_issues` is present but empty', () => {
    const { review } = loadFixture(FIXTURE_EMPTY_ALIAS);
    const dir = repoWithWork();
    try {
      installReview(dir, review);
      const result = runJson(capture, { WT: dir }, dir);

      // schemaValue returned the first alias PRESENT, so `blocking_issues: []` won
      // and the real `blockers` entry was never read: a real blocker was reported as
      // "the review names nothing". `blockers` is a KNOWN alias, so the parser-fault
      // detector could not see it either.
      expect(result.findingsResolved).toBe(true);
      expect(result.findingsUnresolvedReason).toBe('');
      expect(result.blockingFindings.length).toBe(1);
      expect(result.blockingFindings[0].id).toBe('B1');

      // Every spelling that is present is read, so nothing is dropped...
      expect(result.requiredChanges.length).toBe(2);
      expect(JSON.stringify(result.requiredChanges)).toContain('Check the ACL before the topic lookup');
      expect(JSON.stringify(result.requiredChanges)).toContain('Add a regression test that fails without the ACL check');

      // ...and answering one field twice is RECORDED as prompt drift, not resolved silently.
      const problems = result.schemaProblems.join(' ');
      expect(problems).toContain('more than one spelling');
      expect(problems).toContain('blocking_issues');
      expect(problems).toContain('blockers');
    } finally {
      removeDir(dir);
    }
  });

  it('skips a blank scalar so a populated spelling still decides the verdict', () => {
    const dir = repoWithWork();
    try {
      installReview(dir, { decision: '', Decision: 'approved', headline: 'Approved.', blocking_issues: [], required_actions_next_cycle: [] });
      const result = runJson(capture, { WT: dir }, dir);
      // The blank `decision` was returned first, so the review was read as rejected.
      expect(result.verdict).toBe('approved');
      expect(result.verdictSource).toBe('approved');
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket reviewer schema — B3 an unrecognised verdict is a pipeline defect', () => {
  const capture = scriptFor('captureReview');

  it('records the unrecognised verdict instead of starting a blind fix cycle', () => {
    const { review } = loadFixture(FIXTURE_UNRECOGNISED_VERDICT);
    const dir = repoWithWork();
    try {
      installReview(dir, review);
      const result = runJson(capture, { WT: dir }, dir);

      // The "not a recognised verdict" branch was UNREACHABLE: the fallback above it
      // always set `verdict` first, so this probe recorded schemaProblems: [].
      const problems = result.schemaProblems.join(' ');
      expect(problems).toContain('approved_with_comments');
      expect(problems).toContain('not a recognised verdict');

      // The old fallback also pushed a synthetic sentence into the FINDINGS list, so
      // it counted as readable and the engineer got a fix cycle whose only content
      // was the pipeline's own note - the "revise blind" outcome the halt exists for.
      expect(result.findingsResolved).toBe(false);
      expect(result.findingsUnresolvedReason).toBe('unrecognised_verdict');
      expect(JSON.stringify(result.findings)).not.toContain('not recognisable');

      // It halts like a parser fault, naming the value it could not read.
      const brief = runScript(scriptFor('findingsHaltBrief'), { WT: dir }, dir);
      expect(brief).toContain('approved_with_comments');
      expect(brief).toContain('UNRECOGNISED');
      expect(brief).toContain('Human attention required');
      expect(brief).not.toContain('names no blocking issue');
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket reviewer schema — B4 one list coercion, both paths', () => {
  const capture = scriptFor('captureReview');
  const publishable = scriptFor('readPublishable');

  it('treats a scalar findings list as one finding in capture AND at the publish gate', () => {
    const { review } = loadFixture(FIXTURE_SCALAR_LIST);
    const dir = repoWithWork();
    try {
      installReview(dir, review);
      const result = runJson(capture, { WT: dir }, dir);

      // captureReview wrapped the scalar, so it started a fix cycle...
      expect(result.blockingFindings.length).toBe(1);
      expect(String(result.blockingFindings[0])).toContain('the broker ignores the topic ACL');

      // ...while the gate dropped it (its own `Array.isArray(v) ? v : []`) and
      // reported "no actionable finding could be resolved". One coercion now.
      expect(runScript(publishable, { WT: dir }, dir).trim()).toBe('false');
      const decision = publishDecisionOf(dir);
      expect(decision.outcome).toBe('rejected');
      expect(decision.blocking).toBe(1);

      // shapeCheck only flagged boolean/number, so a string where a list belongs was
      // not even recorded as a schema problem.
      expect(result.schemaProblems.join(' ')).toContain('should be a list, not string');
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket reviewer schema — N1 the headline is text, never [object Object]', () => {
  const capture = scriptFor('captureReview');

  it('renders an object headline through asText instead of String()', () => {
    const { review } = loadFixture(FIXTURE_OBJECT_HEADLINE);
    const dir = repoWithWork();
    try {
      installReview(dir, review);
      const result = runJson(capture, { WT: dir }, dir);

      expect(String(result.headline)).not.toContain('[object Object]');
      expect(String(result.headline)).toContain('The change does not address the ticket');
      // The engineer's brief and the ticket comment both quote this field.
      const brief = runScript(scriptFor('handBackBriefing'), { WT: dir }, dir);
      expect(brief).not.toContain('[object Object]');
      expect(brief).toContain('The change does not address the ticket');
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket reviewer schema — N3 a rejection that asks for no work leaves the loop', () => {
  const capture = scriptFor('captureReview');
  const publishable = scriptFor('readPublishable');

  it('reports whether the review asks for any required work at all', () => {
    const gate = scriptFor('readRequiredWork');
    const withBlocker = repoWithWork();
    const nonBlockingOnly = repoWithWork();
    try {
      installReview(withBlocker, loadFixture(FIXTURE_A).review);
      runJson(capture, { WT: withBlocker }, withBlocker);
      expect(runScript(gate, { WT: withBlocker }, withBlocker).trim()).toBe('true');

      installReview(nonBlockingOnly, loadFixture(FIXTURE_NON_BLOCKING_ONLY).review);
      const captured = runJson(capture, { WT: nonBlockingOnly }, nonBlockingOnly);
      // It RESOLVES (the reviewer did say something) but there is nothing to fix.
      expect(captured.findingsResolved).toBe(true);
      expect(runScript(gate, { WT: nonBlockingOnly }, nonBlockingOnly).trim()).toBe('false');
    } finally {
      removeDir(withBlocker);
      removeDir(nonBlockingOnly);
    }
  });

  it('routes that state to the publish gate instead of handing it back for another cycle', () => {
    // Looping on it burned every permitted cycle telling the engineer to "address
    // EVERY required change" when the review required none, while the publish gate
    // would have published it as rejected_non_blocking immediately.
    expect(String(stepById('verdictBranch').config!.condition)).toContain('reviewRequiredWork');
    expect(String(stepById('reviewLoop').config!.condition)).toContain('reviewLoopSettled');

    const dir = repoWithWork();
    try {
      installReview(dir, loadFixture(FIXTURE_NON_BLOCKING_ONLY).review);
      runJson(capture, { WT: dir }, dir);
      expect(runScript(publishable, { WT: dir }, dir).trim()).toBe('true');
      expect(publishDecisionOf(dir).outcome).toBe('rejected_non_blocking');
    } finally {
      removeDir(dir);
    }
  });
});

describe('ProcessAITicket reviewer schema — the shared block is one block in THREE scripts', () => {
  const SCHEMA_OPEN = '// >>> shared review schema';
  const SCHEMA_CLOSE = '// <<< shared review schema';
  const blockOf = (script: string): string => {
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

  it('carries the identical block in readVerdict, the third verdict reader', () => {
    // readVerdict had no shared block at all: it re-derived the verdict with its own
    // `rv.verdict || rv.decision` expression (B1). Three readers, one table.
    const captureBlock = blockOf(scriptFor('captureReview'));
    expect(blockOf(scriptFor('readVerdict'))).toBe(captureBlock);
    expect(blockOf(scriptFor('readPublishable'))).toBe(captureBlock);
  });

  it('pins resolveVerdict and the one list coercion inside that block', () => {
    const block = blockOf(scriptFor('captureReview'));
    expect(block).toContain('const resolveVerdict = (raw) => {');
    expect(block).toContain('const schemaList = (obj, name, problems, label) => {');
    expect(block).toContain('const reviewList = (value) => {');
    expect(block).toContain('review_unavailable');
    // The unreachable-branch fix depends on the resolver reporting whether a verdict
    // was STATED at all, so that is pinned with the resolver itself.
    expect(block).toContain('stated');
  });
});
