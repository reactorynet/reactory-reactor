import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface SaveWorkflowYamlProps {
  nameSpace: string;
  name: string;
  version: string;
  yamlContent: string;
  includeSource?: boolean;
}

export const saveWorkflowYaml: Macro<unknown, SaveWorkflowYamlProps> = async (
  props: SaveWorkflowYamlProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const { nameSpace, name, version, yamlContent, includeSource = false } = props;

  const ctx = context || state.context;
  try {
    if (!nameSpace || !name || !version) {
      return { success: false, error: "'nameSpace', 'name', and 'version' are required." };
    }
    if (typeof yamlContent !== 'string' || yamlContent.trim().length === 0) {
      return { success: false, error: "'yamlContent' must be a non-empty YAML string." };
    }
    if (!ctx) return { success: false, error: "No execution context available." };

    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const result = await workflowService.saveWorkflowYaml(nameSpace, name, version, yamlContent);

    if (result.loadStatus !== 'SUCCESS' && result.loadStatus !== 'PARTIAL') {
      return {
        success: false,
        nameSpace: result.nameSpace,
        name: result.name,
        version: result.version,
        loadStatus: result.loadStatus,
        errors: result.errors,
        error: result.errors?.[0]?.message ?? `Save failed with status ${result.loadStatus}`,
      };
    }

    const base = {
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
    };

    if (includeSource) {
      return { ...base, yamlSource: result.yamlSource, steps: result.steps, designer: result.designer };
    }

    return {
      ...base,
      hint: "Workflow persisted to the YAML catalog and registered with the runner. Use includeSource=true to echo the stored YAML back.",
    };
  } catch (err: any) {
    ctx?.log(`saveWorkflowYaml Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const SaveWorkflowYamlRegistry: MacroComponentDefinition<typeof saveWorkflowYaml> = {
  nameSpace: 'reactor-macros',
  name: 'saveWorkflowYaml',
  alias: 'saveWorkflowYaml',
  version: '1.0.0',
  component: saveWorkflowYaml,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN'],
  description: `# saveWorkflowYaml
  Persists a raw YAML workflow definition to the Reactory workflow catalog via the ReactoryWorkflowService.
  The service validates identifiers and YAML structure, writes to the correct catalog location, and
  registers the workflow with the runner — prefer this over writing files manually.

  ## Usage
  @saveWorkflowYaml(nameSpace, name, version, yamlContent)
  `,
  features: [
    {
      feature: 'saveWorkflowYaml',
      featureType: Reactory.FeatureType.function,
      action: ['save', 'create', 'update', 'write'],
      description: 'Persists a raw YAML workflow definition via the workflow service.',
      stem: 'mutation',
    },
  ],
  stem: 'mutation',
  tags: ['workflow', 'yaml', 'save', 'persist', 'catalog'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: false,
      function: {
        name: "saveWorkflowYaml",
        description: "Saves a raw YAML workflow definition to the Reactory catalog via the workflow service. Validates and writes to the correct location, then registers the workflow with the runner. Use this instead of writing YAML files directly.",
        parameters: {
          type: "object",
          properties: {
            nameSpace: {
              type: "string",
              description: "The workflow namespace. Must match [a-zA-Z0-9_.-]+.",
            },
            name: {
              type: "string",
              description: "The workflow name. Must match [a-zA-Z0-9_.-]+.",
            },
            version: {
              type: "string",
              description: "The workflow version (e.g. '1.0.0'). Must match [a-zA-Z0-9_.-]+.",
            },
            yamlContent: {
              type: "string",
              description: "The full YAML source text for the workflow definition. Must parse to a valid workflow object.",
            },
            includeSource: {
              type: "boolean",
              description: "When true, echoes the stored YAML source, steps array, and designer data back in the response. Default false.",
            },
          },
          required: ["nameSpace", "name", "version", "yamlContent"],
        },
      },
    },
  ],
};
