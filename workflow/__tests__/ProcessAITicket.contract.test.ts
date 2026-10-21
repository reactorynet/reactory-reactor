/**
 * Contract tests for core.ProcessAITicket.
 *
 * These pin the behaviours the AI engineering pipeline depends on, because the
 * workflow is edited as YAML and a silent edit (a mis-nested `thenSteps`, a
 * lowered tool budget, a dropped status update) would only show up as a broken
 * run hours later. Nothing here executes the workflow: it parses and builds the
 * definition, then asserts its shape.
 *
 * The `cli_command` scripts that do the real git/gh work are exercised
 * separately; these assertions guard the wiring.
 */

import * as fs from 'fs';
import * as path from 'path';
import { YamlFlowParser } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/YamlFlowParser';
import { buildYamlWorkflowClass } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/YamlFlowBuilder';

const WORKFLOW_FILE = path.resolve(__dirname, '..', 'ProcessAITicket.yaml');

interface IStep {
  id: string;
  name?: string;
  type: string;
  dependsOn?: string | string[];
  config?: Record<string, any>;
}

const loadDefinition = (): any => {
  const parser = new YamlFlowParser({ validateSchema: true });
  const parsed = parser.parseFromFile(WORKFLOW_FILE) as any;
  if (!parsed.success) {
    throw new Error(`ProcessAITicket.yaml failed to parse: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed.workflow;
};

const def = loadDefinition();
const topLevel: IStep[] = def.steps || [];

/** Depth-first walk that also records the parent chain. */
const walk = (steps: IStep[], trail: string[] = []): Array<{ step: IStep; trail: string[] }> => {
  const out: Array<{ step: IStep; trail: string[] }> = [];
  (steps || []).forEach((step) => {
    out.push({ step, trail });
    const cfg = step.config || {};
    for (const key of ['thenSteps', 'elseSteps', 'steps']) {
      if (Array.isArray(cfg[key])) out.push(...walk(cfg[key], [...trail, step.id]));
    }
  });
  return out;
};

const all = walk(topLevel);
const byId = (id: string): IStep => {
  const hit = all.find((n) => n.step.id === id);
  if (!hit) throw new Error(`step "${id}" not found in ProcessAITicket.yaml`);
  return hit.step;
};
const indexOf = (id: string): number => all.findIndex((n) => n.step.id === id);

describe('core.ProcessAITicket definition', () => {
  it('declares the expected identity', () => {
    expect(def.nameSpace).toBe('core');
    expect(def.name).toBe('ProcessAITicket');
    expect(def.version).toBe('1.4.4');
  });

  it('builds into an engine workflow class', () => {
    // walk() runs inside build(), so a mis-nested branch or an unknown step type
    // throws here rather than at run time.
    const klass = buildYamlWorkflowClass(def);
    const instance = new klass();
    expect(instance.id).toBe('core.ProcessAITicket@1.4.4');
  });

  it('has no duplicate step ids and no dangling dependsOn', () => {
    const ids = all.map((n) => n.step.id);
    expect(ids.length).toBe(new Set(ids).size);

    const known = new Set(ids);
    const dangling: string[] = [];
    all.forEach(({ step }) => {
      const deps = Array.isArray(step.dependsOn) ? step.dependsOn : step.dependsOn ? [step.dependsOn] : [];
      deps.forEach((d) => {
        if (!known.has(d)) dangling.push(`${step.id} -> ${d}`);
      });
    });
    expect(dangling).toEqual([]);
  });

  it('nests every condition/while body inside config', () => {
    // A `thenSteps` beside `config` parses fine but is invisible to the builder,
    // so the branch silently never runs.
    const misplaced = all
      // These keys are not on IStep: their presence IS the defect, so look them up
      // dynamically rather than widening the interface to accommodate a bug.
      .filter(({ step }) => (step as Record<string, any>).thenSteps || (step as Record<string, any>).elseSteps || (step as Record<string, any>).steps)
      .map(({ step }) => step.id);
    expect(misplaced).toEqual([]);
  });

  it('allows a 12h run so the bounded merge poll cannot outlive the workflow', () => {
    expect(Number(def.metadata.timeout)).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000);
  });
});

describe('core.ProcessAITicket tool budgets', () => {
  it('gives the engineer at least 150 tool calls', () => {
    expect(Number(byId('engineer').config.maxToolIterations)).toBeGreaterThanOrEqual(150);
  });

  it('gives the reviewer at least 150 tool calls', () => {
    expect(Number(byId('review').config.maxToolIterations)).toBeGreaterThanOrEqual(150);
  });

  it('gives the hand-back turn at least 150 tool calls', () => {
    expect(Number(byId('handBack').config.maxToolIterations)).toBeGreaterThanOrEqual(150);
  });
});

describe('core.ProcessAITicket branch naming', () => {
  const script = String(byId('prepareWorktree').config.args[1]);

  it('derives the branch from the ticket reference, not a generated slug', () => {
    expect(script).toContain('const branch = prefix + \'/\' + flatRef;');
    expect(script).not.toContain("'ai-' + clean");
  });

  it('flattens the reference so the two slashes cannot nest the ref name', () => {
    expect(script).toContain('.replace(/[^A-Za-z0-9._-]+/g, \'-\')');
  });

  it('passes the ticket requestType through for the branch prefix', () => {
    expect(byId('prepareWorktree').config.env.REQUEST_TYPE).toContain('requestType');
  });

  it('reports the real branch of a reused worktree', () => {
    expect(script).toContain('git rev-parse --abbrev-ref HEAD');
  });
});

describe('core.ProcessAITicket ticket status transitions', () => {
  it('moves the ticket to in_progress before the engineer starts', () => {
    const mark = byId('markInProgress');
    expect(mark.type).toBe('service_invoke');
    expect(mark.config.method).toBe('updateStatus');
    expect(mark.config.params.status).toBe('in_progress');
    expect(indexOf('markInProgress')).toBeLessThan(indexOf('engineer'));
    expect(byId('engineer').dependsOn).toBe('openWorkspaceNote');
  });

  it('creates the persona workspace note before the engineer starts', () => {
    // The note must exist at engineer start, not be left to agent discretion:
    // ORG-003's note was stranded in workspace/notes/ forever because nothing
    // in the workflow knew a workspace existed.
    expect(indexOf('markInProgress')).toBeLessThan(indexOf('openWorkspaceNote'));
    expect(indexOf('openWorkspaceNote')).toBeLessThan(indexOf('engineer'));
    expect(byId('openWorkspaceNote').type).toBe('cli_command');
    expect(byId('openWorkspaceNote').config.env.MODE).toBe('open');
    expect(String(byId('openWorkspaceNote').config.args[1])).toContain('in-progress');
  });

  it('moves the ticket to resolved only once the pull request is merged', () => {
    const resolve = byId('resolveTicket');
    expect(resolve.config.method).toBe('updateStatus');
    expect(resolve.config.params.status).toBe('resolved');

    // resolveTicket must sit on the merged branch of mergeOutcome, never earlier.
    const node = all.find((n) => n.step.id === 'resolveTicket')!;
    expect(node.trail).toContain('mergeOutcome');
    expect(node.trail).toContain('prPublishedGate');
  });

  it('does not change status anywhere else', () => {
    const writes = all
      .filter(({ step }) => step.config && step.config.method === 'updateStatus')
      .map(({ step }) => `${step.id}:${step.config.params.status}`);
    expect(writes.sort()).toEqual(['markInProgress:in_progress', 'resolveTicket:resolved']);
  });
});

describe('core.ProcessAITicket publish and merge flow', () => {
  it('commits, pushes and opens a pull request in that order', () => {
    expect(indexOf('commitChanges')).toBeLessThan(indexOf('pushBranch'));
    expect(indexOf('pushBranch')).toBeLessThan(indexOf('createPullRequest'));
    expect(byId('pushBranch').config.args[1]).toContain('git push --set-upstream origin');
    expect(byId('createPullRequest').config.args[1]).toContain('gh pr create');
  });

  it('keeps the engineer agent from pushing', () => {
    const rules = String(byId('engineer').config.instructions);
    expect(rules).toMatch(/never commit, never push/i);
  });

  it('raises the human approval task with the pull request link', () => {
    const approval = byId('prApproval');
    expect(approval.type).toBe('user_activity');
    expect(approval.config.activityType).toBe('approval');
    expect(String(approval.config.message)).toContain('${steps.readPrUrl.outputs.stdout}');
    expect(String(approval.config.message).toLowerCase()).toContain('pull request');
  });

  it('replaces the old generic sign-off gate', () => {
    expect(all.find((n) => n.step.id === 'signoffGate')).toBeUndefined();
    expect(all.find((n) => n.step.id === 'signoff')).toBeUndefined();
  });

  it('polls GitHub every 3 minutes, at most 20 times', () => {
    const wait = byId('pollWait');
    expect(wait.type).toBe('delay');
    expect(Number(wait.config.duration)).toBe(180000);

    const poll = byId('pollMerge');
    expect(poll.type).toBe('while');
    expect(String(poll.config.condition)).toContain('prPollCount');
    expect(String(poll.config.condition)).toContain('< 20');
    expect(String(byId('checkMerge').config.command)).toBe('gh');
    expect(byId('checkMerge').config.args.join(' ')).toContain('pr view');
  });

  it('only polls after a human approved the pull request', () => {
    const node = all.find((n) => n.step.id === 'pollMerge')!;
    expect(node.trail).toContain('prPublishedGate');
    expect(String(node.step.config.condition)).toContain("variables.prApproved === 'true'");
  });

  it('leaves the ticket in_progress and raises a human task when the merge times out', () => {
    const task = byId('mergeTimeoutTask');
    expect(task.type).toBe('user_activity');
    expect(String(task.config.message)).toContain('${steps.readPrUrl.outputs.stdout}');

    const comment = String(byId('mergeTimeoutComment').config.params.comment);
    expect(comment).toContain('stays in_progress');
  });

  it('reports a publish failure instead of aborting the run', () => {
    expect(byId('commitChanges').config.failOnError).toBe(false);
    expect(byId('pushBranch').config.failOnError).toBe(false);
    expect(byId('createPullRequest').config.failOnError).toBe(false);
    expect(byId('publishFailedTask').type).toBe('user_activity');
  });
});

describe('core.ProcessAITicket commit hygiene', () => {
  it('keeps the run internals out of the commit', () => {
    // .ai-agent/ holds report.json and review.json. No target repository
    // gitignores it, so a bare 'git add -A' would publish them in the PR -
    // and an agent that only wrote a report would look dirty and yield an
    // empty commit.
    const script = String(byId('commitChanges').config.args[1]);
    expect(script).toContain(':(exclude).ai-agent');
    expect(script).not.toContain("execSync('git add -A && git commit'");
  });

  it('untracks run artifacts the agent committed itself', () => {
    // Observed live: the engineer ignored 'never commit', so report.json and
    // review.json were already in the branch and reached the pull request. An
    // agent that only wrote a report would also look dirty and yield an empty
    // commit. The step must untrack them and still commit.
    const script = String(byId('commitChanges').config.args[1]);
    expect(script).toContain('git ls-files .ai-agent');
    expect(script).toContain('git rm -r --cached');
    expect(script).toContain('!dirty.trim() && !internal');
  });

  it('does not mutate the shared .git/info/exclude', () => {
    // Writing there would leak the rule into the main checkout, which shares
    // its git directory with every worktree.
    expect(String(byId('prepareWorktree').config.args[1])).not.toContain('info/exclude');
  });
});

describe('core.ProcessAITicket review-loop resilience', () => {
  it('reads the revised report from disk, not through an env var', () => {
    // Observed live: a 20KB revision report passed via env made 'node -e' fail,
    // and because the step had failOnError the whole run TERMINATED - so a
    // rejected review could never be re-reviewed.
    const step = byId('reReadReportStatus');
    const script = String(step.config.args[1]);
    // It now reads the normalised side-car written by the shared capture script
    // rather than re-deriving the status allow-list from report.json.
    expect(script).toContain('run-status.json');
    expect(script).toContain('readFileSync');
    expect(step.config.env.REPORT).toBeUndefined();
    expect(step.config.failOnError).toBe(false);
  });

  it('reads the reviewer verdict from disk, not through an env var', () => {
    const step = byId('readVerdict');
    const script = String(step.config.args[1]);
    expect(script).toContain('review.json');
    expect(script).toContain('readFileSync');
    expect(step.config.failOnError).toBe(false);
  });

  it('treats changes_requested as a rejection', () => {
    // QualityQuinn returned 'changes_requested', which the old vocabulary did
    // not list; it only rejected via the unknown-verdict fallback.
    const script = String(byId('captureReview').config.args[1]);
    expect(script).toContain('changes_requested');
  });
});

describe('core.ProcessAITicket condition expressions', () => {
  // Template references use ${steps.id.outputs.key}; JS condition expressions use
  // steps.id.key, because the builder's accessor already unwraps 'outputs'.
  // Getting this wrong does not error loudly: the expression THROWS, the builder
  // swallows it and the condition returns false - which silently sent a successful
  // pull request down the publish-failure branch.
  const conditionExprs = (): Array<{ id: string; condition: string }> => {
    const out: Array<{ id: string; condition: string }> = [];
    const visit = (steps: IStep[]): void => {
      (steps || []).forEach((step) => {
        const cfg = step.config || {};
        if (typeof cfg.condition === 'string') out.push({ id: step.id, condition: cfg.condition });
        ['thenSteps', 'elseSteps', 'steps'].forEach((k) => {
          if (Array.isArray(cfg[k])) visit(cfg[k]);
        });
      });
    };
    visit(def.steps);
    return out;
  };

  it('never double-unwraps outputs in a condition', () => {
    const offenders = conditionExprs()
      .filter((c) => /steps\.[A-Za-z0-9_]+\.outputs\b/.test(c.condition))
      .map((c) => c.id);
    expect(offenders).toEqual([]);
  });

  it('evaluates every condition against a stub without throwing', () => {
    // Any identifier accessed off an undefined step throws, which the engine treats
    // as false. Assert the shape is at least evaluable, using the accessor shape.
    const failing: string[] = [];
    conditionExprs().forEach((c) => {
      const steps = new Proxy({}, { get: () => ({ stdout: 'x' }) }) as any;
      const variables = new Proxy({}, { get: () => 'x' }) as any;
      try {
        // eslint-disable-next-line no-new-func
        new Function('input', 'inputs', 'variables', 'env', 'steps', 'stepResults', 'workflow',
          `"use strict"; try { return (${c.condition}); } catch (e) { throw new Error(${JSON.stringify(c.id)} + ': ' + e.message); }`)
          ({}, {}, variables, {}, steps, {}, undefined);
      } catch (e: any) {
        failing.push(e.message);
      }
    });
    expect(failing).toEqual([]);
  });
});

describe('core.ProcessAITicket source file', () => {
  it('is the canonical module copy that gets provisioned on boot', () => {
    expect(fs.existsSync(WORKFLOW_FILE)).toBe(true);
  });
});

describe('core.ProcessAITicket PR template contract', () => {
  const script = String(byId('createPullRequest').config.args[1]);

  it('discovers the template case-insensitively in the documented order', () => {
    expect(script).toContain('pull_request_template.md');
    // .github first, then the repository root, then docs/.
    expect(script).toContain("const templateDirs = ['.github', '.', 'docs'];");
    expect(script).toContain('toLowerCase() === wanted');
  });

  it('merges generated content into the template instead of replacing it', () => {
    expect(script).toContain('parseTemplate');
    expect(script).toContain('HANDLERS');
    expect(script).toContain('section.heading');
    // Guidance blocks must be stripped, as the template itself instructs.
    expect(script).toContain('replace(/<!--[\\s\\S]*?-->/g');
    expect(script).toContain('applyTicks');
    expect(script).toContain('setRow');
  });

  it('still opens the pull request when the template is missing or unparseable', () => {
    expect(script).toContain('template contains no level-2 headings');
    expect(script).toContain('legacyBody');
    expect(script).toContain('PR template not applied');
  });

  it('records template warnings on the ticket', () => {
    expect(byId('readPrTemplateWarning').type).toBe('cli_command');
    expect(byId('prTemplateWarnGate').type).toBe('condition');
    expect(byId('prTemplateWarnComment').config.method).toBe('addComment');
  });

  it('reports the 1.4.4 footer and no stale version reference anywhere', () => {
    expect(script).toContain('Generated by core.ProcessAITicket@1.4.4');
    expect(JSON.stringify(def)).not.toContain('ProcessAITicket@1.4.3');
    expect(JSON.stringify(def)).not.toContain('ProcessAITicket@1.4.2');
  });
});

describe('core.ProcessAITicket workspace note lifecycle', () => {
  it('runs one note script in five modes, so the lifecycle cannot drift', () => {
    const modes = ['open', 'verify', 'reopen', 'close', 'retain'];
    const steps = ['openWorkspaceNote', 'verifyWorkspaceNote', 'reopenWorkspaceNote', 'closeWorkspaceNote', 'retainWorkspaceNoteExhausted', 'retainWorkspaceNoteBlocked'];
    const scripts = steps.map((id) => String(byId(id).config.args[1]));
    steps.forEach((id, index) => {
      expect(modes).toContain(byId(id).config.env.MODE);
      if (index > 0) expect(scripts[index]).toBe(scripts[0]);
    });
  });

  it('checks the note after the engineer session and closes it only after the PR exists', () => {
    expect(indexOf('engineer')).toBeLessThan(indexOf('verifyWorkspaceNote'));
    expect(indexOf('verifyWorkspaceNote')).toBeLessThan(indexOf('captureReport'));
    expect(indexOf('prPublishedComment')).toBeLessThan(indexOf('closeWorkspaceNote'));
    expect(indexOf('closeWorkspaceNote')).toBeLessThan(indexOf('prApprovalGate'));
    expect(byId('closeWorkspaceNote').config.env.PR_URL).toContain('steps.readPrUrl');
  });

  it('keeps the note in progress on rejection, blocked and failed runs', () => {
    expect(byId('reopenWorkspaceNote').config.env.MODE).toBe('reopen');
    expect(indexOf('reopenWorkspaceNote')).toBeLessThan(indexOf('handBack'));
    expect(byId('retainWorkspaceNoteExhausted').config.env.MODE).toBe('retain');
    expect(byId('retainWorkspaceNoteBlocked').config.env.MODE).toBe('retain');
  });

  it('writes the note outside the worktree and guards the diff', () => {
    const script = String(byId('openWorkspaceNote').config.args[1]);
    expect(script).toContain('refusing to write a note that could enter the PR diff');
    expect(script).toContain("path.relative(wt, workspace)");
    const guard = byId('workspaceDiffGuard');
    expect(guard.config.failOnError).toBe(false);
    expect(indexOf('workspaceDiffGuard')).toBeLessThan(indexOf('commitChanges'));
  });

  it('tells the engineer and the reviewer to use the note', () => {
    expect(String(byId('engineer').config.instructions)).toContain('NOTE PATH');
    expect(String(byId('engineer').config.message)).toContain('steps.readNotePath');
    expect(String(byId('review').config.instructions)).toContain('workspace note');
    expect(String(byId('review').config.message)).toContain('steps.readNotePath');
  });
});

describe('core.ProcessAITicket single status normaliser', () => {
  const scripts = () => all.map(({ step }) => String((step.config && step.config.args && step.config.args[1]) || ''));

  it('has no second copy of the status allow-list', () => {
    const offenders = scripts().filter((script) => script.indexOf("const allowed = ['completed'") !== -1);
    expect(offenders).toEqual([]);
  });

  it('shares one capture script between capture and re-capture', () => {
    expect(String(byId('captureReport').config.args[1])).toBe(String(byId('reCaptureReport').config.args[1]));
    expect(String(byId('readReportStatus').config.args[1])).toBe(String(byId('reReadReportStatus').config.args[1]));
  });

  it('normalises the documented vocabulary and widens the work heuristic', () => {
    const script = String(byId('captureReport').config.args[1]);
    ['complete', 'done', 'finished', 'success', 'succeeded', 'resolved'].forEach((word) => {
      expect(script).toContain("'" + word + "'");
    });
    expect(script).toContain('STATUS_SYNONYMS');
    ['changes', 'files', 'implementation', 'acceptanceCriteria', 'diff'].forEach((key) => {
      expect(script).toContain("'" + key + "'");
    });
    expect(script).toContain('git rev-list --count');
  });

  it('reads the status from the single normaliser rather than re-deriving it', () => {
    const reader = String(byId('readReportStatus').config.args[1]);
    expect(reader).toContain('run-status.json');
    expect(reader).not.toContain('STATUS_SYNONYMS');
  });
});

describe('core.ProcessAITicket review findings contract', () => {
  const script = String(byId('captureReview').config.args[1]);

  it('resolves camelCase, snake_case and kebab-case keys', () => {
    expect(script).toContain('requiredChanges');
    expect(script).toContain('required_changes');
    expect(script).toContain('blockingFindings');
    expect(script).toContain('blocking_findings');
    expect(script).toContain('acceptanceCriteria');
    expect(script).toContain('acceptance_criteria');
    expect(script).toContain('normaliseKey');
  });

  it('hands structured findings back instead of raw JSON the engineer must go read', () => {
    const handBack = String(byId('handBack').config.message);
    expect(handBack).toContain('steps.handBackBriefing');
    expect(handBack).not.toContain('steps.captureReview.outputs.stdout');
    expect(indexOf('captureReview')).toBeLessThan(indexOf('handBackBriefing'));
  });

  it('blocks a rejected verdict with no resolvable findings', () => {
    expect(byId('findingsHaltGate').type).toBe('condition');
    expect(byId('findingsHaltGate').config.condition).toContain("reviewFindingsResolved === 'false'");
    expect(byId('findingsHaltComment').config.method).toBe('addComment');
    expect(byId('findingsHaltTask').type).toBe('user_activity');
    // The halt must break the loop, not spin it.
    expect(String(byId('reviewLoop').config.condition)).toContain("variables.runHalt !== 'true'");
  });
});

describe('core.ProcessAITicket primary checkout safety', () => {
  const script = String(byId('submoduleGuardSnapshot').config.args[1]);

  it('detects submodules by their 160000 git mode', () => {
    expect(script).toContain('160000');
    expect(script).toContain('git ls-files -s');
  });

  it('inspects the consumer working copies that mount the worktree repo', () => {
    // Defect 6: REPO has no 160000 entries of its own when the worktree repo is
    // mounted elsewhere, so a REPO-only snapshot is legitimately empty and the
    // guard silently protects nothing. The consumer scan must be unconditional.
    expect(script).toContain('consumerRoots');
    expect(script).toContain('mountsRepo');
    expect(script).toContain('consumersScanned');
  });

  it('does not treat an empty worktree submodule list as a clean verdict', () => {
    // The consumer scan must run before "nothing to do" is concluded, and verify
    // must not report success with no baseline to compare against.
    expect(script).toContain('baselineFound');
    expect(script).toContain('no submodule baseline was captured');
  });

  it('snapshots before and restores after the engineer runs', () => {
    expect(indexOf('submoduleGuardSnapshot')).toBeLessThan(indexOf('engineer'));
    expect(indexOf('engineer')).toBeLessThan(indexOf('submoduleGuardVerify'));
    expect(script).toContain('git checkout --detach');
    expect(String(byId('submoduleGuardVerify').config.args[1])).toBe(script);
  });

  it('forbids in-place submodule checkouts in the engineer prompt', () => {
    const rules = String(byId('engineer').config.instructions);
    expect(rules).toContain('grep 160000');
    expect(rules).toContain('never');
    expect(rules.toLowerCase()).toContain('primary checkout');
  });

  it('hands agents the disposable-clone recipe as the default path', () => {
    // The previous fix left the recipe alone and prompt rules did not prevent
    // the mutation in practice, so the safe path has to BE the recipe.
    const rules = String(byId('engineer').config.instructions);
    expect(rules).toContain('mktemp -d');
    expect(rules).toContain('git clone --shared --no-checkout');
    expect(rules).toContain('npx --no-install tsc --noEmit');
    expect(rules).toContain('rm -rf');
    // Reusing the consumer's node_modules is what made in-place look necessary.
    expect(rules).toContain('node_modules');
  });

  it('offers no in-place escape hatch to agents', () => {
    const rules = String(byId('engineer').config.instructions);
    expect(rules).not.toContain('If you must touch a submodule in place');
    expect(rules).not.toContain('record its SHA first and restore it');
  });
});
