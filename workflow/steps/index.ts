/**
 * Reactory Reactor Workflow Steps
 *
 * Exports all step implementations provided by the reactory-reactor module
 * and a `workflowSteps` array matching the IWorkflowStepProvider[] interface.
 *
 * These providers are auto-discovered at server startup by
 * WorkflowRunner.discoverModuleSteps() and registered into the shared YAML step
 * registry, making them usable by `type:` in any YAML workflow. A provider may
 * also attach a `definition` (designer rendering/config) which is surfaced to the
 * Visual Workflow Designer via the `workflowStepCatalog` GraphQL query.
 */

import Reactory from '@reactorynet/reactory-core';
import { IWorkflowStepDesignerDefinition } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/types/StepDesignerDefinition';
import { AgentConversationStep } from './AgentConversationStep';

/**
 * Local provider shape extending the published IWorkflowStepProvider with the
 * optional designer `definition`. The discovery loop reads `definition` off each
 * provider; the executable registration only needs stepType + constructor.
 */
interface ReactorStepProvider extends Reactory.Workflow.IWorkflowStepProvider {
  definition?: IWorkflowStepDesignerDefinition;
}

/** Designer definition for the agent_conversation step (Visual Workflow Designer). */
const agentConversationDesigner: IWorkflowStepDesignerDefinition = {
  id: 'agent_conversation',
  name: 'AI Agent Conversation',
  category: 'integration',
  description: 'Run a durable conversation with a Reactory AI agent (persona) with auto tool approval',
  icon: 'smart_toy',
  color: '#7b1fa2',
  inputPorts: [
    { name: 'previous', type: 'control_input', dataType: 'any', description: 'Previous step in workflow' },
  ],
  outputPorts: [
    { name: 'next', type: 'control_output', dataType: 'any', description: 'Next step in workflow' },
    { name: 'response', type: 'output', dataType: 'object', description: 'Agent response { sessionId, content }' },
  ],
  propertySchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Step Name', default: 'AI Agent' },
      personaId: { type: 'string', title: 'Persona / Agent Id', description: 'The AI agent to converse with' },
      message: { type: 'string', title: 'Message', description: 'Prompt sent to the agent (supports ${variable})' },
      instructions: { type: 'string', title: 'Instructions', description: 'System-prompt instructions for the conversation' },
      toolApprovalMode: {
        type: 'string',
        title: 'Tool Approval',
        enum: ['auto', 'safe_auto', 'prompt', 'plan'],
        default: 'auto',
      },
      maxToolIterations: { type: 'number', title: 'Max Tool Iterations', default: 10, minimum: 1 },
      sessionId: { type: 'string', title: 'Resume Session Id', description: 'Optional — resume an existing conversation (idempotent retries)' },
    },
    required: ['name', 'personaId', 'message'],
  },
  uiSchema: {
    'ui:order': ['name', 'personaId', 'message', 'instructions', 'toolApprovalMode', 'maxToolIterations', 'sessionId'],
    message: { 'ui:widget': 'RichEditorWidget', 'ui:options': { rows: 3 }, 'ui:help': 'Supports ${variable} substitution' },
    instructions: { 'ui:widget': 'RichEditorWidget', 'ui:options': { rows: 4 } },
    toolApprovalMode: {
      'ui:widget': 'SelectWidget',
      'ui:options': {
        selectOptions: [
          { key: 'auto', value: 'auto', label: 'Auto (run all tools)' },
          { key: 'safe_auto', value: 'safe_auto', label: 'Safe Auto' },
          { key: 'prompt', value: 'prompt', label: 'Prompt' },
          { key: 'plan', value: 'plan', label: 'Plan' },
        ],
      },
    },
  },
  defaultProperties: { name: 'AI Agent', toolApprovalMode: 'auto', maxToolIterations: 10 },
  tags: ['ai', 'agent', 'conversation', 'reactor'],
  rendering: {
    webgl: {
      type: 'webgl',
      theme: 'circuit',
      circuit: {
        elementType: 'icChip',
        labelPrefix: 'AI',
        colors: { body: 0x1a1a1a, bodyHover: 0x2a2a2a, bodySelected: 0x7b1fa2, pins: 0x808080, pinsConnected: 0xb87333 },
        features: { hasNotch: true, pinCount: 6 },
        dimensions: { width: 130, height: 90 },
      },
    },
  },
};

/**
 * All workflow step providers registered by the reactory-reactor module.
 */
const providers: ReactorStepProvider[] = [
  {
    stepType: 'agent_conversation',
    constructor: AgentConversationStep as unknown as Reactory.Workflow.IStepConstructor,
    options: {
      description: 'Run a durable conversation with a Reactory AI agent (persona) with auto tool approval',
      version: '1.0.0',
    },
    definition: agentConversationDesigner,
  },
];

export const workflowSteps: Reactory.Workflow.IWorkflowStepProvider[] = providers;

export { AgentConversationStep };

export default workflowSteps;
