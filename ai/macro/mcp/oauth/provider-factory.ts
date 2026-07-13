/**
 * Builds a {@link ReactoryMcpOAuthProvider} from the chat state + catalog entry.
 *
 * Centralises the runtime-mode-dependent decisions (redirect base URL, browser
 * opener) and the token-store construction, so both transport-construction sites
 * (`addHttpConnection` and `buildHttpTransport`) stay small.
 */
import { exec } from "child_process";
import { UserAuthenticationsTokenStore, TokenStoreUser } from "@reactory/server-core/authentication/oauth";
import { ChatState } from "../../../openai/types/chat";
import { AvailableServiceEntry, McpAuthConfig } from "../standard-config";
import { isLocalMode } from "../runtime-mode";
import { ReactoryMcpOAuthProvider } from "./ReactoryMcpOAuthProvider";

const defaultPort = (): string => process.env.API_PORT || process.env.SERVER_PORT || "4000";

/** Where the `/auth/mcp/:serverId/callback` route is reachable. */
export const resolveRedirectBase = (state: ChatState): string => {
  if (process.env.MCP_OAUTH_REDIRECT_BASE) return process.env.MCP_OAUTH_REDIRECT_BASE;
  if (isLocalMode()) return `http://localhost:${defaultPort()}`;
  const partner = (state.context as unknown as { partner?: { siteUrl?: string } })?.partner;
  return partner?.siteUrl || `http://localhost:${defaultPort()}`;
};

const browserOpener = (): ((url: string) => void) | undefined => {
  if (!isLocalMode()) return undefined;
  return (url: string) => {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start \"\"" : "xdg-open";
    exec(`${cmd} "${url}"`);
  };
};

interface OAuthContextUser {
  _id?: { toString(): string };
  id?: string;
}

/**
 * Construct the OAuth provider for an oauth-typed service, or return null when
 * the entry is not oauth or there is no user on the context to store tokens for.
 */
export const buildMcpOAuthProvider = (
  state: ChatState,
  serverId: string,
  auth: McpAuthConfig | undefined,
): ReactoryMcpOAuthProvider | null => {
  if (!auth || auth.type !== "oauth") return null;
  const user = state.context?.user as unknown as (TokenStoreUser & OAuthContextUser) | undefined;
  if (!user || typeof user.getAuthentication !== "function") return null;

  const tokenStore = new UserAuthenticationsTokenStore(user);
  const userId = user._id?.toString?.() || user.id;
  const clientKey =
    (state as unknown as { clientKey?: string }).clientKey ||
    (state.context as unknown as { partner?: { key?: string } })?.partner?.key;

  return new ReactoryMcpOAuthProvider({
    tokenStore,
    serverId,
    redirectBaseUrl: resolveRedirectBase(state),
    scopes: auth.scopes,
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    userId,
    clientKey,
    openBrowser: browserOpener(),
  });
};

/** Narrow a persisted/catalog auth block down to the oauth case. */
export const isOAuthEntry = (entry: Pick<AvailableServiceEntry, "auth">): boolean =>
  entry.auth?.type === "oauth";
