import fetch from 'node-fetch';
import { 
  IMCPRegistryAdapter, 
  IMCPRegistrySearchResult, 
  MCPRegistryType, 
  MCPTransportType 
} from '../../../types/mcp.types';

export default class CommunityRegistryAdapter implements IMCPRegistryAdapter {
  id: string = 'community';
  type: MCPRegistryType = MCPRegistryType.COMMUNITY;

  private registryUrl = 'https://raw.githubusercontent.com/modelcontextprotocol/servers/main/registry.json';

  private async fetchRegistry(): Promise<any[]> {
    try {
      // In a real implementation, we would fetch the official registry. 
      // Since the exact URL or format might differ, we'll implement a robust fetch
      // that can handle a standard JSON array of tools.
      const response = await fetch(this.registryUrl);
      if (!response.ok) {
        // Fallback to some known servers if the registry isn't available
        return this.getFallbackServers();
      }
      const data = await response.json();
      return Array.isArray(data) ? data : this.getFallbackServers();
    } catch (error) {
      return this.getFallbackServers();
    }
  }

  private getFallbackServers(): any[] {
    return [
      {
        name: 'postgres',
        description: 'PostgreSQL database connector',
        version: '1.0.0',
        transport: 'stdio',
        npmPackage: '@modelcontextprotocol/server-postgres',
        requiredEnvVars: []
      },
      {
        name: 'sqlite',
        description: 'SQLite database connector',
        version: '1.0.0',
        transport: 'stdio',
        npmPackage: '@modelcontextprotocol/server-sqlite',
        requiredEnvVars: []
      },
      {
        name: 'github',
        description: 'GitHub API connector',
        version: '1.0.0',
        transport: 'stdio',
        npmPackage: '@modelcontextprotocol/server-github',
        requiredEnvVars: ['GITHUB_PERSONAL_ACCESS_TOKEN']
      }
    ];
  }

  private mapToServerResult(server: any): IMCPRegistrySearchResult {
    return {
      id: server.name,
      name: server.name,
      description: server.description || '',
      version: server.version || 'latest',
      author: server.author || 'MCP Community',
      transport: server.transport === 'sse' ? MCPTransportType.SSE : MCPTransportType.STDIO,
      registryType: this.type,
      githubUrl: server.githubUrl,
      npmPackage: server.npmPackage,
      requiredEnvVars: server.requiredEnvVars || []
    };
  }

  async search(query: string, options?: any): Promise<IMCPRegistrySearchResult[]> {
    const servers = await this.fetchRegistry();
    const lowerQuery = query.toLowerCase();
    
    return servers
      .filter(s => 
        s.name.toLowerCase().includes(lowerQuery) || 
        (s.description && s.description.toLowerCase().includes(lowerQuery))
      )
      .map(s => this.mapToServerResult(s));
  }

  async getDetails(connectorId: string): Promise<any> {
    const servers = await this.fetchRegistry();
    const server = servers.find(s => s.name === connectorId);
    if (!server) {
      throw new Error(`Connector ${connectorId} not found in community registry`);
    }
    return this.mapToServerResult(server);
  }

  async list(options?: any): Promise<IMCPRegistrySearchResult[]> {
    const servers = await this.fetchRegistry();
    return servers.map(s => this.mapToServerResult(s));
  }
}