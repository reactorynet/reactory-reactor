import { Response } from "express";
import { RPCResponse } from "../rpcUtils";
import Reactory from "@reactory/reactory-core";

export async function promptsList(req: Reactory.Server.ReactoryExpressRequest, res: Response) {
  return RPCResponse(
    {
      prompts: [],
      count: 0
    },
    req.body.id
  );
}

export default promptsList;