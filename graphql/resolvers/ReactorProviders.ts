import { query, mutation, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";
import { IReactorProviderService, IAIPersonaProviderService } from "@reactory/server-modules/reactory-reactor/types/service.types";
import ApiError from "@reactory/server-core/exceptions";

@resolver
class ReactorProvidersResolver {
  resolver: any;

  @query("ReactorProviders")
  async ReactorProviders(_: any, args: any, context: Reactory.Server.IReactoryContext) {
    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    const providers = await providerService.getProviders();
    return providers;
  }

  @query("ReactorModelsForPersona")
  async ReactorModelsForPersona(
    _: any,
    args: { personaId?: string },
    context: Reactory.Server.IReactoryContext
  ) {
    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");

    let capabilities: string[] | undefined;
    if (args.personaId) {
      const personaProvider = context.getService<IAIPersonaProviderService>("reactor.AIPersonaProvider@1.0.0");
      const persona = await personaProvider.getPersona(args.personaId);
      if (persona?.capabilities) {
        capabilities = persona.capabilities;
      }
    }

    return await providerService.getModelsForPersona(capabilities);
  }

  @query("ReactorAiProvidersAdmin")
  async ReactorAiProvidersAdmin(
    _: any,
    args: {
      filter?: { isEnabled?: boolean; searchString?: string; providerType?: string };
      paging?: { page?: number; pageSize?: number };
    },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    let providers = await providerService.getProviders();

    if (args.filter) {
      const { isEnabled, searchString, providerType } = args.filter;
      if (isEnabled !== undefined) {
        providers = providers.filter((p: any) => p.isEnabled !== !isEnabled);
      }
      if (providerType) {
        providers = providers.filter((p: any) => p.providerType === providerType || p.id === providerType);
      }
      if (searchString) {
        const lower = searchString.toLowerCase();
        providers = providers.filter(
          (p: any) =>
            p.name.toLowerCase().includes(lower) ||
            p.id.toLowerCase().includes(lower) ||
            p.description?.toLowerCase().includes(lower)
        );
      }
    }

    const total = providers.length;
    const page = Math.max(1, args.paging?.page || 1);
    const pageSize = Math.max(1, args.paging?.pageSize || 20);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pagedProviders = providers.slice(start, end);

    return {
      paging: {
        page,
        pageSize,
        total,
        hasNext: end < total,
      },
      providers: pagedProviders,
    };
  }

  @query("ReactorAiModelsAdmin")
  async ReactorAiModelsAdmin(
    _: any,
    args: {
      providerId?: string;
      searchString?: string;
      paging?: { page?: number; pageSize?: number };
    },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    let providers = await providerService.getProviders();

    if (args.providerId) {
      providers = providers.filter((p: any) => p.id === args.providerId);
    }

    let allModels: any[] = [];
    for (const p of providers) {
      if (Array.isArray(p.models)) {
        allModels.push(...p.models);
      }
    }

    if (args.searchString) {
      const lower = args.searchString.toLowerCase();
      allModels = allModels.filter(
        (m: any) =>
          m.name.toLowerCase().includes(lower) ||
          m.id.toLowerCase().includes(lower) ||
          m.providerId?.toLowerCase().includes(lower)
      );
    }

    const total = allModels.length;
    const page = Math.max(1, args.paging?.page || 1);
    const pageSize = Math.max(1, args.paging?.pageSize || 20);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pagedModels = allModels.slice(start, end);

    return {
      paging: {
        page,
        pageSize,
        total,
        hasNext: end < total,
      },
      models: pagedModels,
    };
  }

  @query("ReactorAiProviderAdmin")
  async ReactorAiProviderAdmin(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.getProvider(args.id);
  }

  @mutation("ReactorCreateAiProvider")
  async ReactorCreateAiProvider(
    _: any,
    args: { input: any },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.createProvider(args.input);
  }

  @mutation("ReactorUpdateAiProvider")
  async ReactorUpdateAiProvider(
    _: any,
    args: { id: string; input: any },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.updateProvider(args.id, args.input);
  }

  @mutation("ReactorDeleteAiProvider")
  async ReactorDeleteAiProvider(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.deleteProvider(args.id);
  }

  @mutation("ReactorCreateAiModel")
  async ReactorCreateAiModel(
    _: any,
    args: { input: any },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.createModel(args.input);
  }

  @mutation("ReactorUpdateAiModel")
  async ReactorUpdateAiModel(
    _: any,
    args: { id: string; input: any; providerId?: string },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.updateModel(args.id, { ...args.input, providerId: args.providerId });
  }

  @mutation("ReactorDeleteAiModel")
  async ReactorDeleteAiModel(
    _: any,
    args: { id: string; providerId?: string },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.deleteModel(args.id);
  }

  @mutation("ReactorTestAiProvider")
  async ReactorTestAiProvider(
    _: any,
    args: { id: string; testModelId?: string },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.testProviderConnection(args.id, args.testModelId);
  }

  @mutation("ReactorSyncAiProvidersFromYaml")
  async ReactorSyncAiProvidersFromYaml(
    _: any,
    args: { overwrite?: boolean },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!context.user) {
      throw new ApiError("Authentication required", { code: "UNAUTHORIZED" });
    }

    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.syncFromYaml(args.overwrite);
  }
}

export default ReactorProvidersResolver;
