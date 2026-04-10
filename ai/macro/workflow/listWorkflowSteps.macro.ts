import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface ListWorkflowStepsProps {
  searchTerm?: string;
  type?: 'core' | 'custom' | 'all';
}

export const listWorkflowSteps: Macro<unknown, ListWorkflowStepsProps> = async (
  props: ListWorkflowStepsProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const { searchTerm, type = 'all' } = props;

  const ctx = context || state.context;
  try {
    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const runner = (workflowService as any).workflowRunner;
    if (!runner) {
      return { success: false, error: "WorkflowRunner is not initialized." };
    }

    const stepRegistry = runner.getStepRegistry();
    if (!stepRegistry) {
      return { success: false, error: "YamlStepRegistry is not available." };
    }

    const registeredStepTypes: string[] = stepRegistry.getRegisteredSteps();
    const stats = stepRegistry.getStats();

    const coreStepTypes = ['log', 'delay', 'validation', 'dataTransformation', 'apiCall', 'cliCommand', 'fileOperation', 'start', 'end', 'condition', 'for_each', 'service_invoke'];

    let filteredSteps = registeredStepTypes;

    if (type === 'core') {
      filteredSteps = filteredSteps.filter(s => coreStepTypes.includes(s));
    } else if (type === 'custom') {
      filteredSteps = filteredSteps.filter(s => !coreStepTypes.includes(s));
    }

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filteredSteps = filteredSteps.filter(s => {
        if (s.toLowerCase().includes(term)) return true;
        try {
          const meta = stepRegistry.getStepMetadata(s);
          return meta.options?.description?.toLowerCase().includes(term);
        } catch {
          return false;
        }
      });
    }

    const steps = filteredSteps.map(stepType => {
      try {
        const meta = stepRegistry.getStepMetadata(stepType);
        return {
          stepType,
          description: meta.options?.description ?? null,
          version: meta.options?.version ?? null,
          isCore: coreStepTypes.includes(stepType),
        };
      } catch {
        return { stepType, description: null, version: null, isCore: coreStepTypes.includes(stepType) };
      }
    });

    return {
      success: true,
      steps,
      count: steps.length,
      stats: {
        totalSteps: stats.totalSteps,
        coreSteps: stats.coreSteps,
        customSteps: stats.customSteps,
      },
    };
  } catch (err: any) {
    ctx?.log(`listWorkflowSteps Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const ListWorkflowStepsRegistry: MacroComponentDefinition<typeof listWorkflowSteps> = {
  nameSpace: 'reactor-macros',
  name: 'listWorkflowSteps',
  alias: 'listWorkflowSteps',
  version: '1.0.0',
  component: listWorkflowSteps,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# listWorkflowSteps
  Lists all available YAML workflow step types registered in the YamlStepRegistry.
  Includes both core built-in steps and custom steps registered by modules.

  ## Usage
  @listWorkflowSteps(searchTerm?, type?)
  `,
  features: [
    {
      feature: 'listWorkflowSteps',
      featureType: Reactory.FeatureType.function,
      action: ['list', 'query', 'discover'],
      description: 'Lists available workflow step types from the step registry.',
      stem: 'list',
    },
  ],
  stem: 'list',
  tags: ['workflow', 'steps', 'registry', 'discover'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "listWorkflowSteps",
        description: "Lists all available YAML workflow step types registered in the runtime. Returns each step's type identifier, description, version, and whether it is a core or custom step. Use this to discover what step types are available when building or reviewing workflows.",
        parameters: {
          type: "object",
          properties: {
            searchTerm: {
              type: "string",
              description: "Filter steps by name or description containing this term",
            },
            type: {
              type: "string",
              enum: ["core", "custom", "all"],
              description: "Filter by step category: 'core' for built-in steps, 'custom' for module-registered steps, 'all' (default) for both.",
            },
          },
          required: [],
        },
      },
    },
  ],
};
