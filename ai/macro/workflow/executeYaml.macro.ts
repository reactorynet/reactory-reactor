import Reactory from "@reactorynet/reactory-core";
import fs from 'fs';
import yaml from 'js-yaml';
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IWorkflowDefinitionInput } from "@reactory/server-modules/reactory-core/services/Workflow/types";

/**
 * Lifecycle discriminator of an executeYamlWorkflow call.
 *
 * - 'dispatched' — the run was accepted by the workflow engine and instanceId identifies it.
 *   The run continues asynchronously; poll it with getWorkflowHistory(instanceId=...).
 * - 'failed' — the file could not be read, parsed, validated, registered or dispatched.
 *
 * This tool never reports 'completed' or 'failed' for the *run*: dispatch returns as soon as the
 * engine has accepted the instance, so any statement about the run's own outcome would be a lie.
 * There is deliberately no run-status field on the receipt — see definitionSource for the one
 * piece of provenance that IS known at dispatch time.
 */
export type ExecuteYamlWorkflowStatus = 'dispatched' | 'failed';

/**
 * Which definition the dispatched run will execute.
 *
 * - 'file' — the file's definition was registered in this process' runner registry by this call.
 * - 'registry' — a definition for the same nameSpace.name@version was ALREADY registered in this
 *   process, so the file's steps were not used and the engine runs the registered definition.
 *   This is reported rather than silently tolerated because the tool is normally used to test
 *   worktree-local YAML against a workflow that is also registered from the catalog.
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
   * untouched. Set to true only when the intent is to (re)register the definition — use the
   * dedicated saveWorkflowYaml tool for catalog writes.
   */
  register?: boolean;
}

export interface ExecuteYamlWorkflowResult {
  success: boolean;
  status: ExecuteYamlWorkflowStatus;
  /** nameSpace.name@version of the definition in the file. */
  fqn?: string;
  /** Engine instance id of the dispatched run — the handle for every follow-up query. */
  instanceId?: string;
  /** True when the file's definition was written to the on-disk workflow catalog. */
  registered?: boolean;
  /** Which definition the run executes: the file's, or one already registered in this process. */
  definitionSource?: ExecuteYamlWorkflowDefinitionSource;
  /** Present when definitionSource is 'registry': the file's steps were not used. */
  warning?: string;
  error?: string;
  stack?: string;
}

/**
 * Format validation / load errors into a single readable string.
 */
const formatErrors = (errors: any[] | undefined): string => {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  return errors
    .map((error: any) => (typeof error === 'string' ? error : error?.message))
    .filter((message: unknown): message is string => typeof message === 'string' && message.length > 0)
    .join('; ');
};

export const executeYamlWorkflow: Macro<unknown, ExecuteYamlWorkflowProps> = async (
  props: ExecuteYamlWorkflowProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const ctx = context || state.context;
  const { filePath, inputs = {}, register = false } = props;

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

    // 5. Validate — and only write the catalog when the caller explicitly asks for it.
    //
    //    This step used to call saveWorkflowDefinition(definition) unconditionally, which
    //    overwrote whatever was registered under nameSpace.name@version with the contents of
    //    the file. Pointing the tool at a stale or worktree-local YAML therefore silently
    //    replaced the live definition: no diff, no confirmation, no audit entry. The default is
    //    now validation only; catalog writes belong to saveWorkflowYaml / register: true.
    let registered = false;
    if (register === true) {
      const saveResult = await workflowService.saveWorkflowDefinition(definition);
      const loadStatus = saveResult?.loadStatus;
      // A missing result or a missing loadStatus is a registration failure, not a success: the
      // catalog write is the whole point of register: true, so an unconfirmed write must abort
      // the dispatch rather than proceed on an unknown catalog state.
      if (loadStatus !== 'SUCCESS' && loadStatus !== 'PARTIAL') {
        const details = formatErrors(saveResult?.errors);
        return failure(
          `Failed to register workflow definition ${fqn}: ${loadStatus || 'no loadStatus returned by saveWorkflowDefinition'}${details ? ` — ${details}` : ''}. ` +
          'The catalog was not written; re-run with register: false to dispatch the file without writing it.',
          { fqn }
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

    // 6. Load the file's definition into this process' in-memory runner registry.
    //
    //    registerWorkflow APPENDS to runner.state.workflows, and the runner resolves a start with
    //    a first-match lookup (startWorkflow uses .find(); getWorkflowByName uses
    //    selectWorkflowByName, which returns matches.find(...) for an explicit version). So when
    //    this FQN is already registered — the normal case for a catalog workflow — an extra append
    //    would be dead weight AND the run would execute the ALREADY REGISTERED definition, not the
    //    file's. Re-bridging a changed definition would additionally require
    //    registerYamlWorkflowOnHost to rebuild the host class, which is idempotent per engine id.
    //    Both facts are reported to the caller through definitionSource instead of being hidden.
    const runner = workflowService.workflowRunner;
    const existing = typeof runner.getWorkflowByName === 'function'
      ? runner.getWorkflowByName(definition.nameSpace, definition.name, definition.version)
      : undefined;

    const definitionSource: ExecuteYamlWorkflowDefinitionSource = existing ? 'registry' : 'file';

    if (!existing) {
      runner.registerWorkflow({
        nameSpace: definition.nameSpace,
        name: definition.name,
        version: definition.version,
        workflowType: 'YAML',
        location: filePath,
        props: definition,
      });
    }

    // Reset circuit breaker for this workflow in case a previous run failed
    if (typeof runner.resetCircuitBreaker === 'function') {
      runner.resetCircuitBreaker(fqn);
      runner.resetCircuitBreaker(definition.name);
      runner.resetCircuitBreaker(`${fqn}@1`);
    }

    // 7. Dispatch the workflow
    let parsedInputs = inputs;
    if (typeof inputs === 'string' && inputs.trim().length > 0) {
      try {
        parsedInputs = JSON.parse(inputs);
      } catch (e) {
        parsedInputs = {};
      }
    }

    // IReactoryWorkflowService.startWorkflow returns the IWorkflowInstance and is the same entry
    // point the GraphQL startWorkflow mutation uses. The runner's own startWorkflow returns the
    // bare instance id string — reading .outputs / .state off it is what made this macro report
    // { success: true } with no handle in the first place.
    //
    // Only `id` is taken from the instance. Its `status` is NOT surfaced: nothing in production
    // calls LifecycleManager.startWorkflow, so ReactoryWorkflowService.startWorkflow's
    // lifecycle-manager lookup always misses and it returns a fallback whose status is a hardcoded
    // WorkflowStatus.RUNNING (ReactoryWorkflowService.ts:1085). Emitting that would present a
    // constant as an observation — the very "two surfaces, two vocabularies" problem this ticket
    // is about. The engine's real state is read from getWorkflowHistory(instanceId=...).
    let instanceId: string | undefined;

    if (typeof workflowService.startWorkflow === 'function') {
      const instance = await workflowService.startWorkflow(fqn, { input: parsedInputs });
      instanceId = instance?.id || instance?.instanceId;
      if (!instanceId) {
        return failure(
          `Workflow ${fqn} was dispatched but the workflow service did not return an instance id.`,
          { fqn, definitionSource }
        );
      }
    } else {
      // Service implementations without the instance-returning entry point: the runner's
      // startWorkflow does return the instance id (never an object).
      const startedId = await runner.startWorkflow(fqn, definition.version, parsedInputs, ctx);
      if (!startedId || typeof startedId !== 'string') {
        return failure(
          `Workflow ${fqn} was dispatched but the workflow runner did not return an instance id.`,
          { fqn, definitionSource }
        );
      }
      instanceId = startedId;
    }

    // 8. Return the dispatch receipt. No outputs / state (dispatch returns before the run
    //    finishes), and no run-status field (see step 7).
    const result: ExecuteYamlWorkflowResult = {
      success: true,
      status: 'dispatched',
      fqn,
      instanceId,
      registered,
      definitionSource,
    };

    if (definitionSource === 'registry') {
      result.warning =
        `${fqn} was already registered in this process before the call, so the run executes that ` +
        'definition, not the steps in the file you passed. To run the file itself, use a definition ' +
        'whose nameSpace.name@version is not already registered, or re-save it with saveWorkflowYaml.';
    }

    return result;

  } catch (err: any) {
    ctx?.log(`executeYamlWorkflow Macro Error: ${err.message}`, 'error');
    const result: ExecuteYamlWorkflowResult = {
      success: false,
      status: 'failed',
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

  Returns:
  - status 'dispatched' with:
    - instanceId — the engine instance id, the handle for every follow-up query;
    - fqn — nameSpace.name@version from the file;
    - registered — true when the on-disk catalog was written (only with register: true);
    - definitionSource — 'file' when this call registered the file's definition, or 'registry'
      when that workflow id was already registered in the process, in which case the run executes
      the registered definition and warning says so.
  - status 'failed' with error when the file cannot be read, parsed, validated, registered or
    dispatched. success is never true without a status.

  Follow the run up with getWorkflowHistory(instanceId=...) (state, steps and pointers) or
  controlWorkflowInstance (pause/resume/cancel).

  ## The catalog is not touched by default
  The definition is validated and loaded into the runner's in-memory registry only. Pass
  register: true to overwrite the catalog entry nameSpace.name@version with the file's contents;
  use saveWorkflowYaml for deliberate catalog writes.

  ## A changed file for an already-registered workflow is not picked up
  Dispatch cannot replace a definition the process already holds: the check is a first-match
  registry lookup and the engine bridge is registered once per workflow id. Watch
  definitionSource — when it is 'registry' the file's steps were not used.

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
        "Engine. Returns { success, status: 'dispatched', fqn, instanceId, registered, " +
        "definitionSource } as soon as the run is accepted; it does not wait for completion, " +
        "returns no outputs and reports no run status. Poll the run with " +
        "getWorkflowHistory(instanceId=...). The on-disk workflow catalog is only written when " +
        "register: true. definitionSource is 'registry' when that workflow id was already " +
        "registered in the process, meaning the run executes the registered definition rather " +
        "than the file's steps.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute path to the YAML file"
          },
          inputs: {
            type: "object",
            description: "Inputs to pass to the workflow"
          },
          register: {
            type: "boolean",
            description:
              "Write the file's definition into the on-disk workflow catalog before dispatching, " +
              "overwriting any definition registered under the same nameSpace.name@version. " +
              "Defaults to false: the definition is validated and loaded in memory only."
          }
        },
        required: ["filePath"]
      }
    }
  }]
};
