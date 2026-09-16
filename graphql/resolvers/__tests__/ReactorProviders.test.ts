import ReactorProvidersResolver from '../ReactorProviders';

describe('ReactorProvidersResolver CRUD & Admin Queries/Mutations', () => {
  let resolver: ReactorProvidersResolver;
  let mockProviderService: any;
  let mockContext: any;

  const sampleProviders = [
    {
      id: 'openai',
      name: 'OpenAI',
      providerType: 'openai',
      isEnabled: true,
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    },
    {
      id: 'ollama',
      name: 'Ollama Local',
      providerType: 'ollama',
      isEnabled: false,
      models: [{ id: 'llama3', name: 'Llama 3' }],
    },
  ];

  beforeEach(() => {
    mockProviderService = {
      getProviders: jest.fn().mockResolvedValue(sampleProviders),
      getProvider: jest.fn().mockImplementation((id: string) =>
        Promise.resolve(sampleProviders.find((p) => p.id === id))
      ),
      createProvider: jest.fn().mockImplementation((input) => Promise.resolve({ ...input, models: [] })),
      updateProvider: jest.fn().mockImplementation((id, input) => Promise.resolve({ id, ...input })),
      deleteProvider: jest.fn().mockResolvedValue(true),
      createModel: jest.fn().mockImplementation((input) => Promise.resolve({ id: input.modelKey, ...input })),
      updateModel: jest.fn().mockImplementation((id, input) => Promise.resolve({ id, ...input })),
      deleteModel: jest.fn().mockResolvedValue(true),
      testProviderConnection: jest.fn().mockResolvedValue({
        success: true,
        latencyMs: 120,
        message: 'Reachable',
      }),
      syncFromYaml: jest.fn().mockResolvedValue({ providersCount: 10, modelsCount: 45 }),
    };

    mockContext = {
      user: { _id: 'admin-user-id', roles: ['ADMIN'] },
      getService: jest.fn().mockReturnValue(mockProviderService),
    };

    resolver = new ReactorProvidersResolver();
  });

  describe('ReactorAiProvidersAdmin', () => {
    it('throws unauthorized if user is not authenticated', async () => {
      await expect(
        resolver.ReactorAiProvidersAdmin({}, {}, { user: null } as any)
      ).rejects.toThrow('Authentication required');
    });

    it('returns all providers when no filter is supplied', async () => {
      const result = await resolver.ReactorAiProvidersAdmin({}, {}, mockContext);
      expect(result.providers).toHaveLength(2);
      expect(result.paging.total).toBe(2);
      expect(result.paging.page).toBe(1);
      expect(result.paging.pageSize).toBe(20);
      expect(mockProviderService.getProviders).toHaveBeenCalled();
    });

    it('filters providers by isEnabled', async () => {
      const result = await resolver.ReactorAiProvidersAdmin(
        {},
        { filter: { isEnabled: true } },
        mockContext
      );
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].id).toBe('openai');
      expect(result.paging.total).toBe(1);
    });

    it('filters providers by searchString', async () => {
      const result = await resolver.ReactorAiProvidersAdmin(
        {},
        { filter: { searchString: 'ollama' } },
        mockContext
      );
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].id).toBe('ollama');
      expect(result.paging.total).toBe(1);
    });

    it('supports server-side pagination for providers', async () => {
      const result = await resolver.ReactorAiProvidersAdmin(
        {},
        { paging: { page: 2, pageSize: 1 } },
        mockContext
      );
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].id).toBe('ollama');
      expect(result.paging.page).toBe(2);
      expect(result.paging.pageSize).toBe(1);
      expect(result.paging.total).toBe(2);
      expect(result.paging.hasNext).toBe(false);
    });
  });

  describe('ReactorAiModelsAdmin', () => {
    it('throws unauthorized if user is not authenticated', async () => {
      await expect(
        resolver.ReactorAiModelsAdmin({}, {}, { user: null } as any)
      ).rejects.toThrow('Authentication required');
    });

    it('returns all models across providers', async () => {
      const result = await resolver.ReactorAiModelsAdmin({}, {}, mockContext);
      expect(result.models).toHaveLength(2);
      expect(result.paging.total).toBe(2);
      expect(result.models.map((m: any) => m.id)).toEqual(['gpt-4o', 'llama3']);
    });

    it('filters models by providerId', async () => {
      const result = await resolver.ReactorAiModelsAdmin({}, { providerId: 'openai' }, mockContext);
      expect(result.models).toHaveLength(1);
      expect(result.models[0].id).toBe('gpt-4o');
      expect(result.paging.total).toBe(1);
    });

    it('filters models by searchString', async () => {
      const result = await resolver.ReactorAiModelsAdmin({}, { searchString: 'llama' }, mockContext);
      expect(result.models).toHaveLength(1);
      expect(result.models[0].id).toBe('llama3');
      expect(result.paging.total).toBe(1);
    });

    it('supports server-side pagination for models', async () => {
      const result = await resolver.ReactorAiModelsAdmin(
        {},
        { paging: { page: 1, pageSize: 1 } },
        mockContext
      );
      expect(result.models).toHaveLength(1);
      expect(result.models[0].id).toBe('gpt-4o');
      expect(result.paging.page).toBe(1);
      expect(result.paging.pageSize).toBe(1);
      expect(result.paging.total).toBe(2);
      expect(result.paging.hasNext).toBe(true);
    });
  });

  describe('ReactorAiProviderAdmin', () => {
    it('returns specific provider by id', async () => {
      const result = await resolver.ReactorAiProviderAdmin({}, { id: 'openai' }, mockContext);
      expect(result?.name).toBe('OpenAI');
      expect(mockProviderService.getProvider).toHaveBeenCalledWith('openai');
    });
  });

  describe('CRUD Mutations', () => {
    it('creates a new AI provider', async () => {
      const input = { id: 'new-provider', name: 'New Provider' };
      const result = await resolver.ReactorCreateAiProvider({}, { input }, mockContext);
      expect(mockProviderService.createProvider).toHaveBeenCalledWith(input);
      expect(result.id).toBe('new-provider');
    });

    it('updates an existing AI provider', async () => {
      const input = { name: 'Updated Provider Name' };
      const result = await resolver.ReactorUpdateAiProvider({}, { id: 'openai', input }, mockContext);
      expect(mockProviderService.updateProvider).toHaveBeenCalledWith('openai', input);
      expect(result.name).toBe('Updated Provider Name');
    });

    it('deletes an AI provider', async () => {
      const result = await resolver.ReactorDeleteAiProvider({}, { id: 'openai' }, mockContext);
      expect(mockProviderService.deleteProvider).toHaveBeenCalledWith('openai');
      expect(result).toBe(true);
    });

    it('creates an AI model', async () => {
      const input = { providerId: 'openai', modelKey: 'gpt-new', name: 'GPT New' };
      const result = await resolver.ReactorCreateAiModel({}, { input }, mockContext);
      expect(mockProviderService.createModel).toHaveBeenCalledWith(input);
      expect(result.id).toBe('gpt-new');
    });

    it('updates an AI model', async () => {
      const input = { name: 'Updated GPT-4o' };
      const result = await resolver.ReactorUpdateAiModel(
        {},
        { id: 'gpt-4o', input, providerId: 'openai' },
        mockContext
      );
      expect(mockProviderService.updateModel).toHaveBeenCalledWith('gpt-4o', {
        name: 'Updated GPT-4o',
        providerId: 'openai',
      });
      expect(result.name).toBe('Updated GPT-4o');
    });

    it('deletes an AI model', async () => {
      const result = await resolver.ReactorDeleteAiModel({}, { id: 'gpt-4o' }, mockContext);
      expect(mockProviderService.deleteModel).toHaveBeenCalledWith('gpt-4o');
      expect(result).toBe(true);
    });

    it('tests provider connection', async () => {
      const result = await resolver.ReactorTestAiProvider({}, { id: 'openai' }, mockContext);
      expect(mockProviderService.testProviderConnection).toHaveBeenCalledWith('openai', undefined);
      expect(result.success).toBe(true);
      expect(result.latencyMs).toBe(120);
    });

    it('syncs providers from YAML', async () => {
      const result = await resolver.ReactorSyncAiProvidersFromYaml({}, { overwrite: true }, mockContext);
      expect(mockProviderService.syncFromYaml).toHaveBeenCalledWith(true);
      expect(result).toEqual({ providersCount: 10, modelsCount: 45 });
    });
  });
});
