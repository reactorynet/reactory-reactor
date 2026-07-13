/**
 * OAuth callback route for MCP servers.
 *
 * Registered on the shared express app via the reactor module's
 * `passportProviders` hook. Handles the out-of-band consent redirect: validates
 * the CSRF state, resolves the server (by id, from the catalog) and the user,
 * then drives the SDK's `finishAuth(code)` — which discovers metadata, exchanges
 * the code (using the PKCE verifier / client registration persisted during
 * connect), and saves the tokens through the shared encrypted store. The next
 * `connect` then succeeds using those tokens.
 */
import Reactory from "@reactorynet/reactory-core";
import { Application, Response } from "express";
import passport from "passport";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import logger from "@reactory/server-core/logging";
import { User } from "@reactory/server-modules/reactory-core/models";
import {
  UserAuthenticationsTokenStore,
  TokenStoreUser,
  consumeState,
} from "@reactory/server-core/authentication/oauth";
import { findCatalogEntry } from "../catalog";
import { ReactoryMcpOAuthProvider } from "./ReactoryMcpOAuthProvider";

const html = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto">` +
  `<h2>${title}</h2><p>${body}</p></body>`;

export const registerMcpOAuthRoutes = (app: Application): void => {
  app.get(
    "/auth/mcp/:serverId/callback",
    async (req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<void> => {
      const { serverId } = req.params;
      const code = req.query.code as string | undefined;
      const stateParam = req.query.state as string | undefined;

      const state = consumeState(stateParam);
      if (!state || state.flow !== "mcp" || state.serverId !== serverId) {
        logger.warn(`MCP OAuth callback: invalid state for server ${serverId}`);
        res.status(400).send(html("Authorization failed", "Invalid or expired authorization state."));
        return;
      }
      if (!code) {
        res.status(400).send(html("Authorization failed", "Missing authorization code."));
        return;
      }

      const entry = findCatalogEntry(serverId);
      if (!entry?.url) {
        res.status(404).send(html("Authorization failed", `Unknown MCP server "${serverId}".`));
        return;
      }

      try {
        // Resolve the user the tokens belong to (from state; fall back to request context).
        const user = state.userId
          ? ((await User.findById(state.userId)) as unknown as TokenStoreUser | null)
          : (req.context?.user as unknown as TokenStoreUser | undefined);
        if (!user) {
          res.status(400).send(html("Authorization failed", "Could not resolve the user for this authorization."));
          return;
        }

        const redirectBaseUrl = `${req.protocol}://${req.get("host")}`;
        const authProvider = new ReactoryMcpOAuthProvider({
          tokenStore: new UserAuthenticationsTokenStore(user),
          serverId,
          redirectBaseUrl,
          scopes: entry.auth?.scopes,
          clientId: entry.auth?.clientId,
          clientSecret: entry.auth?.clientSecret,
          userId: state.userId,
          clientKey: state.clientKey,
        });

        const transport = new StreamableHTTPClientTransport(new URL(entry.url), { authProvider });
        await transport.finishAuth(code);
        await transport.close().catch(() => {});

        logger.info(`MCP OAuth: authorization completed for server ${serverId}, user ${state.userId}`);

        if (state.redirectTo) {
          res.redirect(302, state.redirectTo);
          return;
        }
        res.status(200).send(
          html(
            "Authorized",
            `You have authorized <strong>${serverId}</strong>. You can close this window and return to the assistant — run <code>connect</code> again.`
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`MCP OAuth callback failed for ${serverId}: ${message}`, { err });
        res.status(500).send(html("Authorization failed", `Token exchange failed: ${message}`));
      }
    }
  );
};

/**
 * Minimal passport strategy so the reactor module's `passportProviders` entry
 * satisfies `passport.use(...)`. The MCP OAuth flow uses plain routes (not
 * `passport.authenticate`), so this strategy is never invoked.
 */
class NoopMcpOAuthStrategy extends passport.Strategy {
  name = "mcp-oauth";
  authenticate(): void {
    this.fail?.(401);
  }
}

export const mcpOAuthPassportProvider = {
  name: "mcp-oauth",
  strategy: new NoopMcpOAuthStrategy(),
  configure: registerMcpOAuthRoutes,
};
