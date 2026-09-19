import { mutation, property, query, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";
import { MacroToolDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import ReactorConversationService from "@reactory/server-modules/reactory-reactor/services/reactor/ReactorConversationService";

//@ts-ignore
@resolver
class ReactorToolResolver {
  resolver: any;

  @mutation("ReactorExecuteTool")
  async ReactorExecuteTool(_: any, args: { tool: string, personaId: string, chatSessionId: string, callId?: string, args?: any }, context: Reactory.Server.IReactoryContext) {
    const conversationService = context.getService<ReactorConversationService>("reactor.ReactorConversationService@1.0.0");
    return await conversationService.executeTool({
      tool: args.tool,
      personaId: args.personaId,
      chatSessionId: args.chatSessionId,
      toolArgs: args.args,
      callId: args.callId,
    });
  }

  @mutation("ReactorCompleteClientToolCalls")
  async ReactorCompleteClientToolCalls(
    _: any,
    args: {
      chatSessionId: string;
      personaId: string;
      results: Array<{
        toolCallId: string;
        toolName: string;
        result?: any;
        isError?: boolean;
        error?: string;
      }>;
      continueProcessing?: boolean;
      streamingMode?: string;
    },
    context: Reactory.Server.IReactoryContext,
  ) {
    const conversationService = context.getService<ReactorConversationService>("reactor.ReactorConversationService@1.0.0");
    return await conversationService.completeClientToolCalls({
      chatSessionId: args.chatSessionId,
      personaId: args.personaId,
      results: args.results,
      continueProcessing: args.continueProcessing,
      streamingMode: args.streamingMode as any,
    });
  }

  /**
   * Reconcile the client's advertised macros and tools onto an existing session.
   *
   * Call this on **every** session establish, not only on creation. A client's
   * capabilities were previously recorded just once, at creation, so a reload, a
   * new tab or a reconnect left a stale set on the session. When the recorded set
   * no longer matches what the browser can run, a tool the client is perfectly
   * able to execute goes unrecognised server-side and the turn dies on a macro
   * error — the failure is not a missing feature, it is a broken conversation.
   *
   * Idempotent and safe to call repeatedly. `macros`/`tools` omitted means "no
   * change"; an explicit empty array clears the client-reported set.
   */
  @mutation("ReactorSyncClientCapabilities")
  async ReactorSyncClientCapabilities(
    _: any,
    args: { chatSessionId: string; macros?: any[] | null; tools?: any[] | null },
    context: Reactory.Server.IReactoryContext,
  ) {
    const conversationService = context.getService<ReactorConversationService>("reactor.ReactorConversationService@1.0.0");
    return await conversationService.syncClientCapabilities({
      chatSessionId: args.chatSessionId,
      macros: args.macros ?? undefined,
      tools: args.tools ?? undefined,
    });
  }

  /**
   * Client-routed tool calls in a session that still have no result.
   *
   * The replay half of the contract. When a client executes a client-side tool
   * and the completion call then fails — dropped connection, closed tab, a
   * browser that slept mid-request — the assistant message keeps a `tool_call`
   * that nothing ever answers, leaving the transcript permanently malformed.
   * A client that reconnects can ask this question and re-report whatever is
   * outstanding, instead of the session staying broken forever.
   */
  @query("ReactorPendingClientToolCalls")
  async ReactorPendingClientToolCalls(
    _: any,
    args: { chatSessionId: string },
    context: Reactory.Server.IReactoryContext,
  ) {
    const conversationService = context.getService<ReactorConversationService>("reactor.ReactorConversationService@1.0.0");
    return await conversationService.getPendingClientToolCalls({
      chatSessionId: args.chatSessionId,
    });
  }

  @property("ReactorToolDefinition", "id")
  async getToolId(tool: Partial<MacroToolDefinition>, args: any, context: Reactory.Server.IReactoryContext): Promise<string | null> {
    if (!tool?.function?.name) return null;
    return new (require('mongodb').ObjectId)(context.utils.hash(tool.function.name)).toString();
  }

  @property("ReactorToolDefinition", "runat")
  async getToolRunAt(tool: Partial<MacroToolDefinition>, args: any, context: Reactory.Server.IReactoryContext): Promise<ReactorMacroRunAt | null> {
    return tool.runat || "server";
  }

  @property("ReactorToolDefinition", "modes")
  async getToolModes(tool: Partial<MacroToolDefinition>): Promise<string[] | null> {
    return tool.modes || null;
  }

  @property("ReactorToolDefinition", "safeForAutoExecution")
  async getToolSafeForAutoExecution(tool: Partial<MacroToolDefinition>): Promise<boolean | null> {
    return tool.safeForAutoExecution ?? null;
  }

  @property("ReactorToolDefinition", "category")
  getToolCategory(tool: Partial<MacroToolDefinition>): string | null {
    return tool.category || null;
  }
}

export default ReactorToolResolver;
