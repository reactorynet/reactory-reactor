/**
 * MCP OAuth client provider.
 *
 * Adapts the MCP SDK's `OAuthClientProvider` onto Reactory's shared OAuth token
 * store (`src/authentication/oauth`). The SDK drives the protocol (discovery,
 * PKCE, dynamic client registration, code exchange, refresh); this class only
 * persists/loads the resulting artifacts — encrypted, on `user.authentications`
 * under key `mcp:<serverId>` — and decides how the authorization redirect is
 * surfaced (open a browser in local mode, or stash the URL for the macro to
 * return in server mode).
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { ITokenStore, createState } from "@reactory/server-core/authentication/oauth";
import { isLocalMode } from "../runtime-mode";

export interface ReactoryMcpOAuthProviderOptions {
  tokenStore: ITokenStore;
  serverId: string;
  /** Base URL the callback route is reachable at (partner site or http://localhost:PORT). */
  redirectBaseUrl: string;
  scopes?: string[];
  /** Pre-registered client (skips dynamic client registration). */
  clientId?: string;
  clientSecret?: string;
  /** Carried in the OAuth state param for the callback to resolve. */
  userId?: string;
  clientKey?: string;
  /** Injected browser opener (local mode only); no-op elsewhere. */
  openBrowser?: (url: string) => void;
}

export class ReactoryMcpOAuthProvider implements OAuthClientProvider {
  /** Set by {@link redirectToAuthorization}; read by the macro in server mode. */
  public pendingAuthorizationUrl?: string;

  private readonly opts: ReactoryMcpOAuthProviderOptions;
  private readonly providerKey: string;

  constructor(opts: ReactoryMcpOAuthProviderOptions) {
    this.opts = opts;
    this.providerKey = `mcp:${opts.serverId}`;
  }

  private get store(): ITokenStore {
    return this.opts.tokenStore;
  }

  get redirectUrl(): string {
    return `${this.opts.redirectBaseUrl.replace(/\/$/, "")}/auth/mcp/${this.opts.serverId}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Reactory Reactor",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.opts.clientSecret ? "client_secret_post" : "none",
      scope: this.opts.scopes?.length ? this.opts.scopes.join(" ") : undefined,
    };
  }

  state(): string {
    return createState({
      flow: "mcp",
      serverId: this.opts.serverId,
      userId: this.opts.userId,
      clientKey: this.opts.clientKey,
    });
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    // Statically-configured (pre-registered) client wins.
    if (this.opts.clientId) {
      return { client_id: this.opts.clientId, client_secret: this.opts.clientSecret };
    }
    const token = await this.store.get(this.providerKey);
    return token?.raw?.clientInformation as OAuthClientInformation | undefined;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.store.patch(this.providerKey, { raw: { clientInformation: info } });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const token = await this.store.get(this.providerKey);
    if (!token) return undefined;
    // Prefer the verbatim SDK object when present (faithful round-trip).
    if (token.raw?.tokens) return token.raw.tokens as OAuthTokens;
    if (!token.accessToken) return undefined;
    return {
      access_token: token.accessToken,
      token_type: "Bearer",
      refresh_token: token.refreshToken,
      scope: token.scopes?.join(" "),
    } as OAuthTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.patch(this.providerKey, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      scopes: tokens.scope ? tokens.scope.split(" ") : undefined,
      lastRefreshedAt: Date.now(),
      connectedAt: Date.now(),
      raw: { tokens },
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.pendingAuthorizationUrl = authorizationUrl.toString();
    if (isLocalMode() && this.opts.openBrowser) {
      try {
        this.opts.openBrowser(this.pendingAuthorizationUrl);
      } catch {
        /* fall back to the stashed URL being surfaced by the macro */
      }
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.patch(this.providerKey, { raw: { codeVerifier } });
  }

  async codeVerifier(): Promise<string> {
    const token = await this.store.get(this.providerKey);
    const verifier = token?.raw?.codeVerifier as string | undefined;
    if (!verifier) throw new Error(`No PKCE code verifier saved for MCP server "${this.opts.serverId}"`);
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") {
      await this.store.remove(this.providerKey);
      return;
    }
    if (scope === "tokens") {
      await this.store.patch(this.providerKey, { accessToken: undefined, refreshToken: undefined, raw: { tokens: undefined } });
    } else if (scope === "verifier") {
      await this.store.patch(this.providerKey, { raw: { codeVerifier: undefined } });
    } else if (scope === "client") {
      await this.store.patch(this.providerKey, { raw: { clientInformation: undefined } });
    }
  }
}
