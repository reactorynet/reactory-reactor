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
import ReactorConversationService from "@reactory/server-modules/reactory-reactor/services/reactor/ReactorConversationService";

interface SessionData {
  initialized: boolean;
  sseRes: Response;
  lastActivity: number;
  heartbeatInterval?: NodeJS.Timeout;
  cleanupTimeout?: NodeJS.Timeout;
}

type SSERequestHandler = (
  req: Reactory.Server.ReactoryExpressRequest, 
  res: Response, 
  sessions: Map<string, SessionData>) => Promise<any | null>;

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
  
  // Register all handlers
  Object.entries(_defaultHandlers).forEach(([method, handler]) => {
    _requestHandlers.set(method, handler);
  });

  const sessions: Map<string, SessionData> = new Map();
  
  // Session cleanup configuration
  const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  const HEARTBEAT_INTERVAL = 10 * 1000; // 10 seconds
  const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  // Periodic cleanup of stale sessions
  const cleanupStaleSessions = () => {
    const now = Date.now();
    const staleSessions: string[] = [];
    
    sessions.forEach((sessionData, sessionId) => {
      if (now - sessionData.lastActivity > SESSION_TIMEOUT) {
        staleSessions.push(sessionId);
      }
    });
    
    staleSessions.forEach(sessionId => {
      const sessionData = sessions.get(sessionId);
      if (sessionData) {
        try {
          sessionData.sseRes.end();
          if (sessionData.heartbeatInterval) {
            clearInterval(sessionData.heartbeatInterval);
          }
          if (sessionData.cleanupTimeout) {
            clearTimeout(sessionData.cleanupTimeout);
          }
        } catch (error) {
          console.warn(`[MCP] Error cleaning up stale session ${sessionId}:`, error);
        }
        sessions.delete(sessionId);
      }
    });
    
    if (staleSessions.length > 0) {
      console.log(`[MCP] Cleaned up ${staleSessions.length} stale sessions`);
    }
  };

  // Start periodic cleanup
  setInterval(cleanupStaleSessions, CLEANUP_INTERVAL);

  const handleSSE = async (req: Reactory.Server.ReactoryExpressRequest, res: Response) => {
    const { context } = req;
    context.debug("[MCP] GET /sse => query:", req.query, 'ReactorServer.handleSSE');
    
    try {
      const conversationService = context.getService<ReactorConversationService>("reactor.ReactorConversationService@1.0.0");
      if (!conversationService) {
        context.error("[MCP] ReactorConversationService not available", null, 'ReactorServer.handleSSE');
        return res.status(503).json({ error: "Service unavailable" });
      }

      // SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Cache-Control");
    
      // create a new chat session 
      const chatState = await conversationService.startChatSession({
        personaId: 'ReactorAIPersona',
        tools: [],
        macros: [],
      });
      
      const sessionId = chatState._id.toString();
      chatState.sseSessionId = sessionId;

      const sessionData: SessionData = {
        sseRes: res,
        initialized: false,
        lastActivity: Date.now()
      };

      sessions.set(sessionId, sessionData);
      context.log("[MCP] Created sessionId:", sessionId);
    
      // event: endpoint => /message?sessionId=...
      res.write(`event: endpoint\n`);
      res.write(`data: /reactor-mcp/messages?sessionId=${sessionId}\n\n`);
    
      // Heartbeat every 10 seconds
      const heartbeatInterval = setInterval(() => {
        try {
          res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
          sessionData.lastActivity = Date.now();
        } catch (error) {
          context.warn("[MCP] Error sending heartbeat", { sessionId, error }, 'ReactorServer.handleSSE');
          clearInterval(heartbeatInterval);
        }
      }, HEARTBEAT_INTERVAL);

      sessionData.heartbeatInterval = heartbeatInterval;
    
      // Cleanup on disconnect
      res.on("close", () => {
        clearInterval(heartbeatInterval);
        sessions.delete(sessionId);
        context.log("[MCP] SSE closed => sessionId=", sessionId);
      });

      res.on("error", (error) => {
        context.error("[MCP] SSE error", { sessionId, error }, 'ReactorServer.handleSSE');
        clearInterval(heartbeatInterval);
        sessions.delete(sessionId);
      });

    } catch (error) {
      context.error("[MCP] Error in handleSSE", error, 'ReactorServer.handleSSE');
      res.status(500).json({ error: "Internal server error" });
    }
  }

  const handleMessage = async (req: Reactory.Server.ReactoryExpressRequest, res: Response) => { 
    const { context } = req;
    context.debug("[MCP] POST /message => body:", req.body, " query:", req.query);

    try {
      const sessionId: string = req.query.sessionId as string;
      if (!sessionId) {
        return res.status(400).json({ error: "Missing sessionId in ?sessionId=..." });
      }
      
      const sessionData = sessions.get(sessionId);
      if (!sessionData) {
        return res.status(404).json({ error: "No SSE session with that sessionId" });
      }

      // Update last activity
      sessionData.lastActivity = Date.now();

      const rpc: any = req.body;
      
      // Validate JSON-RPC formatting
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

      // Validate request size (prevent DoS)
      const requestSize = JSON.stringify(rpc).length;
      if (requestSize > 1024 * 1024) { // 1MB limit
        return res.json({
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32600,
            message: "Request too large"
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
        context.error("[MCP] No SSE response found => sessionId=", sessionId);
        return;
      }

      const method: string = rpc.method;
      
      // Handle the RPC method
      const handler = _requestHandlers.get(method);
      const writeResponse = (result: any) => { 
        if (result !== null) {
          try {
            const dataString = JSON.stringify(result);
            sseRes.write(`event: message\n`);
            sseRes.write(`data: ${dataString}\n\n`);
            sessionData.lastActivity = Date.now();
          } catch (error) {
            context.error("[MCP] Error writing SSE response", { sessionId, error }, 'ReactorServer.handleMessage');
          }
        } else {
          context.warn("[MCP] No response from handler for method:", method, 'ReactorServer.handleMessage');
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
    } catch (error) {
      context.error("[MCP] Error in handleMessage", error, 'ReactorServer.handleMessage');
      res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    handleSSE,
    handleMessage,
    getSessionCount: () => sessions.size,
    cleanupSessions: cleanupStaleSessions
  }
}

export default ReactorSSEServer;