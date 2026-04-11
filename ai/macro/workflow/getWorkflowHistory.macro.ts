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
  /** Dot-path into item.data to return only a subtree, e.g. "result.rows" */
  dataPath?: string;
  /** Filter execution pointers to a specific stepId */
  stepId?: number;
  /** 0-based offset into the execution pointers array (default 0) */
  pointerOffset?: number;
  /** Max execution pointers to return per call (default 20, max 50) */
  pointerLimit?: number;
}

/** Hard ceiling on serialised JSON chars returned from a single call (~32k tokens at 4 chars/token) */
const MAX_RESPONSE_CHARS = 128_000;
const MAX_LIST_ITEMS = 10;
const MAX_POINTER_PAGE = 50;
const DEFAULT_POINTER_PAGE = 20;
/** Individual field values larger than this are truncated with a hint */
const MAX_FIELD_CHARS = 16_000;

/**
 * Truncate a value to MAX_FIELD_CHARS, returning { __truncated, chars, preview }
 * so the AI knows it can drill deeper.
 */
function truncateField(value: any, maxChars: number = MAX_FIELD_CHARS): any {
  if (value === null || value === undefined) return value;
  const serialised = typeof value === 'string' ? value : JSON.stringify(value);
  if (serialised.length <= maxChars) return value;
  return {
    __truncated: true,
    chars: serialised.length,
    preview: serialised.slice(0, maxChars),
    hint: "Value truncated. Use dataPath to drill into a specific sub-key, or pointerOffset/pointerLimit to paginate pointers.",
  };
}

/**
 * Resolve a dot-path on an object (e.g. "result.rows" → obj.result.rows).
 * Returns undefined if the path doesn't exist.
 */
function resolvePath(obj: any, path: string): any {
  return path.split('.').reduce((cur, key) => cur?.[key], obj);
}

/**
 * Enforce the overall response size cap. If the serialised result exceeds
 * MAX_RESPONSE_CHARS it is replaced with a summary + instructions.
 */
function enforceResponseCap(result: any): any {
  const serialised = JSON.stringify(result);
  if (serialised.length <= MAX_RESPONSE_CHARS) return result;

  return {
    success: true,
    __responseTruncated: true,
    totalChars: serialised.length,
    hint: "Response exceeded the size limit. Narrow your query: use dataPath to select a sub-key from data, "
        + "stepId to filter to one step, or pointerOffset/pointerLimit to paginate execution pointers.",
    // Return the non-data metadata so the AI still has context
    ...(result.items?.[0] ? {
      id: result.items[0].id,
      workflowDefinitionId: result.items[0].workflowDefinitionId,
      status: result.items[0].status,
      statusLabel: result.items[0].statusLabel,
      stepCount: result.items[0].stepCount,
      failedStepCount: result.items[0].failedStepCount,
      dataKeys: result.items[0].data ? Object.keys(result.items[0].data) : undefined,
      pointerCount: result.items[0].executionPointers?.length ?? result.items[0].pointerSummary?.totalPointers,
    } : {}),
  };
}

export const getWorkflowHistory: Macro<unknown, GetWorkflowHistoryProps> = async (
  props: GetWorkflowHistoryProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const {
    searchTerm,
    workflowDefinitionId,
    instanceId,
    status,
    page = 1,
    limit = 10,
    includeData = false,
    includePointers = false,
    dataPath,
    stepId,
    pointerOffset = 0,
    pointerLimit = DEFAULT_POINTER_PAGE,
  } = props;
  const effectiveLimit = Math.min(limit, MAX_LIST_ITEMS);
  const effectivePointerLimit = Math.min(pointerLimit, MAX_POINTER_PAGE);

  const summarizeListItem = (item: any) => ({
    id: item.id,
    workflowDefinitionId: item.workflowDefinitionId,
    status: item.status,
    statusLabel: item.statusLabel,
    createTime: item.createTime,
    completeTime: item.completeTime,
    duration: item.duration,
    stepCount: item.stepCount,
    completedStepCount: item.completedStepCount,
    failedStepCount: item.failedStepCount,
  });

  const summarizeFullItem = (item: any) => {
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

    // ── Data handling with path drilling and truncation ──
    if (includeData && item.data) {
      if (dataPath) {
        const resolved = resolvePath(item.data, dataPath);
        summary.data = { [dataPath]: truncateField(resolved) };
        summary.dataPathUsed = dataPath;
      } else {
        // Return keys with truncated previews — never the raw blob
        const dataKeys = Object.keys(item.data);
        summary.dataKeys = dataKeys;
        const dataSummary: Record<string, any> = {};
        for (const key of dataKeys) {
          dataSummary[key] = truncateField(item.data[key]);
        }
        summary.data = dataSummary;
      }
    }

    // ── Execution pointer handling with filtering and pagination ──
    if (includePointers && item.executionPointers) {
      let pointers: any[] = item.executionPointers;

      // Optionally filter by stepId
      if (stepId !== undefined) {
        pointers = pointers.filter((p: any) => p.stepId === stepId);
      }

      const totalPointers = pointers.length;
      const sliced = pointers.slice(pointerOffset, pointerOffset + effectivePointerLimit);

      // Truncate large fields within each pointer
      summary.executionPointers = sliced.map((p: any) => ({
        ...p,
        persistenceData: truncateField(p.persistenceData),
        eventData: truncateField(p.eventData),
        outcome: truncateField(p.outcome),
      }));

      summary.pointerSummary = {
        totalPointers,
        offset: pointerOffset,
        limit: effectivePointerLimit,
        returned: sliced.length,
        hasMore: pointerOffset + effectivePointerLimit < totalPointers,
        ...(stepId !== undefined ? { filteredByStepId: stepId } : {}),
      };
    } else if (item.failedStepCount > 0) {
      summary.failedSteps = item.executionPointers
        ?.filter((p: any) => p.status === 'Failed' || p.errorMessage)
        .map((p: any) => ({
          stepId: p.stepId,
          errorMessage: p.errorMessage,
          errorTime: p.errorTime,
        }))
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

    const pagination = { page, limit: effectiveLimit };

    // Single instance lookup by ID — full detail allowed (with guards)
    if (instanceId) {
      const item = await workflowService.getWorkflowHistoryById(instanceId);
      if (!item) {
        return { success: false, error: `No history found for instance ID: ${instanceId}` };
      }
      const result = {
        success: true,
        items: [summarizeFullItem(item)],
        pagination: { page: 1, pages: 1, limit: 1, total: 1 },
      };
      return enforceResponseCap(result);
    }

    // All list queries return minimal summaries only
    const listHint = "Use getWorkflowHistory(instanceId) to get full details. "
      + "Add includeData with dataPath to drill into data, or includePointers with stepId/pointerOffset to paginate steps.";

    if (searchTerm) {
      const result = await workflowService.searchWorkflowHistory(searchTerm, pagination);
      return { success: true, instances: result.instances.map(summarizeListItem), pagination: result.pagination, hint: listHint };
    }

    if (workflowDefinitionId) {
      const result = await workflowService.getWorkflowHistoryByDefinitionId(workflowDefinitionId, pagination);
      return { success: true, instances: result.instances.map(summarizeListItem), pagination: result.pagination, hint: listHint };
    }

    if (status !== undefined) {
      const result = await workflowService.getWorkflowHistoryByStatus(status, pagination);
      return { success: true, instances: result.instances.map(summarizeListItem), pagination: result.pagination, hint: listHint };
    }

    const result = await workflowService.getWorkflowHistory(undefined, pagination);
    return {
      success: true,
      instances: result.instances.map(summarizeListItem),
      pagination: result.pagination,
      hint: listHint,
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

  **Token safety**: All responses are capped at ~128k chars. Large data values are
  automatically truncated with previews. Use dataPath to drill into specific data keys
  and pointerOffset/pointerLimit to paginate execution pointers.

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
        description: "Retrieves persisted workflow execution history. List queries return MINIMAL summaries (id, status, times, step counts) capped at 10 items. "
          + "For full details use 'instanceId' to look up a SINGLE execution. "
          + "IMPORTANT: Data and pointer payloads can be very large. Values over 16k chars are auto-truncated. "
          + "Use 'dataPath' (e.g. \"result.rows\") to drill into a specific data sub-key instead of loading everything. "
          + "Use 'stepId' to filter pointers to one step, and 'pointerOffset'/'pointerLimit' to paginate through them. "
          + "The total response is hard-capped at 128k chars — if exceeded, you'll get metadata + instructions to narrow the query.",
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
              description: "Retrieve a SPECIFIC execution by instance ID. Required for includeData/includePointers.",
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
              description: "Results per page. Defaults to 10. Maximum 10 for list queries.",
            },
            includeData: {
              type: "boolean",
              description: "Include the workflow data payload (requires instanceId). Large values are auto-truncated; use dataPath to drill into specific keys. Default false.",
            },
            includePointers: {
              type: "boolean",
              description: "Include execution pointers (requires instanceId). Use stepId to filter to one step and pointerOffset/pointerLimit to paginate. Default false.",
            },
            dataPath: {
              type: "string",
              description: "Dot-path into item.data to return only a subtree, e.g. \"result.rows\" or \"input.config\". Avoids loading the entire data blob. Only used with includeData.",
            },
            stepId: {
              type: "number",
              description: "Filter execution pointers to a specific step number. Only used with includePointers.",
            },
            pointerOffset: {
              type: "number",
              description: "0-based offset into the (optionally filtered) execution pointers array. Default 0. Only used with includePointers.",
            },
            pointerLimit: {
              type: "number",
              description: "Max execution pointers to return. Default 20, max 50. Only used with includePointers.",
            },
          },
          required: [],
        },
      },
    },
  ],
};
