import { execSync } from 'child_process';
import { 
  IMCPRegistryAdapter, 
  IMCPRegistrySearchResult, 
  MCPRegistryType,
  MCPTransportType,
  IMCPInstalledConnectorDocument
} from '../../types/mcp.types';
import MCPRegistryModel from '../../models/MCPRegistry';
import MCPInstalledConnectorModel from '../../models/MCPInstalledConnector';
import CommunityRegistryAdapter from './adapters/CommunityRegistryAdapter';

export default class MCPRegistryService {
  name: string = 'MCPRegistryService';
  nameSpace: string = 'reactory';
  version: string = '1.0.0';

  private adapters: Map<MCPRegistryType, IMCPRegistryAdapter> = new Map();

  constructor() {
    this.registerAdapter(new CommunityRegistryAdapter());
  }

  registerAdapter(adapter: IMCPRegistryAdapter) {
    this.adapters.set(adapter.type, adapter);
  }

  getAdapter(type: MCPRegistryType): IMCPRegistryAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`No adapter found for registry type: ${type}`);
    }
    return adapter;
  }

  async search(query: string): Promise<IMCPRegistrySearchResult[]> {
    // Search across all registered adapters
    const results: IMCPRegistrySearchResult[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        const adapterResults = await adapter.search(query);
        results.push(...adapterResults);
      } catch (error) {
        console.error(`Error searching registry ${adapter.type}:`, error);
      }
    }
    return results;
  }

  async list(type?: MCPRegistryType): Promise<IMCPRegistrySearchResult[]> {
    if (type) {
      const adapter = this.getAdapter(type);
      return adapter.list();
    }

    const results: IMCPRegistrySearchResult[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        const adapterResults = await adapter.list();
        results.push(...adapterResults);
      } catch (error) {
        console.error(`Error listing registry ${adapter.type}:`, error);
      }
    }
    return results;
  }

  async getDetails(connectorId: string, type: MCPRegistryType): Promise<any> {
    const adapter = this.getAdapter(type);
    return adapter.getDetails(connectorId);
  }

  // Database operations for custom registries
  async getRegistries() {
    return MCPRegistryModel.find({ enabled: true });
  }

  async addRegistry(registryData: any) {
    const registry = new MCPRegistryModel(registryData);
    return registry.save();
  }

  async installConnector(
    registryType: MCPRegistryType,
    connectorId: string,
    organizationId: string,
    envConfig: Record<string, string> = {}
  ): Promise<IMCPInstalledConnectorDocument> {
    const adapter = this.getAdapter(registryType);
    const details = await adapter.getDetails(connectorId);

    if (!details) {
      throw new Error(`Connector ${connectorId} not found in registry ${registryType}`);
    }

    // Validate required environment variables
    if (details.requiredEnvVars && details.requiredEnvVars.length > 0) {
      for (const envVar of details.requiredEnvVars) {
        if (!envConfig[envVar] && !process.env[envVar]) {
          throw new Error(`Missing required environment variable: ${envVar}`);
        }
      }
    }

    // Validate runtime for stdio
    if (details.transport === MCPTransportType.STDIO) {
      this.validateRuntime(details);
    }

    // Determine command and args based on registry type / details
    let command = 'unknown';
    let args: string[] = [];

    if (details.npmPackage) {
      command = 'npx';
      args = ['-y', details.npmPackage];
    } else if (details.githubUrl) {
      // Placeholder for other runtimes like uvx for python, etc.
      command = 'unknown';
    }

    // Create installed connector record
    const installedConnector = new MCPInstalledConnectorModel({
      name: details.name,
      description: details.description,
      transport: details.transport,
      config: {
        command,
        args,
        env: envConfig,
      },
      version: details.version,
      organizationId,
      status: 'active'
    });

    return installedConnector.save();
  }

  private validateRuntime(details: IMCPRegistrySearchResult) {
    try {
      if (details.npmPackage) {
        // Check if npx is available
        execSync('npx --version', { stdio: 'ignore' });
      }
      // Future: Add checks for Python (uvx), Docker, etc., if specified in details
    } catch (error) {
      throw new Error(`Required runtime for ${details.name} is not available on the host system.`);
    }
  }
}