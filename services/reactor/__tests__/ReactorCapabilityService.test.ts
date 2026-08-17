import ReactorCapabilityService from '../ReactorCapabilityService';
import { ProviderConfig } from '../../../ai/providers/provider-loader';

describe('ReactorCapabilityService', () => {
  it('aggregates capabilities dynamically from provider service', async () => {
    const mockProviders: ProviderConfig[] = [
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: ['text-generation', 'image-understanding', 'reasoning', 'structured-output'],
          },
        ],
        status: { available: true, lastChecked: new Date(), uptime: 100, responseTime: 100, errorRate: 0 },
        capabilities: ['text-generation', 'image-generation'],
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          {
            id: 'claude-3-7-sonnet',
            name: 'Claude 3.7 Sonnet',
            capabilities: ['text-generation', 'code-generation', 'reasoning'],
          },
        ],
        status: { available: true, lastChecked: new Date(), uptime: 100, responseTime: 100, errorRate: 0 },
        capabilities: ['text-generation', 'code-generation'],
      },
    ];

    const mockProviderService = {
      getProviders: jest.fn().mockResolvedValue(mockProviders),
      getProvider: jest.fn(),
    } as any;

    const service = new ReactorCapabilityService({} as any, {} as any);
    service.setProviderService(mockProviderService);

    const capabilities = await service.getCapabilities();

    expect(capabilities).toBeDefined();
    expect(capabilities.length).toBeGreaterThan(0);

    const textCap = capabilities.find((c) => c.id === 'text-generation');
    expect(textCap).toBeDefined();
    expect(textCap.providers).toContain('openai');
    expect(textCap.providers).toContain('anthropic');
    expect(textCap.models).toContain('gpt-4o');
    expect(textCap.models).toContain('claude-3-7-sonnet');

    const reasoningCap = capabilities.find((c) => c.id === 'reasoning');
    expect(reasoningCap).toBeDefined();
    expect(reasoningCap.name).toBe('Reasoning & Extended Thinking');
    expect(reasoningCap.models).toContain('gpt-4o');
    expect(reasoningCap.models).toContain('claude-3-7-sonnet');
  });
});
