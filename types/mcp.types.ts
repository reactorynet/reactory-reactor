import { ObjectId } from 'mongodb';

export enum MCPTransportType {
  STDIO = 'stdio',
  SSE = 'sse',
  WEBSOCKET = 'websocket'
}

export enum MCPRegistryType {
  COMMUNITY = 'community',
  NPM = 'npm',
  GITHUB = 'github',
  CUSTOM = 'custom'
}

export interface IMCPRegistry {
  id: string | ObjectId;
  name: string;
  type: MCPRegistryType;
  url: string;
  description?: string;
  credentials?: {
    type: string;
    token?: string;
    username?: string;
    password?: string;
  };
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMCPConnectorConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface IMCPInstalledConnector {
  id: string | ObjectId;
  name: string;
  description?: string;
  registryId?: string | ObjectId;
  transport: MCPTransportType;
  config: IMCPConnectorConfig;
  status: 'active' | 'inactive' | 'error';
  version?: string;
  organizationId?: string | ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMCPRegistrySearchResult {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  transport: MCPTransportType;
  registryType: MCPRegistryType;
  githubUrl?: string;
  npmPackage?: string;
  requiredEnvVars?: string[];
}

export interface IMCPRegistryAdapter {
  id: string;
  type: MCPRegistryType;
  search(query: string, options?: any): Promise<IMCPRegistrySearchResult[]>;
  getDetails(connectorId: string): Promise<any>;
  list(options?: any): Promise<IMCPRegistrySearchResult[]>;
}