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
    expect(def.version).toBe('1.4.2');
  });

  it('builds into an engine workflow class', () => {
    // walk() runs inside build(), so a mis-nested branch or an unknown step type
    // throws here rather than at run time.
    const klass = buildYamlWorkflowClass(def);
    const instance = new klass();
    expect(instance.id).toBe('core.ProcessAITicket@1.4.2');
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
    expect(byId('engineer').dependsOn).toBe('markInProgress');
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
    expect(script).toContain('report.json');
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
