import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface GetWorkflowProps {
  id?: string;
  nameSpace?: string;
  name?: string;
  detail?: 'summary' | 'full';
}

export const getWorkflow: Macro<unknown, GetWorkflowProps> = async (
  props: GetWorkflowProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const { id, nameSpace, name, detail = 'summary' } = props;

  const ctx = context || state.context;
  try {
    if (!id && !(nameSpace && name)) {
      return { success: false, error: "Provide either 'id' or both 'nameSpace' and 'name'." };
    }
    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const workflow = id
      ? await workflowService.getWorkflowWithId(id)
      : await workflowService.getWorkflow(nameSpace!, name!);

    if (!workflow) {
      return { success: false, error: "Workflow not found." };
    }

    if (detail === 'full') {
      return { success: true, workflow };
    }

    const w: any = workflow;
    return {
      success: true,
      workflow: {
        id: w.id,
        name: w.name,
        nameSpace: w.nameSpace,
        version: w.version,
        description: w.description,
        tags: w.tags,
        author: w.author,
        status: w.status,
        isActive: w.isActive,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        statistics: w.statistics,
        schedule: w.schedule ? { cron: w.schedule.cron, timezone: w.schedule.timezone, enabled: w.schedule.enabled } : null,
        scheduleCount: w.schedules?.length ?? 0,
        errorCount: w.errors?.length ?? 0,
        instanceCount: w.instances?.length ?? 0,
        dependencyCount: w.dependencies?.length ?? 0,
      },
      hint: "Use detail='full' to get the complete workflow object including configuration, instances, and error stack traces.",
    };
  } catch (err: any) {
    ctx?.log(`getWorkflow Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const GetWorkflowRegistry: MacroComponentDefinition<typeof getWorkflow> = {
  nameSpace: 'reactor-macros',
  name: 'getWorkflow',
  alias: 'getWorkflow',
  version: '1.0.0',
  component: getWorkflow,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# getWorkflow
  Retrieves full details of a single workflow from the Reactory Workflow Registry.
  Accepts either the workflow \`id\`, or the \`nameSpace\` + \`name\` combination.

  ## Usage
  @getWorkflow(id?) or @getWorkflow(nameSpace, name)
  `,
  features: [
    {
      feature: 'getWorkflow',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'retrieve', 'inspect'],
      description: 'Retrieves a single registered workflow by id or namespace+name.',
      stem: 'get',
    },
  ],
  stem: 'get',
  tags: ['workflow', 'get', 'registry', 'inspect'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getWorkflow",
        description: "Retrieves full details of a registered workflow including its configuration, statistics, schedules, and registered instances. Provide either 'id' or both 'nameSpace' and 'name'.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The unique workflow registry ID",
            },
            nameSpace: {
              type: "string",
              description: "The workflow namespace (required if 'id' is not provided)",
            },
            name: {
              type: "string",
              description: "The workflow name (required if 'id' is not provided)",
            },
            detail: {
              type: "string",
              enum: ["summary", "full"],
              description: "Level of detail: 'summary' (default) returns key fields only; 'full' returns the complete workflow object including configuration, all instances, and error stack traces.",
            },
          },
          required: [],
        },
      },
    },
  ],
};
