import { service } from "@reactory/server-core/application/decorators/service";
import { MacroComponentDefinition, Macro, MacroFunctions, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { 
 MacroRegistry as DefaultMacroRegistry, 
 executeMacro, 
 processMacroInstructionSet, 
 getMacro 
} from "@reactory/server-modules/reactory-reactor/ai/openai/chat/macro/index";
import Reactory from "@reactory/reactory-core";
import AIPersonaProvider from "../AIPersonaProvider";

@service({
  id: "reactor.ReactorMacroService@1.0.0",
  name: "Reactory Macro Service",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for managing and executing macros",
  serviceType: "macro",
})
class ReactorMacroService implements Reactory.Service.IReactoryService {
  private macroRegistry: MacroComponentDefinition<unknown>[];
  private context: Reactory.Server.IReactoryContext;
  constructor(props, context) {
    // Clone the default registry to allow runtime extension
    this.macroRegistry = [];
    this.context = context;
    this.collectMacros();
  }
  description?: string = "Service for managing and executing macros";
  tags?: string[];
  toString?(includeVersion?: boolean): string {
    return `ReactorMacroService${includeVersion ? `@${this.version}` : ''}`;
  }
  nameSpace: string = "reactor";
  name: string = "ReactorMacroService";
  version: string = "1.0.0";

  collectMacros(): void { 
    // Collect macros from the default registry
    this.macroRegistry = DefaultMacroRegistry.map(macro => ({ ...macro }));
    // Collect macros from all modules in the context
    type ModuleWithReactor = typeof this.context.modules[number] & { reactor?: { macros?: MacroComponentDefinition<unknown>[] } };
    (this.context.modules as ModuleWithReactor[]).forEach(module => { 
      if (Array.isArray(module.reactor?.macros)) {
        module.reactor?.macros.forEach((macro: MacroComponentDefinition<unknown>) => {
          if (macro && macro.name && macro.component) {
            this.addMacro(macro);
          } else {
            this.context.error("Invalid macro definition", { macro }, "ReactorMacroService.collectMacros");
          }
        });
      }
    })
  }


  listMacros(): MacroComponentDefinition<unknown>[] {
    // return only macros that the user has access to
    if (!this.macroRegistry || this.macroRegistry.length === 0) {
      this.context.error("No macros found in registry", null, "ReactorMacroService.listMacros");
      return [];
    }

    const filtered = this.macroRegistry.filter(macro => {
      if (macro.roles && macro.roles.length > 0) {
        return this.context.hasAnyRole(macro.roles);
      }
      return true; // No roles defined, so accessible to all
    });

    return filtered;
  }

  async listMacrosForPersona(personaId: string): Promise<MacroComponentDefinition<unknown>[]> {
    // return only macros that the persona has access to
    if (!this.macroRegistry || this.macroRegistry.length === 0) {
      this.context.error("No macros found in registry", null, "ReactorMacroService.listMacrosForPersona");
      return [];
    }

  
    // load the persona from using AIPersonaProvider service
    const personaProvider =  this.context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0");
    if (!personaProvider) {
      this.context.error("AIPersonaProvider service not found", null, "ReactorMacroService.listMacrosForPersona");
      return [];
    }
    const persona = await personaProvider.getPersona(personaId);
    if (!persona) {
      this.context.error(`Persona with id ${personaId} not found`, { personaId }, "ReactorMacroService.listMacrosForPersona");
      return [];
    }
    // use the persona macros to assign the persona to the macro    
    const filtered = this.macroRegistry.filter(macro => {            
      // check if the persona has access to the macro
      let allowed = false;
      persona.macros?.forEach((personaMacro) => {
        if (
          macro.nameSpace === personaMacro.nameSpace &&
          macro.name === personaMacro.name && 
          macro.version === personaMacro.version) {
            // check if the macro has roles defined
          if (macro.roles && macro.roles.length > 0) {
            allowed = this.context.hasAnyRole(macro.roles);
          } else {
            allowed = true; // No roles defined, so accessible to all
          }
        }        
      });
      return allowed;
    });

    return filtered;
  }

  getMacro<T = unknown>(name: string): Macro<T> | undefined {
    const macroDef = this.macroRegistry.find(m => m.name === name);
    if (!macroDef) { 
      this.context.error(`Macro ${name} not found in registry`, { name }, "ReactorMacroService.getMacro");
      return undefined;
    }

    if (macroDef.roles && macroDef.roles.length > 0) { 
      const hasAccess = this.context.hasAnyRole(macroDef.roles);
      if (!hasAccess) {
        this.context.error(`Access denied for macro ${name}`, { roles: macroDef.roles }, "ReactorMacroService.getMacro");
        return undefined;
      }
    }

    return macroDef?.component as unknown as Macro<T>;
  }

  getMacroFromTool(toolName: string): Macro<T> | undefined {
    const macroDef = this.macroRegistry.find(m => m.tools?.some(tool => tool.function?.name === toolName));
    return macroDef?.component as unknown as Macro<T>;
  }

  async executeTool<T = unknown>(toolName: string, params: any, state: ChatState): Promise<any> { 
    // Use the macro registry in this service
    const macro = this.getMacroFromTool(toolName);
    if (macro && typeof macro === "function") {
      return await macro(params, state) as T;
    } else {
      throw new Error(`Tool ${toolName} not found`);
    }
  }
 
  async executeMacro<T = unknown>(macro: string, state: ChatState): Promise<any> {
    // Use the macro registry in this service
    const regex = /@(\w+)\((.*?)\)/g;
    const match = regex.exec(macro);
    if (!match) throw new Error(`Invalid macro format: ${macro}`);
    const [_macro, ...params] = match.slice(1);
    const splitParams = params[0].split(',');
    const macroToExecute = this.getMacro<T>(_macro);
    if (macroToExecute && typeof macroToExecute === "function") {
      return await macroToExecute([...splitParams], state) as T;
    } else {
      throw new Error(`Macro ${_macro} not found`);
    }
  }

  async processMacroInstructionSet(macros: string[], state: ChatState): Promise<any> {
    // Use the macro registry in this service
    let nextState: ChatState = { ...state };
    let hasErrors: boolean = false;
    let results: any[] = [];
    let ids = '';
    if (macros && macros.length > 0) {
      for (const macro of macros) {
        try {
          const result = await this.executeMacro(macro, nextState);
          ids += macro;
          results.push({ macro, value: result, error: undefined, state: nextState });
        } catch (err) {
          hasErrors = true;
          results.push({ macro, value: undefined, error: err.message || 'Unknown error', state: nextState });
        }
      }
    }
    return {
      id: ids,
      hasErrors,
      results,
      state: nextState,
    };
  }

  addMacro(def: MacroComponentDefinition<unknown>): void {
    this.macroRegistry.push(def);
  }

  addMacros(defs: MacroComponentDefinition<unknown>[]): void {
    this.macroRegistry.push(...defs);
  }
}

export default ReactorMacroService;

