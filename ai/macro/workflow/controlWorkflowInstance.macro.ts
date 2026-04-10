import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { IReactoryWorkflowService } from "@reactory/server-modules/reactory-core/services/Workflow/types";

export type WorkflowInstanceAction = 'pause' | 'resume' | 'cancel';

export interface ControlWorkflowInstanceProps {
  instanceId: string;
  action: WorkflowInstanceAction;
}

export const controlWorkflowInstance: Macro<unknown, ControlWorkflowInstanceProps> = async (
  props: ControlWorkflowInstanceProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  const { instanceId, action } = props;

  const ctx = context || state.context;
  try {
    if (!instanceId) {
      return { success: false, error: "'instanceId' is required." };
    }

    if (!action || !['pause', 'resume', 'cancel'].includes(action)) {
      return { success: false, error: "'action' must be one of: pause, resume, cancel." };
    }

    if (!ctx) return { success: false, error: "No execution context available." };
    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
    }

    let result;
    switch (action) {
      case 'pause':
        result = await workflowService.pauseWorkflowInstance(instanceId);
        break;
      case 'resume':
        result = await workflowService.resumeWorkflowInstance(instanceId);
        break;
      case 'cancel':
        result = await workflowService.cancelWorkflowInstance(instanceId);
        break;
    }

    return {
      success: result.success,
      action,
      instanceId,
      message: result.message,
      data: result.data,
    };
  } catch (err: any) {
    ctx?.log(`controlWorkflowInstance Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
};

export const ControlWorkflowInstanceRegistry: MacroComponentDefinition<typeof controlWorkflowInstance> = {
  nameSpace: 'reactor-macros',
  name: 'controlWorkflowInstance',
  alias: 'controlWorkflowInstance',
  version: '1.0.0',
  component: controlWorkflowInstance,
  roles: ['ADMIN', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# controlWorkflowInstance
  Performs a control action (pause, resume, or cancel) on an active workflow instance.
  Requires the instance ID and the desired action.

  ## Usage
  @controlWorkflowInstance(instanceId, action)
  
  - action: 'pause' | 'resume' | 'cancel'
  `,
  features: [
    {
      feature: 'controlWorkflowInstance',
      featureType: Reactory.FeatureType.function,
      action: ['pause', 'resume', 'cancel', 'control'],
      description: 'Pauses, resumes, or cancels an active workflow instance.',
      stem: 'control',
    },
  ],
  stem: 'control',
  tags: ['workflow', 'instance', 'control', 'pause', 'resume', 'cancel'],
  tools: [
    {
      type: "function",
      safeForAutoExecution: false,
      function: {
        name: "controlWorkflowInstance",
        description: "Pauses, resumes, or cancels an active workflow instance. This is a state-changing operation — always confirm the action and instance ID with the user before proceeding.",
        parameters: {
          type: "object",
          properties: {
            instanceId: {
              type: "string",
              description: "The ID of the workflow instance to control",
            },
            action: {
              type: "string",
              enum: ["pause", "resume", "cancel"],
              description: "The control action to perform: 'pause' suspends execution, 'resume' continues a paused instance, 'cancel' permanently terminates the instance",
            },
          },
          required: ["instanceId", "action"],
        },
      },
    },
  ],
};
