import { mutation, property, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";
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

  @property("ReactorToolDefinition", "id")
  async getToolId(tool: Partial<MacroToolDefinition>, args: any, context: Reactory.Server.IReactoryContext): Promise<string | null> {
    if (!tool?.function?.name) return null;
    return new (require('mongodb').ObjectId)(context.utils.hash(tool.function.name)).toString();
  }

  @property("ReactorToolDefinition", "runat")
  async getToolRunAt(tool: Partial<MacroToolDefinition>, args: any, context: Reactory.Server.IReactoryContext): Promise<ReactorMacroRunAt | null> {
    return tool.runat || "server";
  }
}

export default ReactorToolResolver;
