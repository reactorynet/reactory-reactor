import { Response } from "express";
import { RPCResponse, RPCError } from "../rpcUtils";
import Reactory from "@reactory/reactory-core";
import ReactorMacroService from "@reactory/server-modules/reactory-reactor/services/reactor/providers/ReactorMacroService";
import ReactorConversationService from "@reactory/server-modules/reactory-reactor/services/reactor/ReactorConversationService";
import { ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { CallToolRequest, JSONRPCRequest } from "../types";

export async function toolsCall(
  req: Reactory.Server.ReactoryExpressRequest,
  res: Response
) {
  const { context } = req;
  const { id, params } = req.body as CallToolRequest & JSONRPCRequest;
  const { sessionId } = req.query;
  const { name, arguments: args } = params || {};
  
  if (!name || !args) {
    // context.error(
    //   "[MCP] Invalid params: Missing toolId or arguments",
    //   { name, args },
    //   "toolsCall"
    // );
    return RPCError(
      -32602,
      "Invalid params: Missing toolId or arguments",
      id
    );
  }

  const macroService = context.getService<ReactorMacroService>(
    "reactor.ReactorMacroService@1.0.0"
  );

  if (!macroService) {
    //context.error("[MCP] ReactorMacroService not found", null, "toolsCall");
    return RPCError(
      -32601,
      "Method not found: ReactorMacroService not available",
      id
    );
  }

  //context.debug("[MCP] Calling tool...", { name, args }, "toolsCall");

  try {
    const conversationService = context.getService<ReactorConversationService>(
      "reactor.ReactorConversationService@1.0.0"
    );
    const chatSessionId =
      typeof sessionId === "string"
        ? sessionId
        : sessionId != null && sessionId.toString
        ? sessionId.toString()
        : undefined;

    if (chatSessionId === undefined || chatSessionId === null) {
      context.error(
        "[MCP] Invalid sessionId",
        { sessionId },
        "toolsCall"
      );
      return RPCError(
        -32602,
        "Invalid params: sessionId is missing or invalid",
        id
      );
    }


    const conversationModel = await conversationService.getChatSession({
      id: chatSessionId,
    });

    if (conversationModel == null || conversationModel == undefined) { 
      context.error(
        "[MCP] Chat session not found",
        { id },
        "toolsCall"
      );
      return RPCError(
        -32602,
        "Invalid params: Chat session not found",
        id
      );
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
    
    const toolResult = await macroService.executeTool(name, args, chatState);

    context.debug(`[MCP] Tool execution result for ${name}:`, { 
      toolResult, 
      resultType: typeof toolResult,
      hasTypename: toolResult?.__typename,
      isNull: toolResult === null,
      isUndefined: toolResult === undefined
    }, "toolsCall");

    if (!toolResult) {
      context.error("[MCP] Tool call failed", { toolId: name, args }, "toolsCall");
      return res.json(RPCError(-32603, "Internal error: Tool call failed", id));
    }

    if (!name || !args) {
      return RPCError(
        -32602,
        "Invalid params: Missing toolId or arguments",
        id
      );
    }

    if (typeof toolResult == "object") {
      // check if it has a __typename property
      if (toolResult.__typename) {
        // if it has a __typename property, return it as is
        switch (toolResult.__typename) { 
          case "ReactorErrorResponse":
            return RPCError(
              toolResult.code || -32603,
              toolResult.message || "Unknown error",
              id
            );
          case "ReactorChatMessage":
            // if it has a __typename property and it's a ReactorChatMessage, return it as is
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
            // if it has a __typename property but it's not a known type, return it as is  
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
    } 

    const result = {
      content: [{
        type: "text",
        text: toolResult
      }],
    }

    const response = RPCResponse(result, id);
    return response;
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
