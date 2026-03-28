import { MCPRegistryType } from '../../types/mcp.types';

export default {
  Query: {
    mcpRegistries: async (parent: any, args: any, context: any) => {
      const service = context.reactory.getService('reactory.MCPRegistryService@1.0.0');
      return service.getRegistries();
    },
    mcpRegistrySearch: async (parent: any, { query }: { query: string }, context: any) => {
      const service = context.reactory.getService('reactory.MCPRegistryService@1.0.0');
      return service.search(query);
    },
    mcpRegistryList: async (parent: any, { type }: { type?: string }, context: any) => {
      const service = context.reactory.getService('reactory.MCPRegistryService@1.0.0');
      return service.list(type as MCPRegistryType);
    },
    mcpRegistryConnectorDetails: async (parent: any, { connectorId, type }: { connectorId: string, type: string }, context: any) => {
      const service = context.reactory.getService('reactory.MCPRegistryService@1.0.0');
      return service.getDetails(connectorId, type as MCPRegistryType);
    }
  },
  Mutation: {
    installMCPConnector: async (parent: any, { input }: any, context: any) => {
      const service = context.reactory.getService('reactory.MCPRegistryService@1.0.0');
      const envMap: Record<string, string> = {};
      if (input.env) {
        input.env.forEach((e: any) => {
          envMap[e.key] = e.value;
        });
      }
      return service.installConnector(
        input.registryType as MCPRegistryType,
        input.connectorId,
        input.organizationId,
        envMap
      );
    }
  }
};