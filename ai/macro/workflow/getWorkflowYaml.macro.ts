import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface GetWorkflowYamlProps {
  nameSpace: string;
  name: string;
  version?: string;
  includeSource?: boolean;
}

export const getWorkflowYaml: Macro<unknown, GetWorkflowYamlProps> = async (
  props: GetWorkflowYamlProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const { nameSpace, name, version, includeSource = false } = props;

  const ctx = context || state.context;
  try {
    if (!nameSpace || !name) {
      return { success: false, error: "'nameSpace' and 'name' are required." };
    }
    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const result = await workflowService.getWorkflowYamlDefinition(nameSpace, name, version);

    if (!result) {
      return { success: false, error: `No YAML definition found for ${nameSpace}.${name}${version ? `@${version}` : ''}` };
    }

    if (includeSource) {
      return { success: true, ...result };
    }

    return {
      success: true,
      nameSpace: result.nameSpace,
      name: result.name,
      version: result.version,
      description: result.description,
      author: result.author,
      tags: result.tags,
      sourceType: result.sourceType,
      location: result.location,
      loadStatus: result.loadStatus,
      stepCount: result.steps?.length ?? 0,
      errors: result.errors,
      hint: "Use includeSource=true to get the full YAML source, steps array, and designer data.",
    };
  } catch (err: any) {
    ctx?.log(`getWorkflowYaml Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const GetWorkflowYamlRegistry: MacroComponentDefinition<typeof getWorkflowYaml> = {
  nameSpace: 'reactor-macros',
  name: 'getWorkflowYaml',
  alias: 'getWorkflowYaml',
  version: '1.0.0',
  component: getWorkflowYaml,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN'],
  description: `# getWorkflowYaml
  Retrieves the YAML/JSON workflow definition source for a registered workflow.
  Useful for inspecting, editing, or debugging workflow step definitions.

  ## Usage
  @getWorkflowYaml(nameSpace, name, version?)
  `,
  features: [
    {
      feature: 'getWorkflowYaml',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'retrieve', 'read'],
      description: 'Retrieves the YAML definition of a registered workflow.',
      stem: 'get',
    },
  ],
  stem: 'get',
  tags: ['workflow', 'yaml', 'definition', 'source'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getWorkflowYaml",
        description: "Retrieves the YAML workflow definition source for a registered workflow. Returns the raw definition content along with load status and validation details.",
        parameters: {
          type: "object",
          properties: {
            nameSpace: {
              type: "string",
              description: "The workflow namespace",
            },
            name: {
              type: "string",
              description: "The workflow name",
            },
            version: {
              type: "string",
              description: "Optional workflow version. Defaults to the latest version if not provided.",
            },
            includeSource: {
              type: "boolean",
              description: "When true, includes the full YAML source text, steps array, and designer data. Default false returns metadata and load status only.",
            },
          },
          required: ["nameSpace", "name"],
        },
      },
    },
  ],
};
