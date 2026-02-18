import { Response } from "express";
import { RPCResponse, RPCError, RPCNotification } from "../rpcUtils";
import Reactory from "@reactorynet/reactory-core";
import ReactorMacroService from "@reactory/server-modules/reactory-reactor/services/reactor/providers/ReactorMacroService";
import ReactorConversationService from "@reactory/server-modules/reactory-reactor/services/reactor/ReactorConversationService";
import { ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { CallToolRequest, JSONRPCRequest, ProgressToken } from "../types";

export async function toolsCall(
  req: Reactory.Server.ReactoryExpressRequest,
  res: Response,
  sessions: Map<string, any>
) {
  const { context } = req;
  const { id, params } = req.body as CallToolRequest & JSONRPCRequest;
  const { sessionId } = req.query;
  const { name, arguments: args } = params || {};
  
  // Input validation
  if (!name) {
    context.error("[MCP] Missing tool name", { params }, "toolsCall");
    return RPCError(
      -32602,
      "Invalid params: Missing tool name",
      id
    );
  }

  if (!args || typeof args !== 'object') {
    context.error("[MCP] Missing or invalid arguments", { name, args }, "toolsCall");
    return RPCError(
      -32602,
      "Invalid params: Missing or invalid arguments",
      id
    );
  }

  if (!sessionId || typeof sessionId !== 'string') {
    context.error("[MCP] Invalid sessionId", { sessionId }, "toolsCall");
    return RPCError(
      -32602,
      "Invalid params: sessionId is missing or invalid",
      id
    );
  }

  // Get progress token for notifications
  const progressToken = params?._meta?.progressToken as ProgressToken;

  try {
    // Send progress notification if token provided
    if (progressToken) {
      const sessionData = sessions.get(sessionId);
      if (sessionData?.sseRes) {
        try {
          const progressNotification = RPCNotification("notifications/progress", {
            progressToken,
            progress: 10,
            total: 100
          });
          sessionData.sseRes.write(`event: message\n`);
          sessionData.sseRes.write(`data: ${JSON.stringify(progressNotification)}\n\n`);
        } catch (error) {
          context.warn("[MCP] Failed to send progress notification", { error }, "toolsCall");
        }
      }
    }

    const macroService = context.getService<ReactorMacroService>(
      "reactor.ReactorMacroService@1.0.0"
    );

    if (!macroService) {
      context.error("[MCP] ReactorMacroService not found", null, "toolsCall");
      return RPCError(
        -32601,
        "Method not found: ReactorMacroService not available",
        id
      );
    }

    // Send progress notification
    if (progressToken) {
      const sessionData = sessions.get(sessionId);
      if (sessionData?.sseRes) {
        try {
          const progressNotification = RPCNotification("notifications/progress", {
            progressToken,
            progress: 30,
            total: 100
          });
          sessionData.sseRes.write(`event: message\n`);
          sessionData.sseRes.write(`data: ${JSON.stringify(progressNotification)}\n\n`);
        } catch (error) {
          context.warn("[MCP] Failed to send progress notification", { error }, "toolsCall");
        }
      }
    }

    const conversationService = context.getService<ReactorConversationService>(
      "reactor.ReactorConversationService@1.0.0"
    );

    if (!conversationService) {
      context.error("[MCP] ReactorConversationService not found", null, "toolsCall");
      return RPCError(
        -32601,
        "Method not found: ReactorConversationService not available",
        id
      );
    }

    // Send progress notification
    if (progressToken) {
      const sessionData = sessions.get(sessionId);
      if (sessionData?.sseRes) {
        try {
          const progressNotification = RPCNotification("notifications/progress", {
            progressToken,
            progress: 50,
            total: 100
          });
          sessionData.sseRes.write(`event: message\n`);
          sessionData.sseRes.write(`data: ${JSON.stringify(progressNotification)}\n\n`);
        } catch (error) {
          context.warn("[MCP] Failed to send progress notification", { error }, "toolsCall");
        }
      }
    }

    const conversationModel = await conversationService.getChatSession({
      id: sessionId,
    });

    if (!conversationModel) { 
      context.error("[MCP] Chat session not found", { sessionId }, "toolsCall");
      return RPCError(
        -32602,
        "Invalid params: Chat session not found",
        id
      );
    }

    // Send progress notification
    if (progressToken) {
      const sessionData = sessions.get(sessionId);
      if (sessionData?.sseRes) {
        try {
          const progressNotification = RPCNotification("notifications/progress", {
            progressToken,
            progress: 70,
            total: 100
          });
          sessionData.sseRes.write(`event: message\n`);
          sessionData.sseRes.write(`data: ${JSON.stringify(progressNotification)}\n\n`);
        } catch (error) {
          context.warn("[MCP] Failed to send progress notification", { error }, "toolsCall");
        }
      }
    }

    // Convert conversation model to ChatState format for tool execution
    const chatState: ChatState = {
      id: conversationModel._id?.toString() || conversationModel.id,
      personaId: conversationModel.personaId,
      persona: null, // Will be populated below
      modelId: conversationModel.modelId,
      started: conversationModel.started,
      history: conversationModel.history,
      user: conversationModel.user as Reactory.Models.IUserDocument,
      vars: conversationModel.vars || {},
      context,
      created: conversationModel.created,
      updated: conversationModel.updated,
      macros: (conversationModel.macros || []) as any,
      toolApprovalMode: conversationModel.toolApprovalMode,
      apiKey: process.env.OPENAI_API_KEY || "",
      apiOrg: process.env.OPENAI_ORG || "",
      ai: null, // Not needed for macro execution
    };
    
    // Send progress notification
    if (progressToken) {
      const sessionData = sessions.get(sessionId);
      if (sessionData?.sseRes) {
        try {
          const progressNotification = RPCNotification("notifications/progress", {
            progressToken,
            progress: 90,
            total: 100
          });
          sessionData.sseRes.write(`event: message\n`);
          sessionData.sseRes.write(`data: ${JSON.stringify(progressNotification)}\n\n`);
        } catch (error) {
          context.warn("[MCP] Failed to send progress notification", { error }, "toolsCall");
        }
      }
    }

    const toolResult = await macroService.executeTool(name, args, chatState);

    context.debug(`[MCP] Tool execution result for ${name}:`, { 
      toolResult, 
      resultType: typeof toolResult,
      hasTypename: toolResult?.__typename,
      isNull: toolResult === null,
      isUndefined: toolResult === undefined
    }, "toolsCall");

    if (!toolResult) {
      context.error("[MCP] Tool call failed", { name, args }, "toolsCall");
      return RPCError(-32603, "Internal error: Tool call failed", id);
    }

    // Send final progress notification
    if (progressToken) {
      const sessionData = sessions.get(sessionId);
      if (sessionData?.sseRes) {
        try {
          const progressNotification = RPCNotification("notifications/progress", {
            progressToken,
            progress: 100,
            total: 100
          });
          sessionData.sseRes.write(`event: message\n`);
          sessionData.sseRes.write(`data: ${JSON.stringify(progressNotification)}\n\n`);
        } catch (error) {
          context.warn("[MCP] Failed to send progress notification", { error }, "toolsCall");
        }
      }
    }

    // Handle different result types
    if (typeof toolResult === "object" && toolResult.__typename) {
      switch (toolResult.__typename) { 
        case "ReactorErrorResponse":
          return RPCError(
            toolResult.code || -32603,
            toolResult.message || "Unknown error",
            id
          );
        case "ReactorChatMessage":
          return RPCResponse({
            content: [{
              type: "text",
              text: toolResult.content || ""
            }],
            metadata: {
              ...toolResult
            }
          }, id);
        default:
          return RPCResponse({
            content: [{
              type: "text",
              text: JSON.stringify(toolResult)
            }],
            metadata: {
              ...toolResult
            }
          }, id);
      } 
    } 

    // Handle string results
    if (typeof toolResult === "string") {
      return RPCResponse({
        content: [{
          type: "text",
          text: toolResult
        }],
      }, id);
    }

    // Handle other result types
    return RPCResponse({
      content: [{
        type: "text",
        text: JSON.stringify(toolResult)
      }],
      metadata: {
        resultType: typeof toolResult
      }
    }, id);

  } catch (error) {
    context.error(
      "[MCP] Error executing tool",
      { name, args, error },
      "toolsCall"
    );
    return RPCError(
      -32603,
      `Internal error: ${error?.message || error || "Unknown error"}`,
      id
    );
  }
}

export default toolsCall;
