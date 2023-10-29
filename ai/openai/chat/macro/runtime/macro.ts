import Reactory from "@reactory/reactory-core";
import { ChatState, Macro } from "../../../types/chat";
import { executeMacro } from "..";


export const VariableMacro: Macro<string> = async (
  args: any[],
  state: ChatState) => {
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