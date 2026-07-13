# MCP OAuth Support — Implementation Plan

> **Status (shortest-route slice — IMPLEMENTED):** the MCP OAuth flow is built and
> unit-tested. To unblock MCP without waiting on the full auth-layer refactor, only
> the Layer B primitives MCP consumes were extracted — `token-crypto`,
> `ITokenStore`/`UserAuthenticationsTokenStore`, and stateless `state` — under
> `src/authentication/oauth/`. The full `core.OAuthTokenService`, provider adapters,
> Layer A login-strategy refactor, and `GoogleAuthService` port remain as described
> in `OAUTH_IMPLEMENTATION_PLAN.md` (Phases 1–5) and are NOT part of this slice.
> The MCP transport builds its store directly (`new UserAuthenticationsTokenStore`)
> rather than via the not-yet-built service; swap to the service when it lands.
> Remaining before production: real browser/E2E validation against a live OAuth MCP
> server, and the `open` behaviour in the electron shell.

> **Builds on** `src/authentication/OAUTH_IMPLEMENTATION_PLAN.md`. This is **Phase 6**
> of that plan and depends on its **Layer B** (the shared `core.OAuthTokenService`,
> `ITokenStore`/`UserAuthenticationsTokenStore`, `oauth/state.ts`, `oauth/token-crypto.ts`)
> being in place. MCP does **not** reimplement token storage, encryption, or CSRF
> state — it plugs the MCP SDK's OAuth machinery into those shared services.

## Context

The MCP macro (`ai/macro/mcp/`) currently supports only **static, header-based
auth**: a Reactory session bearer token / client key+secret forwarded to
allow-listed hosts (`buildAuthHeaders`, `macro.ts:99`), plus static catalog
`headers:` (with `${ENV}` interpolation). There is **no OAuth 2.0 flow** — no
dynamic client registration, no PKCE, no authorization-code redirect, no token
refresh. A pre-minted bearer token pasted into `headers:` works; a real consent
handshake does not.

The MCP SDK (`@modelcontextprotocol/sdk@1.28.0`) already implements the OAuth
protocol. `StreamableHTTPClientTransport` accepts an `authProvider?:
OAuthClientProvider` we never pass, and `client/auth.js` exports the helpers we
need (`auth`, `registerClient`, `startAuthorization`, `exchangeAuthorization`,
`refreshAuthorization`, `discoverAuthorizationServerMetadata`,
`UnauthorizedError`, `transport.finishAuth(code)`).

**Goal:** let MCP servers that require OAuth be connected and used by the agent,
in both runtime modes, reusing the shared OAuth layer for everything except the
MCP-SDK-specific handshake.

- **Local mode** — server runs on the user's machine inside the wrapped electron
  app. `localhost` redirect works and the system browser can be opened. Detected
  via `IS_LOCAL_MODE` / `IS_DESKTOP_INSTALL === 'true'` / `process.versions.electron`.
- **Server mode** (default) — traditional client-server. Consent cannot happen
  synchronously mid-agent-turn, so the flow is **out-of-band**: the macro hands
  back an authorization URL, the user completes consent in a browser, a callback
  route persists tokens via the shared store, and the next `connect` succeeds.

## What MCP reuses from the shared OAuth layer (Layer B)

| Need | Shared artifact (from `src/authentication/oauth/`) |
| --- | --- |
| Encrypted token persistence on `user.authentications` | `ITokenStore` / `UserAuthenticationsTokenStore` |
| CSRF state (stateless, multi-instance) | `oauth/state.ts` `createState` / `consumeState` |
| Token field encryption at rest | `oauth/token-crypto.ts` |
| Connect/callback route conventions | `service-routes.ts` pattern (`/auth/oauth/:provider/connect|callback`) |
| Token lifecycle helpers (status/revoke) | `core.OAuthTokenService@1.0.0` |

**MCP-specific delta** (what this plan adds on top): the SDK `OAuthClientProvider`
shim, PKCE + **Dynamic Client Registration** (MCP servers commonly require DCR),
the per-server catalog `auth` descriptor, the two-runtime-mode connect UX, and
threading an `authProvider` into the two MCP transport construction sites.

## Design

### 1. Mode helper — `ai/macro/mcp/runtime-mode.ts`
```ts
export const isLocalMode = (): boolean =>
  process.env.IS_LOCAL_MODE === 'true' ||
  process.env.IS_DESKTOP_INSTALL === 'true' ||
  !!(process.versions as Record<string,string|undefined>).electron;
```
Single source of truth for stdio gating and the OAuth redirect strategy. (Codebase
currently uses `IS_DESKTOP_INSTALL`; support both. Promote to a shared core util
if the auth layer later needs it.)

### 2. Catalog auth descriptor
Extend `AvailableServiceEntry` (`standard-config.ts`) and `McpConnectionEntry`
(`session-config.ts`) with an optional block (default absent = current behavior):
```ts
auth?: {
  type: 'none' | 'bearer' | 'oauth';
  scopes?: string[];
  // Optional overrides when the server does NOT support discovery / DCR:
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId?: string;      // pre-registered client (skips Dynamic Client Registration)
  clientSecret?: string;  // ${ENV} interpolated
}
```
Parsed for both sources: standard `~/.reactor/mcp.{json,yaml}` per-server `auth:`
key (in `standard-config.ts` `toEntry`) and curated `available.yaml`. When
`type` is omitted, behavior is exactly as today.

### 3. `OAuthClientProvider` shim — `ai/macro/mcp/oauth/ReactoryMcpOAuthProvider.ts`
Implements the SDK interface (`client/auth.d.ts:15`). **All persistence delegates
to the shared `ITokenStore`** under provider key **`mcp:<serverId>`** — so MCP
tokens land in the same encrypted `user.authentications` store as every other
provider, and the reactor owns no bespoke crypto or upsert logic.

| SDK member | Backing |
| --- | --- |
| `get redirectUrl` | `${redirectBase}/auth/mcp/${serverId}/callback` |
| `get clientMetadata` | `{ client_name:'Reactory Reactor', redirect_uris:[redirectUrl], scope, grant_types:['authorization_code','refresh_token'], response_types:['code'], token_endpoint_auth_method }` |
| `clientInformation()` / `saveClientInformation()` | `ITokenStore` `raw.clientInformation` (DCR result via SDK `registerClient`, or seeded from catalog `clientId`/`clientSecret`) |
| `tokens()` / `saveTokens()` | `ITokenStore.get/set` (`accessToken`/`refreshToken`/`expiresAt`/`scopes`) |
| `saveCodeVerifier()` / `codeVerifier()` | `ITokenStore` `raw.codeVerifier` (transient PKCE, cleared after exchange) |
| `state()` | shared `oauth/state.ts` `createState({ flow:'mcp', serverId, userId, clientKey })` |
| `redirectToAuthorization(url)` | `isLocalMode()` ? open system browser : stash `this.pendingAuthorizationUrl = url` (non-blocking) for the macro to surface |

`redirectBase` = `context.partner.siteUrl` (server) or `http://localhost:${PORT}`
(local). Because the store is the shared encrypted `user.authentications`, the
`codeVerifier`/`clientInformation` written before the redirect survive to the
callback request — essential for **server mode**, where callback and macro run in
different requests/instances.

### 4. Transport wiring
In `addHttpConnection` (`macro.ts:253`) and `buildHttpTransport`
(`load-clients.ts:41`), when `catalogEntry.auth?.type === 'oauth'`:
```ts
const tokenStore = state.context.getService('core.OAuthTokenService@1.0.0').tokenStore; // shared ITokenStore
const authProvider = new ReactoryMcpOAuthProvider(serverId, url, state.context, { tokenStore, scopes });
const transport = new StreamableHTTPClientTransport(parsedUrl, { authProvider, requestInit });
```
Static header auth remains the default when `auth?.type !== 'oauth'`.

### 5. connect flow + new macro commands
- **`connectClient`** (`macro.ts:459`): import `UnauthorizedError` from the SDK.
  Wrap `client.connect`. On `UnauthorizedError`, read
  `authProvider.pendingAuthorizationUrl` and return an actionable result:
  ```ts
  { success:false, needsAuthorization:true, authorizationUrl,
    instructions: "Open this URL to authorize <server>, then run mcp command='connect' id=... again." }
  ```
  In **local mode**, also auto-open the browser. Distinguish this from a hard
  failure so instructions guide the user to authorize rather than to "provide a
  pre-authenticated URL" (`macro.ts:158`).
- **New commands** (add to enum in `types.ts`, tool schema, and the `McpCli`
  switch): `authorize` (re-issue the authorization URL without a full connect)
  and `logout` (delegates to `ITokenStore.remove('mcp:'+serverId)` / the
  service's revoke).

### 6. Callback route — `ai/macro/mcp/oauth/routes.ts`
`registerMcpOAuthRoutes(app)`, wired via a reactor `passportProvider` entry
(`index.ts:52`) whose `configure(app)` calls it (mirror `useGoogleRoutes`; supply
a trivial custom strategy or register via the module route hook so `passport.use`
at `configure.ts:63` is satisfied). Follows the shared `service-routes.ts`
convention.

`GET /auth/mcp/:serverId/callback`:
1. `consumeState(req)` (shared) → `{ serverId, userId, clientKey }` → load user/context.
2. Read pending record from `ITokenStore.get(userId,'mcp:'+serverId)`:
   `clientInformation`, `codeVerifier`, discovered/overridden token endpoint.
3. **Exchange decoupled from the macro's in-memory transport** (different request
   in server mode): SDK `exchangeAuthorization(authServerUrl, { metadata,
   clientInformation, authorizationCode: req.query.code, codeVerifier, redirectUri })`
   (metadata via `discoverAuthorizationServerMetadata`, or catalog overrides).
4. `ITokenStore.set(...)` the resulting tokens (encrypted); clear `codeVerifier`.
5. Redirect: **local** → success page signalling electron to reconnect;
   **server** → `${partner.siteUrl}` success. Next `connect` finds tokens via the
   provider's `tokens()` and succeeds.

`transport.finishAuth(code)` (`streamableHttp.d.ts:139`) is the live-transport
alternative (viable in local mode); the decoupled `exchangeAuthorization` path is
used for both to keep one code path and to work in server mode.

### 7. Refresh & revoke
- Refresh is automatic: the SDK calls `tokens()`; on expiry the provider refreshes
  and `saveTokens()` writes back through the shared store.
- `disconnect` leaves tokens intact; `logout` clears the grant via the store/service.

## Files

| File | Change |
| --- | --- |
| `ai/macro/mcp/runtime-mode.ts` | **new** — `isLocalMode()` |
| `ai/macro/mcp/oauth/ReactoryMcpOAuthProvider.ts` | **new** — SDK `OAuthClientProvider` delegating to shared `ITokenStore` |
| `ai/macro/mcp/oauth/routes.ts` | **new** — `registerMcpOAuthRoutes(app)`; exchange via SDK, persist via shared store, validate via shared state |
| `ai/macro/mcp/standard-config.ts` | add `auth` to `AvailableServiceEntry`; parse per-server `auth:` |
| `ai/macro/mcp/session-config.ts` | add `auth` to `McpConnectionEntry` (persist across reload) |
| `ai/macro/mcp/macro.ts` | authProvider in `addHttpConnection`; `UnauthorizedError` → `needsAuthorization` in `connectClient`; `authorize`/`logout` commands |
| `ai/macro/mcp/load-clients.ts` | authProvider in `buildHttpTransport` for persisted oauth connections |
| `ai/macro/mcp/types.ts` | add `authorize`/`logout` to command union + tool schema enum |
| `index.ts` | register MCP OAuth callback via `passportProviders` |
| *(dependency)* `src/authentication/oauth/*` | consumed, not modified — must exist (Phases 3–4) |

## Verification

1. **Unit (jest, hermetic)** — extend `macro.test.ts`:
   - `auth: { type:'oauth' }` entry builds a transport with an `authProvider`
     (assert via the existing `StreamableHTTPClientTransport` mock capturing opts).
   - `connectClient` with a mocked `UnauthorizedError` → `needsAuthorization:true`
     + `authorizationUrl`.
   - `ReactoryMcpOAuthProvider.tokens/saveTokens` round-trip against a **mocked
     `ITokenStore`**; assert key `mcp:<serverId>` and that no crypto/upsert lives
     in the reactor (delegation only).
   - `isLocalMode()` true/false via env toggling (mirror the existing
     `REACTORY_MCP_STDIO_ENABLED` save/restore harness).
2. **Callback** — unit-test `routes.ts` with `exchangeAuthorization` + `consumeState`
   mocked: valid state → `ITokenStore.set` called; bad/expired state → 401, no writes.
3. **E2E (local mode)** — against a real OAuth MCP server (dev Atlassian/Linear
   remote MCP): `IS_LOCAL_MODE=true`, `available` → `add-connection` → `connect`
   opens browser → consent → callback stores tokens → `connect` again →
   `tools`/`call-tool` succeed. Confirm the encrypted token doc under
   `user.authentications['mcp:<server>']` via the shared store.
4. **Server mode** — `IS_LOCAL_MODE` unset: `connect` returns `needsAuthorization`
   + URL (no browser); open URL manually; re-`connect` succeeds. Expire the access
   token and re-call a tool to confirm auto-refresh through the shared store.

## Open decisions (confirm before build)

- **Provider-key scope**: `mcp:<serverId>` per server (recommended) vs per
  `(serverId, partner)` for multi-tenant reuse — should align with the Layer B
  provider-key decision.
- **Server-mode UX**: surface the authorization URL in the macro result only, vs.
  also route the user through the shared `${partner.siteUrl}` success screen.
- **DCR vs pre-registered**: rely on Dynamic Client Registration (SDK
  `registerClient`) where supported (zero-config), falling back to catalog
  `clientId/secret`. DCR is the main MCP-specific capability the generic Layer B
  adapter does not need — kept in the shim.
