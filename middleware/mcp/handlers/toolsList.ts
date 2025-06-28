import { Response } from "express";
import { RPCResponse } from "../rpcUtils";
import Reactory from "@reactory/reactory-core";
import ReactorMacroService from "@reactory/server-modules/reactory-reactor/services/reactor/providers/ReactorMacroService";
import { MacroComponentDefinition, MacroToolDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";

export async function toolsList(req: Reactory.Server.ReactoryExpressRequest, res: Response) {
 const { context } = req;
 context.debug("[MCP] Listing tools...", null, 'toolsList');
 const macroService = context.getService<ReactorMacroService>("reactor.ReactorMacroService@1.0.0");
 if (!macroService) {
   context.error("[MCP] ReactorMacroService not found", null, 'toolsList');
   return RPCResponse(
     {
       error: "ReactorMacroService not found"
     },
     req.body.id
   );
 }
 const macros = macroService.listMacros();
 const tools: any[] = [];

 macros.forEach((macro: MacroComponentDefinition<unknown>) => {
       let hasAccess = false;
       if (macro.roles && macro.roles.length > 0) { 
         hasAccess = context.hasAnyRole(macro.roles);
         if (hasAccess === false) {
           return;
         }
       } 
       else hasAccess = true;
       
       if (macro.tools && hasAccess === true) {
         macro.tools.forEach((tool: MacroToolDefinition) => {
           if (tool.type === "function") {
             const { function: func } = tool;
             const toolDefinition = {
               name: func.name,
               description: func.description || "",
               inputSchema: func.parameters,
             };
             tools.push(toolDefinition);
           }
         });
       }
     });
  return RPCResponse(
    {
      tools: [...tools],
      count: tools.length
    },
    req.body.id
  );
}

export default toolsList;