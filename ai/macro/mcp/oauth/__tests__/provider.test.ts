// createState() (via provider.state()) encrypts with the encoder over SECRET_SAUCE.
process.env.SECRET_SAUCE = process.env.SECRET_SAUCE || "unit-test-secret-sauce-value-32chars!";

import { ReactoryMcpOAuthProvider } from "../ReactoryMcpOAuthProvider";
import type { ITokenStore, StoredToken } from "@reactory/server-core/authentication/oauth";

/** In-memory ITokenStore for delegation assertions. */
const makeStore = (): ITokenStore & { data: Map<string, StoredToken> } => {
  const data = new Map<string, StoredToken>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, token) {
      data.set(key, token);
    },
    async patch(key, partial) {
      const cur = data.get(key) ?? {};
      const merged = { ...cur, ...partial, raw: { ...(cur.raw ?? {}), ...(partial.raw ?? {}) } };
      data.set(key, merged);
      return merged;
    },
    async remove(key) {
      data.delete(key);
    },
  };
};

const makeProvider = (store: ITokenStore, over: Partial<ConstructorParameters<typeof ReactoryMcpOAuthProvider>[0]> = {}) =>
  new ReactoryMcpOAuthProvider({
    tokenStore: store,
    serverId: "grafana",
    redirectBaseUrl: "https://app.example",
    scopes: ["read"],
    userId: "u1",
    clientKey: "ck",
    ...over,
  });

describe("ReactoryMcpOAuthProvider", () => {
  it("exposes redirectUrl + clientMetadata derived from options", () => {
    const p = makeProvider(makeStore());
    expect(p.redirectUrl).toBe("https://app.example/auth/mcp/grafana/callback");
    expect(p.clientMetadata.redirect_uris).toEqual(["https://app.example/auth/mcp/grafana/callback"]);
    expect(p.clientMetadata.scope).toBe("read");
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  it("uses client_secret_post when a clientSecret is configured", () => {
    const p = makeProvider(makeStore(), { clientId: "cid", clientSecret: "shh" });
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
  });

  it("round-trips tokens through the store under mcp:<serverId>", async () => {
    const store = makeStore();
    const p = makeProvider(store);
    await p.saveTokens({ access_token: "at", token_type: "Bearer", refresh_token: "rt", expires_in: 3600, scope: "read" } as never);
    expect(store.data.has("mcp:grafana")).toBe(true);
    const t = await p.tokens();
    expect(t).toMatchObject({ access_token: "at", refresh_token: "rt" });
  });

  it("persists PKCE verifier + client information without clobbering each other", async () => {
    const store = makeStore();
    const p = makeProvider(store);
    await p.saveCodeVerifier("cv-123");
    await p.saveClientInformation({ client_id: "dyn-cid" } as never);
    expect(await p.codeVerifier()).toBe("cv-123");
    expect(await p.clientInformation()).toEqual({ client_id: "dyn-cid" });
  });

  it("prefers a statically configured client over stored registration", async () => {
    const store = makeStore();
    const p = makeProvider(store, { clientId: "static-cid", clientSecret: "s" });
    await p.saveClientInformation({ client_id: "dyn-cid" } as never);
    expect(await p.clientInformation()).toEqual({ client_id: "static-cid", client_secret: "s" });
  });

  it("stashes the authorization URL (server mode) instead of redirecting", async () => {
    const p = makeProvider(makeStore());
    await p.redirectToAuthorization(new URL("https://idp.example/authorize?x=1"));
    expect(p.pendingAuthorizationUrl).toBe("https://idp.example/authorize?x=1");
  });

  it("emits a decodable state token", () => {
    const p = makeProvider(makeStore());
    expect(typeof p.state()).toBe("string");
    expect(p.state().length).toBeGreaterThan(0);
  });

  it("throws if a code verifier is requested before one is saved", async () => {
    const p = makeProvider(makeStore());
    await expect(p.codeVerifier()).rejects.toThrow(/code verifier/i);
  });
});
