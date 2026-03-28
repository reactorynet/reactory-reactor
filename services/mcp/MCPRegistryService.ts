import { 
  IMCPRegistryAdapter, 
  IMCPRegistrySearchResult, 
  MCPRegistryType 
} from '../../types/mcp.types';
import MCPRegistryModel from '../../models/MCPRegistry';
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
}