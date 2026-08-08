import ReactorConversationService from '../ReactorConversationService';

describe('ReactorConversationService - Model Context Length Resolution', () => {
  let conversationService: any;
  let mockProviderService: any;
  let mockContext: any;

  beforeEach(() => {
    mockProviderService = {
      getProvider: jest.fn().mockImplementation(async (providerId: string) => {
        if (providerId === 'google') {
          return {
            id: 'google',
            models: [
              { id: 'gemini-2.5-pro', contextLength: 1048576 },
              { id: 'gemini-3.6-flash', contextLength: 1048576 },
            ],
          };
        }
        if (providerId === 'anthropic') {
          return {
            id: 'anthropic',
            models: [
              { id: 'claude-sonnet-5', contextLength: 1000000 },
              { id: 'claude-haiku-4-5', contextLength: 200000 },
            ],
          };
        }
        return null;
      }),
      getProviders: jest.fn().mockResolvedValue([
        {
          id: 'google',
          models: [
            { id: 'gemini-2.5-pro', contextLength: 1048576 },
            { id: 'gemini-3.6-flash', contextLength: 1048576 },
          ],
        },
        {
          id: 'anthropic',
          models: [
            { id: 'claude-sonnet-5', contextLength: 1000000 },
            { id: 'claude-haiku-4-5', contextLength: 200000 },
          ],
        },
      ]),
    };

    mockContext = {
      user: { _id: 'user-123' },
      getService: jest.fn().mockReturnValue(mockProviderService),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    conversationService = new (ReactorConversationService as any)({}, mockContext);
  });

  test('resolves contextLength from specific provider in providers.yaml', async () => {
    const length = await conversationService.resolveModelContextLength('gemini-2.5-pro', 'google');
    expect(length).toBe(1048576);
  });

  test('resolves contextLength via cross-provider search when providerId is omitted or mismatched', async () => {
    const length = await conversationService.resolveModelContextLength('claude-sonnet-5');
    expect(length).toBe(1000000);
  });

  test('falls back to persona maxTokens if model is not found in provider registry', async () => {
    const length = await conversationService.resolveModelContextLength('unknown-model', 'unknown-provider', 500000);
    expect(length).toBe(500000);
  });

  test('falls back to DEFAULT_MAX_TOKENS (200,000) if model and persona maxTokens are both missing', async () => {
    const length = await conversationService.resolveModelContextLength('non-existent-model');
    expect(length).toBe(200000);
  });
});
