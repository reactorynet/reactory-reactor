import { Response } from "express";
import { RPCResponse } from "../rpcUtils";
import Reactory from "@reactory/reactory-core";

export async function initialize(req: Reactory.Server.ReactoryExpressRequest, res: Response) {
  console.log("[MCP] Initializing MCP server...");
  return RPCResponse({
    protocolVersion: "2024-11-05",
    capabilities: {
      prompts: {},
      tools: {},
      resources: {}
    },
    serverInfo: {
      name: process.env.SERVER_ID || "Reactory MCP Server",
      version: "1.0.0",
      description: "MCP Server for Reactory"
    }
  }, req.body.id);
}

export default initialize;