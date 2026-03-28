import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export interface McpConnectionEntry {
  id: string;
  serverName: string;
  description?: string;
  url?: string;
  transport: 'sse' | 'stdio' | 'websocket';
  serviceCommand?: string;
  headers?: Record<string, string>;
  status: 'active' | 'inactive' | 'error';
  connectedAt?: string;
  connectorRef?: string;
}

export interface McpSessionConfig {
  version: string;
  connections: McpConnectionEntry[];
}

const MCP_YAML_FILENAME = 'mcp.yaml';

function defaultConfig(): McpSessionConfig {
  return { version: '1.0', connections: [] };
}

export function loadSessionMcpConfig(sessionFolder: string): McpSessionConfig {
  const filePath = path.join(sessionFolder, MCP_YAML_FILENAME);
  if (!fs.existsSync(filePath)) {
    return defaultConfig();
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(raw) as McpSessionConfig | undefined;
    return parsed ?? defaultConfig();
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
