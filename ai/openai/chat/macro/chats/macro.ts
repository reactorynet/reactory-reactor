import Reactory from "@reactory/reactory-core";
import { ChatState, Macro } from "../../../types/chat";
import ReactorConversationModel from '@reactory/server-modules/reactor/models/ReactorChatState';

export const ChatsMacro: Macro<unknown> = async (
  args: any[],
  state: ChatState): Promise<unknown> => {
  const [k, v] = args;
  try {
    switch(k) {
      case 'list': {
        // list all chats
        const chats = await ReactorConversationModel.find({
          user: state.context.user
        }).then();
        let chat_list = 'Here are your chats:';
        if (chats && chats.length > 0) {
          chats.forEach((chat) => {
            let summary = '';
            chat.history.forEach((message) => {
              if (message.role === 'user') {
                summary = message?.content && message.content.length > 30 ? message.content.substring(0,30) : message.content;
              }
            })
            chat_list += `${chat.id} - ${summary}\n`
          })          
        } else {
          chat_list = 'You have no chat history';
        }

        return chat_list;
      }
      case 'cont': {
        // load chat state
      }
      case 'del': {
        // delete chats
      }
      case 'exp': {
        // exports a chat
      }
      case 'train': {
        // triggers a training instruction
      }
    }

    
  } catch (err) {
    return `Error in variable macro`;
  }
};

export const ChatsMacroRegistry: Reactory.IReactoryComponentDefinition<typeof ChatsMacro> = {
  nameSpace: 'reactor-macros',
  name: 'chats',
  version: '1.0.0',
  component: ChatsMacro,
  description: `# chats macro
  Use this macro to retrieve or switch to a previous chat session
  
  ## Usage
  @chats(list) - lists all sessions for the user
  @chats(cont, id?) - continues the last session with the user, or continues with the id provided. 
  @chats(del, id?) - del deletes a chat session give the id, or if no id it will delete the current chat session
  @chats(exp, id?) - export the chat to data folder for training
  @chats(train, files, model) - uploads training data for a specific model
  `,
  features: [
    {
      feature: 'list',
      featureType: Reactory.FeatureType.function,
      action: ['list'],
      description: 'Lists chat sessions',
      stem: 'list'
    },
    {
      feature: 'cont',
      featureType: Reactory.FeatureType.function,
      action: ['continue'],
      description: 'Continue a chat session',
      stem: 'continue'
    },
    {
      feature: 'del',
      featureType: Reactory.FeatureType.function,
      action: ['delete'],
      description: 'Deletes a chat session',
      stem: 'delete'
    }
  ],
  stem: 'chats',
  tags: ['chats', 'continue', 'delete', 'export', 'train'],
}