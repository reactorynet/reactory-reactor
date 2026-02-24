import {
  mutation,
  query,
  resolver,
  property,
} from "@reactory/server-core/models/graphql/decorators/resolver";
import AIPersonaProvider from "modules/reactory-reactor/services/reactor/AIPersonaProvider";
import { IReactorConversationsService } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { ObjectId } from "mongodb";
import {
  ChatState,
  MacroComponentDefinition,
  MacroToolDefinition,
  ToolApprovalMode,
} from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import ApiError from "exceptions";
import Reactory from "@reactorynet/reactory-core";
import logger from "@reactory/server-core/logging";
import { ReactorConversation, ReactorConversationDocument } from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import { PromptMergeStrategy, StreamingMode } from "modules/reactory-reactor/services/reactor/types/streaming.types";

@resolver
class ReactorChatResolver {
  resolver: any;

  @query("ReactorConversations")
  async ReactorConversations(
    _: any,
    args: {
      filter?: { personaId?: string; userId?: string; modelId?: string };
    },
    context: Reactory.Server.IReactoryContext
  ) {
    const conversationService =
      context.getService<IReactorConversationsService>(
        "reactor.ReactorConversationService@1.0.0"
      );
    return await conversationService.getConversations(args.filter || {});
  }

  @query("ReactorConversation")
  async ReactorConversation(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!args || !args.id) {
      throw new ApiError("InvalidInputError", {
        message: "Conversation ID is required",
        code: "INVALID_INPUT",
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Ensure you provide a valid conversation ID",
      });
    }
    try {
      const conversationService =
        context.getService<IReactorConversationsService>(
          "reactor.ReactorConversationService@1.0.0"
        );
      const conversation = await conversationService.getChatSession({ id: args.id });

      if (!conversation) {
        throw new ApiError("NotFoundError", {
          message: `Conversation with ID ${args.id} not found`,
          code: "NOT_FOUND",
          timestamp: new Date(),
          recoverable: false,
          suggestion:
            "Check if the conversation ID is correct or if you have access to it",
        });
      }
      let chatState: Partial<ChatState> & { __typename: "ReactorChatState" } = {
        __typename: "ReactorChatState",
        id: args.id,
        personaId: conversation.personaId,
        modelId: conversation.modelId,
        user: {
          __typename: "User",
          _id: conversation.user?._id?.toString(),
          id: conversation.user?.id || conversation.user?._id?.toString(),
          firstName: conversation.user?.firstName || "Unknown User",
          lastName: conversation.user?.lastName,
        },
        history: conversation.history,
        vars: conversation.vars || {},
        created: conversation.created,
        updated: conversation.updated,
        toolApprovalMode:
          conversation.toolApprovalMode || ToolApprovalMode.PROMPT,
        tools: conversation?.tools || [],
        macros: conversation?.macros || [],
        tokenCount: conversation.tokenCount,
        maxTokens: conversation.maxTokens,  
        files: conversation.files || [],      
      };

      return chatState;
    } catch (error) {
      return {
        __typename: "ReactorErrorResponse",
        code: "CONVERSATION_LOAD_ERROR",
        message: error.message || "Error loading conversation",
        timestamp: new Date(),
        recoverable: true,
        suggestion:
          "Check if the conversation ID is correct and you have permission to access it",
      }
    }
  }

  @mutation("ReactorStartChatSession")
  async ReactorStartChatSession(
    _: any,
    args: {
      initSession: {
        personaId: string;
        message: string;
        systemPrompt: string;
        streamingMode: StreamingMode;
        promptMergeStrategy: PromptMergeStrategy;
        toolApprovalMode: ToolApprovalMode;
        macros: Partial<MacroComponentDefinition<unknown>>;
        tools: Partial<MacroToolDefinition>[];
        contextFromSessionId?: string;
      };
    },
    context: Reactory.Server.IReactoryContext
  ) {
    const conversationService =
      context.getService<IReactorConversationsService>(
        "reactor.ReactorConversationService@1.0.0"
      );
    return await conversationService.startChatSession(args.initSession);
  }

  @mutation("ReactorSetChatToolApprovalMode")
  async ReactorSetChatToolApprovalMode(
    _: any,
    args: { chatSessionId: string; mode: ToolApprovalMode },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!args || !args.chatSessionId || !args.mode) {
      throw new ApiError("InvalidInputError", {
        message: "chatSessionId and toolApprovalMode are required",
        code: "INVALID_INPUT",
        timestamp: new Date(),
        recoverable: true,
      });
    }

    const conversationService =
      context.getService<IReactorConversationsService>(
        "reactor.ReactorConversationService@1.0.0"
      );
    try {
      return await conversationService.setChatToolApprovalMode(
        args.chatSessionId,
        args.mode
      );
    } catch (error) {
      throw new ApiError("ChatToolApprovalModeError", {
        message: error.message || "Error setting chat tool approval mode",
        code: "CHAT_TOOL_APPROVAL_MODE_ERROR",
        timestamp: new Date(),
        recoverable: true,
        suggestion:
          "Check if the chat session exists and you have permission to modify it",
      });
    }
  }

  @property("ReactorChatState", "id")
  async ReactorChatStateId(
    chatState: ReactorConversation | ChatState,
    _: any,
    context: Reactory.Server.IReactoryContext
  ) {

    if ((chatState as ChatState).__typename === "ReactorChatState" && 
    (chatState as ChatState).id) {
      return (chatState as ChatState).id;
    }

    if ((chatState as ReactorConversation)._id) {
      return (chatState as ReactorConversation)._id.toString();
    }
        
    throw new ApiError("InvalidInputError", {
      message: "Chat state ID is required",
      code: "INVALID_INPUT",
      timestamp: new Date(),
      recoverable: true,
    });    
  }

  @property("ReactorChatState", "user")
  async ReactorChatStateUser(
    chatState: ChatState,
    _: any,
    context: Reactory.Server.IReactoryContext
  ) {
    if (!chatState?.user) {
      return null;
    }

    if (typeof chatState?.user === "string" && ObjectId.isValid(chatState?.user)) {
      return await context.getService<Reactory.Service.IReactoryUserService>("user.UserService@1.0.0").findUserById(chatState?.user);      
    }

    if (typeof chatState?.user === "object" && chatState?.user instanceof ObjectId) {
      return await context.getService<Reactory.Service.IReactoryUserService>("user.UserService@1.0.0").findUserById(chatState?.user.toString());
    }

    return chatState?.user;
  }

  /**
   * Property resolver for ReactorChatState.history
   * 
   * Enriches assistant messages that contain tool_calls with correlated
   * tool_results and tool_errors from subsequent role:"tool" messages in
   * the conversation history. This ensures the client receives the complete
   * execution state for each tool call when loading a session, rather than
   * seeing them as perpetually "running".
   * 
   * The correlation is done by matching tool_call_id on tool-role messages
   * to the id on each tool call in the assistant message.
   */
  @property("ReactorChatState", "history")
  async ReactorChatStateHistory(
    chatState: ChatState,
    _: any,
    context: Reactory.Server.IReactoryContext
  ) {
    const history = chatState?.history;
    if (!history || !Array.isArray(history) || history.length === 0) {
      return [];
    }

    // Build a lookup map: tool_call_id -> tool role message(s)
    // These are the result messages created by executeMacro/executeTool
    const toolResultsByCallId = new Map<string, any>();
    for (const msg of history) {
      const plain = typeof msg.toObject === 'function' ? msg.toObject() : msg;
      if (plain.role === 'tool' && plain.tool_call_id) {
        toolResultsByCallId.set(plain.tool_call_id, plain);
      }
    }

    // Enrich assistant messages that have tool_calls
    return history.map((msg: any) => {
      // Convert Mongoose subdocuments to plain JS objects so that
      // spread and GraphQL field resolution work correctly.
      const plainMsg = typeof msg.toObject === 'function' ? msg.toObject() : msg;

      // Only process assistant messages that have tool_calls
      if (plainMsg.role !== 'assistant' || !Array.isArray(plainMsg.tool_calls) || plainMsg.tool_calls.length === 0) {
        return plainMsg;
      }

      const correlatedResults: any[] = [];
      const correlatedErrors: any[] = [];

      // For each tool call, find the matching tool result message
      const enrichedToolCalls = plainMsg.tool_calls.map((tc: any) => {
        const plainTc = typeof tc.toObject === 'function' ? tc.toObject() : tc;
        const callId = plainTc.id;
        const toolResultMsg = callId ? toolResultsByCallId.get(callId) : null;

        let status = 'pending';
        if (toolResultMsg) {
          // Check if this is an error result
          const content = toolResultMsg.content || '';
          const hasErrorInContent = typeof content === 'string' && content.startsWith('Error executing tool');
          const hasToolErrors = Array.isArray(toolResultMsg.tool_errors) && toolResultMsg.tool_errors.length > 0;

          if (hasErrorInContent || hasToolErrors) {
            status = 'error';
            correlatedErrors.push({
              id: callId,
              name: toolResultMsg.tool_name || plainTc.function?.name,
              error: hasToolErrors 
                ? toolResultMsg.tool_errors.map((e: any) => e.message || JSON.stringify(e)).join('; ')
                : content,
              timestamp: toolResultMsg.timestamp,
            });
          } else {
            status = 'success';
            // Extract result from tool_results array on the tool message
            const resultEntry = Array.isArray(toolResultMsg.tool_results) 
              ? toolResultMsg.tool_results.find((r: any) => r.id === callId)
              : null;
            
            correlatedResults.push({
              id: callId,
              name: toolResultMsg.tool_name || plainTc.function?.name || resultEntry?.name,
              content: resultEntry?.result ?? resultEntry?.content ?? toolResultMsg.content,
              timestamp: toolResultMsg.timestamp,
            });
          }
        }

        return {
          ...plainTc,
          id: callId || plainTc.id,
          type: plainTc.type || 'function',
          function: plainTc.function ? {
            name: plainTc.function.name,
            arguments: typeof plainTc.function.arguments === 'string' 
              ? plainTc.function.arguments 
              : JSON.stringify(plainTc.function.arguments),
          } : null,
          status,
        };
      });

      return {
        ...plainMsg,
        tool_calls: enrichedToolCalls,
        tool_results: [
          ...(Array.isArray(plainMsg.tool_results) ? plainMsg.tool_results.filter((r: any) => r?.id && r?.name) : []),
          ...correlatedResults,
        ],
        tool_errors: [
          ...(Array.isArray(plainMsg.tool_errors) ? plainMsg.tool_errors : []),
          ...correlatedErrors,
        ],
      };
    });
  }

  @property("ReactorChatState", "tools")
  async ReactorChatStateTools(
    chatState: ChatState,
    _: any,
    context: Reactory.Server.IReactoryContext
  ) {
    if (!chatState || !chatState.tools || chatState.tools.length === 0) {
      return [];
    }

    const toolDefinitions: MacroToolDefinition[] = [];

    chatState.tools.forEach((tool) => {
      if (tool?.roles && tool.roles.length > 0) {
        if (context.hasAnyRole(tool.roles)) toolDefinitions.push(tool);
      } else {
        toolDefinitions.push(tool);
      }
    });

    return toolDefinitions;
  }

  @property("ReactorChatState", "macros")
  async ReactorChatStateMacros(
    chatState: ChatState,
    _: any,
    context: Reactory.Server.IReactoryContext
  ) {
    if (!chatState || !chatState.macros || chatState.macros.length === 0) {
      return [];
    }
    const macroDefinitions: MacroComponentDefinition<unknown>[] = [];
    chatState.macros.forEach((macro) => {
      if (macro?.roles && macro.roles.length > 0) {
        if (context.hasAnyRole(macro.roles)) {
          macroDefinitions.push(macro);
        }
      } else {
        macroDefinitions.push(macro);
      }
    });
    return macroDefinitions;
  }

  @property("ReactorChatState", "tokenCount")
  async ReactorChatStateTokenCount(
    chatState: ChatState,
    _: any,
    context: Reactory.Server.IReactoryContext
  ) {
    return chatState?.tokenCount || 0;
  }

  @property("ReactorChatState", "maxTokens")
  async ReactorChatStateMaxTokens(
    chatState: ChatState,
    _: any,
    context: Reactory.Server.IReactoryContext
  ) {
    return chatState?.maxTokens || 8000;
  }

  @property("ReactorChatState", "tokenPressure")
  async ReactorChatStateTokenPressure(
    chatState: ChatState,
    _: any,
    context: Reactory.Server.IReactoryContext
  ) {

    if (!chatState?.tokenCount || !chatState?.maxTokens) {
      return 0;
    }
    // get the presure from the tokenCount and maxTokens
    const tokenPressure = chatState?.tokenCount / chatState?.maxTokens;
    return tokenPressure || 0;
  }

  @property("ReactorChatState", "files")
  async ReactorChatStateFiles(
    chatState: ChatState,
    _: any,
    context: Reactory.Server.IReactoryContext
  ) {
    if (!chatState?.id) {
      return [];    
    }
    
    if (chatState?.files && chatState?.files.length > 0) {
      return chatState.files;
    }
  }

  @mutation("ReactorSendMessage")
  async ReactorSendMessage(
    _: any,
    args: {
      message: {
        message: string;
        personaId: string;
        chatSessionId?: string;
        streamingMode: StreamingMode;
      };
    },
    context: Reactory.Server.IReactoryContext
  ) {
    if (
      !args ||
      !args.message ||
      !args.message.message ||
      !args.message.personaId
    ) {
      return {
        __typename: "ReactorErrorResponse",
        code: "INVALID_INPUT",
        message: "Missing required message parameters",
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Ensure you provide personaId and message content",
      };
    }

    try {
      const conversationService =
        context.getService<IReactorConversationsService>(
          "reactor.ReactorConversationService@1.0.0"
        );
      return await conversationService.sendMessage({
        personaId: args.message.personaId,
        chatSessionId: args.message.chatSessionId,
        message: args.message.message,
        streamingMode: args.message.streamingMode,
      });
    } catch (error) {
      return {
        __typename: "ReactorErrorResponse",
        code: "MESSAGE_PROCESSING_ERROR",
        message: error.message || "Error processing message",
        timestamp: new Date(),
        recoverable: true,
        suggestion:
          "Try rephrasing your message or check your network connection",
      };
    }
  }

  @mutation("ReactorAttachFile") 
  async ReactorAttachFile(
    _: any,
    args: { file: Reactory.Service.IFile; chatSessionId: string },
    context: Reactory.Server.IReactoryContext
  ) {
    if (!args || !args.file) {
      return {
        __typename: "ReactorErrorResponse",
        code: "INVALID_INPUT",
        message: "Missing required file parameters",
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Ensure you provide a file",
      };
    }

    const params = {
      file: args.file,      
      chatSessionId: args.chatSessionId,
    };

    const conversationService =
      context.getService<IReactorConversationsService>(
        "reactor.ReactorConversationService@1.0.0"
      );

    const conversation = await conversationService.getChatSession({ id: args.chatSessionId });
    
    const fileService: Reactory.Service.IReactoryFileService = context.getService('core.ReactoryFileService@1.0.0') as Reactory.Service.IReactoryFileService;
            //upload the file and associate with the workload package
    logger.debug(`Uploading File using Reactory File Service`, { filename: params.file.filename });

    let fileModel = await fileService.uploadFile({
      file: params.file,
      filename: params.file.filename,
      uploadContext: `reactor_chat_file::${params.chatSessionId}`,
      isUserSpecific: true,
      rename: false,
      catalog: true,
      virtualPath: `chats/${conversation.personaId}/${params.chatSessionId}`
    });

    
    
    if (!fileModel) {
      return {
        __typename: "ReactorErrorResponse",
        code: "FILE_UPLOAD_ERROR",
        message: "Failed to upload file",
        timestamp: new Date(),
        recoverable: false,
        suggestion: "Check the file format and size, or try again later",
      };
    }

    try {
      return await conversationService.attachFiles({
        files: [fileModel],        
        chatSessionId: params.chatSessionId,
      });
    } catch (error) {
      return {
        __typename: "ReactorErrorResponse",
        code: "FILE_ATTACHMENT_ERROR",
        message: error.message || "Error attaching file to chat session",
        timestamp: new Date(),
        recoverable: true,
        suggestion:
          "Ensure the chat session exists and you have permission to attach files",
      };
    }
    
  }
  
  @mutation("ReactorAttachImage")
  async ReactorAttachImage(
    _: any,
    args: { image: string; personaId: string; chatSessionId: string },
    context: Reactory.Server.IReactoryContext
  ) {
    const conversationService =
      context.getService<IReactorConversationsService>(
        "reactor.ReactorConversationService@1.0.0"
      );
    return await conversationService.attachImage(args);
  }

  @mutation("ReactorDeleteChatSession")
  async ReactorDeleteChatSession(
    _: any,
    args: { id: string },
    context: Reactory.Server.IReactoryContext
  ) {
    const conversationService =
      context.getService<IReactorConversationsService>(
        "reactor.ReactorConversationService@1.0.0"
      );
    return await conversationService.deleteChatSession(args);
  }

  @mutation("ReactorAskQuestionAudio")
  async ReactorAskQuestionAudio(
    _: any,
    args: { audio: any; personaId: string; chatSessionId: string },
    context: Reactory.Server.IReactoryContext
  ) {
    try {
      const openAIService = context.getService("reactor.OpenAIService@1.0.0");
      // Convert audio to text
      const text = await openAIService.speech2Text(args.audio);

      // Pass to regular message handler
      const conversationService =
        context.getService<IReactorConversationsService>(
          "reactor.ReactorConversationService@1.0.0"
        );
      return await conversationService.sendMessage({
        personaId: args.personaId,
        chatSessionId: args.chatSessionId,
        message: text,
      });
    } catch (error) {
      return {
        __typename: "ReactorErrorResponse",
        code: "AUDIO_PROCESSING_ERROR",
        message: error.message || "Error processing audio",
        timestamp: new Date(),
        recoverable: true,
        suggestion:
          "Try a clearer audio recording or type your message instead",
      };
    }
  }

  @mutation("ReactorAttachUserFileToSession")
  async ReactorAttachUserFileToSession(
    _: any,
    args: { params: { sessionId: string; fileId: string; path: string } },
    context: Reactory.Server.IReactoryContext
  ) {
    try {
      const conversationService =
        context.getService<IReactorConversationsService>(
          "reactor.ReactorConversationService@1.0.0"
        );
      
      return await conversationService.attachUserFileToSession(
        args.params.sessionId,
        args.params.fileId,
        args.params.path
      );
    } catch (error) {
      logger.error("Error attaching user file to session", error);
      return {
        __typename: "ReactorErrorResponse",
        code: "FILE_ATTACH_ERROR",
        message: error.message || "Error attaching file to session",
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Please try again or contact support",
      };
    }
  }

  @mutation("ReactorDetachUserFileFromSession")
  async ReactorDetachUserFileFromSession(
    _: any,
    args: { params: { 
      sessionId: string; 
      fileId: string; 
      delete?: boolean; // Optional, if true, delete the file after detaching
      path: string } },
    context: Reactory.Server.IReactoryContext
  ) {
    try {
      const conversationService =
        context.getService<IReactorConversationsService>(
          "reactor.ReactorConversationService@1.0.0"
        );
      
      return await conversationService.detachUserFileFromSession(
        args.params.sessionId,
        args.params.fileId,
        args.params.path
      );
    } catch (error) {
      logger.error("Error detaching user file from session", error);
      return {
        __typename: "ReactorErrorResponse",
        code: "FILE_DETACH_ERROR",
        message: error.message || "Error detaching file from session",
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Please try again or contact support",
      };
    }
  }
}

export default ReactorChatResolver;
