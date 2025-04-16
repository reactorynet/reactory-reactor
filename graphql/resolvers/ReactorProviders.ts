import { query, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";
import { IReactorProviderService } from "@reactory/server-modules/reactory-reactor/types/service.types";

@resolver
class ReactorProvidersResolver {
  resolver: any;

  @query("ReactorProviders")
  async ReactorProviders(_: any, args: any, context: Reactory.Server.IReactoryContext) {
    const providerService = context.getService<IReactorProviderService>("reactor.ReactorProviderService@1.0.0");
    return await providerService.getProviders();
  }
}

export default ReactorProvidersResolver;
