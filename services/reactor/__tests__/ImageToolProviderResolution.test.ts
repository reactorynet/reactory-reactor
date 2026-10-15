import { MacroRegistry } from '../../../ai/macro';
import ReactorConversationService from '../ReactorConversationService';
import ReactorConversationModel from '../../../models/ReactorChatState';

describe('Image Tool & Provider Resolution', () => {
  it('keeps the image macro client-side: defined as runat client and absent from the server registry', () => {
    // The image macro is owned by the CLIENT (reactory-pwa-client,
    // ReactorChat/hooks/macros/image.macro.tsx, registered in that folder's
    // index.ts) and executes there. The server deliberately refuses to run
    // client-declared macros - see ReactorConversationService: "Macro X is a
    // client-side macro (runat: 'client') and cannot be executed on the
    // server" - so ImageMacro must NOT appear in the server MacroRegistry.
    //
    // This assertion previously required the opposite (toHaveBeenDefined plus
    // alias/runat/tool-name checks against the registry entry). It was wrong:
    // the server-side registration was added, dropped, re-added and dropped
    // again across a523647/4fc4b9f/133bf07/13a94ee because it was never part of
    // the design. Asserting absence states the real contract and guards the
    // invariant that caused that churn.
    const imageMacro = MacroRegistry.find(m => m.name === 'ImageMacro' || m.alias === 'image');
    expect(imageMacro).toBeUndefined();
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
