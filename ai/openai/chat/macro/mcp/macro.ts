import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { 
  InitializedNotification,
  InitializedNotificationSchema,
  InitializeRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import Reactory from "@reactory/reactory-core";
import { URL } from "url";
import uuid from "uuid";
import { McpCliProps } from './types';

// Command handler functions
const getCapabilities = async (params: string[], state: ChatState): Promise<unknown> => {
  const { mcpClients } = state;
  try {
    return mcpClients.map((client) => client.client.getServerCapabilities());
  } catch (error) {
    return { error: `Failed to get capabilities: ${error.message}` };
  }
};

const getPrompts = async (params: string[], state: ChatState): Promise<unknown> => {
  const { mcpClients } = state;
  try {
    return mcpClients.map((client) => client.client.listPrompts());
  } catch (error) {
    return { error: `Failed to get prompts: ${error.message}` };
  }
};

const getTools = async (params: string[], state: ChatState): Promise<unknown> => {
  const { mcpClients } = state;
  const [ id, format = 'text' ] = params;
  try {
    
    if (mcpClients.length === 0) { 
      return format === 'json' ? JSON.stringify({ error: 'No MCP Clients found' }) : 'Error: No MCP Clients found - please add a connection';
    }

    let client = mcpClients[0];
    if (id) {
      client = mcpClients.find((client) => client.id === id.trim());
      if (!client) {
        return format === 'json' ? JSON.stringify({ error: `No client found with id: ${id}` }) : `Error: No client found with id: ${id}`;
      }
    }
    const tools = await client.client.listTools();
    
    if (tools?.count === 0) {
      return format === 'json' ? JSON.stringify({ error: 'No tools found' }) : 'Error: No tools found';
    }
    
    switch (format) { 
      case 'json':
        return JSON.stringify(tools, null, 2);
      case 'text':
      default:
        const toolText = tools.tools.map((tool) => {
          return `Tool: ${tool.name}\nDescription: ${tool.description}\n\n`;
        })
        return `Tools for client ${client.name} (${client.id}):\n\n${toolText}`;
    }
  } catch (error) {
    return { error: `Failed to get tools: ${error.message}` };
  }
};

const getResources = async (params: string[], state: ChatState): Promise<unknown> => {
  const { mcpClients } = state;
  try {
    return mcpClients.map((client) => client.client.listResources());
  } catch (error) {
    return { error: `Failed to get resources: ${error.message}` };
  }
};

const addConnection = async (params: string[], state: ChatState): Promise<unknown> => {
  try {
    const [id, url, transport = 'sse'] = params;
    const { mcpClients } = state;
    
    if (!id || !url) {
      return "Missing required parameters. Usage: @mcpcli(add-connection, id, url, [transport])";
    }

    const client = new Client({
      name: id,
      version: '1.0.0',        
    });
    
    // Create actual URL object with proper URL and ensure trailing slash for base URL
    const baseUrl = url.endsWith('/') ? url : `${url}/`;
    const sseTransport = new SSEClientTransport(new URL(baseUrl));
    
    // Add request options to handle auth if needed
    sseTransport.requestInit = {
      credentials: 'include',
      headers: {
        'Authorization': state.auth?.token ? `Bearer ${state.auth.token}` : '',
        'x-client-key': state.clientKey || '',
        'x-client-pwd': state.clientSecret || ''
      }
    };
    
    mcpClients.push({
      id: uuid.v4(),
      client,
      name: id,
      description: `MCP Client for ${id}`,  
      transports: {
        sse: sseTransport
      }
    });
    
    return `Added connection ${id} with url ${url}`;
  } catch (error) {
    return { error: `Failed to add connection: ${error.message}` };
  }
};

// Command handler function for calling a tool
const callTool = async (params: string[], state: ChatState): Promise<unknown> => { 
  try {
    const [id, toolName, ...toolParams] = params;
    const { mcpClients } = state;

    if (!id || !toolName) {
      return "Missing required parameters. Usage: @mcp(call-tool, id, toolName, [params])";
    }

    const client = mcpClients.find((client) => client.id === id.trim());
    if (!client) {
      return `No client found with id: ${id}`;
    }

    const tools = await client.client.listTools();
    const tool = tools.find((tool) => tool.name === toolName);
    if (!tool) {
      return `No tool found with name: ${toolName}`;
    }

    const result = await client.client.callTool(toolName, ...toolParams);
    return result;
  } catch (error) {
    return { error: `Failed to call tool: ${error.message}` };
  }
}

const connectClient = async (params: string[], state: ChatState): Promise<unknown> => {
  try {
    const [id] = params;
    const { mcpClients, context } = state;
    
    if (!id) return 'No id provided, please use @mcp(connect, id)';
    
    const mcpClientDefinition = mcpClients.find((client) => client.id === id.trim());
    if (!mcpClientDefinition) {
      return `No client found with id: ${id}`;
    }

    const { client, transports } = mcpClientDefinition;
    
    if (!transports) {
      return `No transports found for client: ${id}`;
    }

    let transport = null;
    if (transports.sse) {
      const sseTransport = transports.sse;
      sseTransport.eventSourceInit = {
        ...sseTransport.eventSourceInit,
        withCredentials: true
      };
      
      sseTransport.requestInit = {
        ...sseTransport.requestInit,
      }

      transport = sseTransport;      
    }

    if (transports.stdio) {
      transport = transports.stdio;
    }

    if (transports.websocket) {
      transport = transports.websocket;
    }

    if (!transport) {
      return `No transport found for client: ${id}`;
    }

    if (client.transport) {
      try { 
        client.transport.close();
        // Give the connection time to close properly
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) { 
        console.error(`Error closing transport: ${err.message}`);
      }
    }

    try {
      // on connect the client sends an initializer message.
      let transportInstance = new SSEClientTransport(transport.url, {
        eventSourceInit: transport?.eventSourceInit,
        requestInit: transport.requestInit,
      });

      transportInstance.onmessage = (message) => { 
        context.log(`Client ${mcpClientDefinition.id} message: ${message.data}`);
        // Handle the message
        const parsedMessage = JSON.parse(message.data);
      };

      client.onclose = () => {
        context.log(`Client ${mcpClientDefinition.id} closed`);
        if (client.transport) {
          client.transport.close();
        }
      }


      client.onerror = (error) => {
        context.log(`Client ${mcpClientDefinition.id} error: ${error.message}`);
        if (client.transport) {
          client.transport.close();
        }      
      }

      client.setNotificationHandler(InitializedNotificationSchema, (notification) => { 
        context.log(`Client ${mcpClientDefinition.id} initialized: ${notification}`);
        // Handle the initialized notification
        return notification;
      });

      client.setRequestHandler(InitializeRequestSchema, async (request) => { 
        context.log(`Client ${mcpClientDefinition.id} initialize request: ${request}`);
        // Handle the initialize request
        return {
          id: mcpClientDefinition.id,
          name: mcpClientDefinition.name,
          description: mcpClientDefinition.description
        };
      });

      await mcpClientDefinition.client.connect(transportInstance);
      console.log(`Connected to ${mcpClientDefinition.id} with transport: ${transport.type}`);
      // Wait a moment for the connection to fully establish
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      console.log(`Getting capabilities for ${mcpClientDefinition.id}`);
      // Get the server capabilities
      const capabilities = await mcpClientDefinition.client.getServerCapabilities();
      const toolsList = await mcpClientDefinition.client.listTools();
      const promptsList = await mcpClientDefinition.client.listPrompts();
      const resourcesList = await mcpClientDefinition.client.listResources();
      const capabilitiesText = `Connected to ${capabilities?.serverInfo?.name || 'unknown'}: 
        Server capabilities:
          - tools: ${toolsList?.tools?.length || 0} tools
          - prompts: ${promptsList?.prompts || 0} prompts
          - resources: ${resourcesList?.resources?.length || 0} resources

        Call @mcp(capabilities, ${mcpClientDefinition.id}) to get the capabilities of the client
        Call @mcp(prompts, ${mcpClientDefinition.id}) to get the prompts of the client
        Call @mcp(tools, ${mcpClientDefinition.id}) to get the tools of the client
        Call @mcp(resources, ${mcpClientDefinition.id}) to get the resources of the client
        Call @mcp(disconnect, ${mcpClientDefinition.id}) to disconnect from the client
        Call @mcp(exec, toolName, args, ${mcpClientDefinition.id}) to execute a tool        
        `;

      return capabilitiesText;
    } catch (error) {
      console.error(`Error connecting to MCP: ${error.message}`, error);
      return `Error connecting to ${mcpClientDefinition.id}: ${error.message}`;
    }
  } catch (error) {
    return { error: `Connection error: ${error.message}` };
  }
};

const disconnectClient = async (params: string[], state: ChatState): Promise<unknown> => {
  try {
    const [id] = params;
    const { mcpClients } = state;

    if (!id) return 'No id provided, please use @mcp(disconnect, id)';
    
    const client = mcpClients.find((client) => client.id === id.trim());
    if (!client) {
      return `No client found with id: ${id}`;
    }

    const { transports } = client;

    if (!transports) {
      return `No transports found for client: ${id}`;
    }

    client.client.transport.close();

    return `Disconnected from ${client.id}`;
  } catch (error) {
    return `Failed to disconnect: ${error.message}`;
  }
};

const listConnections = async (params: string[], state: ChatState): Promise<unknown> => {
  try {
    const { 
      mcpClients = []
    } = state;
    
    const connections = mcpClients.map((client) => ({
      id: client.id,
      name: client.name,
      description: client.description 
    }));

    if (connections.length === 0) { 
      return `No connections found`;
    } else {
      return `
      Found ${connections.length} connections:
      ${connections.map((client) => { return `- ${client.name} (${client.id}): ${client.description}` }).join('\n')}
      Call @mcp(connect, ${connections[0].id}) to connect to the first client or any of the other mcp utilities      
      `;
    }
  } catch (error) {
    return { error: `Failed to list connections: ${error.message}` };
  }
};

// Command map
const commandHandlers: Record<string, (params: string[], state: ChatState) => Promise<unknown>> = {
  'capabilities': getCapabilities,
  'prompts': getPrompts,
  'tools': getTools,
  'resources': getResources,
  'add-connection': addConnection,
  'connect': connectClient,
  'disconnect': disconnectClient,
  'connections': listConnections,
};

export const McpCli: Macro<unknown, McpCliProps> = async (
  props: McpCliProps,
  state: ChatState
): Promise<unknown> => {
  try {
    const { 
      command = 'connections', 
      id, 
      url, 
      transport = 'sse', 
      toolName, 
      toolParams = [], 
      format = 'text' 
    } = props;

    // Map command to appropriate handler
    switch (command) {
      case 'capabilities':
        return getCapabilities(id ? [id] : [], state);
      case 'prompts':
        return getPrompts(id ? [id] : [], state);
      case 'tools':
        return getTools(id ? [id, format] : [format], state);
      case 'resources':
        return getResources(id ? [id] : [], state);
      case 'add-connection':
        if (!id || !url) {
          return "Missing required parameters. Usage requires id and url";
        }
        return addConnection([id, url, transport], state);
      case 'connect':
        if (!id) {
          return "Missing required parameter: id";
        }
        return connectClient([id], state);
      case 'disconnect':
        if (!id) {
          return "Missing required parameter: id";
        }
        return disconnectClient([id], state);
      case 'call-tool':
        if (!id || !toolName) {
          return "Missing required parameters: id and toolName";
        }
        return callTool([id, toolName, ...toolParams], state);
      case 'connections':
      default:
        return listConnections([], state);
    }
  } catch (error) {
    console.error(`Error in MCP CLI: ${error instanceof Error ? error.message : 'Unknown error'}`, error);
    return JSON.stringify({ 
      error: `An error occurred while executing the command: ${error instanceof Error ? error.message : 'Unknown error'}` 
    });
  }
};

export const McpClientMacroRegistry: MacroComponentDefinition<typeof McpCli> = {

  nameSpace: 'reactor-macros',
  name: 'mcp',
  version: '1.0.0',
  component: McpCli,
  description: `# MCP Client Macro
  Use this macro to interact with the Model Context Protocol Clients

  ## Usage
  @mcp(capabilities, id) - returns a json object with the capabilities of the MCP Client
  @mcp(prompts, id) - returns a json object with the prompts of the MCP Client
  @mcp(tools, id) - returns a json object with the tools of the MCP Client
  @mcp(resources, id) - returns a json object with the resources of the MCP Client
  @mcp(connect, url) - returns a json object with the connection status of the MCP Client
  @mcp(disconnect, id) - returns a json object with the disconnection status of the MCP Client
  @mcp(connections) - returns a json object with the connections of the MCP Client
  `,
  features: [{
    feature: 'capabilities',
    featureType: Reactory.FeatureType.function,
    action: ['get', 'fetch', 'retrieve'],
  }],
  stem: 'mcp',
  tags: ['mcp', 'chat', 'session', 'context'],
  roles: ['USER'],
  tools: [{
    type: "function",
    function: {
      name: "mcp",
      description: `MCP Client Macro that allows you to interact with the Model Context Protocol Clients`,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: ["capabilities", "prompts", "tools", "resources", "add-connection", "connect", "disconnect", "connections", "call-tool"],
            description: "The MCP command to execute"
          },
          id: {
            type: "string",
            description: "Client ID for operations that require it"
          },
          url: {
            type: "string",
            description: "URL for connection operations"
          },
          transport: {
            type: "string",
            enum: ["sse", "stdio", "websocket"],
            description: "Transport type for connections"
          },
          toolName: {
            type: "string",
            description: "Tool name for tool execution"
          },
          toolParams: {
            type: "array",
            items: { type: "string" },
            description: "Additional parameters for tool execution"
          },
          format: {
            type: "string",
            enum: ["json", "text"],
            description: "Response format"
          }
        },
        required: ["command"]
      }
    }
  }]
}