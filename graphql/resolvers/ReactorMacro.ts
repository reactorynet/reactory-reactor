import { mutation, property, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";
import { MacroComponentDefinition, MacroToolDefinition } from "modules/reactory-reactor/ai/openai/types/chat";
import ReactorConversationService from "modules/reactory-reactor/services/reactor/ReactorConversationService";
import { StreamingTransportManager } from "modules/reactory-reactor/services/reactor/StreamingTransportManager";
import { StreamingEventFactory } from "modules/reactory-reactor/services/reactor/streaming/StreamingEventFactory";
import { ObjectId } from "mongodb";

@resolver
class ReactorMacroResolver {
  resolver: any;

  @mutation("ReactorExecuteMacro")
  async ReactorExecuteMacro(_: any, args: { 
    macroInput: { 
      macro: string, 
      personaId: string,
      calledBy: string, 
      chatSessionId: string,
      callId?: string,
      args?: any }
  }, context: Reactory.Server.IReactoryContext) {
    const conversationService = context.getService<ReactorConversationService>("reactor.ReactorConversationService@1.0.0");
    const result = await conversationService.executeMacro(args.macroInput);

    // Emit an SSE tool_call completion event so the client can update
    // the tool status to 'success' in real-time (mirrors the AUTO mode
    // pattern in sendMessage). Best-effort — SSE failure must not break
    // the GraphQL response.
    const { chatSessionId, callId, macro: macroName } = args.macroInput;
    if (callId && chatSessionId) {
      try {
        const transportManager: StreamingTransportManager = context.getService<StreamingTransportManager>("reactor.StreamingTransportManager@1.0.0");
        if (transportManager.hasActiveTransportForChat(chatSessionId)) {
          // Extract a displayable result for the SSE event
          const toolResultContent = result?.tool_results?.[0]?.content
            ?? result?.tool_results?.[0]?.result
            ?? result?.content
            ?? undefined;
          const toolCompleteEvent = StreamingEventFactory.createToolCallEvent(
            callId,
            macroName,
            JSON.stringify(args.macroInput.args || {}),
            true, // isComplete
            toolResultContent,
            {
              sessionId: chatSessionId,
              conversationId: chatSessionId,
              messageId: new ObjectId().toString(),
            },
          );
          await transportManager.sendEventToSession(chatSessionId, toolCompleteEvent);
        }
      } catch (sseError: any) {
        context.warning(
          `[ReactorExecuteMacro] Failed to send tool_call completion SSE event: ${sseError.message}`,
          { macroName, chatSessionId, callId },
        );
      }
    }

    return result;
  }

  @property("ReactorMacro", "id")
  async getMacroId(macro: Partial<MacroComponentDefinition<unknown>>, args: any, context: Reactory.Server.IReactoryContext): Promise<string | null> { 
    if (!macro) return null;    
    return new (require('mongodb').ObjectId)(
      context.utils.hash(
        `${macro.nameSpace || "reactory-commons"}.${macro.name}@${macro.version || "1.0.0"}`
      )).toString();
  }

  @property("ReactorMacro", "runat")
  getMacroRunat(macro: Partial<MacroComponentDefinition<unknown>>, args: any, context: Reactory.Server.IReactoryContext): string {
    if (!macro) return "server";
    return macro.runat || "server"
  }

  @property("ReactorMacro", "category")
  getMacroCategory(macro: Partial<MacroComponentDefinition<unknown>>): string | null {
    return macro.category || null;
  }

  @property("ReactorTool", "runat") 
  getToolRunat(tool: Partial<MacroToolDefinition>): string {
    return tool.runat || "server"
  }
}

export default ReactorMacroResolver;
