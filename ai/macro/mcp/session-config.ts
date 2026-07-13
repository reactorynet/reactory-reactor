import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Persisted shape of a single MCP connection entry in `<sessionFolder>/mcp.yaml`.
 *
 * Transport semantics:
 * - `http`  — Streamable HTTP transport (MCP spec). Requires `url`.
 * - `sse`   — deprecated alias for `http`, accepted when loading legacy session files.
 * - `stdio` — local child-process transport (desktop / gated server). Requires `command`.
 *
 * `websocket` is intentionally absent — it is not a spec-defined MCP transport.
 */
export type McpTransportKind = 'http' | 'sse' | 'stdio';

export interface McpConnectionEntry {
  id: string;
  serverName: string;
  description?: string;
  transport: McpTransportKind;

  /** Required when transport is 'http' | 'sse'. */
  url?: string;
  /** Optional extra headers for http transport (merged with auth headers by the macro). */
  headers?: Record<string, string>;

  /** Required when transport is 'stdio'. Catalog-supplied command; never user-supplied. */
  command?: string;
  /** Optional args for stdio transport. Catalog-supplied. */
  args?: string[];
  /** Optional env overrides for stdio transport. Catalog-supplied. */
  env?: Record<string, string>;
  /** Optional working directory for stdio transport. */
  cwd?: string;

  /**
   * OAuth / auth descriptor. When `type` is 'oauth' the connection is
   * (re)hydrated with an SDK OAuthClientProvider instead of static headers.
   * Mirrors `McpAuthConfig` from ./standard-config (kept structural to avoid a
   * circular import).
   */
  auth?: {
    type: 'none' | 'bearer' | 'oauth';
    scopes?: string[];
    issuer?: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
  };

  status: 'active' | 'inactive' | 'error';
  connectedAt?: string;
  connectorRef?: string;
  /** Legacy field; retained for back-compat with older mcp.yaml files. */
  serviceCommand?: string;
}

export interface McpSessionConfig {
  version: string;
  connections: McpConnectionEntry[];
}

const MCP_YAML_FILENAME = 'mcp.yaml';

function defaultConfig(): McpSessionConfig {
  return { version: '1.0', connections: [] };
}

/**
 * Normalise legacy values when reading from disk:
 * - 'sse' → 'http' (the SSE transport was deprecated in the 2025-03-26 spec).
 * - 'websocket' → dropped (entry is filtered out).
 */
function normaliseLoadedConfig(config: McpSessionConfig): McpSessionConfig {
  const connections = (config.connections ?? [])
    .filter((c) => (c.transport as string) !== 'websocket')
    .map((c) => ({ ...c, transport: c.transport === 'sse' ? 'http' as const : c.transport }));
  return { version: config.version ?? '1.0', connections };
}

export function loadSessionMcpConfig(sessionFolder: string): McpSessionConfig {
  const filePath = path.join(sessionFolder, MCP_YAML_FILENAME);
  if (!fs.existsSync(filePath)) {
    return defaultConfig();
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(raw) as McpSessionConfig | undefined;
    return parsed ? normaliseLoadedConfig(parsed) : defaultConfig();
  } catch {
    return defaultConfig();
  }
}

export function saveSessionMcpConfig(sessionFolder: string, config: McpSessionConfig): void {
  fs.mkdirSync(sessionFolder, { recursive: true });
  const filePath = path.join(sessionFolder, MCP_YAML_FILENAME);
  fs.writeFileSync(filePath, yaml.dump(config, { lineWidth: 120 }), 'utf8');
}

export function addConnectionToSession(sessionFolder: string, connection: McpConnectionEntry): void {
  const config = loadSessionMcpConfig(sessionFolder);
  const existing = config.connections.findIndex((c) => c.id === connection.id);
  if (existing >= 0) {
    config.connections[existing] = connection;
  } else {
    config.connections.push(connection);
  }
  saveSessionMcpConfig(sessionFolder, config);
}

export function removeConnectionFromSession(sessionFolder: string, connectionId: string): void {
  const config = loadSessionMcpConfig(sessionFolder);
  config.connections = config.connections.filter((c) => c.id !== connectionId);
  saveSessionMcpConfig(sessionFolder, config);
}

export function updateConnectionStatus(
  sessionFolder: string,
  connectionId: string,
  status: McpConnectionEntry['status'],
): void {
  const config = loadSessionMcpConfig(sessionFolder);
  const entry = config.connections.find((c) => c.id === connectionId);
  if (entry) {
    entry.status = status;
    if (status === 'active') {
      entry.connectedAt = new Date().toISOString();
    }
    saveSessionMcpConfig(sessionFolder, config);
  }
}
