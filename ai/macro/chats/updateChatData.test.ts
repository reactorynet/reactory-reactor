import { UpdateChatDataMacro, UpdateChatDataMacroRegistry } from './updateChatData';
import { ChatState, ToolApprovalMode } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { ObjectId } from 'mongodb';

describe('updateChatData macro', () => {
  const mockUpdateChatData = jest.fn();
  let mockContext: any;
  let chatState: ChatState;

  beforeEach(() => {
    jest.clearAllMocks();

    mockUpdateChatData.mockResolvedValue({
      title: 'Fixing auth token refresh',
      summary: 'Investigated and fixed the refresh-token race in the auth service.',
      tags: ['auth', 'bugfix'],
      icon: 'check_circle',
      color: '#2e7d32',
    });

    mockContext = {
      user: { _id: new ObjectId(), email: 'test@example.com' },
      getService: jest.fn((id: string) => {
        if (id.startsWith('reactor.ReactorConversationService')) {
          return { updateChatData: mockUpdateChatData };
        }
        return null;
      }),
      hasAnyRole: jest.fn().mockReturnValue(true),
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

  describe('registry definition', () => {
    it('exposes an updateChatData tool with all-optional fields', () => {
      expect(UpdateChatDataMacroRegistry.name).toBe('updateChatData');
      const tool = UpdateChatDataMacroRegistry.tools?.[0];
      expect(tool).toBeDefined();
      expect(tool.function.name).toBe('updateChatData');

      const props = (tool.function.parameters as any).properties;
      expect(Object.keys(props).sort()).toEqual(['color', 'icon', 'summary', 'tags', 'title']);
      expect((tool.function.parameters as any).required).toEqual([]);
    });

    it('is marked safe for auto execution', () => {
      expect(UpdateChatDataMacroRegistry.tools?.[0].safeForAutoExecution).toBe(true);
    });
  });

  describe('execution', () => {
    it('forwards only the supplied fields to the service', async () => {
      const result: any = await UpdateChatDataMacro(
        { title: 'Fixing auth token refresh' },
        chatState
      );

      expect(mockUpdateChatData).toHaveBeenCalledTimes(1);
      expect(mockUpdateChatData).toHaveBeenCalledWith(chatState.id, {
        title: 'Fixing auth token refresh',
      });
      expect(result.success).toBe(true);
      expect(result.data.title).toBe('Fixing auth token refresh');
    });

    it('supports updating every field at once', async () => {
      const result: any = await UpdateChatDataMacro(
        {
          title: 'Fixing auth token refresh',
          summary: 'Investigated and fixed the refresh-token race.',
          tags: ['auth', 'bugfix'],
          icon: 'check_circle',
          color: '#2e7d32',
        },
        chatState
      );

      expect(mockUpdateChatData).toHaveBeenCalledWith(chatState.id, {
        title: 'Fixing auth token refresh',
        summary: 'Investigated and fixed the refresh-token race.',
        tags: ['auth', 'bugfix'],
        icon: 'check_circle',
        color: '#2e7d32',
      });
      expect(result.success).toBe(true);
      expect(result.data.tags).toEqual(['auth', 'bugfix']);
    });

    it('resolves the conversation id from a persisted document (_id)', async () => {
      const docState: any = { _id: new ObjectId(), context: mockContext };
      await UpdateChatDataMacro({ title: 'Doc state' }, docState);
      expect(mockUpdateChatData).toHaveBeenCalledWith(docState._id.toString(), {
        title: 'Doc state',
      });
    });

    it('uses the explicit context argument when state has none', async () => {
      const bareState: any = { id: chatState.id };
      await UpdateChatDataMacro({ title: 'Via context arg' }, bareState, mockContext);
      expect(mockUpdateChatData).toHaveBeenCalledWith(chatState.id, {
        title: 'Via context arg',
      });
    });

    it('fails gracefully when no fields are supplied', async () => {
      const result: any = await UpdateChatDataMacro({}, chatState);
      expect(result.success).toBe(false);
      expect(mockUpdateChatData).not.toHaveBeenCalled();
    });

    it('fails gracefully when no session id is available', async () => {
      const noIdState: any = { context: mockContext };
      const result: any = await UpdateChatDataMacro({ title: 'x' }, noIdState);
      expect(result.success).toBe(false);
      expect(mockUpdateChatData).not.toHaveBeenCalled();
    });

    it('fails gracefully when the service throws', async () => {
      mockUpdateChatData.mockRejectedValueOnce(new Error('not authorised'));
      const result: any = await UpdateChatDataMacro({ title: 'x' }, chatState);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not authorised');
    });

    it('fails gracefully when the service is unavailable', async () => {
      mockContext.getService = jest.fn().mockReturnValue(null);
      const result: any = await UpdateChatDataMacro({ title: 'x' }, chatState);
      expect(result.success).toBe(false);
    });
  });
});
