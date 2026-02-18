import { Response } from "express";
import { RPCResponse } from "../rpcUtils";
import Reactory from "@reactorynet/reactory-core";

export async function notificationsHeartbeat(req: Reactory.Server.ReactoryExpressRequest & { body: { id?: string } }, res: Response) {
  return RPCResponse(
    {
      heartbeat: Date.now()
    },
    req.body.id ?? null
  );
}

export default notificationsHeartbeat;