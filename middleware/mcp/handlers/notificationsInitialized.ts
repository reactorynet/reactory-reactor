import { Response } from "express";
import type { Reactory } from "@reactory/server-core/types";
import Reactory from "@reactory/reactory-core";

export async function notificationsInitialized(req: Reactory.Server.ReactoryExpressRequest, res: Response): Promise<null> {
  // do nothing.
  return null;
}

export default notificationsInitialized;