import Reactory from "@reactorynet/reactory-core";
import fs from 'fs';
import yaml from 'js-yaml';
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IWorkflowDefinitionInput } from "@reactory/server-modules/reactory-core/services/Workflow/types";


export interface ExecuteYamlWorkflowProps {
  filePath: string;
  inputs?: any;
  timeout?: number;
}

export const executeYamlWorkflow: Macro<unknown, ExecuteYamlWorkflowProps> = async (
  props: ExecuteYamlWorkflowProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const ctx = context || state.context;
  const { filePath, inputs = {}, timeout = 30000 } = props;

  try {
    if (!filePath) {
      return { success: false, error: "filePath is required" };
    }

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found at path: ${filePath}` };
    }

    // 1. Read the file
    const yamlContent = fs.readFileSync(filePath, 'utf8');

    // 2. Parse the YAML
    let definition: IWorkflowDefinitionInput;
    try {
      definition = yaml.load(yamlContent) as IWorkflowDefinitionInput;
    } catch (e: any) {
      return { success: false, error: `Failed to parse YAML: ${e.message}` };
    }

    if (!definition || !definition.nameSpace || !definition.name || !definition.version) {
      return { success: false, error: "YAML definition must include nameSpace, name, and version." };
    }

    const fqn = `${definition.nameSpace}.${definition.name}@${definition.version}`;

    // 3. Get the Workflow Service
    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as any;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    // 4. Ensure WorkflowRunner is initialized
    if (!workflowService.workflowRunner || !workflowService.workflowRunner.isInitialized()) {
      await workflowService.onStartup();
    }

    // 5. Register the workflow definition
    const saveResult = await workflowService.saveWorkflowDefinition(definition);
    if (saveResult && saveResult.loadStatus === 'PARSE_ERROR') {
      return { success: false, error: `Failed to validate workflow definition: ${fqn}` };
    }

    // 6. Execute the workflow
    const result = await workflowService.workflowRunner.startWorkflow(fqn, definition.version, inputs, state.context);

    // 7. Return the result
    return {
      success: true,
      fqn,
      outputs: result.outputs,
      state: result.state
    };

  } catch (err: any) {
    ctx?.log(`executeYamlWorkflow Macro Error: ${err.message}`, 'error');
    return {
      success: false,
      error: err.message,
      stack: err.stack
    };
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
  Loads a YAML workflow definition from a file, registers it with the Reactory Workflow Service, and executes it with the provided inputs.
  
  ## Usage
  @executeYamlWorkflow(filePath, inputs, timeout)
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
      description: "Loads a YAML workflow definition from a file, registers it with the Reactory Workflow Service, and executes it.",
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
          timeout: {
            type: "number",
            description: "Maximum execution time in milliseconds"
          }
        },
        required: ["filePath"]
      }
    }
  }]
};