import {
  query,
  mutation,
  resolver,
} from "@reactory/server-core/models/graphql/decorators/resolver";
import { IReactorProviderService } from "@reactory/server-modules/reactory-reactor/types/service.types";

/**
 * Thin GraphQL resolver layer for provider authentication.
 * All auth logic (encryption, user.authentications writes, partner.auth_config
 * admin updates, single-default enforcement, non-secret echo) lives in
 * ReactorProviderService. The resolver only marshals args and returns.
 */
// @ts-ignore - resolver() is a marker decorator; same pattern used in ReactorProviders.ts
@resolver
class ReactorProviderAuthResolver {
  resolver: any;

  @query("ReactorUserProviderAuth")
  async ReactorUserProviderAuth(
    _: any,
    _args: any,
    context: Reactory.Server.IReactoryContext
  ) {
    const providerService = context.getService<IReactorProviderService>(
      "reactor.ReactorProviderService@1.0.0"
    );
    return providerService.getUserProviderAuth();
  }

  @mutation("ReactorSaveProviderAuth")
  async ReactorSaveProviderAuth(
    _: any,
    args: {
      input: {
        providerId: string;
        credentials: Record<string, any>;
        setAsAccountDefault?: boolean;
        setAsAppDefault?: boolean;
      };
    },
    context: Reactory.Server.IReactoryContext
  ) {
    const providerService = context.getService<IReactorProviderService>(
      "reactor.ReactorProviderService@1.0.0"
    );
    return providerService.saveProviderAuth(args.input);
  }

  @mutation("ReactorRemoveProviderAuth")
  async ReactorRemoveProviderAuth(
    _: any,
    args: { input: { providerId: string } },
    context: Reactory.Server.IReactoryContext
  ) {
    const providerService = context.getService<IReactorProviderService>(
      "reactor.ReactorProviderService@1.0.0"
    );
    return providerService.removeProviderAuth(args.input.providerId);
  }
}

export default ReactorProviderAuthResolver;
