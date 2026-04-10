import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface GetWorkflowHistoryProps {
  searchTerm?: string;
  workflowDefinitionId?: string;
  instanceId?: string;
  status?: number;
  page?: number;
  limit?: number;
  includeData?: boolean;
  includePointers?: boolean;
}

export const getWorkflowHistory: Macro<unknown, GetWorkflowHistoryProps> = async (
  props: GetWorkflowHistoryProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const { searchTerm, workflowDefinitionId, instanceId, status, page = 1, limit = 20, includeData = false, includePointers = false } = props;

    const summarizeHistoryItem = (item: any) => {
      const summary: any = {
        id: item.id,
        workflowDefinitionId: item.workflowDefinitionId,
        version: item.version,
        status: item.status,
        statusLabel: item.statusLabel,
        description: item.description,
        createTime: item.createTime,
        completeTime: item.completeTime,
        duration: item.duration,
        stepCount: item.stepCount,
        completedStepCount: item.completedStepCount,
        failedStepCount: item.failedStepCount,
      };
      if (includeData) summary.data = item.data;
      if (includePointers) {
        summary.executionPointers = item.executionPointers;
      } else if (item.failedStepCount > 0) {
        summary.failedSteps = item.executionPointers
          ?.filter((p: any) => p.status === 'Failed' || p.errorMessage)
          .map((p: any) => ({ stepId: p.stepId, errorMessage: p.errorMessage }))
          ?? [];
      }
      return summary;
    };

  const ctx = context || state.context;
  try {
    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const pagination = { page, limit };

    // Single instance lookup by ID
    if (instanceId) {
      const item = await workflowService.getWorkflowHistoryById(instanceId);
      return item
        ? { success: true, items: [summarizeHistoryItem(item)], pagination: { page: 1, pages: 1, limit: 1, total: 1 } }
        : { success: false, error: `No history found for instance ID: ${instanceId}` };
    }

    // Full-text search
    if (searchTerm) {
      const result = await workflowService.searchWorkflowHistory(searchTerm, pagination);
      return { success: true, instances: result.instances.map(summarizeHistoryItem), pagination: result.pagination };
    }

    // Filter by workflow definition ID
    if (workflowDefinitionId) {
      const result = await workflowService.getWorkflowHistoryByDefinitionId(workflowDefinitionId, pagination);
      return { success: true, instances: result.instances.map(summarizeHistoryItem), pagination: result.pagination };
    }

    // Filter by status
    if (status !== undefined) {
      const result = await workflowService.getWorkflowHistoryByStatus(status, pagination);
      return { success: true, instances: result.instances.map(summarizeHistoryItem), pagination: result.pagination };
    }

    // General listing
    const result = await workflowService.getWorkflowHistory(undefined, pagination);
    return {
      success: true,
      instances: result.instances.map(summarizeHistoryItem),
      pagination: result.pagination,
      hint: "Use includeData=true and/or includePointers=true for full execution details.",
    };

  } catch (err: any) {
    ctx?.log(`getWorkflowHistory Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const GetWorkflowHistoryRegistry: MacroComponentDefinition<typeof getWorkflowHistory> = {
  nameSpace: 'reactor-macros',
  name: 'getWorkflowHistory',
  alias: 'getWorkflowHistory',
  version: '1.0.0',
  component: getWorkflowHistory,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# getWorkflowHistory
  Retrieves persisted workflow execution history from the database.
  Can look up a single instance by ID, search with a text query, filter by definition ID,
  filter by status code, or return a general paginated list.

  ## Usage
  @getWorkflowHistory(searchTerm?, workflowDefinitionId?, instanceId?, status?, page?, limit?)
  `,
  features: [
    {
      feature: 'getWorkflowHistory',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'list', 'search', 'audit'],
      description: 'Retrieves workflow execution history with multiple query modes.',
      stem: 'get',
    },
  ],
  stem: 'get',
  tags: ['workflow', 'history', 'executions', 'audit'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getWorkflowHistory",
        description: "Retrieves persisted workflow execution history. Use 'instanceId' for a single lookup, 'searchTerm' for full-text search, 'workflowDefinitionId' to filter by workflow, 'status' to filter by WorkflowESStatus code (0=PENDING, 1=RUNNABLE, 2=COMPLETE, 3=TERMINATED, 4=SUSPENDED), or leave all empty for a paginated list of all history.",
        parameters: {
          type: "object",
          properties: {
            searchTerm: {
              type: "string",
              description: "Full-text search term to match against workflow history data",
            },
            workflowDefinitionId: {
              type: "string",
              description: "Filter history entries by workflow definition ID",
            },
            instanceId: {
              type: "string",
              description: "Retrieve a specific execution history record by instance ID",
            },
            status: {
              type: "number",
              description: "WorkflowESStatus code: 0=PENDING, 1=RUNNABLE, 2=COMPLETE, 3=TERMINATED, 4=SUSPENDED",
            },
            page: {
              type: "number",
              description: "Page number (1-based). Defaults to 1.",
            },
            limit: {
              type: "number",
              description: "Results per page. Defaults to 20.",
            },
            includeData: {
              type: "boolean",
              description: "When true, includes the full step data payload for each history item. Default false.",
            },
            includePointers: {
              type: "boolean",
              description: "When true, includes full execution pointer details. Default false returns only failed step summaries.",
            },
          },
          required: [],
        },
      },
    },
  ],
};
