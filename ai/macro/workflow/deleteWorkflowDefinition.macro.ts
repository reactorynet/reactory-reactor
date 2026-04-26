import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface DeleteWorkflowDefinitionProps {
  nameSpace: string;
  name: string;
  version?: string;
  confirm: boolean;
}

export const deleteWorkflowDefinition: Macro<unknown, DeleteWorkflowDefinitionProps> = async (
  props: DeleteWorkflowDefinitionProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const { nameSpace, name, version, confirm } = props;
  const ctx = context || state.context;

  try {
    if (!nameSpace || !name) {
      return { success: false, error: "'nameSpace' and 'name' are required." };
    }
    if (confirm !== true) {
      return {
        success: false,
        error: "Destructive operation requires confirm=true to proceed.",
        hint: `Call again with confirm=true to delete ${nameSpace}.${name}${version ? `@${version}` : '@1.0.0 (default)'}.`,
      };
    }
    if (!ctx) return { success: false, error: "No execution context available." };

    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const result = await workflowService.deleteWorkflowDefinition(nameSpace, name, version);

    return {
      success: result.success,
      message: result.message,
      nameSpace,
      name,
      version: version || '1.0.0',
    };
  } catch (err: any) {
    ctx?.log(`deleteWorkflowDefinition Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const DeleteWorkflowDefinitionRegistry: MacroComponentDefinition<typeof deleteWorkflowDefinition> = {
  nameSpace: 'reactor-macros',
  name: 'deleteWorkflowDefinition',
  alias: 'deleteWorkflowDefinition',
  version: '1.0.0',
  component: deleteWorkflowDefinition,
  roles: ['ADMIN', 'WORKFLOW_ADMIN'],
  description: `# deleteWorkflowDefinition
  Deletes a workflow YAML definition from the Reactory catalog via the ReactoryWorkflowService.
  Destructive — requires confirm=true. Cleans up the empty version directory after removing the file.

  ## Usage
  @deleteWorkflowDefinition(nameSpace, name, version?, confirm=true)
  `,
  features: [
    {
      feature: 'deleteWorkflowDefinition',
      featureType: Reactory.FeatureType.function,
      action: ['delete', 'remove'],
      description: 'Deletes a workflow definition from the YAML catalog.',
      stem: 'mutation',
    },
  ],
  stem: 'mutation',
  tags: ['workflow', 'yaml', 'delete', 'catalog', 'destructive'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: false,
      function: {
        name: "deleteWorkflowDefinition",
        description: "Deletes a workflow YAML definition from the Reactory catalog. Destructive — requires confirm=true. Defaults to version '1.0.0' when version is omitted.",
        parameters: {
          type: "object",
          properties: {
            nameSpace: {
              type: "string",
              description: "The workflow namespace.",
            },
            name: {
              type: "string",
              description: "The workflow name.",
            },
            version: {
              type: "string",
              description: "Optional workflow version. Defaults to '1.0.0'.",
            },
            confirm: {
              type: "boolean",
              description: "Must be true to actually perform the delete. Acts as a safety gate.",
            },
          },
          required: ["nameSpace", "name", "confirm"],
        },
      },
    },
  ],
};
