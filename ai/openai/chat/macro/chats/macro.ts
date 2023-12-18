import Reactory from "@reactory/reactory-core";
import { ChatState, Macro } from "../../../types/chat";
import { 
  ChatFactory, 
  SYSTEM_INITIALIZER_MESSAGE, 
  getInitializerMessage
} from '@reactory/server-modules/reactor/ai/openai/chat/questions/factory';
import ReactorConversationModel from '@reactory/server-modules/reactor/models/ReactorChatState';
import { ObjectId } from "mongodb";
import AIPersonaProvider from "modules/reactor/services/PersonaService";


export const ChatsMacro: Macro<unknown> = async (
  args: any[],
  state: ChatState): Promise<unknown> => {
  const [k, v] = args;

  const {
    context
  } = state;

  try {
    switch(k) {
      case 'new': {
        state.id = ObjectId.generate().toString();
        state.history = [await getInitializerMessage(state.botId, state, context)];
        return 'New chat session created'
      }
      case 'size': {
        //calculates the size of the chat in tokens from the history
        let size = 0;
        state.history.forEach((message) => {
          if(message?.content) {
            size += message.content.split(' ').length;
          }
        })

        return `Chat size is ~${size} tokens`;
      }
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
              if (message.role === 'user' && !summary) {
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
        // if v is null or undefined, we find the last chat 
        // for the user
        if(v === undefined || null) {
          const chat = await ReactorConversationModel.findOne({
            user: state.context.user
          }).sort({ started: -1 }).then();
          if (chat) {
            state.history = chat.history;
            state.id = chat.id;
            return `Continuing chat ${chat.id}`;
          } else {
            return `No chat history found`;
          }
        } else {
          const chat = await ReactorConversationModel.findById(v);
          if (chat) {
            state.history = chat.history;
            state.id = chat.id;
            return `Continuing chat ${v}`;
          } else {
            return `Chat ${v} not found`;
          }
        }
      }
      case 'del': {
        // delete chats
        const chat = await ReactorConversationModel.findById(v);
        if (chat) {
          await chat.deleteOne();
          return `Deleted chat ${v}`;
        } else {
          return `Chat ${v} not found`;
        }
      }
      case 'exp': {
        // exports a chat
        return 'Exported chat to data folder'
      }
      case 'train': {
        // triggers a training instruction
      }
      case 'personas': {
        // lists all personas
        const personas = await state.context.getService<AIPersonaProvider>('reactor.AIPersonaProvider@1.0.0').listPersonas();
        return `List of personas:\n\t${personas.map((persona) => `  ${persona.id} - ${persona.name}`).join('\n')}
        `
      }
      case 'speakto': {
        // sets the persona to speak to
        const persona = await state.context.getService<AIPersonaProvider>('reactor.AIPersonaProvider@1.0.0').getPersona(v);
        if (persona) {
          state.botId = persona.id;
          state.id = ObjectId.generate().toString();
          state.history.push(await getInitializerMessage(state.botId, state, context));
          state.persona = persona;
          return `You are now chatting to ${persona.name}`;
        } else {
          return `Persona ${v} not found`;
        }
      }
      case 'clear': {
        // clears the chat history for the user
        const chats = await ReactorConversationModel.find({
          user: state.context.user
        }).then();
        if (chats && chats.length > 0) {
          chats.forEach(async (chat) => {
            await chat.deleteOne();
          })
        }
        return `Cleared chat history`;
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
  @chats(clear) - clears all chat history for the user
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