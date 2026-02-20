import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import {
  getInitializerMessage
} from '@reactory/server-modules/reactory-reactor/ai/openai/chat/questions/factory';
import ReactorConversationModel from '@reactory/server-modules/reactory-reactor/models/ReactorChatState';
import { ObjectId } from "mongodb";
import AIPersonaProvider from "modules/reactory-reactor/services/reactor/AIPersonaProvider";
import { IReactorConversationsService } from "../../../types/service.types";
import { StreamingMode } from "modules/reactory-reactor/services/reactor/types/streaming.types";
import { ChatsMacroProps } from './types';


export const ChatsMacro: Macro<unknown, ChatsMacroProps> = async (
  props: ChatsMacroProps,
  state: ChatState
): Promise<unknown> => {
  const { action, id, message, files, model } = props;
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
        if (!id) {
          return "The 'speakto' action requires an agent id. Use the 'personas' action to list available agents.";
        }

        const personaProvider = state.context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0");
        const availablePersonas = await personaProvider.listPersonas();

        // Validate the requested agent id against available personas
        const persona = availablePersonas.find((p) => p.id === id);
        if (!persona) {
          const personaList = availablePersonas.length > 0
            ? availablePersonas.map((p) => `  • ${p.id} — ${p.name}`).join("\n")
            : "  (no personas currently registered)";
          return (
            `Agent "${id}" is not a registered persona.\n\n` +
            `Available agents:\n${personaList}\n\n` +
            `Please retry with one of the listed agent ids.`
          );
        }

        if (message) {
          // Agent-to-agent delegation: ask the target persona a question and return the response
          const conversationService = state.context.getService<IReactorConversationsService>(
            "reactor.ReactorConversationService@1.0.0"
          );
          const response = await conversationService.sendMessage({
            personaId: persona.id,
            message,
            chatSessionId: undefined,
            streamingMode: StreamingMode.NONE,
            tool_results: undefined,
          });
          const content = response?.content || response?.message || JSON.stringify(response);
          return `Response from ${persona.name}:\n${content}`;
        } else {
          // Original behavior: switch persona context in-place (CLI mode)
          state.personaId = persona.id;
          state.id = ObjectId.generate().toString();
          state.history.push(await getInitializerMessage(state.personaId, state, context));
          state.persona = persona;
          return `You are now chatting to ${persona.name}`;
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
  description: [
    `# chats`,
    `Manage chat sessions and delegate questions to other AI agents.`,
    ``,
    `## Actions`,
    `| action    | id       | message  | Description |`,
    `|-----------|----------|----------|-------------|`,
    `| list      | —        | —        | List all chat sessions for the current user |`,
    `| new       | —        | —        | Start a new chat session |`,
    `| size      | —        | —        | Estimate the current chat size in tokens |`,
    `| cont      | optional | —        | Continue the most recent session, or a specific session by id |`,
    `| del       | required | —        | Delete a chat session by id |`,
    `| exp       | optional | —        | Export a chat session to the data folder for training |`,
    `| train     | —        | —        | Upload training data (also set files and model params) |`,
    `| personas  | —        | —        | List all registered AI agent personas with their ids |`,
    `| speakto   | required | optional | Delegate to another agent. If message is provided, sends the message to that agent and returns their response. If message is omitted, switches the active persona for the remainder of the conversation |`,
    `| clear     | —        | —        | Delete all chat sessions for the current user |`,
    ``,
    `## Important notes for the speakto action`,
    `- The id must be a valid persona id. Call with action "personas" first to get available ids.`,
    `- If the id is invalid the tool will return a list of valid agent ids.`,
  ].join('\n'),
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
    {
      feature: "speakto",
      featureType: Reactory.FeatureType.function,
      action: ["speakto"],
      description: "Switch to another persona or delegate a question to another agent",
      stem: "speakto",
    },
  ],
  stem: "chats",
  tags: ["chats", "continue", "delete", "export", "train", "personas", "speakto", "delegation"],
  tools: [
    {
      type: "function",
      function: {
        name: "chats",
        description: "Manage chat sessions: list, create, continue, delete, or export sessions. Delegate questions to other AI agents via the 'speakto' action. Use 'personas' to discover available agent ids before calling 'speakto'.",
        icon: "chat",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "new", "size", "cont", "del", "exp", "train", "personas", "speakto", "clear"],
              description: "The action to perform. Use 'personas' to list available agents before 'speakto'.",
            },
            id: {
              type: "string",
              description: "A chat session id (for cont, del, exp) or an agent persona id (for speakto). Required for del and speakto; optional for cont and exp.",
            },
            message: {
              type: "string",
              description: "Only used with action 'speakto'. The message to send to the target agent. If omitted, the active persona is switched instead of delegating a single question.",
            },
            files: {
              type: "array",
              description: "File paths for the 'train' action.",
              items: { type: "string" },
            },
            model: {
              type: "string",
              description: "Model identifier for the 'train' action.",
            },
          },
          required: ["action"],
        },
      },
    },
  ],
  alias: "chats",
};