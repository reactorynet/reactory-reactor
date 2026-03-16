import {
  query,
  mutation,
  resolver,
} from "@reactory/server-core/models/graphql/decorators/resolver";
import { IReactorProviderService } from "@reactory/server-modules/reactory-reactor/types/service.types";
import {
  encryptCredentials,
  redactCredentials,
} from "@reactory/server-modules/reactory-reactor/utils/credential-encryption";

const AUTH_KEY_PREFIX = "ai-provider:";

// @ts-ignore - resolver() is a marker decorator; same pattern used in ReactorProviders.ts
@resolver
class ReactorProviderAuthResolver {
  resolver: any;

  /**
   * Returns the authentication status for each provider for the current user.
   */
  @query("ReactorUserProviderAuth")
  async ReactorUserProviderAuth(
    _: any,
    _args: any,
    context: Reactory.Server.IReactoryContext
  ) {
    const providerService = context.getService<IReactorProviderService>(
      "reactor.ReactorProviderService@1.0.0"
    );
    const providers = await providerService.getProviders();
    const user = context.user as any;

    // Get User authentications
    const userAuths: any[] = user?.authentications || [];

    // Get app-level auth config from the partner (ReactoryClient)
    const partner = context.partner;
    const appAuthConfigs: any[] = (partner as any)?.auth_config || [];

    return providers.map((provider) => {
      const authKey = `${AUTH_KEY_PREFIX}${provider.id}`;

      const userAuth = userAuths.find(
        (a: any) => a.provider === authKey
      );
      const appAuth = appAuthConfigs.find(
        (a: any) => a.provider === authKey
      );

      return {
        provider: provider.id,
        configured: !!userAuth,
        isDefault: !!userAuth,
        isAppDefault: !!appAuth?.enabled,
        source: userAuth
          ? "user"
          : appAuth?.enabled
          ? "app"
          : provider.status?.available
          ? "environment"
          : "none",
      };
    });
  }

  /**
   * Saves provider authentication credentials for the current user.
   * Optionally sets as app-level default (ADMIN only).
   */
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
    const { providerId, credentials, setAsAccountDefault = true, setAsAppDefault = false } =
      args.input;
    const authKey = `${AUTH_KEY_PREFIX}${providerId}`;

    // Encrypt sensitive credential values
    const encrypted = encryptCredentials(credentials);

    // Save to user authentications via the User model document method
    const user = context.user as any;
    await user.setAuthentication({
      provider: authKey,
      props: encrypted,
      lastLogin: new Date(),
    });

    // If setAsAppDefault, require ADMIN role
    if (setAsAppDefault) {
      const isAdmin = context.hasRole("ADMIN");
      if (!isAdmin) {
        throw new Error("Only ADMIN users can set app-level provider defaults");
      }

      const partner = context.partner as any;
      if (partner) {
        const existingConfigs: any[] = partner.auth_config || [];
        const existingIdx = existingConfigs.findIndex(
          (c: any) => c.provider === authKey
        );

        const authConfigEntry = {
          provider: authKey,
          enabled: true,
          properties: encrypted,
        };

        if (existingIdx >= 0) {
          existingConfigs[existingIdx] = authConfigEntry;
        } else {
          existingConfigs.push(authConfigEntry);
        }

        partner.auth_config = existingConfigs;
        await partner.save();
      }
    }

    return {
      provider: providerId,
      configured: true,
      isDefault: setAsAccountDefault !== false,
      isAppDefault: setAsAppDefault === true,
      source: "user",
    };
  }

  /**
   * Removes provider authentication credentials for the current user.
   */
  @mutation("ReactorRemoveProviderAuth")
  async ReactorRemoveProviderAuth(
    _: any,
    args: { input: { providerId: string } },
    context: Reactory.Server.IReactoryContext
  ) {
    const { providerId } = args.input;
    const authKey = `${AUTH_KEY_PREFIX}${providerId}`;

    // Remove via User model document method
    const user = context.user as any;
    await user.removeAuthentication(authKey);

    return true;
  }
}

export default ReactorProviderAuthResolver;
