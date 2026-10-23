import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { YamlFlowParser } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/YamlFlowParser';

/**
 * Contract and grep gates for the durable agent continuation feature
 * (REACTORY-302016408).
 *
 * The important one is `wait_event must not carry a timeout`. It is not a style
 * rule: `effectiveDate` is handed to the engine as `subscribeAsOf`, which the engine
 * reads as "ignore events older than this" — so a `timeout` makes the step DEAF for
 * that duration and then wait forever, discarding real signals. Expiry in this
 * feature is a sentinel event published by the sweeper, so no wait may set one.
 */

const MODULE_ROOT = path.resolve(__dirname, '..', '..');
const WAITER_FILE = path.join(MODULE_ROOT, 'workflow', 'AgentContinuation.yaml');
const SWEEPER_FILE = path.join(MODULE_ROOT, 'workflow', 'AgentContinuationSweeper.yaml');
const SERVICE_FILE = path.join(MODULE_ROOT, 'services', 'reactor', 'AgentContinuationService.ts');
const MACRO_FILE = path.join(MODULE_ROOT, 'ai', 'macro', 'runtime', 'continuationMacro.macro.ts');
const MODEL_FILE = path.join(MODULE_ROOT, 'models', 'AgentContinuation.ts');

interface IAnyStep {
  id: string;
  type: string;
  config?: Record<string, any>;
}

/** Depth-first walk over every step, including those nested in control flow. */
function walkSteps(steps: IAnyStep[], visit: (step: IAnyStep) => void): void {
  for (const step of steps || []) {
    visit(step);
    const config: any = step.config || {};
    for (const key of ['thenSteps', 'elseSteps', 'steps']) {
      if (Array.isArray(config[key])) walkSteps(config[key], visit);
    }
    if (Array.isArray(config.branches)) {
      for (const branch of config.branches) walkSteps(branch?.steps || [], visit);
    }
    if (Array.isArray(config.compensate)) walkSteps(config.compensate, visit);
  }
}

function parse(file: string) {
  const parser = new YamlFlowParser();
  return parser.parseFromFile(file);
}

describe('AgentContinuation.yaml — the durable waiter', () => {
  let parsed: any;

  beforeAll(() => {
    const result = parse(WAITER_FILE);
    expect(result.errors).toEqual([]);
    parsed = result.workflow;
  });

  it('parses and declares its identity', () => {
    expect(parsed).toBeTruthy();
    expect(parsed.nameSpace).toBe('reactor');
    expect(parsed.name).toBe('AgentContinuation');
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.inputs.continuationId.required).toBe(true);
  });

  it('loads, guards on pending, arms, waits, delivers — in that order', () => {
    const steps: IAnyStep[] = parsed.steps;
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual([
      'loadContinuation',
      'guardPending',
      'done',
    ]);

    const guard = steps.find((s) => s.id === 'guardPending')!;
    expect(guard.type).toBe('condition');
    // Only a `pending` record may park. A cancelled / already-fired / orphaned one
    // would otherwise occupy a waiter for its whole deadline.
    expect(guard.config!.condition).toContain("state === 'pending'");

    const body: IAnyStep[] = guard.config!.thenSteps;
    expect(body.map((s) => s.id)).toEqual(['armContinuation', 'waitForWake', 'deliverWake']);
    expect(body.map((s) => s.type)).toEqual(['service_invoke', 'wait_event', 'service_invoke']);
  });

  it('waits on the single continuation event name, keyed by the correlation key', () => {
    const guard: any = parsed.steps.find((s: any) => s.id === 'guardPending');
    const wait = guard.config.thenSteps.find((s: any) => s.id === 'waitForWake');

    expect(wait.type).toBe('wait_event');
    expect(wait.config.eventName).toBe('agent.continuation.wake');
    expect(wait.config.eventKey).toContain('correlationKey');
    expect(wait.config.outputVariable).toBe('wake');
  });

  it('delivers with the outcome the wake event carried', () => {
    const guard: any = parsed.steps.find((s: any) => s.id === 'guardPending');
    const deliver = guard.config.thenSteps.find((s: any) => s.id === 'deliverWake');

    expect(deliver.config.service).toBe('reactor.AgentContinuationService@1.0.0');
    expect(deliver.config.method).toBe('deliver');
    expect(deliver.config.params.continuationId).toBe('${input.continuationId}');
    // Observed vs not-observed arrives as DATA on the event, never as a race.
    expect(deliver.config.params.outcome).toBe('${variables.wake.outcome}');
  });
});

describe('grep gate — no wait_event in this feature sets a timeout', () => {
  /**
   * The authoritative check: parse the definition and inspect every wait step,
   * including nested ones.
   */
  it('finds no `timeout` on any parsed wait_event step', () => {
    const found: string[] = [];
    for (const file of [WAITER_FILE, SWEEPER_FILE]) {
      const result = parse(file);
      expect(result.errors).toEqual([]);
      walkSteps((result.workflow as any).steps || [], (step) => {
        if (step.type !== 'wait_event') return;
        const config: any = step.config || {};
        if ('timeout' in config && config.timeout != null) {
          found.push(`${path.basename(file)}#${step.id}`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  /**
   * The textual check. `YamlFlowBuilder` reads `config.timeout` positionally inside
   * the wait_event block, so a `timeout:` line in that block is the exact shape of
   * the bug this gate exists to prevent.
   */
  it('finds no `timeout:` line inside a wait_event block in the feature sources', () => {
    const offenders: string[] = [];
    for (const file of [WAITER_FILE, SWEEPER_FILE, SERVICE_FILE, MACRO_FILE, MODEL_FILE]) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/wait_event|WaitForEvent/.test(line)) return;
        // Look ahead at the step body, which is indented under the `type:` line.
        const window = lines.slice(index, index + 14);
        for (const candidate of window) {
          if (/^\s*timeout\s*:/.test(candidate)) {
            offenders.push(`${path.basename(file)}:${index + 1}`);
            break;
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('states the expiry mechanism as an event, not a timeout', () => {
    const source = fs.readFileSync(WAITER_FILE, 'utf8');
    expect(source).toContain("outcome: 'not_observed'");
    expect(source).toMatch(/no `timeout`/i);
  });
});

describe('AgentContinuationSweeper.yaml — the clock', () => {
  let parsed: any;

  beforeAll(() => {
    const result = parse(SWEEPER_FILE);
    expect(result.errors).toEqual([]);
    parsed = result.workflow;
  });

  it('parses and declares its identity', () => {
    expect(parsed.nameSpace).toBe('reactor');
    expect(parsed.name).toBe('AgentContinuationSweeper');
    expect(parsed.version).toBe('1.0.0');
  });

  it('recovers stalled deliveries, plans, then publishes one event per record', () => {
    const steps: IAnyStep[] = parsed.steps;
    const byId = (id: string) => steps.find((s) => s.id === id)!;

    expect(byId('recoverStalled').config!.method).toBe('recoverStalledFiring');
    expect(byId('planDue').config!.method).toBe('claimDue');
    expect(byId('planDue').config!.params.limit).toContain('input.limit');

    const fireDue = byId('fireDue');
    expect(fireDue.type).toBe('for_each');
    expect(fireDue.config!.items).toContain('steps.planDue');

    const child = fireDue.config!.steps.find((s: IAnyStep) => s.id === 'fireContinuation')!;
    expect(child.config!.method).toBe('fire');
    expect(child.config!.params.source).toBe('sweeper');
    expect(child.config!.params.outcome).toContain('variables.item.outcome');
  });

  it('does not itself deliver a turn — only the waiter instance may touch a session', () => {
    const methods: string[] = [];
    walkSteps(parsed.steps, (step) => {
      if (step.type === 'service_invoke') methods.push(String(step.config!.method));
    });
    expect(methods).not.toContain('deliver');
  });
});

describe('registration gates', () => {
  it('registers both workflows in REACTOR_YAML_WORKFLOWS', () => {
    const source = fs.readFileSync(path.join(MODULE_ROOT, 'workflow', 'index.ts'), 'utf8');
    expect(source).toContain("name: 'AgentContinuation', filename: 'AgentContinuation.yaml', version: '1.0.0'");
    expect(source).toContain(
      "name: 'AgentContinuationSweeper', filename: 'AgentContinuationSweeper.yaml', version: '1.0.0'",
    );
  });

  it('registers the service and exports the model', () => {
    const services = fs.readFileSync(path.join(MODULE_ROOT, 'services', 'index.ts'), 'utf8');
    expect(services).toContain("from \"./reactor/AgentContinuationService\"");
    expect(services).toMatch(/AgentContinuationService\s*\n\];/);

    const models = fs.readFileSync(path.join(MODULE_ROOT, 'models', 'index.ts'), 'utf8');
    expect(models).toContain("from './AgentContinuation'");
    expect(models).toContain('AgentContinuationModel');
  });

  it('registers the three macros', () => {
    const runtime = fs.readFileSync(path.join(MODULE_ROOT, 'ai', 'macro', 'runtime', 'index.ts'), 'utf8');
    expect(runtime).toContain('ContinuationMacroRegistry');
    expect(runtime).toContain('...ContinuationMacroRegistry');

    const source = fs.readFileSync(MACRO_FILE, 'utf8');
    for (const name of ['scheduleContinuation', 'cancelContinuation', 'listContinuations']) {
      expect(source).toContain(`name: '${name}'`);
    }
  });

  /**
   * "Module still loads: the YAML registers and provisions without error."
   *
   * `loadYamlWorkflow` copies each module YAML into the catalog under
   * `$REACTORY_DATA` on every startup (`provisionCatalogFile`), so this exercises
   * the real provisioning path against a throwaway data root.
   */
  it('loads and provisions both workflows from the module index', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reactor-continuation-'));
    const previous = process.env.REACTORY_DATA;
    process.env.REACTORY_DATA = dataRoot;

    try {
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const workflowIndex = require('../index');
      const workflows: any[] = workflowIndex.default || [];
      const ids = workflows.map((w) => w.id);

      expect(ids).toContain('reactor.AgentContinuation@1.0.0');
      expect(ids).toContain('reactor.AgentContinuationSweeper@1.0.0');

      // Canonical module YAML is copied into the catalog: this is what makes a
      // restart adopt the definition.
      const waiterCatalog = path.join(
        dataRoot,
        'workflows',
        'catalog',
        'reactor',
        'AgentContinuation',
        '1.0.0',
        'AgentContinuation.yaml',
      );
      expect(fs.existsSync(waiterCatalog)).toBe(true);
      expect(fs.readFileSync(waiterCatalog, 'utf8')).toContain('name: AgentContinuation');
    } finally {
      if (previous === undefined) delete process.env.REACTORY_DATA;
      else process.env.REACTORY_DATA = previous;
      fs.rmSync(dataRoot, { recursive: true, force: true });
      jest.resetModules();
    }
  });
});
