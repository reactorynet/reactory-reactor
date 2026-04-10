import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService, IWorkflowFilterInput, IPaginationInput } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface ListWorkflowsProps {
  searchString?: string;
  nameSpace?: string;
  tags?: string[];
  status?: string;
  isActive?: boolean;
  hasSchedule?: boolean;
  hasErrors?: boolean;
  neverRun?: boolean;
  page?: number;
  limit?: number;
}

export const listWorkflows: Macro<unknown, ListWorkflowsProps> = async (
  props: ListWorkflowsProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const {
    searchString,
    nameSpace,
    tags,
    status,
    isActive,
    hasSchedule,
    hasErrors,
    neverRun,
    page = 1,
    limit = 20,
  } = props;

  const ctx = context || state.context;
  try {
    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const filter: IWorkflowFilterInput = {};
    if (searchString !== undefined) filter.searchString = searchString;
    if (nameSpace !== undefined) filter.nameSpace = nameSpace;
    if (tags !== undefined) filter.tags = tags;
    if (status !== undefined) filter.status = status;
    if (isActive !== undefined) filter.isActive = isActive;
    if (hasSchedule !== undefined) filter.hasSchedule = hasSchedule;
    if (hasErrors !== undefined) filter.hasErrors = hasErrors;
    if (neverRun !== undefined) filter.neverRun = neverRun;

    const pagination: IPaginationInput = { page, limit };

    const result = await workflowService.getWorkflows(filter, pagination);

    return {
      success: true,
      workflows: result.workflows.map((w: any) => ({
        id: w.id,
        name: w.name,
        nameSpace: w.nameSpace,
        version: w.version,
        description: w.description,
        tags: w.tags,
        status: w.status,
        isActive: w.isActive,
        updatedAt: w.updatedAt,
        statistics: w.statistics,
        scheduleCount: w.schedules?.length ?? 0,
        errorCount: w.errors?.length ?? 0,
        instanceCount: w.instances?.length ?? 0,
      })),
      pagination: result.pagination,
      hint: "Use getWorkflow(id) for full details including configuration, instances, and errors.",
    };
  } catch (err: any) {
    ctx?.log(`listWorkflows Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const ListWorkflowsRegistry: MacroComponentDefinition<typeof listWorkflows> = {
  nameSpace: 'reactor-macros',
  name: 'listWorkflows',
  alias: 'listWorkflows',
  version: '1.0.0',
  component: listWorkflows,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# listWorkflows
  Lists registered workflows from the Reactory Workflow Engine with optional filtering and pagination.
  
  ## Usage
  @listWorkflows(searchString?, nameSpace?, tags?, status?, isActive?, hasSchedule?, hasErrors?, neverRun?, page?, limit?)
  `,
  features: [
    {
      feature: 'listWorkflows',
      featureType: Reactory.FeatureType.function,
      action: ['list', 'search', 'query'],
      description: 'Lists registered workflows with filtering and pagination.',
      stem: 'list',
    },
  ],
  stem: 'list',
  tags: ['workflow', 'list', 'registry', 'query'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "listWorkflows",
        description: "Lists registered workflows from the Reactory Workflow Engine. Supports filtering by namespace, status, tags, active state, schedule, errors, and pagination.",
        parameters: {
          type: "object",
          properties: {
            searchString: {
              type: "string",
              description: "Free-text search string to match against workflow name, description, or namespace",
            },
            nameSpace: {
              type: "string",
              description: "Filter by workflow namespace (e.g. 'core', 'reactor')",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Filter by one or more tags",
            },
            status: {
              type: "string",
              enum: ["ACTIVE", "INACTIVE", "PAUSED", "CANCELLED", "COMPLETED", "FAILED"],
              description: "Filter by workflow registry status",
            },
            isActive: {
              type: "boolean",
              description: "Filter to only active (true) or inactive (false) workflows",
            },
            hasSchedule: {
              type: "boolean",
              description: "Filter to only workflows that have a schedule configured",
            },
            hasErrors: {
              type: "boolean",
              description: "Filter to only workflows that have recorded execution errors",
            },
            neverRun: {
              type: "boolean",
              description: "Filter to only workflows that have never been executed",
            },
            page: {
              type: "number",
              description: "Page number (1-based). Defaults to 1.",
            },
            limit: {
              type: "number",
              description: "Number of results per page. Defaults to 20.",
            },
          },
          required: [],
        },
      },
    },
  ],
};
