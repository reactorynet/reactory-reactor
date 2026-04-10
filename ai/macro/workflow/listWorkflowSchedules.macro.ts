import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService, IPaginationInput } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface ListWorkflowSchedulesProps {
  workflowId?: string;
  scheduleId?: string;
  nameSpace?: string;
  name?: string;
  version?: string;
  page?: number;
  limit?: number;
}

export const listWorkflowSchedules: Macro<unknown, ListWorkflowSchedulesProps> = async (
  props: ListWorkflowSchedulesProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const { workflowId, scheduleId, nameSpace, name, version, page = 1, limit = 20 } = props;

  const ctx = context || state.context;
  try {
    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const summarizeSchedule = (s: any) => ({
      id: s.config?.id,
      name: s.config?.name,
      description: s.config?.description,
      workflow: s.config?.workflow ? { id: s.config.workflow.id, name: s.config.workflow.name, nameSpace: s.config.workflow.nameSpace } : null,
      schedule: s.config?.schedule,
      lastRun: s.lastRun,
      nextRun: s.nextRun,
      runCount: s.runCount,
      errorCount: s.errorCount,
      isRunning: s.isRunning,
    });

    // Single schedule lookup
    if (scheduleId) {
      const schedule = await workflowService.getWorkflowSchedule(scheduleId);
      return schedule
        ? { success: true, schedules: [summarizeSchedule(schedule)], pagination: { page: 1, pages: 1, limit: 1, total: 1 } }
        : { success: false, error: `No schedule found with ID: ${scheduleId}` };
    }

    // Schedules for a specific workflow ID
    if (workflowId) {
      const schedules = await workflowService.getWorkflowSchedulesForWorkflowId(workflowId);
      return { success: true, schedules: schedules.map(summarizeSchedule), pagination: { page: 1, pages: 1, limit: schedules.length, total: schedules.length } };
    }

    // Schedules filtered by namespace/name/version properties
    if (nameSpace || name || version) {
      const result = await workflowService.filterSchedulesByWorkflowProperties(
        nameSpace,
        name,
        version,
        { page, limit }
      );
      return { success: true, schedules: result.schedules.map(summarizeSchedule), filter: result.filter, pagination: result.pagination };
    }

    // General paginated list
    const pagination: IPaginationInput = { page, limit };
    const result = await workflowService.getWorkflowSchedules(pagination);
    return { success: true, schedules: result.schedules.map(summarizeSchedule), pagination: result.pagination };

  } catch (err: any) {
    ctx?.log(`listWorkflowSchedules Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const ListWorkflowSchedulesRegistry: MacroComponentDefinition<typeof listWorkflowSchedules> = {
  nameSpace: 'reactor-macros',
  name: 'listWorkflowSchedules',
  alias: 'listWorkflowSchedules',
  version: '1.0.0',
  component: listWorkflowSchedules,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# listWorkflowSchedules
  Lists workflow schedules from the Reactory Workflow Engine.
  Can retrieve a single schedule by ID, schedules for a specific workflow, filter by namespace/name/version,
  or return all schedules with pagination.

  ## Usage
  @listWorkflowSchedules(workflowId?, scheduleId?, nameSpace?, name?, version?, page?, limit?)
  `,
  features: [
    {
      feature: 'listWorkflowSchedules',
      featureType: Reactory.FeatureType.function,
      action: ['list', 'query', 'get'],
      description: 'Lists workflow schedules with flexible filtering options.',
      stem: 'list',
    },
  ],
  stem: 'list',
  tags: ['workflow', 'schedules', 'cron', 'automation'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "listWorkflowSchedules",
        description: "Lists workflow trigger schedules. Use 'scheduleId' to retrieve a specific schedule, 'workflowId' to get all schedules for a workflow, 'nameSpace/name/version' to filter by workflow properties, or leave all empty for a paginated list of all schedules.",
        parameters: {
          type: "object",
          properties: {
            scheduleId: {
              type: "string",
              description: "Retrieve a single schedule by its ID",
            },
            workflowId: {
              type: "string",
              description: "Retrieve all schedules associated with a specific workflow ID",
            },
            nameSpace: {
              type: "string",
              description: "Filter schedules by workflow namespace",
            },
            name: {
              type: "string",
              description: "Filter schedules by workflow name",
            },
            version: {
              type: "string",
              description: "Filter schedules by workflow version",
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
