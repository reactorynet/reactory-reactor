import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface GetWorkflowErrorsProps {
  workflowId: string;
  includeStacks?: boolean;
}

export const getWorkflowErrors: Macro<unknown, GetWorkflowErrorsProps> = async (
  props: GetWorkflowErrorsProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const { workflowId, includeStacks = false } = props;

  const ctx = context || state.context;
  try {
    if (!workflowId) {
      return { success: false, error: "'workflowId' is required." };
    }
    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    const errors = await workflowService.getWorkflowErrors(workflowId);

    return {
      success: true,
      workflowId,
      errors: errors.map((e: any) => {
        const summary: any = {
          errorType: e.errorType,
          count: e.count,
          lastOccurrence: e.lastOccurrence,
          workflowName: e.workflowName,
          message: e.message,
        };
        if (includeStacks && e.stack) summary.stack = e.stack;
        return summary;
      }),
      count: errors.length,
    };
  } catch (err: any) {
    ctx?.log(`getWorkflowErrors Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const GetWorkflowErrorsRegistry: MacroComponentDefinition<typeof getWorkflowErrors> = {
  nameSpace: 'reactor-macros',
  name: 'getWorkflowErrors',
  alias: 'getWorkflowErrors',
  version: '1.0.0',
  component: getWorkflowErrors,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# getWorkflowErrors
  Retrieves recorded execution errors for a specific workflow by its ID.
  Returns an array of error records including message, code, and optional stack trace.

  ## Usage
  @getWorkflowErrors(workflowId)
  `,
  features: [
    {
      feature: 'getWorkflowErrors',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'diagnose', 'debug'],
      description: 'Retrieves execution errors recorded for a specific workflow.',
      stem: 'get',
    },
  ],
  stem: 'get',
  tags: ['workflow', 'errors', 'debug', 'diagnostics'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getWorkflowErrors",
        description: "Retrieves recorded execution errors for a workflow. Returns error messages, codes, and stack traces. Use this to diagnose failing workflows.",
        parameters: {
          type: "object",
          properties: {
            workflowId: {
              type: "string",
              description: "The workflow registry ID to retrieve errors for",
            },
            includeStacks: {
              type: "boolean",
              description: "When true, includes full stack traces for each error. Default false.",
            },
          },
          required: ["workflowId"],
        },
      },
    },
  ],
};
