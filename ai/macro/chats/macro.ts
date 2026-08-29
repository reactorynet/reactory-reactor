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
import { v4 } from "uuid";
import logger from "@reactory/server-core/logging";


/**
 * Resolve a free-text model/provider hint from the agent into the canonical
 * ids used by the provider registry. The LLM often supplies a display name
 * (e.g. "GPT-5.4") instead of the model id (e.g. "gpt-5.4"); the downstream
 * conversation service looks models up strictly by `m.id === modelId`, so
 * passing a name through unchanged causes the sub-agent launch to fail.
 *
 * Resolution order:
 *  - provider: exact id match, then case-insensitive name match
 *  - model:    exact id match (any provider), then name match scoped to the
 *              resolved provider, then name match across all providers
 *
 * If nothing matches, the original value is returned unchanged so the
 * downstream service surfaces its own error rather than failing silently.
 */
async function resolveModelAndProvider(
  context: Reactory.Server.IReactoryContext,
  model?: string,
  provider?: string,
): Promise<{ modelId?: string; providerId?: string }> {
  if (!model && !provider) return { modelId: undefined, providerId: undefined };

  const providerService = context.getService<any>("reactor.ReactorProviderService@1.0.0");
  if (!providerService) {
    return { modelId: model, providerId: provider };
  }

  let resolvedProviderId = provider;
  if (provider) {
    const providers = await providerService.getProviders();
    const exactProvider = providers.find((p: any) => p.id === provider);
    if (exactProvider) {
      resolvedProviderId = exactProvider.id;
    } else {
      const byName = providers.find(
        (p: any) => p.name?.toLowerCase() === provider.toLowerCase()
      );
      if (byName) resolvedProviderId = byName.id;
    }
  }

  let resolvedModelId = model;
  if (model) {
    const providers = await providerService.getProviders();
    let matchedModelId: string | undefined;

    for (const p of providers) {
      const found = p.models?.find((m: any) => m.id === model);
      if (found) { matchedModelId = found.id; break; }
    }

    if (!matchedModelId) {
      const scopedProviders = resolvedProviderId
        ? providers.filter((p: any) => p.id === resolvedProviderId)
        : providers;
      for (const p of scopedProviders) {
        const found = p.models?.find(
          (m: any) => m.name?.toLowerCase() === model.toLowerCase()
        );
        if (found) { matchedModelId = found.id; break; }
      }
    }

    if (!matchedModelId) {
      for (const p of providers) {
        const found = p.models?.find(
          (m: any) => m.name?.toLowerCase() === model.toLowerCase()
        );
        if (found) { matchedModelId = found.id; break; }
      }
    }

    if (matchedModelId) resolvedModelId = matchedModelId;
  }

  return { modelId: resolvedModelId, providerId: resolvedProviderId };
}


export const ChatsMacro: Macro<unknown, ChatsMacroProps> = async (
  props: ChatsMacroProps,
  state: ChatState
): Promise<unknown> => {
  const { context, modelId, providerId } = state;
  const { action, id, message, files, model = modelId, provider = providerId, providerConfig, async: isAsync, wakeParent } = props;

  

  logger.info(`ChatsMacro: model=${model}, provider=${provider} action=${action}, id=${id}, message=${message}, files=${files}`);

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
          parentSessionId: { $in: [null, undefined] },
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

          // The agent often passes a model display name (e.g. "GPT-5.4")
          // rather than the model id. Resolve to the canonical id before
          // delegating so the sub-agent provider lookup succeeds.
          const resolved = await resolveModelAndProvider(context, model, provider);

          // Defensively parse stringified providerConfig if passed as string
          let parsedProviderConfig = providerConfig;
          if (typeof providerConfig === 'string' && providerConfig.trim().length > 0) {
            try { parsedProviderConfig = JSON.parse(providerConfig); } catch (e) {}
          }
          const targetModelId = resolved.modelId || (resolved.providerId ? state.modelId : persona.modelId) || state.modelId;
          const targetProviderId = resolved.providerId || persona.providerId;

          // ── Non-blocking async dispatch ────────────────────────────────────
          // When async=true, dispatch the delegation to run in the background and
          // return immediately with a delegationId the caller can poll via
          // action="respond". The blocking path below is untouched when async is
          // falsy.
          if (isAsync) {
            const delegationId = v4();
            const subagentSessionId = new ObjectId().toString();

            // Pre-create the sub-agent conversation with a known _id so the
            // delegationId ↔ sessionId mapping is available at dispatch time and the
            // run is recoverable after a crash/disconnect.
            await ReactorConversationModel.create({
              _id: subagentSessionId,
              personaId: persona.id,
              user: state.context.user,
              modelId: targetModelId,
              providerId: targetProviderId,
              history: [],
              vars: {},
              meta: {
                summary: `Sub-agent delegation ${delegationId} to ${persona.name}`,
                title: `Delegation to ${persona.name}`,
              },
              macros: persona.macros || [],
              tools: persona.tools || [],
              started: new Date(),
              sseSessionId: subagentSessionId,
              toolApprovalMode: subagentToolMode,
              parentSessionId: state.id || null,
              use_case: "standalone",
            } as any);

            // Persist the delegation record on the PARENT conversation synchronously
            // (before the fire-and-forget) so the run is recoverable. Also keep the
            // legacy per-persona var for followup backward-compat.
            await ReactorConversationModel.findOneAndUpdate(
              { _id: state.id },
              {
                $set: {
                  [`vars.subagent_delegations.${delegationId}`]: {
                    status: "dispatched",
                    personaId: persona.id,
                    agentName: persona.name,
                    subagentSessionId,
                    parentSessionId: state.id,
                    message,
                    startedAt: new Date().toISOString(),
                  },
                  [`vars.subagent_chat_${persona.id}`]: subagentSessionId,
                  updated: new Date(),
                },
              }
            ).exec();

            // Keep the in-memory var too so other tools see it this turn.
            state.vars[`subagent_chat_${persona.id}`] = subagentSessionId;

            // Fire-and-forget runner: execute the sub-agent in the background,
            // record the result in the delegation record, and (optionally) push a
            // compact callback into the parent session when it is not processing.
            void (async () => {
              try {
                const response = await conversationService.sendMessage({
                  personaId: persona.id,
                  message,
                  modelId: targetModelId,
                  providerId: targetProviderId,
                  chatSessionId: subagentSessionId,
                  streamingMode: StreamingMode.NONE,
                  tool_results: undefined,
                  providerConfig: parsedProviderConfig,
                });
                const content = response?.content || response?.message || JSON.stringify(response);
                await ReactorConversationModel.findOneAndUpdate(
                  { _id: state.id },
                  {
                    $set: {
                      [`vars.subagent_delegations.${delegationId}.status`]: "complete",
                      [`vars.subagent_delegations.${delegationId}.response`]: content,
                      [`vars.subagent_delegations.${delegationId}.completedAt`]: new Date().toISOString(),
                      updated: new Date(),
                    },
                  }
                ).exec();

                if (wakeParent !== false) {
                  try {
                    const parentNow = await ReactorConversationModel.findOne({ _id: state.id }).select("processing").lean().exec();
                    if (parentNow && !parentNow.processing) {
                      const summary = typeof content === "string" && content.length > 500 ? `${content.substring(0, 500)}…` : content;
                      await ReactorConversationModel.findOneAndUpdate(
                        { _id: state.id },
                        {
                          $push: {
                            history: {
                              id: new ObjectId(),
                              role: "system",
                              content: `[Sub-agent ${persona.name} completed delegation ${delegationId}] ${summary} — full result in vars.subagent_delegations.${delegationId}; retrieve with chats action="respond", id="${delegationId}".`,
                              timestamp: new Date(),
                              tool_results: [],
                            },
                          },
                          $set: { updated: new Date() },
                        }
                      ).exec();
                    }
                  } catch (_) { /* best-effort callback */ }
                }
              } catch (err: any) {
                try {
                  await ReactorConversationModel.findOneAndUpdate(
                    { _id: state.id },
                    {
                      $set: {
                        [`vars.subagent_delegations.${delegationId}.status`]: "error",
                        [`vars.subagent_delegations.${delegationId}.error`]: err?.message || String(err),
                        [`vars.subagent_delegations.${delegationId}.completedAt`]: new Date().toISOString(),
                        updated: new Date(),
                      },
                    }
                  ).exec();
                } catch (_) { /* best-effort error record */ }
              }
            })();

            return {
              success: true,
              data: {
                status: "dispatched",
                delegationId,
                subagentSessionId,
                agentId: persona.id,
                agentName: persona.name,
              },
              instructions: `## Delegation Dispatched (non-blocking)\n\nTask sent to **${persona.name}** (${persona.id}).\n- **Delegation ID**: ${delegationId}\n- **Sub-agent Session**: ${subagentSessionId}\n\n### Retrieve the result\n- Call \`chats\` with action="respond", id="${delegationId}" (optionally waitMs=30000) to wait for and fetch the result.\n- You may do other work in the meantime and call respond again later.\n- Do NOT re-send the same task to the agent.\n- Use action="followup", id="${subagentSessionId}" to inspect recent history without waiting.`
            };
          }
          // ── end async dispatch ──────────────────────────────────────────────

          const response = await conversationService.sendMessage({
            personaId: persona.id,
            message,
            modelId: targetModelId,
            providerId: targetProviderId,
            chatSessionId: existingChatId || undefined,
            streamingMode: StreamingMode.NONE,
            tool_results: undefined,
            toolApprovalMode: existingChatId ? undefined : subagentToolMode,
            parentSessionId: existingChatId ? undefined : state.id,
            providerConfig: parsedProviderConfig,
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
          // Defensively parse stringified providerConfig if passed as string
          let parsedProviderConfig = providerConfig;
          if (typeof providerConfig === 'string' && providerConfig.trim().length > 0) {
            try { parsedProviderConfig = JSON.parse(providerConfig); } catch (e) {}
          }
          const response = await conversationService.sendMessage({
            personaId: existingConv.personaId,
            message,
            chatSessionId: conversationId,
            streamingMode: StreamingMode.NONE,
            providerConfig: parsedProviderConfig,
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
      case "respond": {
        if (!id) {
          return {
            success: false,
            error: "The 'respond' action requires an id (delegationId or sub-agent conversation id).",
            instructions: `## Missing ID\n\nProvide the delegationId returned by an async speakto, or a sub-agent conversation id.\n\n### Recovery Options:\n- Use the delegationId from the "dispatched" response\n- Use \`chats\` with action="personas" and speakto (async=true) to dispatch a new delegation`
          };
        }

        const waitMs = Math.max(0, Math.min(120000, props.waitMs || 30000));
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        // 1. Resolve the delegation record (from the parent conversation's vars).
        const parentConv = await ReactorConversationModel.findOne({ _id: state.id }).lean().exec();
        let record: any = (parentConv?.vars?.subagent_delegations as any)?.[id];
        const delegationId = id;

        if (!record) {
          // 2. Otherwise treat id as a sub-agent conversation id (mirror followup)
          //    and build an implicit record from it.
          const subConv = await ReactorConversationModel.findOne({ _id: id, user: state.context.user }).lean().exec();
          if (!subConv) {
            return {
              success: false,
              error: `No delegation found for id "${id}".`,
              instructions: `## Not Found\n\nNo delegation record or sub-agent conversation with id "${id}".\n\n### Recovery Options:\n- Verify the delegationId from the dispatched response\n- Use \`chats\` with action="personas" and speakto (async=true) to dispatch a new delegation`
            };
          }
          record = {
            status: (subConv.history || []).some((h: any) => h.role === "assistant" && h.content) ? "complete" : "dispatched",
            personaId: subConv.personaId,
            agentName: subConv.personaId,
            subagentSessionId: id,
            startedAt: subConv.started ? new Date(subConv.started).toISOString() : undefined,
          };
        }

        const subagentSessionId = record.subagentSessionId || id;

        // 3. Bounded poll while the delegation is still running.
        let rec = record;
        let waited = 0;
        while (rec.status === "dispatched" && waited < waitMs) {
          await sleep(500);
          waited += 500;
          const fresh = await ReactorConversationModel.findOne({ _id: state.id }).lean().exec();
          const freshRec = (fresh?.vars?.subagent_delegations as any)?.[delegationId];
          if (freshRec) rec = freshRec;
        }

        // 4. Resolve the actual result text. Prefer the stored response; fall back
        //    to the sub-agent conversation's last assistant message (covers implicit
        //    and stale records where the run actually finished).
        let finalResponse: string | undefined = rec.response;
        if (!finalResponse) {
          const subConv = await ReactorConversationModel.findOne({ _id: subagentSessionId }).lean().exec();
          const lastAssistant = [...(subConv?.history || [])].reverse().find((h: any) => h.role === "assistant" && h.content);
          finalResponse = lastAssistant?.content;
          // A stale "dispatched" that actually finished becomes complete.
          if (rec.status === "dispatched" && finalResponse) rec = { ...rec, status: "complete" };
        }

        // 5. Complete branch.
        if (rec.status === "complete") {
          try {
            await ReactorConversationModel.findOneAndUpdate(
              { _id: state.id },
              {
                $set: {
                  [`vars.subagent_delegations.${delegationId}.collected`]: true,
                  [`vars.subagent_delegations.${delegationId}.collectedAt`]: new Date().toISOString(),
                  updated: new Date(),
                },
              }
            ).exec();
          } catch (_) { /* best-effort collected flag */ }

          const content = finalResponse || "";
          return {
            success: true,
            data: {
              status: "complete",
              delegationId,
              subagentSessionId,
              personaId: rec.personaId,
              response: content,
              completedAt: rec.completedAt,
            },
            instructions: `## Delegation Result (complete)\n\n**Agent**: ${rec.agentName || rec.personaId}\n**Delegation**: ${delegationId}\n\n${content}\n\n### Suggested Next Steps:\n- Use this result to continue your task\n- For the full sub-agent transcript use action="followup", id="${subagentSessionId}"`
          };
        }

        // 6. Error branch.
        if (rec.status === "error") {
          return {
            success: true,
            data: {
              status: "error",
              delegationId,
              subagentSessionId,
              personaId: rec.personaId,
              error: rec.error,
              completedAt: rec.completedAt,
            },
            instructions: `## Delegation Failed\n\n**Agent**: ${rec.agentName || rec.personaId}\n**Delegation**: ${delegationId}\n\nError: ${rec.error}\n\n### Suggested Next Steps:\n- Retry with action="speakto", id="${rec.personaId}", message=..., async=true\n- Or investigate the error before retrying`
          };
        }

        // 7. Still running — return recent history so the caller can decide.
        const runSubConv = await ReactorConversationModel.findOne({ _id: subagentSessionId }).lean().exec();
        const recentHistory = (runSubConv?.history || []).slice(-3).map((item: any) => ({
          role: item.role,
          content: item.content,
          tool_calls: item.tool_calls,
          tool_results: item.tool_results,
          timestamp: item.timestamp,
        }));
        return {
          success: true,
          data: {
            status: "running",
            delegationId,
            subagentSessionId,
            personaId: rec.personaId,
            waitedMs: waited,
            recentHistory,
          },
          instructions: `## Delegation Still Running\n\n**Agent**: ${rec.agentName || rec.personaId}\n**Delegation**: ${delegationId}\n\nThe sub-agent is still working (waited ${waited}ms).\n\n### Suggested Next Steps:\n- Do other work, then call action="respond", id="${delegationId}" again to keep polling\n- Use action="followup", id="${subagentSessionId}" to inspect recent history without waiting`
        };
      }
      case "clear": {
        const chats = await ReactorConversationModel.find({
          user: state.context.user,
          parentSessionId: { $in: [null, undefined] },
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
    `| speakto   | required | optional | Delegate to another agent. If message is provided, sends it and returns the response. Automatically resumes previous conversation with the same persona. If message is omitted, switches the active persona. Set async=true to dispatch in background (returns delegationId immediately; collect later with respond). |`,
    `| respond   | required | —        | Retrieve the result of an async speakto delegation. id is the delegationId (or sub-agent conversation id). Polls up to waitMs (default 30s) and returns complete/error/running. |`,
    `| followup  | required | optional | Follow up on a sub-agent conversation. id can be a persona ID (auto-resolves stored conversation) or a direct conversation ID. If message is provided, sends it to the sub-agent. Returns recent history. Use historyCount to control how mToolApprovalMode items (default: 2). |`,
    `| clear     | —        | —        | Delete all chat sessions for the current user |`,
    ``,
    `## How sub-agent conversations work`,
    `- When you use \`speakto\` with a message, the sub-agent's conversation ID is stored in vars as \`subagent_chat_{personaId}\`.`,
    `- Subsequent \`speakto\` calls to the same persona automatically resume the same conversation.`,
    `- Use \`followup\` to inspect history or send follow-up messages without switching context.`,
    `- Sub-agents default to safe_auto tool approval mode (auto if primary agent is in auto mode).`,
    `- **Non-blocking delegation:** use \`speakto\` with \`async=true\`. The tool returns immediately with status "dispatched" and a \`delegationId\`; the sub-agent runs in the background. Call \`respond\` with that delegationId to wait for and fetch the result (polls up to waitMs, default 30s). The delegation record is persisted in the parent conversation's vars under \`subagent_delegations\`.`,
    `- When an async delegation completes and the parent session is idle, a compact callback message is pushed into the parent session automatically (suppress with \`wakeParent=false\`).`,
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
    {
      feature: "respond",
      featureType: Reactory.FeatureType.function,
      action: ["respond"],
      description: "Retrieve the result of an async (non-blocking) speakto delegation by delegationId",
      stem: "respond",
    },
  ],
  stem: "chats",
  tags: ["chats", "continue", "delete", "export", "train", "personas", "speakto", "followup", "respond", "delegation", "async", "non-blocking"],
  tools: [
    {
      type: "function",
      function: {
        name: "chats",
        description: "Manage chat sessions: list, create, continue, delete, or export sessions. Delegate questions to other AI agents via the 'speakto' action. Use 'personas' to discover available agent ids before calling 'speakto'. For long-running sub-agent tasks, use speakto with async=true (returns immediately with a delegationId) and retrieve the result later with action='respond'.",
        icon: "chat",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "new", "size", "cont", "del", "exp", "train", "personas", "speakto", "followup", "respond", "clear"],
              description: "The action to perform. Use 'personas' to list available agents before 'speakto'. Use 'followup' to inspect or continue a sub-agent conversation. Use 'respond' to retrieve the result of an async speakto delegation.",
            },
            id: {
              type: "string",
              description: "A chat session id (for cont, del, exp), an agent persona id (for speakto, followup), a direct conversation id (for followup), or a delegationId from an async speakto (for respond). Required for del, speakto, followup, and respond; optional for cont and exp.",
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
              description: "Optional model to use for the action. Accepts either the model id (e.g. 'gpt-5.4') or the display name (e.g. 'GPT-5.4'); names are resolved to ids automatically. If omitted, the current session's model is used.",
            },
            provider: {
              type: "string",
              description: "Optional provider for the action. Accepts either the provider id (e.g. 'openai') or the display name (e.g. 'OpenAI'); names are resolved to ids automatically. If omitted, the persona's default provider is used.",
            },
            historyCount: {
              type: "number",
              description: "Number of recent history items to return for the 'followup' action (default: 2).",
            },
            async: {
              type: "boolean",
              description: "Used with 'speakto' (and a message). When true, dispatches the delegation non-blocking: returns immediately with status 'dispatched' and a delegationId; the sub-agent runs in the background. Retrieve the result later with action='respond', id=<delegationId>. Default false (blocking).",
            },
            wakeParent: {
              type: "boolean",
              description: "Used with async 'speakto'. When false, suppresses the automatic callback message pushed into the parent session when the delegation completes. Default true.",
            },
            waitMs: {
              type: "number",
              description: "Used with 'respond'. Milliseconds to wait for a running delegation before returning 'running' status. Clamped to 0–120000. Default 30000.",
            },
            providerConfig: {
              type: "object",
              description: "Optional provider configuration (e.g. structuredOutput schema).",
            },
          },
          required: ["action"],
        },
      },
    },
  ],
  alias: "chats",
};