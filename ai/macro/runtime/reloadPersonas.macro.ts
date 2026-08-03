import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/types/macro.types";
import AIPersonaProvider from "../../../services/reactor/AIPersonaProvider";

export const ReloadPersonasMacro: Macro<unknown, unknown> = async (
  props: unknown,
  state: ChatState,
  context: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  try {
    // Resolve AIPersonaProvider
    const personaProvider = context.getService<AIPersonaProvider>("reactor.AIPersonaProvider@1.0.0");
    if (!personaProvider) {
      throw new Error("AIPersonaProvider service not found");
    }

    const result = await personaProvider.reloadPersonas();

    return {
      success: true,
      totalLoaded: result.totalLoaded,
      instructions: `## Personas Reloaded Successfully\n\nSuccessfully reloaded **${result.totalLoaded}** AI personas from the modules and user directories.`
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      error: errMsg,
      instructions: `## Failed to Reload Personas\n\nError: ${errMsg}`
    };
  }
};

export const ReloadPersonasMacroRegistry: MacroComponentDefinition<typeof ReloadPersonasMacro> = {
  nameSpace: 'reactor-macros',
  name: 'reloadPersonas',
  version: '1.0.0',
  alias: 'reloadPersonas',
  component: ReloadPersonasMacro,
  category: 'Runtime',
  description: `# reloadPersonas macro
  Use this macro to dynamically reload all AI personas from disk (module directories and ~/.reactor/ai/persona) into the application memory.

  ## Usage
  @reloadPersonas()
  `,
  features: [
    {
      feature: 'reload',
      featureType: Reactory.FeatureType.function,
      action: ['reload', 'refresh', 'repopulate'],
      description: 'Operation that dynamically reloads all AI personas.',
      stem: 'reload'
    }
  ],
  roles: ['USER'],
  stem: 'reloadPersonas',
  tags: ['personas', 'reload', 'refresh', 'runtime'],
  tools: [{
    type: "function",
    safeForAutoExecution: true,
    function: {
      name: "reloadPersonas",
      description: "Dynamically reload all AI personas from disk (module directories and ~/.reactor user directory) into memory.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  }]
};
