import { mutation, query, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";
import AIPersonaProvider from "@reactory/server-modules/reactory-reactor/services/PersonaService";
import ReactorConversationModel from '@reactory/server-modules/reactory-reactor/models/ReactorChatState';
import IOpenAIService, { IReactorConversationsService } from "@reactory/server-modules/reactory-reactor/types/service.types";

//@ts-ignore
@resolver
class ReactorChatResolver {
  resolver: any

  @query("ReactorPersonas")
  ReactorPersonas(_: any, __: any, context: Reactory.Server.IReactoryContext){
    return context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0").listPersonas();
  }

  @query("ReactorConversations")
  ReactorConversations(_: any, args: { botId: string, userId: string, modelId: string }, context: Reactory.Server.IReactoryContext){ 

    const { botId, userId, modelId } = args;

    if(!botId || !userId || !modelId) { 
      return ReactorConversationModel.find({
        user: context.user
      }).exec()
    }

    if( botId && !userId && !modelId) { 
      return ReactorConversationModel.find({
        botId: botId,
        user: context.user
      }).exec();
    }

    if( botId && userId && !modelId) { 
      return ReactorConversationModel.find({
        botId: botId,
        userId: userId
      }).exec();
    }

    return ReactorConversationModel.find({
      botId: args.botId,
      userId: args.userId,
      modelId: args.modelId
    }).exec();
  }

  @mutation("ReactorAskQuestion")
  ReactorAskQuestion(_: any, args: { botId: string, chatSessionId: string, question: string }, context: Reactory.Server.IReactoryContext) {
    return context.getService<IOpenAIService>("reactor.OpenAIService@1.0.0").chat(args);
  }

  @mutation("ReactorExecuteMacro")
  async ReactorExecuteMacro(_: any, args: { macro: string, botId: string, chatSessionId: string }, context: Reactory.Server.IReactoryContext) {
    // You would need to implement a method in the service to execute macros
    return await context.getService<IReactorConversationsService>("reactor.ReactorConversationsService@1.0.0")
      .executeMacro(args);
  }

  @mutation("ReactorAttachImage")
  async ReactorAttachImage(_: any, args: { image: string, botId: string, chatSessionId: string }, context: Reactory.Server.IReactoryContext) {
    // A method in the service to attach images to the conversation
    return await context.getService<IReactorConversationsService>("reactor.ReactorConversationsService@1.0.0")
      .attachImage(args);
  }

  @mutation("ReactorDeleteChatSession")
  async ReactorDeleteChatSession(_: any, args: { id: string }, context: Reactory.Server.IReactoryContext) {
    // A method in the service to delete a chat session
    return await context.getService<IReactorConversationsService>("reactor.ReactorConversationsService@1.0.0")
      .deleteChatSession(args);
  }

  @mutation("ReactorAskQuestionAudio")
  async ReactorAskQuestionAudio(_: any, args: { audio: any, botId: string, chatSessionId: string }, context: Reactory.Server.IReactoryContext) {
    // A method to handle speech to text and ask a question
    const { chatAudio, speech2Text } = context.getService<IOpenAIService>("reactor.OpenAIService@1.0.0");
    
    return chatAudio({ ...args,  question: await speech2Text(args.audio), format: "wav" });
  }
}

export default ReactorChatResolver;