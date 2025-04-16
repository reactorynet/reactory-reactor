
import { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
  CallToolRequestSchema,
  JSONRPCMessage,
  ListResourcesRequestSchema,  
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import logger from '@reactory/server-core/logging';

const DEBUG_PROMPTS = [{
  name: "example-prompt",
  description: "An example prompt template",
  arguments: [{
    name: "arg1",
    description: "Example argument",
    required: true
  }]
}];

const DEBUG_TOOLS = [{
  name: "example-tool",
  description: "An example tool",
  parameters: {
    type: "object",
    properties: {
      arg1: {
        type: "string",
        description: "Example argument"
      }
    }
  }
}];


const DEBUG_RESOURCES = [{
  name: "example-resource",
  description: "An example resource",
  type: "example-type"
}];

export const SDKServer = () => {
  const connections: { [sessionId: string]: { transport: SSEServerTransport, res: Response }} = {};
  const server = new Server(
    {
      name: "reactory-mcp-server",
      version: "2.0"
    },
    {
      capabilities: {
        prompts: {},
        tools: {},
        resources: {}
      }
    }
  );

  const prompts = [...DEBUG_PROMPTS];
  const tools = [...DEBUG_TOOLS];
  const resources = [...DEBUG_RESOURCES];

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts,
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== "example-prompt") {
      throw new Error("Unknown prompt");
    }
    return {
      description: "Example prompt",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Example prompt text"
        }
      }]
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools,
    };
  });

  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    logger.debug(`Initializing MCP server with request: ${JSON.stringify(request)}`);
    return {
      capabilities: {
        prompts,
        tools,
        resources
      }
    };
  });

  server.oninitialized = () => {
    logger.info('MCP server initialized');
  };

  return {
    handleSSE: async (req: Request, res: Response) => { 
      console.log("New SSE connection.");
      const transport = new SSEServerTransport('/reactory-mcp/messages', res)
      connections[req.query.sessionId as string] = { transport, res };      
      await server.connect(transport);
      const _onMsg = transport.onmessage; // original hook
      const _onClose = transport.onclose;
      const _onErr = transport.onerror;
      transport.onmessage = (msg: any) => {
        console.log(msg);
        if (_onMsg) _onMsg(msg);
      };
      transport.onclose = () => {
        console.log("Transport closed.");
        if (_onClose) _onClose();
      };
      transport.onerror = (err) => {
        console.error(err);
        if (_onErr) _onErr(err);
      };
      server.onclose = async () => {
        //clearInterval(updateInterval);
        await server.close();
        console.log("SSE connection closed.");
      };
    },
    handleMessage: async (req: Request, res: Response) => { 
      console.log("--> Received message (post)");
      if(req.query.sessionId) {
        const sessionId = req.query.sessionId as string;
        const connection = connections[sessionId];
        if (!connection) {
          console.error("No connection found for sessionId:", sessionId);
          return res.status(404).json({ error: "No connection found for sessionId" });
        }
        const transport = connection.transport;
        const message: JSONRPCMessage = req.body;
        if (message.jsonrpc !== "2.0" || !message.method) {
          return res.status(400).json({
            error: {
              code: -32600,
              message: "Invalid JSON-RPC request"
            }
          });
        }
        console.log("Sending message to transport:", message);
        transport.send(message);
        res.status(200).json({
          jsonrpc: "2.0",
          id: message.id,
          result: { ack: `Received ${message.method}` }
        });
      } else {
        console.error("No sessionId provided in query.");
        return res.status(400).json({ error: "Missing sessionId in query" });
      }
      console.log("<--", res.statusCode, res.statusMessage);
    }
  }
}

export default SDKServer;