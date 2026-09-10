import ReactorProviderService from '../ReactorProviderService';
import { ReactorPostgresDataSource, ReactoryAiProvider, ReactoryAiModel } from '../../../models';

jest.mock('../../../models', () => {
  const actual = jest.requireActual('../../../models');
  return {
    ...actual,
    ReactorPostgresDataSource: {
      isInitialized: false,
      getRepository: jest.fn(),
    },
  };
});

describe('ReactorProviderService CRUD & DB Integration', () => {
  let service: ReactorProviderService;
  let mockProviderRepo: any;
  let mockModelRepo: any;
  let mockContext: any;
  let inMemoryDb: ReactoryAiProvider[] = [];

  beforeEach(() => {
    jest.clearAllMocks();

    inMemoryDb = [];

    mockContext = {
      user: { _id: 'user-123' },
      log: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    mockProviderRepo = {
      count: jest.fn().mockImplementation(() => Promise.resolve(inMemoryDb.length)),
      findOne: jest.fn().mockImplementation(({ where }: any) => {
        return Promise.resolve(inMemoryDb.find((p) => p.id === where?.id) || null);
      }),
      find: jest.fn().mockImplementation(() => Promise.resolve([...inMemoryDb])),
      save: jest.fn().mockImplementation((p: ReactoryAiProvider) => {
        const idx = inMemoryDb.findIndex((existing) => existing.id === p.id);
        if (idx >= 0) inMemoryDb[idx] = p;
        else inMemoryDb.push(p);
        return Promise.resolve(p);
      }),
      remove: jest.fn().mockImplementation((p: ReactoryAiProvider) => {
        inMemoryDb = inMemoryDb.filter((existing) => existing.id !== p.id);
        return Promise.resolve(p);
      }),
    };

    mockModelRepo = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((m) => Promise.resolve(m)),
      remove: jest.fn().mockResolvedValue(true),
    };

    (ReactorPostgresDataSource.getRepository as jest.Mock).mockImplementation((target: any) => {
      if (target === ReactoryAiProvider) return mockProviderRepo;
      if (target === ReactoryAiModel) return mockModelRepo;
      throw new Error(`Unexpected target: ${target}`);
    });

    service = new ReactorProviderService({} as any, mockContext);
  });

  describe('Fallback to YAML when DB uninitialized', () => {
    it('loads providers from YAML successfully', async () => {
      const providers = await service.getProviders();
      expect(providers.length).toBeGreaterThan(0);
      const openai = await service.getProvider('openai');
      expect(openai).toBeDefined();
      expect(openai?.name).toBe('OpenAI');
    });

    it('creates provider in-memory when DB is not initialized', async () => {
      const newProvider = await service.createProvider({
        id: 'local-test',
        name: 'Local Test',
        endpointUrl: 'http://localhost:8000',
        capabilities: ['text-generation'],
      });

      expect(newProvider.id).toBe('local-test');
      const retrieved = await service.getProvider('local-test');
      expect(retrieved?.name).toBe('Local Test');
    });

    it('creates and deletes model in-memory when DB is not initialized', async () => {
      await service.createModel({
        providerId: 'openai',
        modelKey: 'gpt-test-model',
        name: 'GPT Test Model',
        contextLength: 64000,
      });

      const provider = await service.getProvider('openai');
      expect(provider?.models.find((m) => m.id === 'gpt-test-model')).toBeDefined();

      const deleted = await service.deleteModel('gpt-test-model');
      expect(deleted).toBe(true);
      const providerAfter = await service.getProvider('openai');
      expect(providerAfter?.models.find((m) => m.id === 'gpt-test-model')).toBeUndefined();
    });

    it('creates and deletes provider in-memory when DB is not initialized', async () => {
      await service.createProvider({
        id: 'temp-provider',
        name: 'Temp Provider',
      });

      const retrieved = await service.getProvider('temp-provider');
      expect(retrieved?.name).toBe('Temp Provider');

      const deleted = await service.deleteProvider('temp-provider');
      expect(deleted).toBe(true);
      const retrievedAfter = await service.getProvider('temp-provider');
      expect(retrievedAfter).toBeUndefined();
    });
  });

  describe('Database interaction when DataSource is initialized', () => {
    beforeEach(() => {
      (ReactorPostgresDataSource as any).isInitialized = true;
    });

    it('creates and persists provider in PostgreSQL', async () => {
      const created = await service.createProvider({
        id: 'db-provider',
        name: 'Database Provider',
        endpointUrl: 'https://api.db-provider.com',
        capabilities: ['text-generation'],
      });

      expect(mockProviderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'db-provider',
          name: 'Database Provider',
        })
      );
      expect(created.id).toBe('db-provider');
    });

    it('updates provider in PostgreSQL', async () => {
      const existingEntity = new ReactoryAiProvider();
      existingEntity.id = 'db-provider';
      existingEntity.name = 'Old Name';
      existingEntity.models = [];
      inMemoryDb.push(existingEntity);

      await service.updateProvider('db-provider', {
        name: 'New Name',
      });

      expect(mockProviderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'db-provider',
          name: 'New Name',
        })
      );
    });

    it('deletes provider from PostgreSQL', async () => {
      const existingEntity = new ReactoryAiProvider();
      existingEntity.id = 'db-provider';
      inMemoryDb.push(existingEntity);

      const result = await service.deleteProvider('db-provider');

      expect(mockProviderRepo.remove).toHaveBeenCalledWith(existingEntity);
      expect(result).toBe(true);
    });

    it('creates and persists model in PostgreSQL', async () => {
      const providerEntity = new ReactoryAiProvider();
      providerEntity.id = 'openai';
      providerEntity.models = [];
      inMemoryDb.push(providerEntity);

      mockModelRepo.findOne.mockResolvedValue(null);

      const model = await service.createModel({
        providerId: 'openai',
        modelKey: 'new-model',
        name: 'New Model',
        contextLength: 32000,
      });

      expect(mockModelRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'openai',
          modelKey: 'new-model',
          name: 'New Model',
        })
      );
      expect(model.id).toBe('new-model');
    });

    it('deletes model from PostgreSQL', async () => {
      const modelEntity = new ReactoryAiModel();
      modelEntity.id = 'm-uuid';
      modelEntity.modelKey = 'new-model';

      mockModelRepo.findOne.mockResolvedValue(modelEntity);

      const result = await service.deleteModel('m-uuid');

      expect(mockModelRepo.remove).toHaveBeenCalledWith(modelEntity);
      expect(result).toBe(true);
    });
  });

  describe('testProviderConnection', () => {
    it('returns error if provider is not found', async () => {
      const result = await service.testProviderConnection('unknown-provider');
      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");
    });
  });
});
