import { Response } from "express";
import { RPCResponse } from "../rpcUtils";
import Reactory from "@reactory/reactory-core";

export async function resourcesList(req: Reactory.Server.ReactoryExpressRequest, res: Response) {
  console.log("[MCP] Listing resources...");
  return RPCResponse({
      resources: [],
      count: 0
    }, req.body.id);
}


export default resourcesList;