import { Response } from "express";
import { RPCResponse, RPCError } from "../rpcUtils";
import Reactory from "@reactory/reactory-core";

export async function notificationsError(req: Reactory.Server.ReactoryExpressRequest, res: Response) {
  console.log("[MCP] Error notification...");
  const error = req.body.params.error;
  if (!error) {
    return RPCError(
      -32602,
      "Invalid params: Missing error",
      req.body.id
    );
  }
  return RPCResponse(
    {
      error: error
    },
    req.body.id
  );
}

export default notificationsError;