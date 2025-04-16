import Reactory from "@reactory/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import { 
  ChatFactory, 
  SYSTEM_INITIALIZER_MESSAGE, 
  getInitializerMessage
} from '@reactory/server-modules/reactory-reactor/ai/openai/chat/questions/factory';
import ReactorConversationModel from '@reactory/server-modules/reactory-reactor/models/ReactorChatState';
import { ObjectId } from "mongodb";
import AIPersonaProvider from "modules/reactory-reactor/services/reactor/AIPersonaProvider";


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
        state.history = [await getInitializerMessage(state.personaId, state, context)];
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
          state.personaId = persona.id;
          state.id = ObjectId.generate().toString();
          state.history.push(await getInitializerMessage(state.personaId, state, context));
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

export const ChatsMacroRegistry: MacroComponentDefinition<typeof ChatsMacro> = {
  nameSpace: 'reactor-macros',
  name: 'chats',
  version: '1.0.0',
  component: ChatsMacro,
  description: `# chats macro
  Use this macro to retrieve or switch to a previous chat session
  
  ## Usage as a inline function / command action.
  @chats(list) - lists all sessions for the user
  @chats(new) - creates a new chat session
  @chats(size) - calculates the size of the chat in tokens
  @chats(cont, id?) - continues the last session with the user, or continues with the id provided. 
  @chats(del, id?) - del deletes a chat session give the id, or if no id it will delete the current chat session
  @chats(exp, id?) - export the chat to data folder for training
  @chats(train, files, model) - uploads training data for a specific model
  @chats(personas) - lists all personas
  @chats(speakto, id) - sets the persona to speak to
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
  tools: [{
    type: "function",
    function: {
      name: "chats",
      description: "Retrieve or switch to a previous chat session",
      parameters: {
        type: "object",
        properties: {
          args: {
            type: "array",
            description: ` Provides a list of actions to take on the chat session.
            The arguments for the chat macro are passed as an array.
            The first argument is the action to take, and the second argument is the id of the chat session to act on.
            The following actions are supported: 
            - list: lists all chat sessions
            - cont, id: continues a chat session
            - del, id: deletes a chat session
            - exp: exports a chat session
            - train: trains a model with the chat session
            - clear: clears all chat history for the user
            - personas: lists all personas
            - speakto, id: sets the persona to speak to
            `,
            items: {
              type: "string"
            }
          },
        },
        required: ["action"]
      }
    }
  }],
  alias: 'chat'
}