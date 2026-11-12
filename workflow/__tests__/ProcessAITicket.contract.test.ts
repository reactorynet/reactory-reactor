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
  /** Step-level tolerance: a failing step that must not end the instance. */
  continueOnError?: boolean;
  /** Mutually exclusive with `continueOnError` — see YamlStepBody.ts. */
  retryPolicy?: Record<string, any>;
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
  it('describes post-publication observation and the publish lifecycle', () => {
    const description = String(def.description);
    expect(description).toContain('OBSERVES');
    expect(description).toContain('maxPostPublishFixCycles');
    expect(description).toContain('awaiting_human');
    expect(description).toContain('blocked_needs_human');
    // The old text claimed the run only polled for the merge.
    expect(description).not.toContain('Once the review passes it\n  commits, pushes and opens a pull request, raises a human approval task');
  });

  it('declares the expected identity', () => {
    expect(def.nameSpace).toBe('core');
    expect(def.name).toBe('ProcessAITicket');
    expect(def.version).toBe('1.4.8');
  });

  it('builds into an engine workflow class', () => {
    // walk() runs inside build(), so a mis-nested branch or an unknown step type
    // throws here rather than at run time.
    const klass = buildYamlWorkflowClass(def);
    const instance = new klass();
    expect(instance.id).toBe('core.ProcessAITicket@1.4.8');
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
    // WORKFLOW-003: the engineer is gated on a validated primary-checkout baseline, so the
    // note (and the guard snapshot) must both complete before the session is allowed to start.
    expect(byId('engineer').dependsOn).toBe('submoduleBaselineGate');
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
  it('commits, gates on the commit, pushes and opens a pull request in that order', () => {
    expect(indexOf('commitChanges')).toBeLessThan(indexOf('readPublishReadiness'));
    // The readiness gate sits between the commit and the push: it is the only point at
    // which git can answer "is there a commit to publish?".
    expect(indexOf('readPublishReadiness')).toBeLessThan(indexOf('publishReadinessGate'));
    expect(indexOf('publishReadinessGate')).toBeLessThan(indexOf('pushBranch'));
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

  it('keeps the commit soft and hard-stops the publish path after it', () => {
    // Two deliberately separate guarantees. The COMMIT step is soft, because a fatal step
    // terminates the instance with no ticket comment, no human task and a non-terminal
    // runStatus - a pinned run, which is the failure this ticket exists to remove.
    const commit = byId('commitChanges').config;
    // Assert the key is written explicitly; CliCommandStep treats anything but an exact
    // `false` as fatal, so a value-only assertion would pass either way.
    expect('failOnError' in commit).toBe(true);
    expect(commit.failOnError).toBe(false);

    // The publish path is still hard-stopped, but only after the comment, the human task
    // and the terminal runStatus are in place.
    expect(byId('publishReadinessGate').type).toBe('condition');
    expect((byId('pushBranch') as any).dependsOn).toBe('publishReadinessGate');
    expect('failOnError' in byId('publishBlockHalt').config).toBe(true);
    expect(byId('publishBlockHalt').config.failOnError).toBe(true);
    expect(byId('publishBlockComment').type).toBe('service_invoke');
    expect(byId('publishBlockTask').type).toBe('user_activity');
    expect(byId('setRunStatusPublishBlocked').config.value).toBe('blocked');

    // Talking to GitHub stays soft, so a failed push or PR still ends with a comment and
    // a human task instead of a dead instance.
    expect(byId('pushBranch').config.failOnError).toBe(false);
    expect(byId('createPullRequest').config.failOnError).toBe(false);
    expect(byId('publishFailedTask').type).toBe('user_activity');
  });
});

describe('core.ProcessAITicket commit hygiene', () => {
  it('keeps the run internals out of the commit', () => {
    // .ai-agent/ holds report.json and review.json. The step stages with a plain
    // 'git add -A' and then unstages the artefacts: a negative pathspec on the add
    // makes git fail on an ignored path (the W4/W9b data loss), while the rm
    // --cached works whether or not the repository ignores the directory.
    const script = String(byId('commitChanges').config.args[1]);
    expect(script).toContain("run('git add -A')");
    expect(script).toContain('git rm -r --cached --quiet --ignore-unmatch -- .ai-agent');
    expect(script).not.toContain("execSync('git add -A -- . ");
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

    // Revision 2: the STAMPED review.json is read first, and the side-car is only
    // used afterwards (to cross-check, or to honour a capture-failure verdict). A
    // side-car read first would let a rewritten review-normalised.json drive the
    // review loop.
    expect(script).toContain('const stampedVerdict');
    expect(script).toContain('review-accepted.json');
    expect(script).toContain('crypto');
    const stampedAt = script.indexOf('const stampedVerdict');
    // The side-car READ (the comment above also names the file, so match the call).
    const sideCarAt = script.indexOf("readJson('review-normalised.json')");
    expect(stampedAt).toBeGreaterThan(-1);
    expect(sideCarAt).toBeGreaterThan(-1);
    expect(stampedAt).toBeLessThan(sideCarAt);
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

  it('reports the current footer and no stale version reference anywhere', () => {
    expect(script).toContain('Generated by core.ProcessAITicket@1.4.8');
    // The whole definition must speak one version. A body that renders the OLD
    // marker is indistinguishable from a pre-bump body — which is exactly what
    // made the 1.4.6 generator's defects impossible to attribute (see
    // REACTORY-302016408/20261028/3330908249).
    ['1.4.6', '1.4.5', '1.4.3', '1.4.2'].forEach((stale) => {
      expect(JSON.stringify(def)).not.toContain('ProcessAITicket@' + stale);
    });
  });

  it('stamps the footer with the definition version, so the two cannot diverge', () => {
    // The footer is the only marker a reader of a pull request has. It was
    // hard-coded while `version:` moved, so a body generated by a rewritten
    // generator was indistinguishable from the defective artefact that shares
    // its footer. This assertion is structural rather than a literal: bump the
    // YAML and the footer must move with it, or this fails.
    const footerVersions = Array.from(
      script.matchAll(/Generated by core\.ProcessAITicket@([0-9]+\.[0-9]+\.[0-9]+)/g),
    ).map((match) => match[1]);

    expect(footerVersions).toEqual([def.version]);
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

describe('core.ProcessAITicket worktree base contracts (WORKFLOW-002)', () => {
  const script = String(byId('prepareWorktree').config.args[1]);
  const addLines = script.split('\n').filter((line) => line.indexOf('git worktree add') !== -1);

  it('fetches the remote default branch before creating the worktree', () => {
    expect(script).toContain('resolveRemoteDefault');
    expect(script).toContain("refs/remotes/origin/HEAD");
    expect(script).toContain('git fetch ');
    expect(script).toContain('--prune');
    expect(script).toContain('fetchOk');
    expect(script).toContain('baseWarnings');
  });

  it('bases the worktree on the remote-tracking ref, never on HEAD', () => {
    expect(script).toContain("const baseRef = remoteDefault.ref;");
    expect(script).toContain("const baseSha = tryRunIn('git rev-parse ' + baseRef);");
    // The pre-1.4.5 defect: `-b <branch>` with no commit-ish after it.
    const defective = addLines.filter((line) => /-b "' \+ branch \+ '"\s*[,)]/.test(line));
    expect(defective).toEqual([]);
  });

  it('emits baseRef and baseSha in the step output', () => {
    expect(script).toContain('baseRef: baseRef,');
    expect(script).toContain('baseSha: baseSha,');
    expect(script).toContain('headBranch: headBranch,');
    expect(script).toContain('headSha: headSha,');
    expect(script).toContain('remoteDefault: remoteDefault.name,');
    expect(script).toContain('fetchOk: fetchOk,');
  });

  it('surfaces an off-default checkout as a ticket warning', () => {
    expect(script).toContain("if (headBranch !== remoteDefault.name)");
    expect(byId('readWorktreeBaseWarning').type).toBe('cli_command');
    expect(String(byId('worktreeBaseWarnGate').config.condition)).toContain("steps.readWorktreeBaseWarning.stdout !== ''");
    expect(byId('worktreeBaseWarnComment').config.method).toBe('addComment');
  });

  it('validates a pre-existing local branch instead of reusing it blindly', () => {
    expect(script).toContain("const branchRef = 'refs/heads/' + branch;");
    expect(script).toContain('does not descend from');
    expect(script).toContain('isAncestor(cwd, branchSha, baseSha)');
  });

  it('keeps reporting reused worktrees with their real branch', () => {
    expect(script).toContain('reused: true,');
    expect(script).toContain('git rev-parse --abbrev-ref HEAD');
    expect(script).toContain('derivedFromBase');
  });
});

describe('core.ProcessAITicket baseline validation contracts (WORKFLOW-003)', () => {
  const script = String(byId('submoduleGuardSnapshot').config.args[1]);

  it('validates the observed mount HEAD against the remote default branch', () => {
    expect(script).toContain('resolveDefault');
    expect(script).toContain('merge-base --is-ancestor');
    expect(script).toContain('headShaClean');
    expect(script).toContain('headShaDirty');
    expect(script).toContain('baselineReady');
  });

  it('rejects a baseline that is not an ancestor of origin/<default> as a restore target', () => {
    expect(script).toContain('is not a restore target');
    expect(script).toContain('unsafeBaselines');
    expect(script).toContain('recorded as dirty, not adopted');
  });

  it('records pre-existing gitlink drift without restoring or committing it', () => {
    expect(script).toContain('indexDrift');
    expect(script).toContain('neither restored nor committed');
  });

  it('serialises runs per consumer mount', () => {
    expect(script).toContain('reactor-mount-');
    expect(script).toContain('acquireLock');
    expect(script).toContain('releaseLock');
    expect(script).toContain('RUN_ID');
    expect(String(byId('submoduleGuardSnapshot').config.env.RUN_ID)).toContain('reference');
  });

  it('refuses to start the engineer on a contaminated baseline', () => {
    // The engineer no longer runs before the guard: the baseline is validated and
    // a bad one stops the run with a ticket comment and a human task.
    expect(byId('engineer').dependsOn).toBe('submoduleBaselineGate');
    expect(String(byId('submoduleBaselineGate').config.condition)).toContain("!== 'blocked'");
    expect(indexOf('submoduleGuardSnapshot')).toBeLessThan(indexOf('submoduleBaselineGate'));
    expect(indexOf('submoduleBaselineGate')).toBeLessThan(indexOf('engineer'));
    expect(byId('submoduleBaselineBlockedComment').config.method).toBe('addComment');
    expect(byId('submoduleBaselineHalt').config.failOnError).toBe(true);
  });

  it('reports a mount defect on the ticket, not only in the log', () => {
    const reader = String(byId('readSubmoduleMutation').config.args[1]);
    expect(reader).toContain('violations');
    expect(reader).toContain('unsafeBaselines');
    expect(reader).toContain('baselineReady');
    expect(byId('submoduleGuardComment').config.method).toBe('addComment');
  });
});

/**
 * REACTORY-302016408 - the loop's exit condition.
 *
 * The workflow is YAML, so a plausible-looking edit (a gate that still tests only
 * `approved`, a halt that forgets to break the loop) would only show up as a
 * stranded branch hours later. These assertions pin the wiring of the fix.
 */
describe('core.ProcessAITicket exit condition contracts (REACTORY-302016408)', () => {
  it('runs a one-shot confirmation review after the loop rather than restructuring it', () => {
    expect(byId('confirmationReviewGate').type).toBe('condition');
    expect(byId('confirmationReviewGate').config.condition).toContain("variables.reviewVerdict === 'rejected'");
    expect(byId('confirmationReviewGate').config.condition).toContain("variables.confirmationReview !== 'true'");
    expect(byId('confirmationReviewGate').config.condition).toContain("variables.runHalt !== 'true'");

    expect(indexOf('reviewLoop')).toBeLessThan(indexOf('confirmationReviewGate'));
    expect(indexOf('confirmationReviewGate')).toBeLessThan(indexOf('outcome'));

    // A confirmation review is one reviewer turn, not a second loop.
    expect(byId('confirmationReview').type).toBe('agent_conversation');
    expect(byId('confirmationReview').config.personaId).toBe('${input.reviewerId}');
    expect(byId('setConfirmationRan').config.value).toBe('true');
    expect(JSON.stringify(def)).not.toContain('confirmationCycle');

    // It normalises a verdict exactly the way the loop does.
    expect(String(byId('captureConfirmationReview').config.args[1])).toBe(String(byId('captureReview').config.args[1]));
    expect(String(byId('readConfirmationVerdict').config.args[1])).toBe(String(byId('readVerdict').config.args[1]));

    // "Did the engineer revise after the last review" is decided from the artefact mtimes.
    const assess = String(byId('assessConfirmationNeed').config.args[1]);
    expect(assess).toContain('report.json');
    expect(assess).toContain('review.json');
    expect(assess).toContain('mtimeMs');
  });

  it('gates publication on the publish decision, not on an approved verdict alone', () => {
    expect(byId('outcome').config.condition).toBe("variables.publishable === 'true'");
    expect(String(byId('outcome').config.condition)).not.toContain("reviewVerdict === 'approved'");

    const script = String(byId('readPublishable').config.args[1]);
    expect(script).toContain('blockingFlag');
    expect(script).toContain('rejected_non_blocking');
    expect(script).toContain('publish-decision.json');
    // Fail closed: unstated blocking flags are counted, never read as non-blocking.
    expect(script).toContain('blocking === 0 && unstated === 0 && nonBlocking > 0');

    // REACTORY-302016408 (revision 2). The DECISION is taken from the stamped
    // bytes, not from the side-car. Reading the verdict from an agent-writable
    // file is what let a rewritten review-normalised.json flip a rejection into an
    // approval while the stamped review.json still said rejected.
    expect(script).toContain("review-accepted.json");
    expect(script).toContain('const stampedVerdict');
    expect(script).toContain('const claimedVerdict');
    expect(script).toContain('review-normalised.json says');
    expect(script).toContain('const attributable = !stampedProblem');
    // Findings are classified from the stamped bytes too, so the non-blocking
    // publish path cannot be re-labelled through the side-car.
    expect(script).toContain('const findingsSource = stampedInner');
    expect(script).toContain('resolveKey(findingsSource');
  });

  it('reports a capture failure as review_unavailable and never as rejected', () => {
    const script = String(byId('captureReview').config.args[1]);
    expect(script).toContain("fail('review_unavailable', 'review.json not found')");
    expect(script).not.toContain("fail('rejected', 'review.json not found')");
    expect(script).toContain('reviewAvailable: false');

    expect(byId('reviewUnavailableGate').type).toBe('condition');
    expect(byId('reviewUnavailableGate').config.condition).toBe("variables.reviewVerdict === 'review_unavailable'");
    expect(byId('reviewUnavailableComment').config.method).toBe('addComment');
    expect(byId('reviewUnavailableTask').type).toBe('user_activity');
    expect(byId('setRunHaltUnavailable').config.value).toBe('true');

    // It must not consume a review cycle.
    const bump = String(byId('bumpCycle').config.args[1]);
    expect(bump).toContain("=== 'review_unavailable'");
    expect(bump).toContain('unavailable ? cycle : cycle + 1');
  });

  it('sets a terminal runStatus and an honest prState on every path that runs its steps', () => {
    const value = (id: string): string => String(byId(id).config.value);
    const trailOf = (id: string): string[] => (all.find((n) => n.step.id === id) || { trail: [] as string[] }).trail;

    // Each EXIT PATH is enumerated: the setter's value, and the branch it lives under,
    // so a setter that drifts into the wrong branch fails here. (The earlier version of
    // this test proved only two ordering relationships, which was not the claim.)
    const EXITS: Array<{ id: string; value: string; trail: string[] }> = [
      { id: 'setRunStatusCompleted', value: 'completed', trail: ['reportBranch', 'outcome', 'prPublishedGate'] },
      { id: 'setRunStatusPublishFailed', value: 'failed', trail: ['reportBranch', 'outcome', 'prPublishedGate'] },
      { id: 'setRunStatusExhausted', value: 'blocked', trail: ['reportBranch', 'outcome'] },
      { id: 'setRunStatusUnavailable', value: 'blocked', trail: ['reportBranch', 'reviewLoop'] },
      { id: 'setRunStatusBlocked', value: 'blocked', trail: ['reportBranch'] },
      { id: 'setRunStatusNoTicket', value: 'blocked', trail: ['ticketGuard'] },
    ];

    EXITS.forEach((exit) => {
      expect(value(exit.id)).toBe(exit.value);
      const trail = trailOf(exit.id);
      exit.trail.forEach((parent) => expect(trail).toContain(parent));
    });

    const PR_STATE_EXITS: Array<{ id: string; trail: string[] }> = [
      { id: 'setPrStateNotOpenedExhausted', trail: ['reportBranch', 'outcome'] },
      { id: 'setPrStateNotOpenedBlocked', trail: ['reportBranch'] },
      { id: 'setPrStatePublishFailed', trail: ['reportBranch', 'outcome', 'prPublishedGate'] },
      { id: 'setPrStateNoTicket', trail: ['ticketGuard'] },
    ];

    PR_STATE_EXITS.forEach((exit) => {
      expect(value(exit.id)).toBe('NOT_OPENED');
      const trail = trailOf(exit.id);
      exit.trail.forEach((parent) => expect(trail).toContain(parent));
    });

    // A run that opened a pull request records the state the create call returned.
    expect(byId('setPrStateOpened').config.sourcePath).toBe('readCreatedPrState.outputs.stdout');

    // DOCUMENTED BOUNDARY: guardInputs, prepareWorktree and submoduleBaselineHalt are
    // failOnError steps that TERMINATE the instance from inside their own step. No later
    // step can run, so no variable can be set on those paths - the instance ends failed,
    // not pending. Asserted so the boundary is deliberate rather than an omission.
    ['guardInputs', 'prepareWorktree', 'submoduleBaselineHalt'].forEach((id) => {
      expect(byId(id).config.failOnError).toBe(true);
    });
  });

  it('reports a branch that was published before the review instead of adopting it', () => {
    // RC-2: an engineer that pushes early defeats the publish gate this ticket is about.
    expect(byId('detectPrematurePublish').type).toBe('cli_command');
    const script = String(byId('detectPrematurePublish').config.args[1]);
    expect(script).toContain('git ls-remote --heads origin');
    expect(script).toContain('gh pr list --head');

    expect(byId('prematurePublishGate').type).toBe('condition');
    expect(byId('prematurePublishGate').config.condition).toBe("steps.readPrematurePublish.stdout === 'yes'");
    expect(byId('prematurePublishComment').config.method).toBe('addComment');
    expect(String(byId('prematurePublishComment').config.params.comment)).toContain('PROCESS VIOLATION');

    // The check runs BEFORE the review, so the reviewer is told, not protected from it.
    expect(indexOf('detectPrematurePublish')).toBeLessThan(indexOf('reviewLoop'));
    expect(byId('reviewLoop').dependsOn).toBe('prematurePublishGate');
    expect(String(byId('review').config.message)).toContain('steps.readPrematurePublishSummary');
  });

  it('gives the reviewer the committed diff against the base, not a diff against HEAD', () => {
    // RC-3: `git diff --stat HEAD` reports nothing for a committed run, so the reviewer
    // was handed "no changes detected" as its change evidence.
    const script = String(byId('diffstat').config.args[1]);
    // The COMMAND must be the base form; the old HEAD-only invocation may survive only
    // as the explanatory comment above it.
    expect(script).not.toContain("git('git diff --stat HEAD')");
    expect(script).toContain("git('git diff --stat ' + base + '...HEAD')");
    expect(script).toContain('git status --porcelain');
    expect(script).toContain('resolveBase');
  });

  it('hardens revision detection beyond the report mtime alone', () => {
    // RC-4: a code change with no report rewrite must still trigger the confirmation pass.
    const script = String(byId('assessConfirmationNeed').config.args[1]);
    expect(script).toContain('touchedAtOrAfterReview');
    expect(script).toContain('git status --porcelain');
    expect(script).toContain('git log -1 --format=%ct');
  });

  it('warns the human when work is published on non-blocking grounds', () => {
    expect(byId('nonBlockingPublishGate').config.condition).toContain("variables.reviewVerdict === 'rejected'");
    expect(byId('nonBlockingPublishComment').config.method).toBe('addComment');

    const pr = String(byId('createPullRequest').config.args[1]);
    expect(pr).toContain('rejected_non_blocking');
    expect(pr).toContain('Review status');
  });

  it('distinguishes a rejection from a run that could not be reviewed on the ticket', () => {
    const narrative = String(byId('readReviewOutcomeNarrative').config.args[1]);
    expect(narrative).toContain('COULD NOT BE REVIEWED');
    expect(narrative).toContain('REJECTED');

    expect(String(byId('exhaustedComment').config.params.comment)).toContain('steps.readReviewOutcomeNarrative');
    expect(String(byId('exhaustedLog').config.message)).toContain('steps.readReviewOutcomeNarrative');
  });
});

/**
 * Programme outcome reporting (1.4.8) — the SHAPE of the bridge.
 *
 * A programme child is failed `child_completed_unreported` when it ends without
 * reporting, so the bridge has to cover every terminal path. Two of those paths
 * ABORT the instance (`submoduleBaselineHalt`, `publishBlockHalt` exit 1 with
 * failOnError), and a step placed after a terminating step never runs — so those
 * two report from inside their own branch, immediately before the halt.
 *
 * These assertions are about the graph, not about prose: which scope each call
 * sits in, what guards it, and where it sits relative to the step that halts.
 */
describe('core.ProcessAITicket programme reporting', () => {
  /** Every scope carries its own id and which branch of the parent it came from. */
  interface IScopeRef { id: string; branch: 'root' | 'thenSteps' | 'elseSteps' | 'steps' }
  interface ISite { step: IStep; ancestors: IScopeRef[]; scopeOrder: string[] }

  const collect = (): ISite[] => {
    const out: ISite[] = [];
    const visit = (steps: IStep[], ancestors: IScopeRef[]): void => {
      const scopeOrder = (steps || []).map((step) => step.id);
      (steps || []).forEach((step) => {
        out.push({ step, ancestors, scopeOrder });
        const cfg = step.config || {};
        (['thenSteps', 'elseSteps', 'steps'] as const).forEach((key) => {
          if (Array.isArray(cfg[key])) visit(cfg[key], [...ancestors, { id: step.id, branch: key }]);
        });
      });
    };
    visit(def.steps, []);
    return out;
  };

  const sites = (): ISite[] => collect().filter((site) => site.step.config?.method === 'reportPackageOutcome');
  const site = (id: string): ISite => {
    const hit = sites().find((entry) => entry.step.id === id);
    if (!hit) throw new Error(`report site "${id}" not found`);
    return hit;
  };
  const inBranch = (entry: ISite, gateId: string, branch: IScopeRef['branch']): boolean =>
    entry.ancestors.some((ancestor) => ancestor.id === gateId && ancestor.branch === branch);

  it('declares the reconciler fields as OPTIONAL inputs, so the Support path is unaffected', () => {
    ['dispatchId', 'programmeId', 'packageId'].forEach((name) => {
      const input = (def.inputs || {})[name];
      expect(input).toBeDefined();
      expect(input.type).toBe('string');
      expect(input.required).toBe(false);
      // A default would make every Support-path run look programme-dispatched.
      expect(input.default).toBeUndefined();
    });
  });

  it('leaves every pre-existing input exactly as it was', () => {
    expect(def.inputs.agentId.required).toBe(true);
    expect(def.inputs.reviewerId.default).toBe('QualityQuinn');
    expect(def.inputs.requireSignoff.default).toBe(true);
    expect(def.inputs.maxReviewCycles.type).toBe('number');
  });

  it('reports on every terminal path: one fall-through gate and one ahead of each halt', () => {
    const found = sites().map((entry) => entry.step.id).sort();
    expect(found).toEqual([
      'reportProgrammeOutcome',
      'reportPublishBlockOutcome',
      'reportSubmoduleBaselineOutcome',
    ]);

    // Every one of them is a guarded service_invoke, never a top-level call, so
    // there is no path on which a Support-path run reaches one.
    sites().forEach((entry) => {
      expect(entry.step.type).toBe('service_invoke');
      expect(entry.step.config!.service).toBe('reactor.WorkflowProgrammeService@1.0.0');
      expect(entry.ancestors.length).toBeGreaterThan(0);
      expect(topLevel.map((step) => step.id)).not.toContain(entry.step.id);
    });
  });

  it('guards every report on the dispatch probe, not on input.dispatchId', () => {
    // An unset optional input arrives as the unresolved token `${input.dispatchId}`,
    // which is TRUTHY. A bare `input.dispatchId &&` condition would therefore fire
    // on every Support-path run.
    const probe = byId('readProgrammeDispatch');
    expect(probe.type).toBe('cli_command');
    expect(probe.config!.env.DISPATCH_ID).toBe('${input.dispatchId}');
    expect(String(probe.config!.args[1])).toContain('indexOf(TOK) !== -1');

    // The probe precedes the ticket guard, because the two halting branches report
    // from inside the ticket-guarded pipeline.
    const order = def.steps.map((step: IStep) => step.id);
    expect(order.indexOf('readProgrammeDispatch')).toBeLessThan(order.indexOf('ticketGuard'));

    // Each report's NEAREST guarding condition is the probe.
    sites().forEach((entry) => {
      const nearestGate = [...entry.ancestors].reverse().find((ancestor) => byId(ancestor.id).type === 'condition');
      expect(nearestGate).toBeDefined();
      expect(String(byId(nearestGate!.id).config!.condition)).toBe("steps.readProgrammeDispatch.stdout !== ''");
    });
  });

  it('reports a publish-readiness block BEFORE the step that halts the instance', () => {
    const entry = site('reportPublishBlockOutcome');
    expect(inBranch(entry, 'publishReadinessGate', 'elseSteps')).toBe(true);

    // Authored before the halt in the SAME scope: `publishBlockHalt` exits 1 and
    // terminates the instance, so a step after it would never run. The gate's own
    // sibling list is the one that matters (the report lives inside the gate).
    const order = collect().find((site) => site.step.id === 'publishBlockReportGate')!.scopeOrder;
    expect(order.indexOf('publishBlockReportGate')).toBeGreaterThan(-1);
    expect(order.indexOf('publishBlockReportGate')).toBeLessThan(order.indexOf('publishBlockHalt'));

    expect(entry.step.config!.params.status).toBe('failed');
    expect(entry.step.config!.params.error).toBe('${steps.describePublishBlock.outputs.stdout}');
    expect(Object.keys(entry.step.config!.params).sort()).toEqual(['dispatchId', 'error', 'status']);

    // The halt itself is untouched: it must still terminate the run.
    const halt = byId('publishBlockHalt');
    expect(halt.type).toBe('cli_command');
    expect(halt.config!.failOnError).toBe(true);
    expect(String(halt.config!.args[1])).toContain('process.exit(1)');
  });

  it('reports a contaminated baseline BEFORE the step that halts the instance', () => {
    const entry = site('reportSubmoduleBaselineOutcome');
    expect(inBranch(entry, 'submoduleBaselineGate', 'elseSteps')).toBe(true);

    const order = collect().find((site) => site.step.id === 'submoduleBaselineReportGate')!.scopeOrder;
    expect(order.indexOf('submoduleBaselineReportGate')).toBeLessThan(order.indexOf('submoduleBaselineHalt'));

    expect(entry.step.config!.params.status).toBe('failed');
    expect(entry.step.config!.params.error).toBe('${steps.readProgrammeBaselineBlock.outputs.stdout}');
    expect(Object.keys(entry.step.config!.params).sort()).toEqual(['dispatchId', 'error', 'status']);

    // A human-readable summary, not raw guard JSON, because it becomes lastError.
    const summary = byId('readProgrammeBaselineBlock');
    expect(summary.type).toBe('cli_command');
    expect(String(summary.config!.args[1])).toContain('primary-checkout baseline is not usable');

    const halt = byId('submoduleBaselineHalt');
    expect(halt.config!.failOnError).toBe(true);
    expect(String(halt.config!.args[1])).toContain('process.exit(1)');
  });

  it('tolerates a failed report on every path, and says so loudly', () => {
    sites().forEach((entry) => {
      expect(entry.step.continueOnError).toBe(true);
      // Mutually exclusive with continueOnError: such a step returns next() and
      // never throws, so `.onError(Retry)` is unreachable (YamlStepBody.ts).
      expect(entry.step.retryPolicy).toBeUndefined();
    });

    // `continueOnError` covers a THROWN failure; a returned `reported: false` is
    // not an error, so an explicit WARN branch covers it.
    expect(byId('programmeOutcomeLanded').type).toBe('condition');
    expect(byId('programmeOutcomeRejectedLog').config!.level).toBe('warn');
    expect(String(byId('programmeOutcomeRejectedLog').config!.message)).toContain('child_completed_unreported');
  });

  it('reports the fall-through outcome after publishReadinessGate, so a reported prUrl is real', () => {
    expect(indexOf('reportProgrammeOutcome')).toBeGreaterThan(indexOf('publishReadinessGate'));
    expect(site('reportProgrammeOutcome').ancestors.map((a) => a.id)).toContain('programmeOutcomeGate');
  });

  it('sends only the fields the reconciler understands, and never a mergedSha', () => {
    expect(Object.keys(byId('reportProgrammeOutcome').config!.params)).toEqual([
      'dispatchId',
      'status',
      'prUrl',
      'error',
    ]);
    expect(JSON.stringify(sites().map((entry) => entry.step.config!.params))).not.toContain('mergedSha');
  });
});

describe('core.ProcessAITicket signed-commit contracts (PROCESS-001)', () => {
  /**
   * REACTORY-302016408/20261111/432598720. The pipeline produced commits that GitHub
   * could not verify, so they could not merge into any branch with required_signatures.
   * The signature was structurally valid (%G? = G) but unattributable: the committer was
   * an identity no account owns, and GitHub reported verified:false (reason "no_user").
   *
   * INVARIANT: a signed commit is only verifiable when the committer is the owner of the
   * signing key.
   */
  const workflowSource = (): string => fs.readFileSync(WORKFLOW_FILE, 'utf8');

  it('never invents a commit identity', () => {
    // D1: the fallback identity was 'Reactory AI <ai@reactory.net>'. That address owns no
    // signing key, so the fallback carried exactly the defect it was written to avoid.
    expect(workflowSource()).not.toContain('ai@reactory.net');

    const script = String(byId('commitChanges').config!.args[1]);

    // Identity is resolved from the repository configuration...
    expect(script).toContain('commit.gpgsign');
    expect(script).toContain('user.signingkey');
    expect(script).toContain('gpg.format');
    expect(script).toContain('user.name');
    expect(script).toContain('user.email');

    // ...and the bot identity may only ever be the AUTHOR. GitHub attributes a verified
    // signature through the COMMITTER, so overriding the committer would break the very
    // verification this change exists to guarantee.
    expect(script).toContain('GIT_AUTHOR_EMAIL');
    expect(script).toContain('GIT_AUTHOR_NAME');
    expect(script).not.toContain('-c user.email');
  });

  it('fails with the missing configuration named instead of inventing an identity', () => {
    const script = String(byId('commitChanges').config!.args[1]);

    // Signing enabled + no user.email is a hard stop, not a fallback.
    expect(script).toContain('if (!configuredEmail)');
    expect(script).toContain('user.email is not configured');
    expect(script).toContain('user.signingkey');
    // It must be reported as a COMMIT failure, so publishReadinessGate blocks the run
    // with the reason rather than pushing whatever is on the branch.
    expect(script).toContain("reason: 'git commit failed'");
    expect(script).toContain('process.exit(1)');
  });

  it('resets engineer-created commits before the reviewer runs', () => {
    // D2: nothing stopped the engineer's own commits from being published verbatim.
    const guard = byId('guardEngineerCommits');
    expect(guard.type).toBe('cli_command');

    const script = String(guard.config!.args[1]);
    expect(script).toContain('git rev-list --count');
    expect(script).toContain('git reset --soft');
    // The base is resolved the way prepareWorktree resolves it.
    expect(script).toContain('origin/HEAD');
    expect(script).toContain('origin/main');
    expect(script).toContain("recovered ? 'recovered' : 'blocked'");

    // After the engineer session, and before the reviewer sees the branch.
    expect(indexOf('verifyWorkspaceNote')).toBeLessThan(indexOf('guardEngineerCommits'));
    expect(indexOf('guardEngineerCommits')).toBeLessThan(indexOf('reviewLoop'));

    // The recovery is reported on the ticket, and a reset that cannot be proven stops
    // the run instead of publishing an agent-authored commit.
    expect(byId('engineerCommitComment').type).toBe('service_invoke');
    expect(byId('engineerCommitHalt').config!.failOnError).toBe(true);
    expect(String(byId('engineerCommitHalt').config!.args[1])).toContain('process.exit(1)');
  });

  it('blocks publication when a commit is not verifiable', () => {
    // D3: publishReadinessGate only asserted that a commit EXISTS.
    const verify = String(byId('verifyCommitSignatures').config!.args[1]);

    expect(byId('verifyCommitSignatures').type).toBe('cli_command');
    expect(verify).toContain('commit.gpgsign');
    expect(verify).toContain('%G?');
    expect(verify).toContain("commit.signature !== 'G'");
    expect(verify).toContain('commit-verification.json');
    expect(verify).toContain('user.signingkey');
    // Signing disabled must remain a no-op so unsigned repositories publish as before.
    expect(verify).toContain('commit.gpgsign is not enabled');

    // The verdict is consumed by the readiness gate, which already owns the block,
    // ticket comment, human task and hard halt - so an unverifiable commit can never
    // reach pushBranch, and nothing new needs to report to the programme.
    const readiness = String(byId('readPublishReadiness').config!.args[1]);
    expect(readiness).toContain('commit-verification.json');
    expect(readiness).toContain('a signed commit is only verifiable');
    expect(readiness).toContain('Nothing was pushed');

    expect(indexOf('commitChanges')).toBeLessThan(indexOf('verifyCommitSignatures'));
    expect(indexOf('verifyCommitSignatures')).toBeLessThan(indexOf('readPublishReadiness'));
    expect(indexOf('readPublishReadiness')).toBeLessThan(indexOf('publishReadinessGate'));
    // pushBranch's own contract is unchanged, and the halt stays hard.
    expect((byId('pushBranch') as any).dependsOn).toBe('publishReadinessGate');
    expect(byId('publishReadinessGate').type).toBe('condition');
    expect(byId('publishBlockHalt').config!.failOnError).toBe(true);
  });

  it('keeps the workflow version pinned for the in-place hotfix', () => {
    // The pin lives in reactory-core (a separate nested repository) and the runner matches
    // the id VERBATIM. Bumping the body alone removes @1.4.8 from the catalog and stops
    // every delegated run, so this fix ships in place and the coordinated bump is
    // documented in workflow/README.md instead.
    expect(String(def.version)).toBe('1.4.8');
    expect(String(def.version)).not.toBe('');
  });
});

/**
 * PROCESS-002 structural contracts.
 *
 * Two defects, both reproduced on SPEECH-010 (PR #18):
 *
 *  1. The integrity guards ran ONCE, after the first engineer session. The
 *     reviewer-rejection path re-enters the SAME engineer session via `handBack`,
 *     and nothing re-ran guardEngineerCommits or verifyCommitSignatures on that
 *     revision. Commits made during a revision were published verbatim.
 *  2. Nothing read the pull request after it was opened. CodeQL/code-scanning
 *     review threads, failing checks and review comments arrived on the PR and
 *     reached nobody.
 *
 * These assertions pin the SHAPE that makes the fix work: the guard is re-run on
 * every revision, the observation loop is bounded and separately budgeted,
 * agent-fixable blocks hand back to the same engineer session, human-only blocks
 * do not loop, and the terminal states are honest.
 */
describe('core.ProcessAITicket revision integrity and post-publication loop (PROCESS-002)', () => {
  const scriptOf = (id: string): string => String(byId(id).config!.args[1]);
  const valueOf = (id: string): string => String(byId(id).config!.value);
  const trailOf = (id: string): string[] =>
    (all.find((node) => node.step.id === id) || { trail: [] as string[] }).trail;
  const descendants = (id: string): string[] => {
    const out: string[] = [];
    const visit = (steps: IStep[]): void => {
      (steps || []).forEach((step) => {
        out.push(step.id);
        const cfg = step.config || {};
        ['thenSteps', 'elseSteps', 'steps'].forEach((key) => {
          if (Array.isArray(cfg[key])) visit(cfg[key]);
        });
      });
    };
    visit(byId(id).config!.thenSteps || []);
    visit(byId(id).config!.elseSteps || []);
    return out;
  };

  // ── A. The guard runs on every revision ───────────────────────────────────
  it('re-runs the engineer-commit guard after every revision, from one implementation', () => {
    // PROCESS-001 ran the guard once. `handBack` re-enters the same session and
    // the revision path never returned through it, so b46bcd6 and 67ffdc were
    // published with committer 'Reactor AI' and GitHub reported verified:false.
    const revisionGuard = byId('guardRevisionCommits');
    expect(revisionGuard.type).toBe('cli_command');

    // ONE implementation: the revision guard runs the SAME script as the first-
    // session guard (a YAML anchor), so the two cannot drift.
    expect(scriptOf('guardRevisionCommits')).toBe(scriptOf('guardEngineerCommits'));
    // ...and the post-publication fix guard reuses it as well.
    expect(scriptOf('guardPostPublishCommits')).toBe(scriptOf('guardEngineerCommits'));

    // It runs INSIDE the review loop, after the hand-back and before the report
    // status is re-read, so the reset happens before the loop can re-review.
    expect(trailOf('guardRevisionCommits')).toContain('reviewLoop');
    expect(trailOf('guardRevisionCommits')).toContain('verdictBranch');
    expect(indexOf('handBack')).toBeLessThan(indexOf('guardRevisionCommits'));
    expect(indexOf('guardRevisionCommits')).toBeLessThan(indexOf('reReadReportStatus'));
    expect((byId('reReadReportStatus') as any).dependsOn).toBe('revisionCommitGate');

    // The same fail-closed semantics as the first session: blocked halts the run.
    expect(byId('revisionIntegrityGate').config!.condition).toBe(
      "steps.readRevisionCommitState.stdout === 'blocked'",
    );
    expect(valueOf('setIntegrityBlockedTrue')).toBe('true');
    expect(valueOf('setRevisionRunHalt')).toBe('true');
    expect(valueOf('setRevisionRunStatusBlocked')).toBe('blocked');
  });

  it('keeps the revision guard measured against the published tip after publication', () => {
    // Resetting a POST-publication revision to the repository base would discard
    // the commit origin already has. BASE_REF is the published tip.
    expect(String(byId('guardEngineerCommits').config!.args[1])).toContain("process.env.BASE_REF");
    expect(String(byId('guardEngineerCommits').config!.args[1])).toContain('explicit-base');
    expect(byId('guardPostPublishCommits').config!.env.BASE_REF).toBe(
      '${steps.resolvePublishedTip.outputs.stdout}',
    );
    expect(indexOf('resolvePublishedTip')).toBeGreaterThan(indexOf('createPullRequest'));

    // BLOCKING (review round 2): resolved ONCE, outside the loop, the SECOND fix
    // cycle measured against the tip the FIRST cycle had already replaced. It saw
    // a phantom commit, reset the branch to the stale tip and then refused to
    // push. The tip is re-resolved at the TOP of every iteration, so the guard,
    // the lease and the push all see what origin has NOW.
    expect(trailOf('resolvePublishedTip')).toContain('postPublishLoop');
    expect(indexOf('resolvePublishedTip')).toBeLessThan(indexOf('observePullRequest'));
    expect(indexOf('resolvePublishedTip')).toBeGreaterThan(indexOf('postPublishLoop'));
    // Exactly ONE such step, so there is no stale second copy to read by mistake.
    expect(all.filter((entry) => entry.step.id === 'resolvePublishedTip').length).toBe(1);
    // The observation, the guard and the push all consume THAT value.
    expect(byId('observePullRequest').config!.env.TIP).toBe('${steps.resolvePublishedTip.outputs.stdout}');
    expect(byId('republishPush').config!.env.OBSERVED_TIP).toBe('${steps.resolvePublishedTip.outputs.stdout}');
  });

  it('allows a repair rewrite with an explicitly bound lease, and only that', () => {
    // BLOCKING (review round 2): the unverifiable-commit repair re-creates the
    // commits on the publication base, so the old tip is EXPECTED not to be an
    // ancestor. The unconditional fast-forward rule made the repair dead code.
    const push = scriptOf('republishPush');
    expect(push).toContain("const repairBase = String(process.env.REPAIR_BASE || '').trim()");
    expect(push).toContain("done({ ok: true, mode: 'fast-forward'");
    expect(push).toContain("mode: 'rewrite-refused'");
    expect(push).toContain("mode: 'repair-rewrite'");
    // The lease names the tip the observation saw, and the push is refused when
    // origin no longer matches it.
    expect(push).toContain("'git push --force-with-lease=refs/heads/' + branch + ':' + observedTip");
    expect(push).toContain('remoteTip !== observedTip');
    expect(push).toContain("git ls-remote origin refs/heads/");
    // A repair needs a base; resolveRepairBase must return the PUBLICATION base,
    // never the published tip (which would repair nothing).
    expect(byId('republishPush').config!.env.REPAIR_BASE).toBe('${steps.resolveRepairBase.outputs.stdout}');
    const repairBase = scriptOf('resolveRepairBase');
    expect(repairBase).toContain("observation.base");
    expect(repairBase).toContain("publish-readiness.json");
    expect(byId('resolveRepairBase').config!.env.BASE).toBeUndefined();
  });

  it('vetoes publication when a revision commit cannot be proven neutralised', () => {
    // integrityBlocked is set by the revision guard, then applied to the publish
    // decision BEFORE the outcome branch reads it. It can only close the gate.
    const veto = byId('integrityVetoGate');
    expect(veto.config!.condition).toContain("variables.integrityBlocked === 'true'");
    expect(veto.config!.condition).toContain("variables.publishable === 'true'");
    expect(valueOf('setPublishableFalseOnIntegrity')).toBe('false');
    expect(indexOf('setPublishable')).toBeLessThan(indexOf('integrityVetoGate'));
    expect(indexOf('integrityVetoGate')).toBeLessThan(indexOf('outcome'));
  });

  // ── D3 hardening: committer identity, not only %G? ────────────────────────
  it('verifies the committer is the key owner, not only that a signature exists', () => {
    // %G? = G proves the signature is mathematically valid. GitHub attributes it
    // through the COMMITTER, so the SPEECH-010 commits were locally 'G' and
    // remotely verified:false (no_user). Both conditions are now required.
    const verify = scriptOf('verifyCommitSignatures');
    expect(verify).toContain("commit.signature !== 'G'");
    expect(verify).toContain('keyOwner');
    expect(verify).toContain('committer_not_key_owner');
    expect(verify).toContain("git config --get user.email");
    expect(verify).toContain('keyOwner: keyOwner');
    // The re-publish passes the same gate, from the same implementation.
    expect(scriptOf('verifyPostPublishSignatures')).toBe(verify);
    expect(scriptOf('republishCommit')).toBe(scriptOf('commitChanges'));
  });

  // ── B. Observation and routing ────────────────────────────────────────────
  it('observes the pull request after publication using gh api only', () => {
    const observe = scriptOf('observePullRequest');
    expect(byId('observePullRequest').config!.command).toBe('node');
    // Every read is `gh` against the repository already in use.
    expect(observe).toContain('gh pr view');
    expect(observe).toContain('gh api repos/');
    expect(observe).toContain('gh api graphql');
    expect(observe).toContain('/pulls/');
    expect(observe).toContain('/reviews');
    expect(observe).toContain('/check-runs');
    expect(observe).toContain('/protection');
    expect(observe).toContain('reviewThreads');
    // No paid dependency, no hosted service, no direct HTTP client.
    expect(observe).not.toContain('axios');
    expect(observe).not.toContain('curl ');
    expect(observe).not.toContain('api.github.com');
    // It runs only once a pull request exists.
    expect(trailOf('observePullRequest')).toContain('prPublishedGate');
    expect(trailOf('observePullRequest')).toContain('postPublishLoop');
    expect(indexOf('createPullRequest')).toBeLessThan(indexOf('observePullRequest'));
  });

  it('bounds the post-publication loop separately from reviewCycleBound', () => {
    // The pre-publish bound is untouched...
    const review = String(byId('reviewLoop').config!.condition);
    expect(review).toContain('variables.reviewCycleBound');
    expect(review).not.toContain('postPublish');
    // ...and the new loop has its own counter and its own input.
    const loop = byId('postPublishLoop');
    expect(loop.type).toBe('while');
    expect(String(loop.config!.condition)).toContain('postPublishContinue');
    expect(Number(loop.config!.maxIterations)).toBeGreaterThan(0);
    expect(String(byId('postPublishBudgetGate').config!.condition)).toContain('postPublishFixBound');
    expect(byId('resolvePostPublishBound').config!.env.BOUND).toBe('${input.maxPostPublishFixCycles}');
    expect((def.inputs as any).maxPostPublishFixCycles.default).toBe(2);
    // The loop cannot run before a PR exists, and the merge poll still waits for
    // the human approval that follows a mergeable observation.
    expect(trailOf('postPublishLoop')).toContain('prPublishedGate');
    expect(indexOf('postPublishOutcomeGate')).toBeLessThan(indexOf('prApprovalGate'));
  });

  it('hands agent-fixable findings back to the SAME engineer session', () => {
    const handBack = byId('postPublishHandBack');
    expect(handBack.type).toBe('agent_conversation');
    expect(handBack.config!.sessionId).toBe('${variables.engineerSessionId}');
    expect(handBack.config!.personaId).toBe('${input.agentId}');
    // The findings reach the engineer as the briefing the pipeline built: the
    // thread BODY, verbatim, is the input - not a summary of it.
    expect(String(handBack.config!.message)).toContain('${steps.preparePostPublishReview.outputs.stdout}');
    expect(String(byId('preparePostPublishReview').config!.args[1])).toContain('finding.body');
    // It is reachable only from the fixable arm.
    expect(trailOf('postPublishHandBack')).toContain('postPublishRoute');
    expect(trailOf('postPublishHandBack')).toContain('postPublishHandBackGate');
    // The engineer is engaged only for a real code change; the REPAIR arm is
    // entered independently (a signing fault is not a code change).
    expect(byId('postPublishEngineerGate').config!.condition).toBe(
      "variables.postPublishDecision === 'changes_required'",
    );
    expect(String(byId('postPublishHandBackGate').config!.condition)).toContain(
      "variables.postPublishRepairNeeded === 'true'",
    );
  });

  it('does NOT loop on a block only a human can clear', () => {
    // required_signatures with no configured key (or an unidentified
    // branch-protection rule) is human-only: looping would burn every cycle and
    // still be unmergeable.
    expect(String(byId('postPublishMergeableGate').config!.condition)).toBe(
      "variables.postPublishState === 'clean'",
    );
    expect(valueOf('setPostPublishHumanBlocked')).toBe('blocked_human');
    expect(valueOf('setPostPublishHumanContinue')).toBe('false');
    // Nothing that hands work back to the engineer is reachable from that arm.
    const humanArm = descendants('postPublishMergeableGate');
    expect(humanArm).not.toContain('postPublishHandBack');
    expect(humanArm).not.toContain('guardPostPublishCommits');
    expect(humanArm).not.toContain('republishPush');
    // The observation step classifies that condition rather than the YAML.
    const observe = scriptOf('observePullRequest');
    expect(observe).toContain('required_signatures');
    expect(observe).toContain('human_only');
    expect(observe).toContain('BLOCKED with no agent-fixable finding');
  });

  it('never reports an UNREADABLE observation as success', () => {
    // BLOCKING (review round 2): the old shape asked "is this human_only?" and
    // sent every other value - including 'unavailable' - to awaiting_human, so a
    // gh outage set runStatus=completed for a PR nobody had read.
    const gate = byId('postPublishMergeableGate');
    expect(String(gate.config!.condition)).toBe("variables.postPublishState === 'clean'");
    expect(String(gate.config!.condition)).not.toContain('unavailable');
    // 'unavailable' can therefore only reach the blocked branch.
    const blockedArm = descendants('postPublishMergeableGate');
    expect(blockedArm).toContain('setPostPublishBlockReason');
    expect(blockedArm).toContain('readPostPublishBlockReason');
    expect(blockedArm).toContain('setPostPublishHumanBlocked');
    // ...and the outcome gate turns that into the blocked lifecycle state.
    expect(trailOf('setPublishStateBlockedHuman')).toContain('postPublishOutcomeGate');
    // The reason says the mergeability is UNKNOWN rather than guessing.
    const reason = scriptOf('readPostPublishBlockReason');
    expect(reason).toContain("state === 'unavailable'");
    expect(reason).toContain('UNKNOWN');
    // awaiting_human is NOT reachable from anywhere else.
    expect(trailOf('setPostPublishAwaitingHuman')).toContain('postPublishMergeableGate');
  });

  it('converges on a review that requested changes on an older commit', () => {
    // BLOCKING (review round 2): GitHub keeps reviewDecision=CHANGES_REQUESTED
    // after the fix, so re-reporting the same review as a fresh finding meant the
    // loop could never converge and always exhausted its budget.
    const observe = scriptOf('observePullRequest');
    expect(observe).toContain('commit_id');
    expect(observe).toContain('staleReviews');
    expect(observe).toContain('headSha');
    expect(observe).toContain('awaitingReview');
    // A stale review is re-requested, never re-handed.
    const apply = scriptOf('applyPostPublishDecisions');
    expect(apply).toContain('requested_reviewers');
    expect(apply).toContain('staleReviews');
    // REVIEW_REQUIRED is a human wait, not a human-only block.
    expect(observe).not.toContain("REVIEW_REQUIRED') && fixable.length === 0");
  });

  it('gives the post-publication judgement the same provenance as review.json', () => {
    // SECONDARY (review round 2): postPublishReview is continueOnError, so a
    // crashed reviewer silently consumed the previous cycle's verdict.
    const prepare = scriptOf('preparePostPublishReview');
    expect(prepare).toContain('post-publish-review-window.json');
    expect(prepare).toContain('startedAtMs');
    expect(prepare).toContain('nonce');
    expect(prepare).toContain("'post-publish-review.json', 'post-publish-review-normalised.json'");
    expect(prepare).toContain('cleared.push');

    const capture = scriptOf('capturePostPublishReview');
    expect(capture).toContain('post-publish-review-window.json');
    expect(capture).toContain('predates this review window');
    expect(capture).toContain('belongs to cycle');
    expect(capture).toContain('reviewSha256');
    // A refusal must WRITE the invalid record, or the reader picks up the
    // previous cycle's file.
    expect(capture).toContain('writeNormalised(payload)');
    expect(capture).toContain("state: 'invalid'");
    expect(byId('preparePostPublishReview').config!.env.CYCLE).toBe('${variables.postPublishCycle}');

    // An INVALID judgement writes NOTHING: the valid-looking dismissals inside
    // an invalid record must not reach GitHub, or the invalid arm's
    // "nothing was dismissed" is a lie.
    expect(scriptOf('applyPostPublishDecisions')).toContain("if (String(record.state || '') === 'invalid')");
    expect(scriptOf('applyPostPublishDecisions')).toContain('no dismissal, thread resolution, review request or PR comment was performed');
  });

  it('carries a real code-scanning alert number to the dismissal call', () => {
    // SECONDARY (review round 2): alertNumber was copied from the observation but
    // never populated, so the PATCH path was unreachable in a real run.
    const observe = scriptOf('observePullRequest');
    expect(observe).toContain('code-scanning/alerts?state=open');
    expect(observe).toContain('refs/pull/');
    expect(observe).toContain('alertNumber');
    expect(observe).toContain("kind: 'code_scanning_alert'");

    const apply = scriptOf('applyPostPublishDecisions');
    expect(apply).toContain('code-scanning/alerts/');
    // ...and an unresolvable alert is never presented as applied.
    expect(apply).toContain("status: 'recorded-only'");
    expect(apply).toContain('NO GitHub dismissal was written');
  });

  // ── C. The quality agent judges; the workflow applies ─────────────────────
  it('gives the quality agent a fix-or-dismiss decision with a mandatory justification', () => {
    // The judgement lives in the agent, not in YAML string matching: 3 of 16
    // CodeQL findings on PR #13 were false positives.
    expect(byId('postPublishReview').type).toBe('agent_conversation');
    expect(byId('postPublishReview').config!.personaId).toBe('${input.reviewerId}');
    const instructions = String(byId('postPublishReview').config!.instructions);
    expect(instructions).toContain('dismiss');
    expect(instructions).toContain('justification');
    expect(instructions).toContain('false positive');

    const capture = scriptOf('capturePostPublishReview');
    expect(capture).toContain('invalidDismissals');
    expect(capture).toContain('justification');
    expect(capture).toContain('dismissedComment');
    expect(capture).toContain("state = 'invalid'");
    // The "fix" set uses the SAME shape the pre-publish reviewer produces.
    expect(capture).toContain("['requiredChanges', 'required_changes', 'changes']");

    // A dismissal is written to GitHub with its justification, not silently.
    const apply = scriptOf('applyPostPublishDecisions');
    expect(apply).toContain('code-scanning/alerts/');
    expect(apply).toContain('state=dismissed');
    expect(apply).toContain('dismissed_reason');
    expect(apply).toContain('dismissed_comment');
    expect(apply).toContain('gh pr comment');
    // An addressed review thread is resolved through the agent's own judgement.
    expect(apply).toContain('resolveReviewThread');
    expect(capture).toContain('resolvedFindingIds');
  });

  it('records a structured log for every post-publication cycle', () => {
    const capture = scriptOf('capturePostPublishReview');
    expect(capture).toContain('post-publish-log.json');
    expect(capture).toContain('observed:');
    expect(capture).toContain('judged:');
    expect(capture).toContain('dismissals: dismissals.map');
    // What was fixed is appended by the re-publish step, and it records BOTH
    // facts so the log cannot claim a fix that was never committed.
    expect(scriptOf('readRepublishResult')).toContain('entry.fixed');
    expect(scriptOf('readRepublishResult')).toContain('committed: committed');
    expect(scriptOf('readRepublishResult')).toContain('pushed: pushed');
  });

  // ── D. Honest terminal states ─────────────────────────────────────────────
  it('reports a published-but-unmergeable pull request as blocked, never as success', () => {
    // 'completed' is now reachable ONLY from the mergeable observation.
    expect(trailOf('setRunStatusCompleted')).toContain('postPublishOutcomeGate');
    expect(valueOf('setRunStatusCompleted')).toBe('completed');
    expect(trailOf('setPublishStateAwaitingHuman')).toContain('postPublishOutcomeGate');
    expect(valueOf('setPublishStateAwaitingHuman')).toBe('awaiting_human');

    expect(trailOf('setRunStatusUnmergeable')).toContain('postPublishOutcomeGate');
    expect(valueOf('setRunStatusUnmergeable')).toBe('blocked');
    expect(valueOf('setPublishStateBlockedHuman')).toBe('blocked_needs_human');
    expect(byId('postPublishBlockedTask').type).toBe('user_activity');
    // The note does not move to complete while the PR cannot merge.
    expect(trailOf('retainWorkspaceNoteUnmergeable')).toContain('postPublishOutcomeGate');
    // The run-level status is what the programme reconciler reports on.
    expect(String(byId('readProgrammeReportStatus').config!.args[1])).toContain("=== 'completed'");
  });

  it('states the exact reason when the post-publication budget is exhausted', () => {
    expect(valueOf('setPostPublishExhausted')).toBe('exhausted');
    const describe = scriptOf('describePostPublishBlock');
    expect(describe).toContain('budget was exhausted');
    expect(describe).toContain('still blocked');
    expect(describe).toContain('NOT complete');
    expect(String(byId('describePostPublishBlock').config!.env.OUTCOME)).toBe(
      '${variables.postPublishOutcome}',
    );
    expect(String(byId('describePostPublishBlock').config!.env.BOUND)).toBe(
      '${variables.postPublishFixBound}',
    );
  });

  it('waits for running checks instead of calling them a policy block', () => {
    // BLOCKING (review round 3): only terminal check FAILURES were findings, so a
    // queued/in_progress required check was invisible; BLOCKED + no finding became
    // a "human-only branch-protection policy" and every PR against a repository
    // with required status checks ended blocked before CI had finished.
    const observe = scriptOf('observePullRequest');
    expect(observe).toContain('const pendingChecks = []');
    expect(observe).toContain('PENDING_STATUSES');
    expect(observe).toContain("classification = 'pending'");
    // A pending check is neither a finding nor a human-only reason.
    expect(observe).toContain('awaitingChecks');
    expect(String(byId('observePullRequest').config!.args[1])).toContain('!awaitingAnything');

    // The wait is its own arm: bounded, delayed, and it does not consume the
    // fix budget.
    expect(byId('postPublishPendingGate').type).toBe('condition');
    expect(String(byId('postPublishPendingGate').config!.condition)).toBe(
      "variables.postPublishState === 'pending'",
    );
    expect(byId('postPublishWait').type).toBe('delay');
    expect(Number(byId('postPublishWait').config!.duration)).toBeGreaterThan(0);
    expect(String(byId('postPublishWaitBudgetGate').config!.condition)).toContain('postPublishWaitCount');
    expect(String(byId('postPublishWaitBudgetGate').config!.condition)).toContain('postPublishWaitBound');
    expect(valueOf('setPostPublishPendingExhausted')).toBe('awaiting_human');
    expect((def.steps as IStep[]).map((step) => step.id)).toContain('seedPostPublishWaitCount');
    // The WAIT arm (thenSteps) never hands work back to the engineer, and it
    // never claims a human-only policy. The elseSteps legitimately contains the
    // mergeable gate, which is a different arm.
    const waitArm = (byId('postPublishPendingGate').config!.thenSteps || []).map((step: IStep) => step.id);
    expect(waitArm).toContain('postPublishWaitBudgetGate');
    expect(waitArm).not.toContain('postPublishHandBack');
    expect(waitArm).not.toContain('setPostPublishHumanBlocked');
    expect(waitArm).not.toContain('postPublishMergeableGate');
  });

  it('uses the LIVE pull request state and attributes only this PR\'s alerts', () => {
    const observe = scriptOf('observePullRequest');
    // SECONDARY (review round 3): PR_STATE is the creation-time variable.
    expect(observe).toContain("const liveState = String(pr.state || '').toUpperCase()");
    expect(observe).toContain("liveState === 'CLOSED'");
    expect(observe).not.toContain("state === 'CLOSED'");
    // The unscoped alert fallback must not lend its alerts to this PR.
    expect(observe).toContain('codeScanningRefScoped');
    expect(observe).toContain('unattributedAlerts');
    expect(observe).toContain('const attributable = (alert)');
    expect(observe).toContain("instanceRef.indexOf(pullRefFragment) !== -1");
  });

  it('resolves a repository for the dismissals instead of silently doing nothing', () => {
    // BLOCKING (review round 3): the step's env is WT + PR_NUMBER only, and the
    // script read PR_REPO with no fallback - so every GitHub write was inert.
    const apply = scriptOf('applyPostPublishDecisions');
    expect(apply).toContain('const resolveRepo = () => {');
    expect(apply).toContain("gh repo view --json nameWithOwner -q .nameWithOwner");
    expect(apply).toContain("git remote get-url origin");
    expect(apply).toContain('repoProblem');
    expect(apply).toContain('POST-PUBLICATION WRITES SKIPPED');
    // A failed resolution is reported, never presented as applied.
    expect(apply).toContain("status: 'not-applied'");
    expect(byId('applyPostPublishDecisions').config!.env.PR_REPO).toBeUndefined();
  });

  it('only closes a review thread for a DISMISSED finding', () => {
    // BLOCKING (review round 3): every resolvedFindingIds thread was closed
    // BEFORE the hand-back, including threads whose finding was also a required
    // change - so an unfinished fix looked finished on the next observation.
    const apply = scriptOf('applyPostPublishDecisions');
    expect(apply).toContain('const dismissedIds = new Set');
    expect(apply).toContain('requiredForThread');
    expect(apply).toContain('deferredThreads.push');
    expect(apply).toContain('deferredThreads: deferredThreads');
  });

  it('does not report a no-op cycle as a fix', () => {
    // BLOCKING (review round 3): the engineer could change nothing, republishCommit
    // would return committed:false, and the log still said fixed:[{pushed:true}].
    const result = scriptOf('readRepublishResult');
    expect(result).toContain("process.env.COMMIT");
    expect(result).toContain('const committed = commit.committed === true');
    expect(result).toContain('committed: committed');
    expect(result).toContain('committed: committed,');
    expect(result).toContain("pushed && committed ? 'pushed' : (pushed ? 'no_change' : 'push_failed')");
    expect(byId('readRepublishResult').config!.env.COMMIT).toBe('${steps.republishCommit.outputs.stdout}');

    expect(byId('republishNoChangeGate').type).toBe('condition');
    expect(String(byId('republishNoChangeGate').config!.condition)).toBe(
      "steps.readRepublishResult.stdout === 'no_change'",
    );
    expect(valueOf('setPostPublishNoChange')).toBe('blocked_human');
    expect(valueOf('setPostPublishNoChangeContinue')).toBe('false');
    expect(trailOf('setPostPublishNoChange')).toContain('republishResultGate');
  });

  it('treats changes_required with no required change as invalid', () => {
    // SECONDARY (review round 3): a forgotten requiredChanges field became
    // 'no_action' and the reviewer's judgement was discarded.
    const capture = scriptOf('capturePostPublishReview');
    expect(capture).toContain('claimsChanges');
    expect(capture).toContain("state = 'invalid'");
    expect(capture).toContain('but recorded no requiredChanges');
  });

  it('closes a review thread the reviewer FIXED, but only after the fix is published', () => {
    // BLOCKING (round 4): applyPostPublishDecisions closed a thread only when the
    // finding was ALSO a dismissal, and capture stringified requiredChanges so
    // requiredForThread never matched. A fixed thread was therefore deferred for
    // ever and the same thread was re-observed on every cycle.
    const capture = scriptOf('capturePostPublishReview');
    expect(capture).toContain('const requiredChangeIds');
    expect(capture).toContain('requiredIds');
    // The ids survive into the artefact the apply step reads.
    expect(capture).toContain('requiredChangeIds: requiredIds');
    // A prose required change may quote a finding id.
    expect(capture).toContain('ID_TOKEN');

    const apply = scriptOf('applyPostPublishDecisions');
    // ONLY a dismissed finding closes here: a bare resolvedFindingIds entry
    // carries no recorded justification, so a human's thread must not be closed
    // on it. Everything else waits for the published commit.
    expect(apply).toContain('if (!dismissed) {');
    expect(apply).toContain('it was not dismissed, so there is no recorded justification');
    expect(apply).toContain('deferredThreads.push');
    expect(apply).not.toContain('const pendingFix = !dismissed && !noAction');

    // The post-push step is the only place a FIXED thread is closed, and it is
    // reachable only from the "committed AND pushed" arm.
    const resolve = scriptOf('resolveAddressedThreads');
    expect(resolve).toContain('resolveReviewThread');
    expect(resolve).toContain('dismissedIds.has');
    expect(byId('resolveAddressedThreads').config!.env.CYCLE).toBe('${variables.postPublishCycle}');
    expect((byId('resolveAddressedThreads') as any).dependsOn).toBe('setPostPublishCycleNext');
    expect(trailOf('resolveAddressedThreads')).toContain('republishResultGate');
    expect(trailOf('resolveAddressedThreads')).toContain('republishReadinessGate');
    // Never reachable when the fix did not land.
    expect(trailOf('resolveAddressedThreads')).toContain('postPublishHandBackGate');
  });

  it('does not force a commit when the reviewer required no change', () => {
    // BLOCKING (round 4): the commit/push chain ran for a dismiss-all verdict, so
    // "worktree clean" became no_change and the run stopped blocked without ever
    // re-observing the PR whose findings it had just dismissed.
    const gate = byId('postPublishHandBackGate');
    // A repair need can enter the chain, but never a no_action with nothing to
    // repair: that is the engineer gate below.
    expect(String(gate.config!.condition)).toContain("variables.postPublishDecision === 'changes_required'");
    expect(byId('postPublishEngineerGate').config!.condition).toBe(
      "variables.postPublishDecision === 'changes_required'",
    );

    const thenIds = (gate.config!.thenSteps || []).map((step: IStep) => step.id);
    const elseIds = (gate.config!.elseSteps || []).map((step: IStep) => step.id);
    // The commit/push chain lives in the changes_required arm only.
    expect(thenIds).toContain('reCapturePostPublishReport');
    expect(thenIds).toContain('postPublishIntegrityProceedGate');
    expect(elseIds).not.toContain('republishCommit');
    expect(elseIds).not.toContain('republishPush');
    expect(elseIds).not.toContain('reCapturePostPublishReport');
    // The no_action arm re-observes instead, bounded separately from the fix budget.
    expect(elseIds).toContain('bumpPostPublishReobserve');
    expect(elseIds).toContain('postPublishReobserveGate');
    expect(String(byId('postPublishReobserveGate').config!.condition)).toContain('postPublishReobserveBound');
    expect(byId('bumpPostPublishReobserve').config!.env.N).toBe('${variables.postPublishReobserveCount}');
    // Exhausting the re-observes is a human stop, not a success.
    expect(trailOf('setPostPublishReobserveBlocked')).toContain('postPublishReobserveGate');
    expect(valueOf('setPostPublishReobserveBlocked')).toBe('blocked_human');
    expect(valueOf('setPostPublishReobserveContinue')).toBe('false');
    // A no-op fix in a changes_required cycle is still a failure.
    expect(valueOf('setPostPublishNoChange')).toBe('blocked_human');
  });

  it('cannot reach approval or merge polling from the blocked arm', () => {
    // BLOCKING (round 4): dependsOn is ORDERING-ONLY in this engine, not a skip,
    // so the blocked arm fell through into prApprovalGate and pollMerge and an
    // unmergeable PR still raised an "Approve and merge" task and polled.
    const outcome = byId('postPublishOutcomeGate');
    // awaitahuman AND merged are the only two success outcomes.
    const condition = String(outcome.config!.condition);
    expect(condition).toContain("variables.postPublishOutcome === 'awaiting_human'");
    expect(condition).toContain("variables.postPublishOutcome === 'merged'");
    expect(condition).not.toContain('blocked_human');
    expect(condition).not.toContain('exhausted');

    const mergeableArm = (outcome.config!.thenSteps || []).map((step: IStep) => step.id);
    const blockedArm = (outcome.config!.elseSteps || []).map((step: IStep) => step.id);

    // The merge path is INSIDE the mergeable arm...
    expect(mergeableArm).toContain('postPublishLifecycleGate');
    expect(mergeableArm).toContain('mergeOutcome');
    const mergePath = descendants('prMergePathGate');
    expect(mergePath).toContain('prApprovalGate');
    expect(mergePath).toContain('pollMerge');
    // ...and structurally absent from the blocked one.
    expect(blockedArm).not.toContain('prApprovalGate');
    expect(blockedArm).not.toContain('pollMerge');
    expect(blockedArm).not.toContain('mergeOutcome');
    expect(blockedArm).not.toContain('prApproval');
    // The blocked arm ends at the human task, and the merge path is not beneath it.
    expect(blockedArm).toContain('postPublishBlockedTask');
    ['prApprovalGate', 'pollMerge', 'mergeOutcome'].forEach((id) => {
      expect(trailOf(id)).not.toContain('postPublishBlockedTask');
      expect(trailOf(id)).not.toContain('setRunStatusUnmergeable');
    });

    // prApprovalGate / pollMerge / mergeOutcome are NO LONGER siblings of the gate.
    const published = all.find((entry) => entry.step.id === 'prPublishedGate')!;
    const publishedThen = (published.step.config!.thenSteps || []).map((step: IStep) => step.id);
    expect(publishedThen).toContain('postPublishOutcomeGate');
    expect(publishedThen).not.toContain('prApprovalGate');
    expect(publishedThen).not.toContain('pollMerge');
    expect(publishedThen).not.toContain('mergeOutcome');
    expect(trailOf('prApprovalGate')).toContain('postPublishOutcomeGate');
    expect(trailOf('prApprovalGate')).toContain('prMergePathGate');
    expect(trailOf('pollMerge')).toContain('postPublishOutcomeGate');
    expect(trailOf('pollMerge')).toContain('prMergePathGate');
    // An already-merged PR skips the approval/poll path entirely.
    expect(String(byId('prMergePathGate').config!.condition)).toBe("variables.prState !== 'MERGED'");
  });

  it('keeps every new step inside a config scope and reachable from the publish branch', () => {
    // Guards against the shape that silently breaks the engine: control-flow
    // lists must live under `config`, not beside it.
    const misplaced = all
      .filter(({ step }) => (step as Record<string, any>).thenSteps || (step as Record<string, any>).elseSteps)
      .map(({ step }) => step.id);
    expect(misplaced).toEqual([]);

    const produced = [
      'observePullRequest',
      'postPublishRoute',
      'postPublishMergeableGate',
      'postPublishOutcomeGate',
      'republishReadinessGate',
      'guardPostPublishCommits',
      'verifyPostPublishSignatures',
    ];
    produced.forEach((id) => {
      expect(trailOf(id)).toContain('prPublishedGate');
    });
  });
});
