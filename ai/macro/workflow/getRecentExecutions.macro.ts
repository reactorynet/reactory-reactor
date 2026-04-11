import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface GetRecentExecutionsProps {
  limit?: number;
}

export const getRecentExecutions: Macro<unknown, GetRecentExecutionsProps> = async (
  props: GetRecentExecutionsProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const MAX_RECENT = 10;
  const { limit = 10 } = props;
  const effectiveLimit = Math.min(limit, MAX_RECENT);

  const ctx = context || state.context;
  try {
    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const executions = await workflowService.getRecentWorkflowExecutions(effectiveLimit);

    return {
      success: true,
      executions: executions.map((item: any) => ({
        id: item.id,
        workflowDefinitionId: item.workflowDefinitionId,
        version: item.version,
        status: item.status,
        statusLabel: item.statusLabel,
        createTime: item.createTime,
        completeTime: item.completeTime,
        duration: item.duration,
        stepCount: item.stepCount,
        completedStepCount: item.completedStepCount,
        failedStepCount: item.failedStepCount,
      })),
      count: executions.length,
      hint: "Use getWorkflowHistory(instanceId) for full execution details.",
    };
  } catch (err: any) {
    ctx?.log(`getRecentExecutions Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const GetRecentExecutionsRegistry: MacroComponentDefinition<typeof getRecentExecutions> = {
  nameSpace: 'reactor-macros',
  name: 'getRecentExecutions',
  alias: 'getRecentExecutions',
  version: '1.0.0',
  component: getRecentExecutions,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# getRecentExecutions
  Retrieves the most recent workflow execution history records across all workflows.
  Useful for a quick overview of what has run recently.

  ## Usage
  @getRecentExecutions(limit?)
  `,
  features: [
    {
      feature: 'getRecentExecutions',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'list', 'monitor'],
      description: 'Returns the most recent workflow executions across all workflows.',
      stem: 'get',
    },
  ],
  stem: 'get',
  tags: ['workflow', 'recent', 'executions', 'history', 'monitor'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getRecentExecutions",
        description: "Returns the most recently completed or running workflow executions across all workflows. Useful for quick status overview and monitoring.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of recent executions to return. Defaults to 10. Maximum 10.",
            },
          },
          required: [],
        },
      },
    },
  ],
};
