import { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import SDKServer from './SDKServer';
import SimpleServer from './SimpleServer';

const sseServer = SimpleServer();
const sdkServer = SDKServer();
const serverUsesSDK = false;

const handleSSERequest = (req: Request, res: Response) => {
  if(serverUsesSDK) {
    return sdkServer.handleSSE(req, res);
  } else {
    return sseServer.handleSSE(req, res);
  }
};

const handeMessageRequest = (req: Request, res: Response) => {
  if(serverUsesSDK) {
    return sdkServer.handleMessage(req, res);
  } else {
    return sseServer.handleMessage(req, res);
  }  
};

export default {
  handleSSERequest,
  handeMessageRequest
};
