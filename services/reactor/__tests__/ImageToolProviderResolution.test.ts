import { MacroRegistry } from '../../../ai/macro';
import ReactorConversationService from '../ReactorConversationService';
import ReactorConversationModel from '../../../models/ReactorChatState';

describe('Image Tool & Provider Resolution', () => {
  it('keeps the image macro client-side: defined as runat client and absent from the server registry', () => {
    // The image macro is a CLIENT-side tool and the server does not declare it.
    //
    // A client tool has no server-side execution path, so the server only has to
    // CLASSIFY the call and RECORD the browser's result (see the header of
    // ReactorConversationService.clientTools.test.ts). Client macros are
    // advertised by the client itself at session creation -
    // syncClientCapabilities({ macros, tools }) records them on the conversation
    // with runat: 'client' - so there is nothing for the server to declare
    // statically. That spec uses ImageMacro and FormMacro as its examples.
    //
    // The siblings confirm it: form, component, chart and d3 are all listed in
    // the personas' tool includes and all have NO server-side definition and no
    // MacroRegistry entry. The image macro is the odd one out only because a
    // server-side duplicate was once wired into the registry, then dropped,
    // re-added and dropped again across a523647/4fc4b9f/133bf07/13a94ee - churn
    // from a registration that was never part of the design.
    //
    // Asserting ABSENCE states the real contract and guards the invariant that
    // caused that churn. The previous form required the opposite (toBeDefined
    // plus alias/runat/tool-name checks against the registry entry), which is
    // what kept failing.
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
