import { mutation, query, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";
import AIPersonaProvider from "modules/reactory-reactor/services/reactor/AIPersonaProvider";
import { IReactorConversationsService } from "@reactory/server-modules/reactory-reactor/types/service.types";

@resolver
class ReactorChatResolver {
  resolver: any

  @query("ReactorPersonas")
  ReactorPersonas(_: any, __: any, context: Reactory.Server.IReactoryContext){
    return context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0").listPersonas();
  }

  @query("ReactorConversations")
  async ReactorConversations(_: any, args: { filter?: { personaId?: string, userId?: string, modelId?: string } }, context: Reactory.Server.IReactoryContext){ 
    const conversationService = context.getService<IReactorConversationsService>("reactor.ReactorConversationService@1.0.0");
    return await conversationService.getConversations(args.filter || {});
  }

  @mutation("ReactorSendMessage")
  async ReactorSendMessage(_: any, args: { message: {
    message: string, personaId: string, chatSessionId?: string
  } }, context: Reactory.Server.IReactoryContext) {
    
    if (!args || !args.message || !args.message.message || !args.message.personaId) {
      return {
        __typename: "ReactorErrorResponse",
        code: "INVALID_INPUT",
        message: "Missing required message parameters",
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Ensure you provide personaId and message content"
      };
    }
    
    const conversationService = context.getService<IReactorConversationsService>("reactor.ReactorConversationService@1.0.0");
    return await conversationService.sendMessage({
      personaId: args.message.personaId,
      chatSessionId: args.message.chatSessionId,
      message: args.message.message
    });
  }

  @mutation("ReactorExecuteMacro")
  async ReactorExecuteMacro(_: any, args: { macro: string, personaId: string, chatSessionId: string }, context: Reactory.Server.IReactoryContext) {
    const conversationService = context.getService<IReactorConversationsService>("reactor.ReactorConversationService@1.0.0");
    return await conversationService.executeMacro(args);
  }

  @mutation("ReactorExecuteTool")
  async ReactorExecuteTool(_: any, args: { tool: string, personaId: string, chatSessionId: string }, context: Reactory.Server.IReactoryContext) {
    const conversationService = context.getService<IReactorConversationsService>("reactor.ReactorConversationService@1.0.0");
    return await conversationService.executeTool(args);
  }

  @mutation("ReactorAttachImage")
  async ReactorAttachImage(_: any, args: { image: string, personaId: string, chatSessionId: string }, context: Reactory.Server.IReactoryContext) {
    const conversationService = context.getService<IReactorConversationsService>("reactor.ReactorConversationService@1.0.0");
    return await conversationService.attachImage(args);
  }

  @mutation("ReactorDeleteChatSession")
  async ReactorDeleteChatSession(_: any, args: { id: string }, context: Reactory.Server.IReactoryContext) {
    const conversationService = context.getService<IReactorConversationsService>("reactor.ReactorConversationService@1.0.0");
    return await conversationService.deleteChatSession(args);
  }

  @mutation("ReactorAskQuestionAudio")
  async ReactorAskQuestionAudio(_: any, args: { audio: any, personaId: string, chatSessionId: string }, context: Reactory.Server.IReactoryContext) {
    try {
      const openAIService = context.getService("reactor.OpenAIService@1.0.0");
      // Convert audio to text
      const text = await openAIService.speech2Text(args.audio);
      
      // Pass to regular message handler
      const conversationService = context.getService<IReactorConversationsService>("reactor.ReactorConversationService@1.0.0");
      return await conversationService.sendMessage({
        personaId: args.personaId,
        chatSessionId: args.chatSessionId,
        message: text
      });
    } catch (error) {
      return {
        __typename: "ReactorErrorResponse",
        code: "AUDIO_PROCESSING_ERROR",
        message: error.message || "Error processing audio",
        timestamp: new Date(),
        recoverable: true,
        suggestion: "Try a clearer audio recording or type your message instead"
      };
    }
  }
}

export default ReactorChatResolver;