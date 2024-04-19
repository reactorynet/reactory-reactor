import { IReactorConversationsService } from "../types/service.types";


export default class ReactorConversationService implements IReactorConversationsService {
  private context: Reactory.Server.IReactoryContext;
  
  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
      
      this.context = context;
  }

  async executeMacro(args: { macro: string, botId: string, chatSessionId: string }): Promise<TReactorConversationModel> {
    const { macro, botId, chatSessionId } = args;
    const { ReactorConversationModel } = this.context.models;
    const { getService } = this.context;
    const { chat } = getService<IOpenAIService>("reactor.OpenAIService@1.0.0");
    const { chatSession } = getService<IReactorChatSessionService>("reactor.ReactorChatSessionService@1.0.0");
    const { bot } = getService<IReactorBotService>("reactor.ReactorBotService@1.0.0");
    const { user } = this.context;
    const { i18n } = this.context;

    const chatSessionModel = await chatSession.getChatSession({ id: chatSessionId });
    const botModel = await bot.getBot({ id: botId });

    const chatResponse = await chat({
      botId: botId,
      chatSessionId: chatSessionId,
      question: macro,
      language: i18n.language,
      user: user,
      bot: botModel,
      chatSession: chatSessionModel
    });

    const conversation = await ReactorConversationModel.findOne({ _id: chatSessionId }).exec();

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    conversation.history.push(chatResponse);
    conversation.updated = new Date();

    return await conversation.save();
  }

}