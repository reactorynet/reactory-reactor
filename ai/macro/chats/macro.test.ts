import { ChatsMacro, ChatsMacroRegistry } from './macro';
import ReactorConversationModel from '@reactory/server-modules/reactory-reactor/models/ReactorChatState';
import { ObjectId } from 'mongodb';
import { ChatState, ToolApprovalMode } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

describe('ChatsMacro', () => {
  let chatState: ChatState;
  const mockSendMessage = jest.fn();
  const mockListPersonas = jest.fn();
  const mockGetProviders = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    mockListPersonas.mockResolvedValue([
      { id: 'daan', name: 'Docent Daan', modelId: 'gpt-4o', providerId: 'openai' },
      { id: 'ReactorAIPersona', name: 'Reactor', modelId: 'gpt-4o', providerId: 'openai' },
    ]);

    mockGetProviders.mockResolvedValue([
      { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
    ]);

    const mockContext: any = {
      user: {
        _id: new ObjectId(),
        firstName: 'Test',
        lastName: 'User',
        email: 'test@example.com',
      },
      getService: jest.fn((id: string) => {
        if (id.startsWith('reactor.AIPersonaProvider')) {
          return { listPersonas: mockListPersonas };
        }
        if (id.startsWith('reactor.ReactorConversationService')) {
          return { sendMessage: mockSendMessage };
        }
        if (id.startsWith('reactor.ReactorProviderService')) {
          return { getProviders: mockGetProviders };
        }
        return null;
      }),
      hasAnyRole: jest.fn().mockReturnValue(true),
      hasRole: jest.fn().mockReturnValue(true),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    chatState = {
      id: new ObjectId().toString(),
      personaId: 'ReactorAIPersona',
      modelId: 'gpt-4o',
      providerId: 'openai',
      toolApprovalMode: ToolApprovalMode.AUTO,
      history: [],
      vars: {},
      context: mockContext,
    } as any;
  });

  describe('Registry Definition', () => {
    it('declares respond action, async parameters, and metadata', () => {
      expect(ChatsMacroRegistry.name).toBe('chats');
      expect(ChatsMacroRegistry.tags).toContain('respond');
      expect(ChatsMacroRegistry.tags).toContain('async');
      expect(ChatsMacroRegistry.tags).toContain('non-blocking');

      const toolDef = ChatsMacroRegistry.tools?.[0];
      expect(toolDef).toBeDefined();
      const actions = (toolDef?.function.parameters as any).properties.action.enum;
      expect(actions).toContain('respond');
      expect(actions).toContain('speakto');
      expect(actions).toContain('followup');

      const props = (toolDef?.function.parameters as any).properties;
      expect(props.async).toBeDefined();
      expect(props.wakeParent).toBeDefined();
      expect(props.waitMs).toBeDefined();

      const respondFeature = ChatsMacroRegistry.features?.find(f => f.feature === 'respond');
      expect(respondFeature).toBeDefined();
    });
  });

  describe('action: speakto (blocking)', () => {
    it('requires an agent id', async () => {
      const result: any = await ChatsMacro({ action: 'speakto' }, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires an agent id');
    });

    it('rejects unknown persona ids with list of available personas', async () => {
      const result: any = await ChatsMacro({ action: 'speakto', id: 'unknown-agent', message: 'hello' }, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a registered persona');
      expect(result.data?.availablePersonas).toHaveLength(2);
    });

    it('executes synchronously and blocks when async is false/omitted', async () => {
      mockSendMessage.mockResolvedValue({
        sessionId: 'sub-session-123',
        content: 'Sub-agent answer',
      });

      const result: any = await ChatsMacro(
        { action: 'speakto', id: 'daan', message: 'Review this syllabus' },
        chatState
      );

      expect(result.success).toBe(true);
      expect(result.data.status).toBeUndefined(); // blocking returns standard payload
      expect(result.data.response).toBe('Sub-agent answer');
      expect(result.data.conversationId).toBe('sub-session-123');
      expect(chatState.vars?.subagent_chat_daan).toBe('sub-session-123');
    });
  });

  describe('action: speakto (non-blocking async)', () => {
    it('dispatches immediately and returns delegationId and subagentSessionId', async () => {
      const createSpy = jest.spyOn(ReactorConversationModel, 'create').mockResolvedValue({} as any);
      const findOneAndUpdateSpy = jest.spyOn(ReactorConversationModel, 'findOneAndUpdate').mockReturnValue({
        exec: jest.fn().mockResolvedValue({} as any),
      } as any);

      // Deferred promise to simulate background work
      let resolveBackgroundWork: (val: any) => void = () => {};
      mockSendMessage.mockImplementation(() => new Promise((resolve) => {
        resolveBackgroundWork = resolve;
      }));

      const result: any = await ChatsMacro(
        {
          action: 'speakto',
          id: 'daan',
          message: 'Build a full course outline in background',
          async: true,
        },
        chatState
      );

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('dispatched');
      expect(result.data.delegationId).toBeDefined();
      expect(typeof result.data.delegationId).toBe('string');
      expect(result.data.subagentSessionId).toBeDefined();
      expect(result.data.agentId).toBe('daan');
      expect(result.data.agentName).toBe('Docent Daan');
      expect(result.instructions).toContain('Delegation Dispatched');
      expect(result.instructions).toContain('action="respond"');

      // Pre-created subagent conversation in MongoDB
      expect(createSpy).toHaveBeenCalled();
      // Synchronously persisted delegation record in parent conversation vars
      expect(findOneAndUpdateSpy).toHaveBeenCalled();

      // Resolve background work
      resolveBackgroundWork({ content: 'Course outline ready' });

      createSpy.mockRestore();
      findOneAndUpdateSpy.mockRestore();
    });
  });

  describe('action: respond', () => {
    it('requires an id', async () => {
      const result: any = await ChatsMacro({ action: 'respond' }, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toContain("requires an id");
    });

    it('returns complete result when delegation is finished and marks collected', async () => {
      const delegationId = 'del-uuid-1';
      const subagentSessionId = 'sub-session-abc';

      const findOneSpy = jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue({
        lean: () => ({
          exec: jest.fn().mockResolvedValue({
            _id: chatState.id,
            vars: {
              subagent_delegations: {
                [delegationId]: {
                  status: 'complete',
                  personaId: 'daan',
                  agentName: 'Docent Daan',
                  subagentSessionId,
                  response: 'Completed course outline text',
                  completedAt: '2026-08-29T10:00:00.000Z',
                },
              },
            },
          }),
        }),
      } as any);

      const findOneAndUpdateSpy = jest.spyOn(ReactorConversationModel, 'findOneAndUpdate').mockReturnValue({
        exec: jest.fn().mockResolvedValue({} as any),
      } as any);

      const result: any = await ChatsMacro({ action: 'respond', id: delegationId }, chatState);

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
      expect(result.data.delegationId).toBe(delegationId);
      expect(result.data.response).toBe('Completed course outline text');
      expect(result.data.personaId).toBe('daan');

      // Marks record as collected
      expect(findOneAndUpdateSpy).toHaveBeenCalled();

      findOneSpy.mockRestore();
      findOneAndUpdateSpy.mockRestore();
    });

    it('returns error result when delegation failed in background', async () => {
      const delegationId = 'del-uuid-2';

      const findOneSpy = jest.spyOn(ReactorConversationModel, 'findOne').mockReturnValue({
        lean: () => ({
          exec: jest.fn().mockResolvedValue({
            _id: chatState.id,
            vars: {
              subagent_delegations: {
                [delegationId]: {
                  status: 'error',
                  personaId: 'daan',
                  agentName: 'Docent Daan',
                  error: 'AI Provider timeout exceeded',
                  completedAt: '2026-08-29T10:05:00.000Z',
                },
              },
            },
          }),
        }),
      } as any);

      const result: any = await ChatsMacro({ action: 'respond', id: delegationId }, chatState);

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('error');
      expect(result.data.error).toContain('AI Provider timeout');

      findOneSpy.mockRestore();
    });

    it('returns running status with recent history when still dispatched and waitMs expires', async () => {
      const delegationId = 'del-uuid-3';
      const subagentSessionId = 'sub-session-still-running';

      const findOneSpy = jest.spyOn(ReactorConversationModel, 'findOne').mockImplementation((query: any) => {
        if (query._id === chatState.id) {
          return {
            lean: () => ({
              exec: jest.fn().mockResolvedValue({
                _id: chatState.id,
                vars: {
                  subagent_delegations: {
                    [delegationId]: {
                      status: 'dispatched',
                      personaId: 'daan',
                      agentName: 'Docent Daan',
                      subagentSessionId,
                    },
                  },
                },
              }),
            }),
          } as any;
        }
        if (query._id === subagentSessionId) {
          return {
            lean: () => ({
              exec: jest.fn().mockResolvedValue({
                _id: subagentSessionId,
                personaId: 'daan',
                history: [
                  { role: 'user', content: 'Build course' },
                  { role: 'assistant', content: '', tool_calls: [{ function: { name: 'searchGraph' } }] },
                ],
              }),
            }),
          } as any;
        }
        return { lean: () => ({ exec: jest.fn().mockResolvedValue(null) }) } as any;
      });

      const result: any = await ChatsMacro(
        { action: 'respond', id: delegationId, waitMs: 600 },
        chatState
      );

      expect(result.success).toBe(true);
      expect(result.data.status).toBe('running');
      expect(result.data.delegationId).toBe(delegationId);
      expect(result.data.recentHistory).toBeDefined();
      expect(result.instructions).toContain('Delegation Still Running');

      findOneSpy.mockRestore();
    });
  });
});
