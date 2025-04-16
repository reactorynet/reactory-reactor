import { query, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";
import { IReactorCapabilityService } from "@reactory/server-modules/reactory-reactor/types/service.types";

@resolver
class ReactorCapabilitiesResolver {
  resolver: any;

  @query("ReactorCapabilities")
  async ReactorCapabilities(_: any, args: any, context: Reactory.Server.IReactoryContext) {
    const capabilityService = context.getService<IReactorCapabilityService>("reactor.ReactorCapabilityService@1.0.0");
    return await capabilityService.getCapabilities();
  }
}

export default ReactorCapabilitiesResolver;
