import Reactory from "@reactory/reactory-core";
import { ChatState, Macro } from "../../../types/chat";
import { executeMacro } from "..";
import modules from '@reactory/server-core/modules';

export const VariableMacro: Macro<unknown> = async (
  args: any[],
  state: ChatState): Promise<unknown> => {
  const [k, v] = args;
  try {
    if(k === 'get') {
      return state.vars[v];
    }

    if(k === 'del') {
      delete state.vars[k];
    }

    if(state.vars[k]) {
      if(v && typeof v === 'string' && v.startsWith('@')) {
        // process the inner macro
        const result = await executeMacro<unknown>(v, state);
        state = result.state;
        state.vars[k] = result.error ? result.error : result.value;
      } else {
        state.vars[k] = v;
      }
    }
  } catch (err) {
    return `Error in variable macro`;
  }
};

export const VariableMacroRegistry: Reactory.IReactoryComponentDefinition<typeof VariableMacro> = {
  nameSpace: 'reactor-macros',
  name: 'var',
  version: '1.0.0',
  component: VariableMacro,
  description: `# var macro
  Use this macro to store, retrieve or remove a variable
  
  ## Usage
  @var(key2, value) - sets the value
  @var(key2, @macro(some/param)) - sets the value after it executes the nested macro
  @var(key2) - returns the value
  `,
  features: [
    {
      feature: 'set',
      featureType: Reactory.FeatureType.function,
      action: ['set', 'put', 'stores', 'saves', 'persist'],
      description: 'Operation that stores or saves a variable.',
      stem: 'set'
    },
    {
      feature: 'get',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'retrieve', 'fetch value'],
      description: 'Operation that retrieves a variable.',
      stem: 'set'
    }
  ],
  stem: 'fetch',
  tags: ['fetch', 'http', 'url', 'data'],
}

// a macro that describes modules installed in reactory
export const ModuleMacro: Macro<unknown> = async (
  args: any[],
  state: ChatState): Promise<unknown> => {    
    const describeModule = (module: Reactory.Server.IReactoryModule) => { 
      return `
      Module Id: ${module.nameSpace}.${module.name}@${module.version}
      Depencies: ${module.dependencies.map((dep) => `${dep}`).join('\n')}
      Services:
      ${module.services.map((service) => `\t${service.id}`).join('\n')} 
      `
    };
    let moduleText =  `Enabled Modules: ${modules.enabled?.map((mod) => { return describeModule(mod) })}`;    
    return moduleText;
};

export const ModuleMacroRegistry: Reactory.IReactoryComponentDefinition<typeof ModuleMacro> = { 
  nameSpace: 'reactor-macros',
  name: 'modules',
  version: '1.0.0',
  component: ModuleMacro,
  description: `# modules macro
  Use this macro to list the modules installed in reactory
  
  ## Usage
  @modules - lists the modules installed in reactory
  `,
  features: [
    {
      feature: 'list',
      featureType: Reactory.FeatureType.function,
      action: ['list', 'show', 'display'],
      description: 'Operation that lists the modules installed in reactory.',
      stem: 'list'
    }
  ],
  stem: 'list',
  tags: ['list', 'modules', 'installed'],
}