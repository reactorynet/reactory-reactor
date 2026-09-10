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
    args: { filter?: { isEnabled?: boolean; searchString?: string; providerType?: string } },
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

    return providers;
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
