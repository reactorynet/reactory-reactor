import { query, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";
import { IReactorProviderService, IAIPersonaProviderService } from "@reactory/server-modules/reactory-reactor/types/service.types";

@resolver
class ReactorProvidersResolver {
  resolver: any;

  @query("ReactorProviders")
  async ReactorProviders(_: any, args: any, context: Reactory.Server.IReactoryContext) {
    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.getProviders();
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
}

export default ReactorProvidersResolver;
