import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { URL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChatState, MCPClient } from "../../openai/types/chat";
import { loadSessionMcpConfig, saveSessionMcpConfig, McpConnectionEntry } from "./session-config";

interface CatalogEntry { url?: string; transport?: string; id?: string; }

const loadCatalog = (): CatalogEntry[] => {
  const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT;
  if (!dataRoot) return [];
  const p = path.join(dataRoot, "profiles", "reactor", "mcp", "available.yaml");
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = yaml.load(raw) as { services?: CatalogEntry[] } | undefined;
    return parsed?.services ?? [];
  } catch {
    return [];
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

const isStdioAllowed = (): boolean => {
  if ((process.versions as Record<string, string | undefined>).electron) return true;
  return process.env.REACTORY_MCP_STDIO_ENABLED === "true";
};

const buildHttpTransport = (
  conn: McpConnectionEntry,
  state: ChatState,
  allowedUrls: string[]
): StreamableHTTPClientTransport | null => {
  if (!conn.url) return null;
  const baseUrl = conn.url.endsWith("/") ? conn.url : `${conn.url}/`;

  const headers: Record<string, string> = { ...(conn.headers ?? {}) };
  if (hostMatches(conn.url, allowedUrls)) {
    if (state.authToken) headers["Authorization"] = `Bearer ${state.authToken}`;
    const anyState = state as unknown as { clientKey?: string; clientSecret?: string };
    if (anyState.clientKey) headers["x-client-key"] = anyState.clientKey;
    if (anyState.clientSecret) headers["x-client-pwd"] = anyState.clientSecret;
  }

  return new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { credentials: "include", headers },
  });
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

    if (conn.transport === "http" || conn.transport === "sse") {
      const http = buildHttpTransport(conn, state, allowedUrls);
      if (http) transports.http = http;
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
    });
  }

  if (dirty) {
    saveSessionMcpConfig(state.sessionFolder, config);
  }
};
