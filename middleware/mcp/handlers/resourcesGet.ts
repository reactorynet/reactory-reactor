import { Response } from "express";
import { RPCResponse, RPCError } from "../rpcUtils";
import Reactory from "@reactorynet/reactory-core";

export async function resourcesGet(req: Reactory.Server.ReactoryExpressRequest, res: Response) {
  console.log("[MCP] Getting resource...");
  const resourceId = req.body.params.resourceId;
  if (!resourceId) {
    return RPCError(
      -32602,
      "Invalid params: Missing resourceId",
      req.body.id
    );
  }
  return RPCResponse(
    {
      resource: {
        id: resourceId,
        name: "Sample Resource",
        type: "sample",
        data: {
          content: "This is a sample resource"
        }
      }
    },
    req.body.id
  );
}

export default resourcesGet;