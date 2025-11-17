import { Response } from "express";
import { RPCResponse } from "../rpcUtils";
import Reactory from "@reactory/reactory-core";
import { LATEST_PROTOCOL_VERSION, InitializeRequest, JSONRPCRequest } from "../types";

export async function initialize(req: Reactory.Server.ReactoryExpressRequest & { body: InitializeRequest & JSONRPCRequest }, res: Response) {
  const { context } = req;
  context.log("[MCP] Initializing MCP server...", null, 'initialize');
  
  try {
    const { protocolVersion, capabilities, clientInfo } = req.body.params || {};
    
    // Validate protocol version
    if (!protocolVersion) {
      return RPCResponse({
        error: "Missing protocolVersion parameter"
      }, req.body.id);
    }

    // Use the latest supported version or client's version if compatible
    const supportedVersion = LATEST_PROTOCOL_VERSION;
    
    return RPCResponse({
      protocolVersion: supportedVersion,
      capabilities: {
        prompts: {
          listChanged: true
        },
        tools: {
          listChanged: true
        },
        resources: {
          listChanged: true,
          subscribe: true
        },
        logging: {},
        experimental: {
          "reactor.extensions": {
            description: "Reactor-specific extensions for enhanced functionality"
          }
        }
      },
      serverInfo: {
        name: process.env.SERVER_ID || "Reactory MCP Server",
        version: "1.0.0"
      },
      instructions: `Reactory MCP Server provides access to Reactor's AI capabilities, tools, and resources.

Available features:
- Tool execution through Reactor macros
- Resource access and management
- Prompt templates and management
- Real-time notifications and progress updates

The server supports the latest MCP protocol version and provides enhanced capabilities for AI-powered development workflows.`
    }, req.body.id);
  } catch (error) {
    context.error("[MCP] Error in initialize", error, 'initialize');
    return RPCResponse({
      error: "Initialization failed"
    }, req.body.id);
  }
}

export default initialize;