
import { Request, Response } from "express";
import { v4 as uuid } from "uuid";

type SSERequestHandler = (req: Request, res: Response) => any | null;

const RPCResponse = (result: any, id: string | null) => {
  return {
    jsonrpc: "2.0",
    id,
    result
  }
}

const RPCError = (code: number, message: string, id: string | null) => {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: code,
      message: message
    }
  }
}
const RPCNotification = (method: string, params: any) => {
  return {
    jsonrpc: "2.0",
    method,
    params
  }
}

const RPCRequest = (method: string, params: any, id: string | null) => {
  return {
    jsonrpc: "2.0",
    method: method,
    params: params,
    id: id
  }
}

const SimpleSSEServer = () => {

  const _requestHandlers = new Map<string, SSERequestHandler>();
  const _defaultHandlers = {
    'initialize': (req: Request, res: Response) => {
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
    },
    'tools/list': (req: Request, res: Response) => {
      console.log("[MCP] Listing tools...");
      return RPCResponse(
        {
          tools: [],
          count: 0
        },
        req.body.id
      );
    },
    'prompts/list': (req: Request, res: Response) => {
      return RPCResponse(
        {
          prompts: [],
          count: 0
        },
        req.body.id
      );
    },
    'resources/list': (req: Request, res: Response) => {
      console.log("[MCP] Listing resources...");
      return RPCResponse({
          resources: [],
          count: 0
        }, req.body.id);
    },
    'resources/get': (req: Request, res: Response) => {
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
    },
    'tools/call': (req: Request, res: Response) => {
      console.log("[MCP] Calling tool...");
      const toolId = req.body.params.toolId;
      const args: any[] = [];
      if (!toolId || !args) {
        return RPCError(
          -32602,
          "Invalid params: Missing toolId or arguments",
          req.body.id
        );
      }
      res.json(RPCResponse(
        {
          toolId: toolId,
          result: {
            status: "success",
            data: {
              content: "Tool call successful"
            }
          }
        },
        req.body.id
      ));
    },
    'notifications/initialized': (req: Request, res: Response) => {
      // do nothing.
      return null;
    },
    'notifications/heartbeat': (req: Request, res: Response) => {
      return RPCResponse(
        {
          heartbeat: Date.now()
        },
        req.body.id
      );
    },
    'notifications/close': (req: Request, res: Response) => {
      console.log("[MCP] Closing connection...");
      const sessionId = req.body.params.sessionId;
      if (!sessionId) {
        return RPCError(
          -32602,
          "Invalid params: Missing sessionId",
          req.body.id
        );
      }
      res.json(RPCResponse(
        {
          closed: true
        },
        req.body.id
      ));
    },
    'notifications/error': (req: Request, res: Response) => {
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
    },
  }
  
  _requestHandlers.set('initialize', _defaultHandlers['initialize']);
  _requestHandlers.set('tools/list', _defaultHandlers['tools/list']);
  _requestHandlers.set('prompts/list', _defaultHandlers['prompts/list']);
  _requestHandlers.set('resources/list', _defaultHandlers['resources/list']);
  _requestHandlers.set('resources/get', _defaultHandlers['resources/get']);
  _requestHandlers.set('tools/call', _defaultHandlers['tools/call']);
  _requestHandlers.set('notifications/initialized', _defaultHandlers['notifications/initialized']);
  _requestHandlers.set('notifications/heartbeat', _defaultHandlers['notifications/heartbeat']);
  _requestHandlers.set('notifications/close', _defaultHandlers['notifications/close']);
  _requestHandlers.set('notifications/error', _defaultHandlers['notifications/error']);
  

  const sessions: Map<string, any> = new Map();

  const handleSSE = (req: Request, res: Response) => { 
    console.log("[MCP] GET /sse => query:", req.query);
    
      // SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
    
      // Generate a sessionId
      const sessionId = uuid();
      sessions.set(sessionId, { sseRes: res, initialized: false });
      console.log("[MCP] Created sessionId:", sessionId);
    
      // event: endpoint => /message?sessionId=...
      res.write(`event: endpoint\n`);
      res.write(`data: /reactor-mcp/messages?sessionId=${sessionId}\n\n`);
    
      // Heartbeat every 10 seconds
      const hb = setInterval(() => {
        res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
      }, 10000);
    
      // Cleanup on disconnect
      req.on("close", () => {
        clearInterval(hb);
        sessions.delete(sessionId);
        console.log("[MCP] SSE closed => sessionId=", sessionId);
      });
  }

  const handleMessage = (req: Request, res: Response) => { 
    console.log("[MCP] POST /message => body:", req.body, " query:", req.query);

    const sessionId: string = req.query.sessionId as string;
    if (!sessionId) {
      return res.status(400).json({ error: "Missing sessionId in ?sessionId=..." });
    }
    const sessionData = sessions.get(sessionId);
    if (!sessionData) {
      return res.status(404).json({ error: "No SSE session with that sessionId" });
    }

    const rpc = req.body;
    // Check JSON-RPC formatting
    if (!rpc || rpc.jsonrpc !== "2.0" || !rpc.method) {
      return res.json({
        jsonrpc: "2.0",
        id: rpc?.id ?? null,
        error: {
          code: -32600,
          message: "Invalid JSON-RPC request"
        }
      });
    }

    // Minimal HTTP ack
    res.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { ack: `Received ${rpc.method}` }
    });

    // The actual response => SSE
    const sseRes = sessionData.sseRes;
    if (!sseRes) {
      console.log("[MCP] No SSE response found => sessionId=", sessionId);
      return;
    }
    const method: string = rpc.method;
    // Handle the RPC method
    const handler = _requestHandlers.get(method);
    const writeResponse = (result: any) => { 
      if (result !== null) {
        const dataString = JSON.stringify(result);
        sseRes.write(`event: message\n`);
        sseRes.write(`data: ${dataString}\n\n`);
      }
    };
    if (handler) { 
      writeResponse(handler(req, sseRes));
      return;
    } else {
      console.log("[MCP] No handler for method:", rpc.method);
      writeResponse(RPCError(
        -32601,
        `Method '${rpc.method}' not recognized`,
        rpc.id
      ));      
      return;
    } 
  }

  return {
    handleSSE,
    handleMessage
  }
}

export default SimpleSSEServer;