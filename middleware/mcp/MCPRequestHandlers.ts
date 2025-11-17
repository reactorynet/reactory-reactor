import { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import SDKServer from './SDKServer';
import ReactorServer from './ReactorServer';

const sseServer = ReactorServer();


const handleSSERequest = (req: Reactory.Server.ReactoryExpressRequest, res: Response) => {
  return sseServer.handleSSE(req, res);
};

const handeMessageRequest = (req: Reactory.Server.ReactoryExpressRequest, res: Response) => {
  return sseServer.handleMessage(req, res);
};

export default {
  handleSSERequest,
  handeMessageRequest
};
