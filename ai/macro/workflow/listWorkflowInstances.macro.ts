import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService, IInstanceFilterInput, IPaginationInput } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface ListWorkflowInstancesProps {
  id?: string;
  nameSpace?: string;
  name?: string;
  version?: string;
  status?: string;
  createdBy?: string;
  startTimeFrom?: string;
  startTimeTo?: string;
  page?: number;
  limit?: number;
}

export const listWorkflowInstances: Macro<unknown, ListWorkflowInstancesProps> = async (
  props: ListWorkflowInstancesProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const {
    id,
    nameSpace,
    name,
    version,
    status,
    createdBy,
    startTimeFrom,
    startTimeTo,
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

    const filter: IInstanceFilterInput = {};
    if (id !== undefined) filter.id = id;
    if (nameSpace !== undefined) filter.nameSpace = nameSpace;
    if (name !== undefined) filter.name = name;
    if (version !== undefined) filter.version = version;
    if (status !== undefined) filter.status = status;
    if (createdBy !== undefined) filter.createdBy = createdBy;
    if (startTimeFrom !== undefined) filter.startTimeFrom = new Date(startTimeFrom);
    if (startTimeTo !== undefined) filter.startTimeTo = new Date(startTimeTo);

    const pagination: IPaginationInput = { page, limit };

    const result = await workflowService.getWorkflowInstances(filter, pagination);

    return {
      success: true,
      instances: result.instances.map((inst: any) => ({
        id: inst.id,
        workflowId: inst.workflowId,
        version: inst.version,
        status: inst.status,
        priority: inst.priority,
        startedAt: inst.startedAt,
        updatedAt: inst.updatedAt,
        completedAt: inst.completedAt,
        hasError: !!inst.error,
        errorMessage: inst.error?.message,
        resourceUsage: inst.resourceUsage,
      })),
      pagination: result.pagination,
    };
  } catch (err: any) {
    ctx?.log(`listWorkflowInstances Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const ListWorkflowInstancesRegistry: MacroComponentDefinition<typeof listWorkflowInstances> = {
  nameSpace: 'reactor-macros',
  name: 'listWorkflowInstances',
  alias: 'listWorkflowInstances',
  version: '1.0.0',
  component: listWorkflowInstances,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# listWorkflowInstances
  Lists active in-memory workflow instances from the Reactory Workflow Engine.
  Supports filtering by workflow identity, status, creator, and start time range.

  ## Usage
  @listWorkflowInstances(nameSpace?, name?, status?, page?, limit?)
  `,
  features: [
    {
      feature: 'listWorkflowInstances',
      featureType: Reactory.FeatureType.function,
      action: ['list', 'query', 'monitor'],
      description: 'Lists active workflow instances with optional filters.',
      stem: 'list',
    },
  ],
  stem: 'list',
  tags: ['workflow', 'instances', 'monitor', 'runtime'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "listWorkflowInstances",
        description: "Lists active in-memory workflow instances. Filter by workflow namespace, name, version, status, or time window.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Filter by a specific instance ID",
            },
            nameSpace: {
              type: "string",
              description: "Filter by workflow namespace",
            },
            name: {
              type: "string",
              description: "Filter by workflow name",
            },
            version: {
              type: "string",
              description: "Filter by workflow version",
            },
            status: {
              type: "string",
              enum: ["pending", "running", "paused", "completed", "failed", "cancelled"],
              description: "Filter by instance status",
            },
            createdBy: {
              type: "string",
              description: "Filter by the user ID who created the instance",
            },
            startTimeFrom: {
              type: "string",
              description: "ISO 8601 date string — filter instances started on or after this time",
            },
            startTimeTo: {
              type: "string",
              description: "ISO 8601 date string — filter instances started on or before this time",
            },
            page: {
              type: "number",
              description: "Page number (1-based). Defaults to 1.",
            },
            limit: {
              type: "number",
              description: "Results per page. Defaults to 20.",
            },
          },
          required: [],
        },
      },
    },
  ],
};
