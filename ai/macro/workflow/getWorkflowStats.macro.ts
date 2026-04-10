import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface GetWorkflowStatsProps {
  includeMetrics?: boolean;
  includeSystemStatus?: boolean;
}

export const getWorkflowStats: Macro<unknown, GetWorkflowStatsProps> = async (
  props: GetWorkflowStatsProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const { includeMetrics = false, includeSystemStatus = false } = props;

  const ctx = context || state.context;
  try {
    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const stats = await workflowService.getWorkflowExecutionStats();
    const result: Record<string, unknown> = { success: true, stats };

    if (includeMetrics) {
      result.metrics = await workflowService.getWorkflowMetrics();
    }

    if (includeSystemStatus) {
      result.systemStatus = await workflowService.getSystemStatus();
    }

    return result;
  } catch (err: any) {
    ctx?.log(`getWorkflowStats Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const GetWorkflowStatsRegistry: MacroComponentDefinition<typeof getWorkflowStats> = {
  nameSpace: 'reactor-macros',
  name: 'getWorkflowStats',
  alias: 'getWorkflowStats',
  version: '1.0.0',
  component: getWorkflowStats,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# getWorkflowStats
  Returns workflow execution statistics including total, successful, failed, and average execution time.
  Optionally includes full engine metrics and system health status.

  ## Usage
  @getWorkflowStats(includeMetrics?, includeSystemStatus?)
  `,
  features: [
    {
      feature: 'getWorkflowStats',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'stats', 'metrics', 'monitor'],
      description: 'Returns workflow execution statistics and optionally engine metrics and system status.',
      stem: 'get',
    },
  ],
  stem: 'get',
  tags: ['workflow', 'stats', 'metrics', 'monitoring'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getWorkflowStats",
        description: "Returns workflow execution statistics (total executions, success/failure counts, average execution time). Optionally fetch full engine metrics and system health status.",
        parameters: {
          type: "object",
          properties: {
            includeMetrics: {
              type: "boolean",
              description: "When true, includes detailed engine metrics (lifecycle stats, scheduler stats, error maps). Defaults to false.",
            },
            includeSystemStatus: {
              type: "boolean",
              description: "When true, includes the workflow engine system health status. Defaults to false.",
            },
          },
          required: [],
        },
      },
    },
  ],
};
