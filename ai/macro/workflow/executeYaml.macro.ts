import Reactory from "@reactorynet/reactory-core";
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IWorkflowDefinitionInput } from "@reactory/server-modules/reactory-core/services/Workflow/types";

/**
 * Lifecycle discriminator of an executeYamlWorkflow call.
 *
 * - 'dispatched' — the engine accepted the run and instanceId identifies it. Poll it with
 *   getWorkflowHistory(instanceId=...).
 * - 'dispatched_unconfirmed' — the dispatch call was made but the tool could not confirm it
 *   (no instance id came back, or the call threw after the dispatch attempt began). A run MAY BE
 *   LIVE. Do NOT retry blindly: a second dispatch of a side-effecting workflow (e.g.
 *   core.ProcessAITicket) duplicates branches and pull requests. Check getRecentExecutions first.
 * - 'failed' — the call was rejected before anything was dispatched. Safe to retry after fixing
 *   the cause.
 *
 * `success` is true only for 'dispatched'. This tool never reports 'completed'/'failed' for the
 * RUN: dispatch returns as soon as the engine accepts the instance, so any statement about the
 * run's own outcome would be a lie. There is deliberately no run-status field on the receipt —
 * the service's instance status is a hardcoded constant (see step 7) and history is the only
 * honest source for it.
 */
export type ExecuteYamlWorkflowStatus = 'dispatched' | 'dispatched_unconfirmed' | 'failed';

/**
 * Which definition the dispatched run executes.
 *
 * - 'file' — the run executes the steps in the file this call was given. Either this call
 *   registered them, or an already-registered entry resolves to this same content.
 * - 'registry' — the process already holds a definition for this nameSpace.name@version whose
 *   executable content differs from the file. The run executes that one; `warning` says so.
 *
 * This is computed by comparing executable content (steps/inputs/outputs/variables), not by
 * asking whether the FQN is known: a repeat run of an unchanged file is 'file' and stays silent.
 */
export type ExecuteYamlWorkflowDefinitionSource = 'file' | 'registry';

export interface ExecuteYamlWorkflowProps {
  filePath: string;
  inputs?: any;
  /**
   * Write the file's definition into the on-disk workflow catalog before dispatching.
   *
   * Defaults to false: the definition is validated and loaded into the runner's in-memory
   * registry only, so an existing catalog entry with the same nameSpace.name@version is left
   * untouched. Set to true only when the intent is to update the catalog — and note that a
   * catalog write does not replace a definition this process has already loaded (see the
   * `definitionStale` field and the warning).
   */
  register?: boolean;
}

export interface ExecuteYamlWorkflowResult {
  success: boolean;
  status: ExecuteYamlWorkflowStatus;
  /** nameSpace.name@version of the definition in the file. Always present once the file parsed. */
  fqn?: string;
  /** Engine instance id of the dispatched run — the handle for every follow-up query. */
  instanceId?: string;
  /** True when this call wrote the file's definition to the on-disk workflow catalog. */
  registered?: boolean;
  /**
   * Reported when `registered` is true. SUCCESS or PARTIAL; PARTIAL means the definition loaded
   * with validation warnings, so the caller knows something was degraded.
   */
  loadStatus?: string;
  /** Which definition the run executes: this file's content, or a different registered one. */
  definitionSource?: ExecuteYamlWorkflowDefinitionSource;
  /**
   * True only when this call wrote the catalog but the run still executes a DIFFERENT, already
   * loaded definition. `registered: true` is then a catalog fact, not an execution fact.
   */
  definitionStale?: boolean;
  /** Present when definitionSource is 'registry': the file's steps are not what runs. */
  warning?: string;
  error?: string;
  stack?: string;
}

/**
 * Format validation / load errors into a single readable string, keeping the error codes —
 * a bare message loses the machine-readable reason the caller needs.
 */
const formatErrors = (errors: any[] | undefined): string => {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  return errors
    .map((error: any) => {
      if (typeof error === 'string') return error;
      const message = typeof error?.message === 'string' ? error.message : undefined;
      const code = typeof error?.code === 'string' ? error.code : undefined;
      if (message && code) return `${message} (${code})`;
      return message || code;
    })
    .filter((text: unknown): text is string => typeof text === 'string' && text.length > 0)
    .join('; ');
};

/**
 * JSON with sorted keys (cycle-safe) so two definitions can be compared without depending on
 * property order.
 */
const stableStringify = (value: any): string | undefined => {
  const seen = new WeakSet<object>();
  const walk = (node: any): any => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return '[circular]';
    seen.add(node);
    if (Array.isArray(node)) return node.map(walk);
    const out: Record<string, any> = {};
    for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return undefined;
  }
};

/**
 * The parts of a definition that decide what actually executes. Designer metadata, descriptions
 * and version bumps for cosmetics must not make a definition look "stale".
 */
const executableShape = (definition: any): string | undefined => {
  if (!definition || typeof definition !== 'object') return undefined;
  return stableStringify({
    steps: definition.steps ?? null,
    inputs: definition.inputs ?? null,
    outputs: definition.outputs ?? null,
    variables: definition.variables ?? null,
  });
};

export const executeYamlWorkflow: Macro<unknown, ExecuteYamlWorkflowProps> = async (
  props: ExecuteYamlWorkflowProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const ctx = context || state.context;
  const { filePath, inputs = {}, register = false } = props;

  // Hoisted so the catch can report what the attempt had reached. `dispatchAttempted` is what
  // separates a safe-to-retry 'failed' from a may-be-live 'dispatched_unconfirmed'.
  let attemptedFqn: string | undefined;
  let dispatchAttempted = false;

  const failure = (error: string, extra: Partial<ExecuteYamlWorkflowResult> = {}): ExecuteYamlWorkflowResult => ({
    success: false,
    status: 'failed',
    ...extra,
    error,
  });

  try {
    if (!filePath) {
      return failure("filePath is required");
    }

    if (!fs.existsSync(filePath)) {
      return failure(`File not found at path: ${filePath}`);
    }

    // 1. Read the file
    const yamlContent = fs.readFileSync(filePath, 'utf8');

    // 2. Parse the YAML
    let definition: IWorkflowDefinitionInput;
    try {
      definition = yaml.load(yamlContent) as IWorkflowDefinitionInput;
    } catch (e: any) {
      return failure(`Failed to parse YAML: ${e.message}`);
    }

    if (!definition || !definition.nameSpace || !definition.name || !definition.version) {
      return failure("YAML definition must include nameSpace, name, and version.");
    }

    const fqn = `${definition.nameSpace}.${definition.name}@${definition.version}`;
    attemptedFqn = fqn;

    // 3. Get the Workflow Service
    if (!ctx) return failure("No execution context available.", { fqn });
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as any;
    if (!workflowService) {
      return failure("core.ReactoryWorkflowService@1.0.0 is not available in the context.", { fqn });
    }

    // 4. Ensure WorkflowRunner is initialized
    if (!workflowService.workflowRunner || !workflowService.workflowRunner.isInitialized()) {
      await workflowService.onStartup();
    }

    const runner = workflowService.workflowRunner;
    const lookup = (): any => (
      typeof runner.getWorkflowByName === 'function'
        ? runner.getWorkflowByName(definition.nameSpace, definition.name, definition.version)
        : undefined
    );

    // 5. Snapshot the registry entry BEFORE anything writes to it.
    //
    //    `saveWorkflowDefinition` registers the FQN in the runner itself once it has written the
    //    catalog, so a lookup taken after the save is always truthy — which made a first-ever
    //    `register: true` call report `definitionSource: 'registry'` and warn that the caller's
    //    own file had been ignored. The snapshot is the only way to tell "already there before I
    //    arrived" from "I just put it there".
    const preExisting = lookup();

    // 6. Validate — and only write the catalog when the caller explicitly asks for it.
    //
    //    This step used to call saveWorkflowDefinition unconditionally, overwriting whatever was
    //    registered under nameSpace.name@version with the file's contents: pointing the tool at a
    //    stale or worktree-local YAML silently replaced the live definition with no diff and no
    //    audit entry. The default is validation only.
    let registered = false;
    let loadStatus: string | undefined;
    if (register === true) {
      const saveResult = await workflowService.saveWorkflowDefinition(definition);
      loadStatus = saveResult?.loadStatus;
      // A missing result or a missing loadStatus is a registration failure: the catalog write is
      // the whole point of register: true, so an unconfirmed write must not dispatch as if it
      // had succeeded.
      if (loadStatus !== 'SUCCESS' && loadStatus !== 'PARTIAL') {
        const details = formatErrors(saveResult?.errors);
        return failure(
          `Failed to register workflow definition ${fqn}: ${loadStatus || 'no loadStatus returned by saveWorkflowDefinition'}${details ? ` — ${details}` : ''}. ` +
          'The catalog write could not be confirmed. Re-run with register: false to dispatch the file without writing the catalog.',
          { fqn, ...(loadStatus ? { loadStatus } : {}) }
        );
      }
      registered = true;
    } else if (typeof workflowService.validateWorkflowDefinition === 'function') {
      const validation = await workflowService.validateWorkflowDefinition(definition);
      if (validation && validation.isValid === false) {
        const details = formatErrors(validation.errors);
        return failure(
          `Workflow definition ${fqn} failed validation${details ? `: ${details}` : ''}.`,
          { fqn }
        );
      }
    }

    // 7. Decide what the run will actually execute.
    //
    //    An entry that pre-existed only competes with the file if its executable content differs.
    //    Comparing content (not merely "is this FQN known") keeps a repeat run of an unchanged
    //    file silent — otherwise every later call warned that the file was ignored and the
    //    warning became noise on the one run where it mattered.
    //
    //    A pre-existing entry with no cached steps resolves its definition lazily from
    //    `location`, so in that case location identity is what decides.
    const executedFromFile = ((): boolean => {
      if (!preExisting) return true; // this call registers the file (or the save just did)
      const cached = preExisting.props;
      const hasCachedSteps = !!(cached && Array.isArray(cached.steps) && cached.steps.length > 0);
      if (!hasCachedSteps) {
        const location = typeof preExisting.location === 'string' ? path.resolve(preExisting.location) : undefined;
        return location === path.resolve(filePath);
      }
      return executableShape(cached) === executableShape(definition);
    })();

    const definitionSource: ExecuteYamlWorkflowDefinitionSource = executedFromFile ? 'file' : 'registry';
    // A catalog write that did not change what runs: `registered` is a catalog fact, not an
    // execution fact.
    const definitionStale = registered && definitionSource === 'registry';

    // 8. Register the file's definition when nothing else did.
    //
    //    `registerWorkflow` APPENDS and every lookup is a first match, so re-registering an FQN
    //    the process already holds cannot displace the existing entry — it only grows the
    //    registry. Skipped when a pre-existing entry exists, and skipped when register: true has
    //    already made the service register the catalog target.
    if (!preExisting && !registered && !lookup()) {
      runner.registerWorkflow({
        nameSpace: definition.nameSpace,
        name: definition.name,
        version: definition.version,
        workflowType: 'YAML',
        location: filePath,
        props: definition,
      });
    }

    // NOTE: no circuit-breaker reset here. YAML starts go through WorkflowRunner.startYamlWorkflow,
    // which returns before errorHandler.executeWithRetry ever runs — so no breaker is set on this
    // path and there is nothing to reset. Resetting `definition.name` and `${fqn}@1` (the residue
    // of the retired major-version truncation) implied retry semantics this path does not have.

    // 9. Dispatch the workflow
    let parsedInputs = inputs;
    if (typeof inputs === 'string' && inputs.trim().length > 0) {
      try {
        parsedInputs = JSON.parse(inputs);
      } catch (e) {
        parsedInputs = {};
      }
    }

    // IReactoryWorkflowService.startWorkflow returns the IWorkflowInstance and is the same entry
    // point the GraphQL startWorkflow mutation uses; it takes { input } because startYamlWorkflow
    // unwraps data.input. Only `id` is read from the instance — its `status` is a hardcoded
    // WorkflowStatus.RUNNING in the service's lifecycle-miss fallback (ReactoryWorkflowService.ts
    // :1085), because nothing in production calls LifecycleManager.startWorkflow. Reporting it
    // would present a constant as an observation.
    let instanceId: string | undefined;
    let unconfirmedReason: string | undefined;

    dispatchAttempted = true;
    if (typeof workflowService.startWorkflow === 'function') {
      const instance = await workflowService.startWorkflow(fqn, { input: parsedInputs });
      instanceId = instance?.id;
      if (!instanceId) unconfirmedReason = 'the workflow service returned no instance id';
    } else {
      // Same { input } envelope as the primary branch: the fallback is the same contract, and
      // passing inputs raw would unwrap to a different depth when a workflow input is itself
      // named `input`.
      const startedId = await runner.startWorkflow(fqn, definition.version, { input: parsedInputs }, ctx);
      if (!startedId || typeof startedId !== 'string') {
        unconfirmedReason = 'the workflow runner returned no instance id';
      } else {
        instanceId = startedId;
      }
    }

    if (!instanceId) {
      // The dispatch call was made. A run may be live, so this must not look retryable.
      return {
        success: false,
        status: 'dispatched_unconfirmed',
        fqn,
        registered,
        ...(loadStatus ? { loadStatus } : {}),
        definitionSource,
        definitionStale,
        error:
          `${fqn} was dispatched but ${unconfirmedReason}. The run may be live — do NOT retry. ` +
          'Check getRecentExecutions for a run started moments ago, and use getWorkflowHistory once you have its id.',
      };
    }

    // 10. Return the dispatch receipt. No outputs/state (dispatch returns before the run
    //     finishes) and no run-status field (see step 9).
    const result: ExecuteYamlWorkflowResult = {
      success: true,
      status: 'dispatched',
      fqn,
      instanceId,
      registered,
      ...(loadStatus ? { loadStatus } : {}),
      definitionSource,
      definitionStale,
    };

    if (definitionSource === 'registry') {
      result.warning =
        `${fqn} is already loaded in this process with a definition whose steps differ from ${filePath}, ` +
        'so this run executes the loaded definition, not the steps in this file.' +
        (definitionStale
          ? ' The catalog was updated, but a running process keeps executing the definition it loaded at startup.'
          : '') +
        ' To make changed steps take effect, bump `version` in the YAML (a new nameSpace.name@version gets ' +
        'a fresh engine id) or restart the server. Re-saving the same version does not replace a definition ' +
        'the process has already loaded.';
    }

    return result;

  } catch (err: any) {
    ctx?.log(`executeYamlWorkflow Macro Error: ${err.message}`, 'error');

    if (dispatchAttempted) {
      // A throw after the dispatch attempt began is indistinguishable from a throw after the
      // engine accepted the instance (e.g. inside the service, or a post-accept finalizer), so
      // the conservative report is "may be live" — retrying could duplicate a real run.
      const result: ExecuteYamlWorkflowResult = {
        success: false,
        status: 'dispatched_unconfirmed',
        ...(attemptedFqn ? { fqn: attemptedFqn } : {}),
        error:
          `${err.message} — the dispatch attempt had already started, so a run may be live. ` +
          'Do NOT retry blindly; check getRecentExecutions first.',
      };
      if (err?.stack) result.stack = err.stack;
      return result;
    }

    const result: ExecuteYamlWorkflowResult = {
      success: false,
      status: 'failed',
      ...(attemptedFqn ? { fqn: attemptedFqn } : {}),
      error: err.message,
    };
    if (err?.stack) result.stack = err.stack;
    return result;
  }
};

export const ExecuteYamlWorkflowRegistry: MacroComponentDefinition<typeof executeYamlWorkflow> = {
  nameSpace: 'reactor-macros',
  name: 'executeYamlWorkflow',
  alias: 'executeYamlWorkflow',
  version: '1.0.0',
  component: executeYamlWorkflow,
  roles: ['ADMIN', 'DEVELOPER'],
  description: `# executeYamlWorkflow
  Loads a YAML workflow definition from a file and dispatches it to the Reactory Workflow Engine
  with the provided inputs.

  ## Dispatch only
  The call returns as soon as the engine has accepted the run. It does not wait for the run to
  finish, does not return workflow outputs, and does not report the run's status — read that from
  getWorkflowHistory(instanceId=...), which is the durable record.

  ## Status tells you whether it is safe to retry
  - 'dispatched' — accepted, instanceId identifies it. success is true.
  - 'dispatched_unconfirmed' — the dispatch call was made but could not be confirmed (no instance
    id returned, or it threw after the attempt began). A run MAY BE LIVE. Do NOT retry; check
    getRecentExecutions.
  - 'failed' — rejected before anything was dispatched. Safe to retry once the cause is fixed.

  ## Receipt fields
  instanceId, fqn, registered (catalog written by this call), loadStatus (SUCCESS or PARTIAL when
  registered), definitionSource and definitionStale.

  - definitionSource 'file' — the run executes this file's steps.
  - definitionSource 'registry' — the process already holds a definition for this
    nameSpace.name@version whose steps differ from the file, so the run executes that one and
    warning says so.
  - definitionStale — true when this call wrote the catalog but the run still executes a different
    already-loaded definition. registered is then a catalog fact, not an execution fact.

  ## Changing a definition the process already loaded
  Re-saving or bumping nothing does not replace it: the runner keeps the definition it loaded, and
  the engine bridge is registered once per workflow id. To make changed steps take effect, bump
  'version' in the YAML or restart the server.

  ## The catalog is not touched by default
  The definition is validated and loaded into the runner's in-memory registry only. Pass
  register: true to write the catalog entry nameSpace.name@version; use saveWorkflowYaml for
  deliberate catalog edits.

  ## Usage
  @executeYamlWorkflow(filePath, inputs, register)
  `,
  features: [
    {
      feature: 'executeYamlWorkflow',
      featureType: Reactory.FeatureType.function,
      action: ['execute', 'run', 'test'],
      description: 'Executes a YAML workflow from a file.',
      stem: 'execute'
    }
  ],
  stem: 'execute',
  tags: ['workflow', 'yaml', 'execute', 'test'],
  tools: [{
    type: "function",
    function: {
      name: "executeYamlWorkflow",
      description:
        "Loads a YAML workflow definition from a file and dispatches it to the Reactory Workflow " +
        "Engine. Returns { success, status, fqn, instanceId, registered, loadStatus, " +
        "definitionSource, definitionStale, warning } as soon as the run is accepted; it does not " +
        "wait for completion, returns no outputs and reports no run status (read that from " +
        "getWorkflowHistory(instanceId=...)). status is 'dispatched' (accepted), " +
        "'dispatched_unconfirmed' (a run MAY BE LIVE — do not retry, check getRecentExecutions) or " +
        "'failed' (nothing dispatched, safe to retry). definitionSource 'registry' means the " +
        "process already holds a different definition for that workflow id, so the run executes " +
        "that one, not the file's steps; to make changed steps take effect, bump version or " +
        "restart the server. The on-disk catalog is only written when register: true.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute path to the YAML file"
          },
          inputs: {
            // Models frequently send a JSON string; the macro accepts both, so the schema says
            // so instead of leaving a reachable shape unadvertised.
            oneOf: [
              { type: "object", description: "Inputs to pass to the workflow" },
              { type: "string", description: "JSON-encoded inputs object" }
            ]
          } as any,
          register: {
            type: "boolean",
            description:
              "Write the file's definition into the on-disk workflow catalog before dispatching, " +
              "overwriting any definition registered under the same nameSpace.name@version. " +
              "Defaults to false: the definition is validated and loaded in memory only. A catalog " +
              "write does not replace a definition this process has already loaded — see " +
              "definitionStale."
          }
        },
        required: ["filePath"]
      }
    }
  }]
};
