import { mutation, property, resolver } from "@reactory/server-core/models/graphql/decorators/resolver";
import { MacroComponentDefinition } from "modules/reactory-reactor/ai/openai/types/chat";
import ReactorConversationService from "modules/reactory-reactor/services/reactor/ReactorConversationService";

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
    return await conversationService.executeMacro(args.macroInput);
  }

  @property("ReactorMacro", "id")
  async getMacroId(macro: Partial<MacroComponentDefinition<unknown>>, args: any, context: Reactory.Server.IReactoryContext): Promise<string | null> { 
    if (!macro) return null;    
    return new (require('mongodb').ObjectId)(
      context.utils.hash(
        `${macro.nameSpace || "reactory-commons"}.${macro.name}@${macro.version || "1.0.0"}`
      )).toString();
  }
}

export default ReactorMacroResolver;
