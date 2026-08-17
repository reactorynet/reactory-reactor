import { MacroRegistry } from '../../../ai/macro';
import ReactorConversationService from '../ReactorConversationService';
import ReactorConversationModel from '../../../models/ReactorChatState';

describe('Image Tool & Provider Resolution', () => {
  it('registers the ImageMacro in MacroRegistry with alias image', () => {
    const imageMacro = MacroRegistry.find(m => m.name === 'ImageMacro' || m.alias === 'image');
    expect(imageMacro).toBeDefined();
    expect(imageMacro?.alias).toBe('image');
    expect(imageMacro?.runat).toBe('client');
    expect(imageMacro?.tools?.[0]?.function?.name).toBe('image');
  });

  it('attachImage respects conversation.providerId', async () => {
    const mockFindOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: 'session-123',
        providerId: 'anthropic',
        modelId: 'claude-3-7-sonnet',
      })
    });

    const mockFindOneAndUpdate = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(true)
    });

    const mockGetAdapter = jest.fn().mockResolvedValue({
      adaptResponse: jest.fn().mockImplementation((res) => res)
    });

    const mockGetPersona = jest.fn().mockResolvedValue({
      id: 'reactor',
      providerId: 'openai',
      modelId: 'gpt-4o',
    });

    const service = new ReactorConversationService({ props: { dependencies: {} } } as any);
    (service as any).context = {
      user: { _id: 'user-1' },
      getService: jest.fn().mockReturnValue({
        getPersona: mockGetPersona
      })
    };
    (service as any).providerService = {
      getAdapter: mockGetAdapter
    };
    (service as any).validateChatSessionId = jest.fn();

    const originalFindOne = ReactorConversationModel.findOne;
    const originalFindOneAndUpdate = ReactorConversationModel.findOneAndUpdate;
    ReactorConversationModel.findOne = mockFindOne as any;
    ReactorConversationModel.findOneAndUpdate = mockFindOneAndUpdate as any;

    try {
      await service.attachImage({
        chatSessionId: 'session-123',
        personaId: 'reactor',
        image: 'data:image/png;base64,123'
      });

      expect(mockGetAdapter).toHaveBeenCalledWith('anthropic');
    } finally {
      ReactorConversationModel.findOne = originalFindOne;
      ReactorConversationModel.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });
});
