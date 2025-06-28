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
import Reactory from "@reactory/reactory-core";

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
      const conversation = await conversationService.loadChatSession(args.id);

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
          id: conversation.user?.id,
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
        macros: Partial<MacroComponentDefinition<unknown>>;
        tools: Partial<MacroToolDefinition>[];
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

  @mutation("ReactorSendMessage")
  async ReactorSendMessage(
    _: any,
    args: {
      message: {
        message: string;
        personaId: string;
        chatSessionId?: string;
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
}

export default ReactorChatResolver;
