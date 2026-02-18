import { Response } from "express";
import { RPCResponse, RPCError } from "../rpcUtils";
import Reactory from "@reactorynet/reactory-core";

export async function notificationsClose(
  req: Reactory.Server.ReactoryExpressRequest & { body: { id?: string; params?: { sessionId?: string } } }, 
  res: Response, 
  sessions: Map<string, { initialized: boolean, sseRes: Response }>) {
  req.context.log("[MCP] Closing connection...");
  const sessionId = req.body.params?.sessionId;
  if (!sessionId) {
    return RPCError(
      -32602,
      "Invalid params: Missing sessionId",
      req.body.id ?? null
    );
  }
  const sessionData = sessions.get(sessionId);
  if (!sessionData) {
    return RPCError(
      -32602,
      "Invalid params: Session not found",
      req.body.id ?? null
    );
  }
  
  // Properly close the SSE connection
  try {
    sessionData.sseRes.end();
  } catch (error) {
    req.context.warn("[MCP] Error closing SSE connection", { sessionId, error }, "notificationsClose");
  }
  
  sessions.delete(sessionId);
  req.context.log("[MCP] Session closed successfully", { sessionId }, "notificationsClose");
  return RPCResponse({ closed: true }, req.body.id ?? null);
}

export default notificationsClose;