/**
 * Contract guard for the workflow programme reconciler.
 *
 * The reconciler is only "the permanent answer" if its four moving parts agree:
 *
 *   1. `WorkflowProgrammeReconciler.yaml` declares `reactor.WorkflowProgrammeReconciler@1.0.0`
 *      and its single action is `WorkflowProgrammeService.reconcile` — no
 *      `invoke_workflow`, because the duplicating parent pattern is rejected for
 *      good, not temporarily.
 *   2. The registry entry in `workflow/index.ts` names the same namespace, name and
 *      version, because `loadYamlWorkflow` derives the catalog DESTINATION from the
 *      TS arguments while the id comes from the YAML body.
 *   3. A schedule exists, runs every 60 seconds, and is single-flight.
 *   4. The service id and method named by the YAML actually exist in the source.
 *
 * Read as source text where possible: this suite must not need a module bootstrap to
 * tell us the schedule and the body disagree.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

const WORKFLOW_DIR = path.resolve(__dirname, '..');
const MODULE_DIR = path.resolve(WORKFLOW_DIR, '..');
const YAML_PATH = path.join(WORKFLOW_DIR, 'WorkflowProgrammeReconciler.yaml');
const REGISTRY_PATH = path.join(WORKFLOW_DIR, 'index.ts');
const SERVICE_PATH = path.join(MODULE_DIR, 'services', 'reactor', 'WorkflowProgrammeService.ts');
const SCHEDULE_PATH = path.join(
  WORKFLOW_DIR,
  'schedules',
  'reactor.workflowprogrammereconciler-1.0.0-schedule.yaml',
);

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const body = yaml.load(read(YAML_PATH)) as any;
const schedule = yaml.load(read(SCHEDULE_PATH)) as any;

describe('workflow programme reconciler contract', () => {
  it('parses, so the assertions below cannot pass vacuously', () => {
    expect(body).toBeTruthy();
    expect(schedule).toBeTruthy();
  });

  it('declares the identity the schedule and the registry address', () => {
    expect(body.nameSpace).toBe('reactor');
    expect(body.name).toBe('WorkflowProgrammeReconciler');
    expect(body.version).toBe('1.0.0');
    expect(`${body.nameSpace}.${body.name}@${body.version}`).toBe('reactor.WorkflowProgrammeReconciler@1.0.0');
  });

  it('is one durable tick: a single reconcile service call, and no parent workflow', () => {
    const steps: any[] = body.steps || [];
    const nonTerminal = steps.filter((step) => !['end', 'log'].includes(step.type));
    expect(nonTerminal).toHaveLength(1);

    const tick = nonTerminal[0];
    expect(tick.type).toBe('service_invoke');
    expect(tick.config.service).toBe('reactor.WorkflowProgrammeService@1.0.0');
    expect(tick.config.method).toBe('reconcile');

    // The rejected pattern, asserted absent rather than merely discouraged.
    expect(steps.some((step) => step.type === 'invoke_workflow')).toBe(false);
  });

  it('is last in every path: the tick ends in an end step', () => {
    expect((body.steps || []).some((step: any) => step.type === 'end')).toBe(true);
  });

  it('ships a 60 second, single-flight schedule targeting this workflow', () => {
    expect(schedule.workflow.id).toBe('reactor.WorkflowProgrammeReconciler@1.0.0');
    expect(schedule.workflow.nameSpace).toBe('reactor');
    expect(schedule.workflow.version).toBe('1.0.0');
    // `* * * * *` is one minute. Anything slower breaks the dispatch-latency and
    // crash-recovery bounds this feature promises.
    expect(schedule.schedule.cron).toBe('* * * * *');
    expect(schedule.schedule.enabled).toBe(true);
    expect(schedule.maxConcurrent).toBe(1);
  });

  it('is registered with the module, because the catalog destination comes from the TS table', () => {
    const registry = read(REGISTRY_PATH);
    const entry = /\{[^}]*name:\s*'WorkflowProgrammeReconciler'[^}]*\}/.exec(registry);
    expect(entry).not.toBeNull();
    const literal = entry![0];
    expect(literal).toContain("nameSpace: 'reactor'");
    expect(literal).toContain("filename: 'WorkflowProgrammeReconciler.yaml'");
    expect(literal).toContain("version: '1.0.0'");
  });

  it('names a service and method that exist in the service source', () => {
    const source = read(SERVICE_PATH);
    expect(source).toContain("id: 'reactor.WorkflowProgrammeService@1.0.0'");
    expect(source).toMatch(/async reconcile\(/);
  });

  it('documents the dispatch-id recovery and the lease, so the design cannot be silently dropped', () => {
    const yamlSource = read(YAML_PATH);
    expect(yamlSource).toContain('dispatch id');
    expect(yamlSource).toContain('single-flight');
    expect(yamlSource).toContain('invoke_workflow');
  });
});
