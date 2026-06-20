/**
 * Unit tests for AgentConversationStep — uses a mock ReactorConversationService
 * (no real LLM calls) to verify the create-session + send-message contract,
 * resume behaviour, tool-approval defaults, and validation.
 */

import { AgentConversationStep } from '../AgentConversationStep';
import { workflowSteps } from '../index';
import { YamlStepRegistry } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/registry/YamlStepRegistry';

const CONVERSATION_SERVICE_ID = 'reactor.ReactorConversationService@1.0.0';

function makeService(overrides: any = {}) {
  return {
    startChatSession: jest.fn(async () => ({ id: 'sess-1' })),
    sendMessage: jest.fn(async () => ({ content: 'hello from agent', sessionId: 'sess-1' })),
    setChatMaxToolIterations: jest.fn(async () => undefined),
    setChatModelProvider: jest.fn(async () => undefined),
    ...overrides,
  };
}

function makeContext(service: any) {
  return {
    inputs: {},
    workflowInputs: {},
    variables: {},
    env: {},
    stepResults: {},
    workflow: { id: 't', instanceId: 't', nameSpace: 'test', name: 'agent', version: '1.0.0' },
    logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    reactoryContext: {
      getService: (id: string) => (id === CONVERSATION_SERVICE_ID ? service : null),
    },
  } as any;
}

describe('AgentConversationStep', () => {
  it('creates a conversation with instructions + auto tool approval, then sends the message', async () => {
    const service = makeService();
    const step = new AgentConversationStep('chat', {
      personaId: 'reactor',
      message: 'Summarise the report',
      instructions: 'You are a careful analyst.',
      maxToolIterations: 25,
    });

    const result = await step.execute(makeContext(service));

    expect(result.success).toBe(true);
    expect(result.outputs.sessionId).toBe('sess-1');
    expect(result.outputs.content).toBe('hello from agent');

    expect(service.startChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        personaId: 'reactor',
        systemPrompt: 'You are a careful analyst.',
        toolApprovalMode: 'auto',
      }),
    );
    expect(service.setChatMaxToolIterations).toHaveBeenCalledWith('sess-1', 25);
    expect(service.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        personaId: 'reactor',
        message: 'Summarise the report',
        chatSessionId: 'sess-1',
        toolApprovalMode: 'auto',
      }),
    );
  });

  it('resumes an existing conversation without creating a new session', async () => {
    const service = makeService();
    const step = new AgentConversationStep('chat', {
      personaId: 'reactor',
      message: 'follow up',
      sessionId: 'existing-99',
    });

    const result = await step.execute(makeContext(service));

    expect(result.success).toBe(true);
    expect(service.startChatSession).not.toHaveBeenCalled();
    expect(service.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatSessionId: 'existing-99', message: 'follow up' }),
    );
    expect(result.outputs.sessionId).toBe('existing-99');
  });

  it('resolves template values from variables', async () => {
    const service = makeService();
    const ctx = makeContext(service);
    ctx.variables.topic = 'pricing';
    const step = new AgentConversationStep('chat', {
      personaId: 'reactor',
      message: 'Tell me about ${topic}',
    });

    await step.execute(ctx);
    expect(service.sendMessage.mock.calls[0][0].message).toBe('Tell me about pricing');
  });

  it('fails gracefully when the conversation service is unavailable', async () => {
    const step = new AgentConversationStep('chat', { personaId: 'reactor', message: 'hi' });
    const ctx = makeContext(null);
    ctx.reactoryContext.getService = () => null;

    const result = await step.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Conversation service');
  });

  it('reports conversation errors as a failed result and preserves the sessionId', async () => {
    const service = makeService({
      sendMessage: jest.fn(async () => {
        throw new Error('LLM provider timeout');
      }),
    });
    const step = new AgentConversationStep('chat', { personaId: 'reactor', message: 'hi' });

    const result = await step.execute(makeContext(service));
    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM provider timeout');
    expect(result.outputs.sessionId).toBe('sess-1'); // created before the failure
  });

  it('validates personaId and message are required', () => {
    const step = new AgentConversationStep('chat', {} as any);
    const v = step.validateConfig({});
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toContain('personaId');
    expect(v.errors.join(' ')).toContain('message');
  });

  it('rejects an invalid toolApprovalMode', () => {
    const step = new AgentConversationStep('chat', {} as any);
    const v = step.validateConfig({ personaId: 'r', message: 'm', toolApprovalMode: 'yolo' });
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toContain('toolApprovalMode');
  });
});

describe('reactor module workflow step registration (Phase 4 reference)', () => {
  it('exposes agent_conversation as an IWorkflowStepProvider', () => {
    const provider = workflowSteps.find((s) => s.stepType === 'agent_conversation');
    expect(provider).toBeDefined();
    expect(typeof provider!.constructor).toBe('function');
  });

  it('registers module providers into a YamlStepRegistry (as discoverModuleSteps does)', () => {
    const registry = new YamlStepRegistry();
    workflowSteps.forEach((s) => registry.registerStep(s.stepType, s.constructor as any, s.options || {}));

    expect(registry.hasStep('agent_conversation')).toBe(true);

    const step = registry.createStep({
      id: 'x',
      type: 'agent_conversation',
      config: { personaId: 'reactor', message: 'hi' },
    });
    expect(step.stepType).toBe('agent_conversation');
  });
});
