import {
  startServer as StartMCPService
} from '@reactory/server-modules/reactory-reactor/ai/mcp';

type ReactoryCliApp = (vargs: string[], context: Reactory.Server.IReactoryContext) => Promise<void>

const ReactoryMCPServerCliApp: Reactory.IReactoryComponentDefinition<ReactoryCliApp> = { 
  nameSpace: 'reactor',
  name: 'MCPServe',
  version: '1.0.0',
  description: `Reactory Reactor MCP Server CLI. Use this CLI to start the Reactory Reactor MCP Server.
  This CLI is powered by the Model Context Protocol SDK. You will need to have the Model Context Protocol SDK installed to use this CLI.`,
  component: StartMCPService,
  domain: 'cli',
  features: [{
    feature: 'mcp',
    featureType: 'ai',
    action: ["mcp", "server", "start", "run", "launch", "init", "begin", "start", "mcp-server"],
    description: 'Start the Reactory Reactor MCP Server',
    stem: 'mcp',
  }],
  overwrite: false,
  roles: ['USER'],
  stem: 'reactor',
  tags: ['reactor', 'cli', 'mcp', 'server', 'ai'],
  toString(includeVersion) {
    return includeVersion ? `${this.nameSpace}.${this.name}@${this.version}` : this.name;
  },
};

export default ReactoryMCPServerCliApp;