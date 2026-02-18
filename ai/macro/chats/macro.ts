import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import {
  getInitializerMessage
} from '@reactory/server-modules/reactory-reactor/ai/openai/chat/questions/factory';
import ReactorConversationModel from '@reactory/server-modules/reactory-reactor/models/ReactorChatState';
import { ObjectId } from "mongodb";
import AIPersonaProvider from "modules/reactory-reactor/services/reactor/AIPersonaProvider";
import { ChatsMacroProps } from './types';


export const ChatsMacro: Macro<unknown, ChatsMacroProps> = async (
  props: ChatsMacroProps,
  state: ChatState
): Promise<unknown> => {
  const { action, id, files, model } = props;
  const { context } = state;

  try {
    switch (action) {
      case "new": {
        state.id = ObjectId.generate().toString();
        state.history = [await getInitializerMessage(state.personaId, state, context)];
        return "New chat session created";
      }
      case "size": {
        let size = 0;
        state.history.forEach((message) => {
          if (message?.content) {
            size += message.content.split(" ").length;
          }
        });
        return `Chat size is ~${size} tokens`;
      }
      case "list": {
        const chats = await ReactorConversationModel.find({
          user: state.context.user,
        }).then();
        let chat_list = "Here are your chats:";
        if (chats && chats.length > 0) {
          chats.forEach((chat) => {
            let summary = "";
            chat.history.forEach((message) => {
              if (message.role === "user" && !summary) {
                summary = message?.content && message.content.length > 30 ? message.content.substring(0, 30) : message.content;
              }
            });
            chat_list += `${chat.id} - ${summary}\n`;
          });
        } else {
          chat_list = "You have no chat history";
        }
        return chat_list;
      }
      case "cont": {
        if (!id) {
          const chat = await ReactorConversationModel.findOne({
            user: state.context.user,
          })
            .sort({ started: -1 })
            .then();
          if (chat) {
            state.history = chat.history;
            state.id = chat.id;
            return `Continuing chat ${chat.id}`;
          } else {
            return `No chat history found`;
          }
        } else {
          const chat = await ReactorConversationModel.findById(id);
          if (chat) {
            state.history = chat.history;
            state.id = chat.id;
            return `Continuing chat ${id}`;
          } else {
            return `Chat ${id} not found`;
          }
        }
      }
      case "del": {
        const chat = await ReactorConversationModel.findById(id);
        if (chat) {
          await chat.deleteOne();
          return `Deleted chat ${id}`;
        } else {
          return `Chat ${id} not found`;
        }
      }
      case "exp": {
        return "Exported chat to data folder";
      }
      case "train": {
        // triggers a training instruction
        return "Training triggered";
      }
      case "personas": {
        const personas = await state.context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0").listPersonas();
        return `List of personas:\n\t${personas.map((persona) => `  ${persona.id} - ${persona.name}`).join("\n")}`;
      }
      case "speakto": {
        const persona = await state.context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0").getPersona(id);
        if (persona) {
          state.personaId = persona.id;
          state.id = ObjectId.generate().toString();
          state.history.push(await getInitializerMessage(state.personaId, state, context));
          state.persona = persona;
          return `You are now chatting to ${persona.name}`;
        } else {
          return `Persona ${id} not found`;
        }
      }
      case "clear": {
        const chats = await ReactorConversationModel.find({
          user: state.context.user,
        }).then();
        if (chats && chats.length > 0) {
          for (const chat of chats) {
            await chat.deleteOne();
          }
        }
        return `Cleared chat history`;
      }
      default:
        return `Unknown action: ${action}`;
    }
  } catch (err) {
    return `Error in chats macro: ${err.message}`;
  }
};

export const ChatsMacroRegistry: MacroComponentDefinition<typeof ChatsMacro> = {
  nameSpace: "reactor-macros",
  name: "chats",
  version: "1.0.0",
  component: ChatsMacro,
  roles: ["USER"],
  description: `# chats macro\nUse this macro to retrieve or switch to a previous chat session\n\n## Usage as a inline function / command action.\n@chats(list) - lists all sessions for the user\n@chats(new) - creates a new chat session\n@chats(size) - calculates the size of the chat in tokens\n@chats(cont, id?) - continues the last session with the user, or continues with the id provided. \n@chats(del, id?) - del deletes a chat session give the id, or if no id it will delete the current chat session\n@chats(exp, id?) - export the chat to data folder for training\n@chats(train, files, model) - uploads training data for a specific model\n@chats(personas) - lists all personas\n@chats(speakto, id) - sets the persona to speak to\n@chats(clear) - clears all chat history for the user\n`,
  features: [
    {
      feature: "list",
      featureType: Reactory.FeatureType.function,
      action: ["list"],
      description: "Lists chat sessions",
      stem: "list",
    },
    {
      feature: "cont",
      featureType: Reactory.FeatureType.function,
      action: ["continue"],
      description: "Continue a chat session",
      stem: "continue",
    },
    {
      feature: "del",
      featureType: Reactory.FeatureType.function,
      action: ["delete"],
      description: "Deletes a chat session",
      stem: "delete",
    },
  ],
  stem: "chats",
  tags: ["chats", "continue", "delete", "export", "train"],
  tools: [
    {
      type: "function",
      function: {
        name: "chats",
        description: "Retrieve or switch to a previous chat session",
        icon: "chat",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "The action to take on the chat session.",
            },
            id: {
              type: "string",
              description: "The id of the chat session to act on (optional).",
            },
            files: {
              type: "array",
              description: "Files for training (optional).",
              items: { type: "string" },
            },
            model: {
              type: "string",
              description: "Model for training (optional).",
            },
          },
          required: ["action"],
        },
      },
    },
  ],
  alias: "chats",
};