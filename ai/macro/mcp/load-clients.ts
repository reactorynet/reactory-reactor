import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { URL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChatState, MCPClient } from "../../openai/types/chat";
import { loadSessionMcpConfig, saveSessionMcpConfig, McpConnectionEntry } from "./session-config";
import { loadStandardMcpServers, McpAuthConfig } from "./standard-config";
import { buildMcpOAuthProvider } from "./oauth/provider-factory";
import type { ReactoryMcpOAuthProvider } from "./oauth/ReactoryMcpOAuthProvider";
import { isLocalMode } from "./runtime-mode";

interface CatalogEntry { url?: string; transport?: string; id?: string; }

const loadCatalog = (): CatalogEntry[] => {
  // Standard-config http servers (~/.reactor/mcp.yaml) are user-declared trust and
  // participate in credential forwarding alongside the curated available.yaml catalog.
  const standard: CatalogEntry[] = loadStandardMcpServers().map((s) => ({
    id: s.id,
    url: s.url,
    transport: s.transport,
  }));

  const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT;
  if (!dataRoot) return standard;
  const p = path.join(dataRoot, "profiles", "reactor", "mcp", "available.yaml");
  if (!fs.existsSync(p)) return standard;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = yaml.load(raw) as { services?: CatalogEntry[] } | undefined;
    return [...standard, ...(parsed?.services ?? [])];
  } catch {
    return standard;
  }
};

const hostMatches = (candidate: string, allowedUrls: string[]): boolean => {
  try {
    const c = new URL(candidate);
    return allowedUrls.some((a) => {
      try { return new URL(a).origin === c.origin; } catch { return false; }
    });
  } catch { return false; }
};

const isStdioAllowed = (): boolean =>
  isLocalMode() || process.env.REACTORY_MCP_STDIO_ENABLED === "true";

interface BuiltHttp {
  transport: StreamableHTTPClientTransport;
  authProvider?: ReactoryMcpOAuthProvider;
}

const buildHttpTransport = (
  conn: McpConnectionEntry,
  state: ChatState,
  allowedUrls: string[]
): BuiltHttp | null => {
  if (!conn.url) return null;
  const baseUrl = conn.url.endsWith("/") ? conn.url : `${conn.url}/`;

  const headers: Record<string, string> = { ...(conn.headers ?? {}) };
  if (hostMatches(conn.url, allowedUrls)) {
    if (state.authToken) headers["Authorization"] = `Bearer ${state.authToken}`;
    const anyState = state as unknown as { clientKey?: string; clientSecret?: string };
    if (anyState.clientKey) headers["x-client-key"] = anyState.clientKey;
    if (anyState.clientSecret) headers["x-client-pwd"] = anyState.clientSecret;
  }

  // Rehydrate the OAuth provider for oauth-typed connections so a reconnect after
  // out-of-band consent (a different request) picks up the stored tokens.
  const authProvider =
    buildMcpOAuthProvider(state, conn.serverName, conn.auth as McpAuthConfig | undefined) ?? undefined;

  const requestInit: RequestInit = { credentials: "include", headers };
  const transport = new StreamableHTTPClientTransport(
    new URL(baseUrl),
    authProvider ? { requestInit, authProvider } : { requestInit }
  );
  return { transport, authProvider };
};

const buildStdioTransport = (conn: McpConnectionEntry): StdioClientTransport | null => {
  if (!isStdioAllowed()) return null;
  if (!conn.command) return null;
  return new StdioClientTransport({
    command: conn.command,
    args: conn.args ?? [],
    env: conn.env,
    cwd: conn.cwd,
  });
};

export const loadClientsFromSession = (state: ChatState): void => {
  if (!state.mcpClients) state.mcpClients = [];
  if (!state.sessionFolder) return;

  const config = loadSessionMcpConfig(state.sessionFolder);
  const catalog = loadCatalog();
  const allowedUrls = catalog.map((s) => s.url).filter((u): u is string => typeof u === "string");

  let dirty = false;

  for (const conn of config.connections) {
    if (state.mcpClients.find((c) => c.id === conn.id)) continue;

    // Stale 'active' entries can't be trusted across process restarts — reset to inactive.
    if (conn.status === "active") {
      conn.status = "inactive";
      dirty = true;
    }

    const transports: MCPClient["transports"] = {};
    let authProvider: ReactoryMcpOAuthProvider | undefined;

    if (conn.transport === "http" || conn.transport === "sse") {
      const http = buildHttpTransport(conn, state, allowedUrls);
      if (http) {
        transports.http = http.transport;
        authProvider = http.authProvider;
      }
    } else if (conn.transport === "stdio") {
      const stdio = buildStdioTransport(conn);
      if (stdio) transports.stdio = stdio;
    }

    if (!transports.http && !transports.stdio) {
      // Skip unrecognised / gated-off entries rather than crashing.
      continue;
    }

    const client = new Client({ name: conn.serverName, version: "1.0.0" });
    state.mcpClients.push({
      id: conn.id,
      client,
      name: conn.serverName,
      description: conn.description || `MCP Client for ${conn.serverName}`,
      transports,
      // Cached for diagnostics/error messages — without these a rehydrated
      // client reports "(unknown url)" on connect failures.
      url: conn.url,
      command: conn.command,
      authProvider,
    });
  }

  if (dirty) {
    saveSessionMcpConfig(state.sessionFolder, config);
  }
};
