import { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import initializeHandler from "./handlers/initialize";
import toolsListHandler from "./handlers/toolsList";
import promptsListHandler from "./handlers/promptsList";
import resourcesListHandler from "./handlers/resourcesList";
import resourcesGetHandler from "./handlers/resourcesGet";
import toolsCallHandler from "./handlers/toolsCall";
import notificationsInitializedHandler from "./handlers/notificationsInitialized";
import notificationsHeartbeatHandler from "./handlers/notificationsHeartbeat";
import notificationsCloseHandler from "./handlers/notificationsClose";
import notificationsErrorHandler from "./handlers/notificationsError";
import { RPCError } from "./rpcUtils";
import ReactorConversationService from "modules/reactory-reactor/services/reactor/ReactorConversationService";

type SSERequestHandler = (
  req: Reactory.Server.ReactoryExpressRequest, 
  res: Response, 
  sessions: Map<string, { initialized: boolean, sseRes: Response }>) => Promise<any | null>;

const ReactorSSEServer = () => {

  const _requestHandlers = new Map<string, SSERequestHandler>();
  const _defaultHandlers: Record<string, SSERequestHandler> = {
    'initialize': initializeHandler,
    'tools/list': toolsListHandler,
    'prompts/list': promptsListHandler,
    'resources/list': resourcesListHandler,
    'resources/get': resourcesGetHandler,
    'tools/call': toolsCallHandler,
    'notifications/initialized': notificationsInitializedHandler,
    'notifications/heartbeat': notificationsHeartbeatHandler,
    'notifications/close': notificationsCloseHandler,
    'notifications/error': notificationsErrorHandler,
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

  const handleSSE = async (req: Reactory.Server.ReactoryExpressRequest, res: Response) => {
    const { context } = req;
    context.debug("[MCP] GET /sse => query:", req.query, 'ReactorServer.handleSSE');
    const conversationService = context.getService<ReactorConversationService>("reactor.ReactorConversationService@1.0.0");
      // SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
    
      // create a new chat session 
      const chatState = await conversationService.startChatSession({
        personaId: 'ReactorAIPersona',
        tools: [],
        macros: [],
      });
      
      const sessionId = chatState._id.toString();
      chatState.sseSessionId = sessionId;

      sessions.set(sessionId, { sseRes: res, initialized: false });
      context.log("[MCP] Created sessionId:", sessionId);
    
      // event: endpoint => /message?sessionId=...
      res.write(`event: endpoint\n`);
      res.write(`data: /reactor-mcp/messages?sessionId=${sessionId}\n\n`);
    
      // Heartbeat every 10 seconds
      const hb = setInterval(() => {
        res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
      }, 10000);
    
      // Cleanup on disconnect
      res.on("close", () => {
        clearInterval(hb);
        sessions.delete(sessionId);
        context.log("[MCP] SSE closed => sessionId=", sessionId);
      });
  }

  const handleMessage = async (req: Reactory.Server.ReactoryExpressRequest, res: Response) => { 
    const { context } = req;
    console.log("[MCP] POST /message => body:", req.body, " query:", req.query);

    const sessionId: string = req.query.sessionId as string;
    if (!sessionId) {
      return res.status(400).json({ error: "Missing sessionId in ?sessionId=..." });
    }
    const sessionData = sessions.get(sessionId);
    if (!sessionData) {
      return res.status(404).json({ error: "No SSE session with that sessionId" });
    }

    const rpc: any = req.body;
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
      } else {
        context.error("[MCP] No response from handler for method:", method, 'ReactorServer.handleMessage');
      }
    };
    if (handler) { 
      try {
        const handlerResult = await handler(req, sseRes, sessions);
        writeResponse(handlerResult);
      } catch (err) { 
        context.error("[MCP] Error in handler for method:", method, err);
        writeResponse(RPCError(
          -32603,
          `Internal error in handler for method '${method}': ${err.message || 'Unknown error'}`,
          rpc.id
        ));
      }
    } else {
      context.error("[MCP] No handler for method:", rpc.method);
      writeResponse(RPCError(
        -32601,
        `Method '${rpc.method}' not recognized`,
        rpc.id
      ));
    } 
  }

  return {
    handleSSE,
    handleMessage
  }
}

export default ReactorSSEServer;