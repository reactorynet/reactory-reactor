import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { 
  InitializedNotification,
  InitializedNotificationSchema,
  InitializeRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import Reactory from "@reactorynet/reactory-core";
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

    const clientCount = state.mcpClients?.length || 0;
    const availableCommands = 'capabilities, prompts, tools, resources, add-connection, connect, disconnect, connections, call-tool';

    // Map command to appropriate handler
    switch (command) {
      case 'capabilities': {
        const result = await getCapabilities(id ? [id] : [], state);
        return {
          success: !result?.error,
          data: result,
          instructions: result?.error
            ? `## MCP Capabilities \u2014 Error\n\n${result.error}\n\n### Recovery Options:\n- Use \`mcp\` with command="connections" to verify available clients\n- Ensure the client is connected first with command="connect"`
            : `## MCP Server Capabilities\n\nRetrieved capabilities for ${id || 'all'} client(s).\n\n### Suggested Next Steps:\n- Use \`mcp\` with command="tools" to list available tools\n- Use \`mcp\` with command="prompts" to list available prompts\n- Use \`mcp\` with command="resources" to list resources`
        };
      }
      case 'prompts': {
        const result = await getPrompts(id ? [id] : [], state);
        return {
          success: !result?.error,
          data: result,
          instructions: result?.error
            ? `## MCP Prompts \u2014 Error\n\n${result.error}\n\n### Recovery Options:\n- Verify client is connected with \`mcp\` command="connections"`
            : `## MCP Prompts\n\nRetrieved prompts for ${id || 'all'} client(s).\n\n### Suggested Next Steps:\n- Use \`mcp\` with command="tools" to list tools\n- Use \`mcp\` with command="call-tool" to execute a tool`
        };
      }
      case 'tools': {
        const result = await getTools(id ? [id, format] : [format], state);
        const hasError = typeof result === 'object' && result?.error;
        return {
          success: !hasError,
          data: result,
          instructions: hasError
            ? `## MCP Tools \u2014 Error\n\n${result.error}\n\n### Recovery Options:\n- Use \`mcp\` command="connections" to check available clients\n- Use \`mcp\` command="connect" to establish a connection first`
            : `## MCP Tools\n\nRetrieved tool list for ${id || 'default'} client.\n\n### Suggested Next Steps:\n- Use \`mcp\` with command="call-tool", id="<client_id>", toolName="<tool_name>" to execute a tool\n- Use format="json" for machine-readable output`
        };
      }
      case 'resources': {
        const result = await getResources(id ? [id] : [], state);
        return {
          success: !result?.error,
          data: result,
          instructions: result?.error
            ? `## MCP Resources \u2014 Error\n\n${result.error}`
            : `## MCP Resources\n\nRetrieved resources for ${id || 'all'} client(s).`
        };
      }
      case 'add-connection': {
        if (!id || !url) {
          return {
            success: false,
            error: 'Missing required parameters: id and url',
            instructions: `## MCP Add Connection \u2014 Missing Parameters\n\nBoth **id** and **url** are required.\n\n### Usage:\n- command="add-connection", id="my-server", url="http://localhost:3001/sse"\n- Optional: transport="sse" (default), "stdio", or "websocket"`
          };
        }
        const result = await addConnection([id, url, transport], state);
        const hasError = typeof result === 'object' && result?.error;
        return {
          success: !hasError,
          data: result,
          instructions: hasError
            ? `## MCP Add Connection \u2014 Error\n\n${result.error}\n\n### Recovery Options:\n- Verify the URL is correct and the MCP server is running\n- Check the transport type (sse, stdio, websocket)`
            : `## MCP Connection Added\n\nConnection **${id}** registered (${url}, transport: ${transport}).\n\n### Suggested Next Steps:\n- Use \`mcp\` with command="connect", id="<connection_id>" to establish the connection\n- Use \`mcp\` with command="connections" to list all registered connections`
        };
      }
      case 'connect': {
        if (!id) {
          return {
            success: false,
            error: 'Missing required parameter: id',
            instructions: `## MCP Connect \u2014 Missing ID\n\nA client **id** is required.\n\n### Recovery Options:\n- Use \`mcp\` with command="connections" to list available client IDs\n- Use \`mcp\` with command="add-connection" to register a new connection first`
          };
        }
        const result = await connectClient([id], state);
        const hasError = typeof result === 'object' && result?.error;
        return {
          success: !hasError,
          data: result,
          instructions: hasError
            ? `## MCP Connect \u2014 Error\n\n${typeof result === 'object' ? result.error : result}\n\n### Recovery Options:\n- Verify the MCP server is running at the configured URL\n- Check the transport configuration\n- Use \`mcp\` command="connections" to verify client registration`
            : `## MCP Client Connected\n\n${typeof result === 'string' ? result : `Connected to client ${id}.`}\n\n### Suggested Next Steps:\n- Use \`mcp\` with command="tools", id="${id}" to discover available tools\n- Use \`mcp\` with command="call-tool" to execute a tool`
        };
      }
      case 'disconnect': {
        if (!id) {
          return {
            success: false,
            error: 'Missing required parameter: id',
            instructions: `## MCP Disconnect \u2014 Missing ID\n\nA client **id** is required.\n\n### Recovery Options:\n- Use \`mcp\` with command="connections" to find client IDs`
          };
        }
        const result = await disconnectClient([id], state);
        const hasError = typeof result === 'string' && result.startsWith('Failed');
        return {
          success: !hasError,
          data: result,
          instructions: hasError
            ? `## MCP Disconnect \u2014 Error\n\n${result}\n\n### Recovery Options:\n- Use \`mcp\` command="connections" to verify the client exists`
            : `## MCP Client Disconnected\n\nDisconnected from **${id}**.\n\n### Suggested Next Steps:\n- Use \`mcp\` with command="connect", id="${id}" to reconnect\n- Use \`mcp\` with command="connections" to see remaining connections`
        };
      }
      case 'call-tool': {
        if (!id || !toolName) {
          return {
            success: false,
            error: 'Missing required parameters: id and toolName',
            instructions: `## MCP Call Tool \u2014 Missing Parameters\n\nBoth **id** (client) and **toolName** are required.\n\n### Usage:\n- command="call-tool", id="<client_id>", toolName="<tool_name>", toolParams=["arg1", "arg2"]\n\n### Recovery Options:\n- Use \`mcp\` with command="tools", id="<client_id>" to list available tool names`
          };
        }
        const result = await callTool([id, toolName, ...toolParams], state);
        const hasError = typeof result === 'object' && result?.error;
        return {
          success: !hasError,
          data: result,
          instructions: hasError
            ? `## MCP Call Tool \u2014 Error\n\n${result.error}\n\n### Recovery Options:\n- Verify the tool name with \`mcp\` command="tools"\n- Check the client is connected with \`mcp\` command="connections"\n- Review toolParams format`
            : `## MCP Tool Executed\n\nTool **${toolName}** on client **${id}** returned successfully.\n\n### Suggested Next Steps:\n- Inspect the returned data\n- Call another tool if needed\n- Use \`var\` to store the result for later use`
        };
      }
      case 'connections':
      default: {
        const result = await listConnections([], state);
        const hasError = typeof result === 'object' && result?.error;
        return {
          success: !hasError,
          data: result,
          instructions: hasError
            ? `## MCP Connections \u2014 Error\n\n${result.error}`
            : `## MCP Connections (${clientCount})\n\n${clientCount === 0 ? 'No connections registered.' : `${clientCount} connection(s) available.`}\n\n### Suggested Next Steps:\n${clientCount === 0 ? '- Use \\`mcp\\` with command="add-connection", id="name", url="http://..." to add one' : '- Use \\`mcp\\` with command="connect", id="<client_id>" to establish a connection\\n- Use \\`mcp\\` with command="tools" to discover available tools'}\n\n### Available Commands:\n${availableCommands}`
        };
      }
    }
  } catch (error) {
    console.error(`Error in MCP CLI: ${error instanceof Error ? error.message : 'Unknown error'}`, error);
    return {
      success: false,
      error: `An error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`,
      instructions: `## MCP Error\n\n${error instanceof Error ? error.message : 'Unknown error'}\n\n### Recovery Options:\n- Use \`mcp\` with command="connections" to check client state\n- Verify the MCP server is running and accessible`
    };
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