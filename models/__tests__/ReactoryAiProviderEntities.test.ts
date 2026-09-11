import { DataSource, Repository } from 'typeorm';
import ReactoryAiProvider from '../ReactoryAiProvider';
import ReactoryAiModel from '../ReactoryAiModel';
import { seedAiProviders } from '../seedAiProviders';
import { loadProviders } from '../../ai/providers/provider-loader';

jest.mock('../../ai/providers/provider-loader', () => ({
  loadProviders: jest.fn(),
}));

describe('ReactoryAiProvider and ReactoryAiModel Entities & Seeder', () => {
  let mockProviderRepo: jest.Mocked<Repository<ReactoryAiProvider>>;
  let mockModelRepo: jest.Mocked<Repository<ReactoryAiModel>>;
  let mockDataSource: jest.Mocked<DataSource>;

  const sampleProviders = [
    {
      id: 'openai',
      name: 'OpenAI',
      endpointUrl: 'https://api.openai.com/v1',
      apiVersion: 'v1',
      defaultModel: 'gpt-4o',
      capabilities: ['text-generation', 'code-generation'],
      credentialRequirements: ['apiKey'],
      credentialEnvVars: { apiKey: 'OPENAI_API_KEY' },
      models: [
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          version: '2024-05-13',
          capabilities: ['text-generation', 'reasoning'],
          contextLength: 128000,
          supportsStreaming: true,
          supportedTools: ['function-calling'],
          supportedMediaTypes: ['text', 'image'],
          inputCostPerTokenUsdCents: 0.0005,
          outputCostPerTokenUsdCents: 0.0015,
        },
      ],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      endpointUrl: 'https://api.anthropic.com',
      apiVersion: 'v1',
      defaultModel: 'claude-opus-4-8',
      capabilities: ['text-generation', 'reasoning'],
      credentialRequirements: ['apiKey'],
      credentialEnvVars: { apiKey: 'ANTHROPIC_API_KEY' },
      models: [
        {
          id: 'claude-opus-4-8',
          name: 'Claude Opus 4.8',
          version: '4.8',
          capabilities: ['text-generation', 'reasoning'],
          contextLength: 1000000,
          supportsStreaming: true,
          sampling: { temperature: false, topP: false, topK: false },
          thinking: { mode: 'adaptive', effort: 'high', display: 'summarized' },
        },
      ],
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    mockProviderRepo = {
      count: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    } as any;

    mockModelRepo = {
      count: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    } as any;

    mockDataSource = {
      getRepository: jest.fn().mockImplementation((target: any) => {
        if (target === ReactoryAiProvider) return mockProviderRepo;
        if (target === ReactoryAiModel) return mockModelRepo;
        throw new Error(`Unexpected target: ${target}`);
      }),
    } as any;

    (loadProviders as jest.Mock).mockReturnValue(sampleProviders);
  });

  describe('seedAiProviders', () => {
    it('should seed providers and models when table is empty', async () => {
      mockProviderRepo.count.mockResolvedValue(0);
      mockProviderRepo.findOne.mockResolvedValue(null);
      mockModelRepo.findOne.mockResolvedValue(null);

      const result = await seedAiProviders(mockDataSource, false);

      expect(mockProviderRepo.count).toHaveBeenCalled();
      expect(result.providersCount).toBe(2);
      expect(result.modelsCount).toBe(2);

      // Verify provider saves
      expect(mockProviderRepo.save).toHaveBeenCalledTimes(2);
      expect(mockProviderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'openai',
          name: 'OpenAI',
          providerType: 'openai',
          isSystem: true,
          isEnabled: true,
        })
      );
      expect(mockProviderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'anthropic',
          name: 'Anthropic',
          providerType: 'anthropic',
          isSystem: true,
          isEnabled: true,
        })
      );

      // Verify child model saves
      expect(mockModelRepo.save).toHaveBeenCalledTimes(2);
      expect(mockModelRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'openai',
          modelKey: 'gpt-4o',
          name: 'GPT-4o',
          contextLength: 128000,
        })
      );
      expect(mockModelRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'anthropic',
          modelKey: 'claude-opus-4-8',
          name: 'Claude Opus 4.8',
          contextLength: 1000000,
          samplingConfig: { temperature: false, topP: false, topK: false },
          thinkingConfig: { mode: 'adaptive', effort: 'high', display: 'summarized' },
        })
      );
    });

    it('should skip seeding when providers already exist and overwrite is false', async () => {
      mockProviderRepo.count.mockResolvedValue(5);
      mockModelRepo.count.mockResolvedValue(25);

      const result = await seedAiProviders(mockDataSource, false);

      expect(result).toEqual({ providersCount: 5, modelsCount: 25 });
      expect(mockProviderRepo.save).not.toHaveBeenCalled();
      expect(mockModelRepo.save).not.toHaveBeenCalled();
    });

    it('should re-seed when providers exist if overwrite is true', async () => {
      mockProviderRepo.count.mockResolvedValue(5);
      mockProviderRepo.findOne.mockResolvedValue(null);
      mockModelRepo.findOne.mockResolvedValue(null);

      const result = await seedAiProviders(mockDataSource, true);

      expect(result.providersCount).toBe(2);
      expect(result.modelsCount).toBe(2);
      expect(mockProviderRepo.save).toHaveBeenCalledTimes(2);
      expect(mockModelRepo.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('Entity structure validation', () => {
    it('should instantiate ReactoryAiProvider with expected defaults', () => {
      const provider = new ReactoryAiProvider();
      provider.id = 'custom-provider';
      provider.name = 'Custom Provider';

      expect(provider.id).toBe('custom-provider');
      expect(provider.name).toBe('Custom Provider');
    });

    it('should instantiate ReactoryAiModel with expected properties', () => {
      const model = new ReactoryAiModel();
      model.modelKey = 'model-1';
      model.providerId = 'custom-provider';
      model.name = 'Model 1';

      expect(model.modelKey).toBe('model-1');
      expect(model.providerId).toBe('custom-provider');
      expect(model.name).toBe('Model 1');
    });
  });
});
