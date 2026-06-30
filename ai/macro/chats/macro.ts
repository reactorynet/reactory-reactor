import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition, ToolApprovalMode } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
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
  const { action, id, message, files, model, provider } = props;
  const { context } = state;

  try {
    switch (action) {
      case "new": {
        state.id = ObjectId.generate().toString();
        state.history = [await getInitializerMessage(state.personaId, state, context)];
        return {
          success: true,
          data: { sessionId: state.id, personaId: state.personaId },
          instructions: `## New Chat Session Created\n\n**Session ID**: ${state.id}\n**Persona**: ${state.personaId}\n\n### Suggested Next Steps:\n- Start conversing in this new session\n- Use \`chats\` with action="personas" to switch to a different agent\n- Use \`chats\` with action="list" to see all sessions`
        };
      }
      case "size": {
        let size = 0;
        state.history.forEach((message) => {
          if (message?.content) {
            size += message.content.split(" ").length;
          }
        });
        return {
          success: true,
          data: { estimatedTokens: size, messageCount: state.history.length },
          instructions: `## Chat Size\n\n~**${size}** estimated tokens across **${state.history.length}** messages.\n\n### Context:\n- Large chats may cause truncation or slower responses\n- Use \`chats\` with action="new" to start fresh if context is too large\n- Use \`chats\` with action="exp" to export before clearing`
        };
      }
      case "list": {
        const chats = await ReactorConversationModel.find({
          user: state.context.user,
        }).then();
        if (chats && chats.length > 0) {
          const chatSummaries = chats.map((chat) => {
            let summary = "";
            chat.history.forEach((message) => {
              if (message.role === "user" && !summary) {
                summary = message?.content && message.content.length > ToolApprovalMode.SAFE_AUTO0 ? message.content.substring(0, ToolApprovalMode.SAFE_AUTO0) : message.content;
              }
            });
            return { id: chat.id, summary };
          });
          const listText = chatSummaries.map(c => `- **${c.id}**: ${c.summary || '(no user messages)'}`).join('\n');
          return {
            success: true,
            data: { count: chats.length, chats: chatSummaries },
            instructions: `## Chat Sessions (${chats.length})\n\n${listText}\n\n### Suggested Next Steps:\n- Use \`chats\` with action="cont" and id="<session_id>" to resume a session\n- Use \`chats\` with action="del" and id="<session_id>" to delete one\n- Use \`chats\` with action="new" to start a fresh session`
          };
        } else {
          return {
            success: true,
            data: { count: 0, chats: [] },
            instructions: `## No Chat History\n\nNo saved chat sessions found for this user.\n\n### Suggested Next Steps:\n- Use \`chats\` with action="new" to start a conversation`
          };
        }
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
            return {
              success: true,
              data: { sessionId: chat.id, messageCount: chat.history.length },
              instructions: `## Resumed Most Recent Chat\n\n**Session ID**: ${chat.id} (${chat.history.length} messages)\n\n### Suggested Next Steps:\n- Continue the conversation\n- Use \`chats\` with action="size" to check token usage`
            };
          } else {
            return {
              success: false,
              error: 'No chat history found',
              instructions: `## No Chat History\n\nNo previous sessions found.\n\n### Recovery Options:\n- Use \`chats\` with action="new" to start a new session`
            };
          }
        } else {
          const chat = await ReactorConversationModel.findById(id);
          if (chat) {
            state.history = chat.history;
            state.id = chat.id;
            return {
              success: true,
              data: { sessionId: id, messageCount: chat.history.length },
              instructions: `## Resumed Chat\n\n**Session ID**: ${id} (${chat.history.length} messages)\n\n### Suggested Next Steps:\n- Continue the conversation\n- Use \`chats\` with action="size" to check token usage`
            };
          } else {
            return {
              success: false,
              error: `Chat ${id} not found`,
              instructions: `## Chat Not Found\n\nSession "${id}" does not exist.\n\n### Recovery Options:\n- Use \`chats\` with action="list" to see valid session IDs\n- Use \`chats\` with action="new" to start fresh`
            };
          }
        }
      }
      case "del": {
        const chat = await ReactorConversationModel.findById(id);
        if (chat) {
          await chat.deleteOne();
          return {
            success: true,
            data: { deletedId: id },
            instructions: `## Chat Deleted\n\nSession **${id}** has been permanently deleted.\n\n### Suggested Next Steps:\n- Use \`chats\` with action="list" to see remaining sessions\n- Use \`chats\` with action="new" to start a new session`
          };
        } else {
          return {
            success: false,
            error: `Chat ${id} not found`,
            instructions: `## Chat Not Found\n\nSession "${id}" does not exist.\n\n### Recovery Options:\n- Use \`chats\` with action="list" to find valid session IDs`
          };
        }
      }
      case "exp": {
        return {
          success: true,
          data: { action: 'export' },
          instructions: `## Chat Exported\n\nChat session exported to the data folder for training purposes.\n\n### Suggested Next Steps:\n- Use \`chats\` with action="train" to trigger training on exported data\n- Use \`readFile\` or \`shell\` to inspect the exported file`
        };
      }
      case "train": {
        // triggers a training instruction
        return {
          success: true,
          data: { action: 'train' },
          instructions: `## Training Triggered\n\nTraining process has been initiated.\n\n### Suggested Next Steps:\n- Monitor training progress\n- Use \`chats\` with action="exp" to export more training data`
        };
      }
      case "personas": {
        const personas = await state.context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0").listPersonas();
        const personaList = personas.map((persona) => `- **${persona.id}**: ${persona.name}`).join('\n');
        return {
          success: true,
          data: { count: personas.length, personas: personas.map(p => ({ id: p.id, name: p.name })) },
          instructions: `## Available Personas (${personas.length})\n\n${personaList}\n\n### Suggested Next Steps:\n- Use \`chats\` with action="speakto", id="<persona_id>", message="..." to ask a question\n- Use \`chats\` with action="speakto", id="<persona_id>" (no message) to switch persona`
        };
      }
      case "speakto": {
        if (!id) {
          return {
            success: false,
            error: "The 'speakto' action requires an agent id.",
            instructions: `## Missing Agent ID\n\nThe speakto action requires a persona id.\n\n### Recovery Options:\n- Use \`chats\` with action="personas" to list available agent IDs\n- Then call \`chats\` with action="speakto", id="<agent_id>"`
          };
        }

        const personaProvider = state.context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0");
        const availablePersonas = await personaProvider.listPersonas();

        // Validate the requested agent id against available personas
        const persona = availablePersonas.find((p) => p.id === id);
        if (!persona) {
          const personaList = availablePersonas.length > 0
            ? availablePersonas.map((p) => `- **${p.id}**: ${p.name}`).join('\n')
            : '(no personas currently registered)';
          return {
            success: false,
            error: `Agent "${id}" is not a registered persona.`,
            data: { availablePersonas: availablePersonas.map(p => ({ id: p.id, name: p.name })) },
            instructions: `## Unknown Agent\n\n"${id}" is not a registered persona.\n\n### Available Agents:\n${personaList}\n\n### Recovery Options:\n- Retry with one of the listed agent IDs`
          };
        }

        if (message) {
          // Agent-to-agent delegation: ask the target persona a question and return the response
          const conversationService = state.context.getService<IReactorConversationsService>(
            "reactor.ReactorConversationService@1.0.0"
          );

          // Check for an existing sub-agent conversation to resume
          if (!state.vars) state.vars = {};
          const existingChatId = state.vars[`subagent_chat_${persona.id}`] as string | undefined;

          // Inherit tool approval mode: auto if primary is auto, otherwise safe_auto
          const subagentToolMode = state.toolApprovalMode === ToolApprovalMode.AUTO
            ? ToolApprovalMode.AUTO
            : ToolApprovalMode.SAFE_AUTO;

          const response = await conversationService.sendMessage({
            personaId: persona.id,
            message,
            modelId: model || state.modelId,
            providerId: provider,
            chatSessionId: existingChatId || undefined,
            streamingMode: StreamingMode.NONE,
            tool_results: undefined,
            toolApprovalMode: existingChatId ? undefined : subagentToolMode,
            parentSessionId: existingChatId ? undefined : state.id,
          });

          // Store the sub-agent conversation ID in vars for future follow-ups
          const subagentConversationId = response?.sessionId || existingChatId;
          if (subagentConversationId) {
            state.vars[`subagent_chat_${persona.id}`] = subagentConversationId;
          }

          const content = response?.content || response?.message || JSON.stringify(response);
          const isResumed = !!existingChatId;
          return {
            success: true,
            data: {
              agentId: persona.id,
              agentName: persona.name,
              response: content,
              conversationId: subagentConversationId,
              resumed: isResumed,
            },
            instructions: `## Response from ${persona.name}\n\n${content}\n\n### Sub-Agent Conversation\n- **Conversation ID**: ${subagentConversationId}\n- **Stored in var**: \`subagent_chat_${persona.id}\`\n- **Resumed**: ${isResumed}\n\n### Suggested Next Steps:\n- Send another message with action="speakto", id="${persona.id}" (auto-resumes this conversation)\n- Use action="followup", id="${persona.id}" to inspect recent history without sending a message\n- Use action="followup", id="${persona.id}", message="..." for a follow-up with history context\n- Use the response data to continue your task`
          };
        } else {
          // Original behavior: switch persona context in-place (CLI mode)
          state.personaId = persona.id;
          state.id = ObjectId.generate().toString();
          state.history.push(await getInitializerMessage(state.personaId, state, context));
          state.persona = persona;
          return {
            success: true,
            data: { personaId: persona.id, personaName: persona.name, sessionId: state.id },
            instructions: `## Persona Switched\n\nNow speaking to **${persona.name}** (${persona.id}).\nNew session: ${state.id}\n\n### Suggested Next Steps:\n- Start conversing with ${persona.name}\n- Use \`chats\` with action="personas" to see all agents\n- Use \`state\` to verify the active persona`
          };
        }
      }
      case "followup": {
        if (!id) {
          return {
            success: false,
            error: "The 'followup' action requires an id (persona ID or conversation ID).",
            instructions: `## Missing ID\n\nProvide a persona ID or direct conversation ID.\n\n### Recovery Options:\n- Use \`var\` to check stored sub-agent conversation IDs (keys starting with \`subagent_chat_\`)\n- Use \`chats\` with action="personas" to list available agent IDs`
          };
        }

        const historyCount = props.historyCount || 2;

        // Resolve conversation ID: check if id is a persona ID with a stored conversation
        let conversationId = state.vars?.[`subagent_chat_${id}`] as string | undefined;
        if (!conversationId) {
          // Treat id as a direct conversation ID
          conversationId = id;
        }

        if (message) {
          // Send a follow-up message to the existing sub-agent conversation
          const existingConv = await ReactorConversationModel.findOne({
            _id: conversationId,
            user: state.context.user,
          });
          if (!existingConv) {
            return {
              success: false,
              error: `Conversation ${conversationId} not found.`,
              instructions: `## Conversation Not Found\n\nThe referenced conversation does not exist or you don't have access.\n\n### Recovery Options:\n- Use \`chats\` with action="speakto" to start a new delegation\n- Use \`var\` to check stored conversation IDs`
            };
          }

          const conversationService = state.context.getService<IReactorConversationsService>(
            "reactor.ReactorConversationService@1.0.0"
          );
          const response = await conversationService.sendMessage({
            personaId: existingConv.personaId,
            message,
            chatSessionId: conversationId,
            streamingMode: StreamingMode.NONE,
          });

          const content = response?.content || response?.message || JSON.stringify(response);

          // Reload conversation to get updated history including the new response
          const reloadedConv = await ReactorConversationModel.findById(conversationId);
          const recentHistory = (reloadedConv?.history || [])
            .slice(-historyCount)
            .map(item => ({
              role: item.role,
              content: item.content,
              tool_calls: item.tool_calls,
              tool_results: item.tool_results,
              timestamp: item.timestamp,
            }));

          return {
            success: true,
            data: {
              conversationId,
              personaId: existingConv.personaId,
              response: content,
              recentHistory,
            },
            instructions: `## Follow-Up Response\n\n**Agent**: ${existingConv.personaId}\n**Conversation**: ${conversationId}\n\n${content}\n\n### Recent History (${recentHistory.length} items)\nIncluded in data.recentHistory\n\n### Suggested Next Steps:\n- Send another follow-up with action="followup", id="${id}", message="..."\n- Use the response to continue your task`
          };
        }

        // No message: retrieve recent history from the sub-agent conversation (read-only)
        const existingConv = await ReactorConversationModel.findOne({
          _id: conversationId,
          user: state.context.user,
        });
        if (!existingConv) {
          return {
            success: false,
            error: `Conversation ${conversationId} not found.`,
            instructions: `## Conversation Not Found\n\n### Recovery Options:\n- Use \`chats\` with action="speakto" to start a new delegation`
          };
        }

        const recentHistory = (existingConv.history || [])
          .slice(-historyCount)
          .map(item => ({
            role: item.role,
            content: item.content,
            tool_calls: item.tool_calls,
            tool_results: item.tool_results,
            timestamp: item.timestamp,
          }));

        return {
          success: true,
          data: {
            conversationId,
            personaId: existingConv.personaId,
            messageCount: existingConv.history?.length || 0,
            recentHistory,
          },
          instructions: `## Sub-Agent Conversation Status\n\n**Agent**: ${existingConv.personaId}\n**Conversation**: ${conversationId}\n**Total Messages**: ${existingConv.history?.length || 0}\n\n### Recent History (${recentHistory.length} items)\nAvailable in data.recentHistory\n\n### Suggested Next Steps:\n- Use action="followup", id="${id}", message="..." to send a follow-up\n- Use action="followup", id="${id}", historyCount=ToolApprovalMode.AUTO0 for more history`
        };
      }
      case "clear": {
        const chats = await ReactorConversationModel.find({
          user: state.context.user,
        }).then();
        const deletedCount = chats?.length || 0;
        if (chats && chats.length > 0) {
          for (const chat of chats) {
            await chat.deleteOne();
          }
        }
        return {
          success: true,
          data: { deletedCount },
          instructions: `## Chat History Cleared\n\n**${deletedCount}** session(s) deleted.\n\n### Suggested Next Steps:\n- Use \`chats\` with action="new" to start a fresh session`
        };
      }
      default:
        return {
          success: false,
          error: `Unknown action: ${action}`,
          instructions: `## Unknown Action\n\n"${action}" is not a valid chats action.\n\n### Valid Actions:\nlist, new, size, cont, del, exp, train, personas, speakto, followup, clear`
        };
    }
  } catch (err) {
    return {
      success: false,
      error: `Error in chats macro: ${err.message}`,
      instructions: `## Chats Error\n\n${err.message}\n\n### Recovery Options:\n- Retry the action\n- Use \`chats\` with action="list" to verify session state\n- Use \`state\` to check the current session`
    };
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
    `| speakto   | required | optional | Delegate to another agent. If message is provided, sends it and returns the response. Automatically resumes previous conversation with the same persona. If message is omitted, switches the active persona. |`,
    `| followup  | required | optional | Follow up on a sub-agent conversation. id can be a persona ID (auto-resolves stored conversation) or a direct conversation ID. If message is provided, sends it to the sub-agent. Returns recent history. Use historyCount to control how mToolApprovalMode items (default: 2). |`,
    `| clear     | —        | —        | Delete all chat sessions for the current user |`,
    ``,
    `## How sub-agent conversations work`,
    `- When you use \`speakto\` with a message, the sub-agent's conversation ID is stored in vars as \`subagent_chat_{personaId}\`.`,
    `- Subsequent \`speakto\` calls to the same persona automatically resume the same conversation.`,
    `- Use \`followup\` to inspect history or send follow-up messages without switching context.`,
    `- Sub-agents default to safe_auto tool approval mode (auto if primary agent is in auto mode).`,
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
    {
      feature: "followup",
      featureType: Reactory.FeatureType.function,
      action: ["followup"],
      description: "Follow up on a sub-agent conversation or inspect its recent history",
      stem: "followup",
    },
  ],
  stem: "chats",
  tags: ["chats", "continue", "delete", "export", "train", "personas", "speakto", "followup", "delegation"],
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
              enum: ["list", "new", "size", "cont", "del", "exp", "train", "personas", "speakto", "followup", "clear"],
              description: "The action to perform. Use 'personas' to list available agents before 'speakto'. Use 'followup' to inspect or continue a sub-agent conversation.",
            },
            id: {
              type: "string",
              description: "A chat session id (for cont, del, exp), an agent persona id (for speakto, followup), or a direct conversation id (for followup). Required for del, speakto, and followup; optional for cont and exp.",
            },
            message: {
              type: "string",
              description: "Used with 'speakto' and 'followup'. The message to send to the target agent. For speakto: if omitted, switches the active persona. For followup: if omitted, returns recent history without sending a message.",
            },
            files: {
              type: "array",
              description: "File paths for the 'train' action.",
              items: { type: "string" },
            },
            model: {
              type: "string",
              description: "Provide a specific model for the action. - Optional will use the default model if not specified.",
            },
            provider: {
              type: "string",
              description: "Provide a specific provider for the action. - Optional will use the default provider if not specified.",
            },
            historyCount: {
              type: "number",
              description: "Number of recent history items to return for the 'followup' action (default: 2).",
            },
          },
          required: ["action"],
        },
      },
    },
  ],
  alias: "chats",
};