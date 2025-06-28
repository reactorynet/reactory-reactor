import Reactory from "@reactory/reactory-core";
import { ChatState, Macro, MacroComponentDefinition, MacroToolDefinition } from "../../../types/chat";
import { executeMacro } from "..";
import modules from '@reactory/server-core/modules';
import { AddMacroProps, VariableMacroProps, ModuleMacroProps, EnvironmentMacroProps, StateMacroProps } from './types';

/**
 * A macro that allows the user to or the llm to add a function to the chat state.
 * This is useful for creating custom functions that can be used in the chat.
 * @param props - The props for the macro containing name, func, description, and parameters
 * @param state 
 */
export const AddMacro: Macro<unknown, AddMacroProps> = async (
  props: AddMacroProps,
  state: ChatState): Promise<unknown> => {
  
  const { name, func, description, parameters } = props;
  if(!name || !func) {
    return `Error: Macro name and function are required`;
  }

  // the func will be text that we need to evaluate 
  // to create the function
  let macroFunc;

  try {
    macroFunc = eval(func);
  } catch (err) {
    return `Error: Could not create macro function: ${err}`;
  }
  if(typeof macroFunc !== 'function') {
    return `Error: Macro function is not a function`;
  }
  // add the macro to the state
  state.macros.push({ 
    name,
    nameSpace: 'runtime-macro',
    description,
    version: '1.0.0',
    features: [],
    component: macroFunc,
    tools: [{
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties: parameters,
          required: Object.keys(parameters)
        }
      }
    }]
  });

  return `Macro ${name} added to state: use @${name} to call it`;
}

export const AddMacroRegistry: MacroComponentDefinition<typeof AddMacro> = {
  nameSpace: 'reactor-macros',
  name: 'addMacro',
  version: '1.0.0',
  component: AddMacro,
  roles: ['ADMIN', 'DEVELOPER'],
  description: `# addMacro
  Use this macro to create a new macro at runtime [Experimental]
  ## Usage
  @addMacro(name, function, description, parameters) - creates a new macro
  @addMacro(name, function) - creates a new macro with no description or parameters
  @addMacro(name, function, description) - creates a new macro with no parameters
  `,
  features: [
    {
      feature: 'addMcro',
      featureType: Reactory.FeatureType.function,
      action: ['add', 'create', 'define'],
      description: 'Operation that creates a new macro.',
      stem: 'add'
    }
  ],
  stem: 'create',
  tags: ['create', 'macro', 'function'],
  tools: [{
    type: "function",
    function: {
      name: "addMacro",
      description: "Creates a new macro at runtime",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the macro"
          },
          func: {
            type: "string",
            description: "The function code as a string"
          },
          description: {
            type: "string",
            description: "Description of the macro"
          },
          parameters: {
            type: "object",
            description: "Parameters for the macro"
          }
        },
        required: ["name", "func"]
      }
    }
  }]
}

// a macro that allows the user to store, retrieve or remove a variable in the chat state
export const VariableMacro: Macro<unknown, VariableMacroProps> = async (
  props: VariableMacroProps,
  state: ChatState): Promise<unknown> => {
  const { key, value } = props;
  try {

    if(!state) {
      return `Error: Chat state is not defined`;
    }

    if(!state.vars) {
      state.vars = {};
    }

    if(value === undefined || value === null) {
      return state.vars[key || ''];
    }

    if(value === 'del') {
      delete state.vars[key];
      return `Variable ${key} deleted`;
    }

    if(value && typeof value === 'string' && value.startsWith('@')) {
      // process the inner macro
      const result = await executeMacro<unknown>(value, state);
      state = result.state;
      state.vars[key] = result.error ? result.error : result.value;
    } else {
      state.vars[key] = value;
    }
    
    return `Variable ${key} set to ${value}`;
  } catch (err) {
    return `Error in variable macro: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
};

export const VariableMacroRegistry: MacroComponentDefinition<typeof VariableMacro> = {
  nameSpace: 'reactor-macros',
  name: 'var',
  version: '1.0.0',
  component: VariableMacro,
  roles: ['ADMIN', 'DEVELOPER'],
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
  tools: [{
    type: "function",
    function: {
      name: "var",
      description: "Store, retrieve or remove a variable in the chat state",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "The key for the variable to set, get or delete"
          },
          value: {
            type: "string",
            description: "The value to set for the variable (omit for get operation, use 'del' for delete)"
          },
        },
        required: ["key"]
      }
    }
  }]
}

// a macro that describes modules installed in reactory
export const ModuleMacro: Macro<unknown, ModuleMacroProps> = async (
  props: ModuleMacroProps,
  state: ChatState): Promise<unknown> => {    
    const { details = false } = props;
    
    const describeModule = (module: Reactory.Server.IReactoryModule) => { 
      if (details) {
        return `
        Module Id: ${module.nameSpace}.${module.name}@${module.version}
        Dependencies: ${module.dependencies.map((dep) => `${dep}`).join('\n')}
        Services:
        ${module.services.map((service) => `\t${service.id}`).join('\n')} 
        `;
      } else {
        return `${module.nameSpace}.${module.name}@${module.version}`;
      }
    };
    
    let moduleText = `Enabled Modules: \n${modules.enabled?.map((mod) => { return describeModule(mod) }).join('\n')}`;    
    return moduleText;
};

export const ModuleMacroRegistry: MacroComponentDefinition<typeof ModuleMacro> = { 
  nameSpace: 'reactor-macros',
  name: 'modules',
  version: '1.0.0',
  component: ModuleMacro,
  roles: ['ADMIN', 'DEVELOPER'],
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
  tools: [{
    type: "function",
    function: {
      name: "modules",
      description: "Lists modules installed in the Reactory system",
      parameters: {
        type: "object",
        properties: {
          details: {
            type: "boolean",
            description: "Show detailed information about the modules"
          }
        },
        required: []
      }
    }
  }]
}

// a macro that provides information about the environment variables
export const EnvironmentMacro: Macro<unknown, EnvironmentMacroProps> = async (
  props: EnvironmentMacroProps,
  state: ChatState): Promise<unknown> => {
    const { envKey } = props;
    
    // If a specific environment variable is requested
    if(envKey && typeof envKey === 'string') {
      return process.env[envKey] || `Environment variable ${envKey} not found`;
    }
    
    // Return all environment variables (or a safe subset)
    const safeEnvVars: Record<string, string> = {};
    // Option to filter sensitive variables or only include specific ones
    const allowedVars = [
      'NODE_ENV', 
      'PORT', 
      'HOST', 
      'APP_VERSION', 
      'APP_NAME', 
      'REACTORY_HOME', 
      'REACTORY_SERVER',
      'REACTORY_CLIENT',
      'REACTORY_DATA',
      'REACTORY_NATIVE',
      'HOME'
    ];
    
    allowedVars.forEach(varName => {
      if (process.env[varName]) {
        safeEnvVars[varName] = process.env[varName] as string;
      }
    });
    
    return JSON.stringify(safeEnvVars, null, 2);
};

export const EnvironmentMacroRegistry: MacroComponentDefinition<typeof EnvironmentMacro> = {
  nameSpace: 'reactor-macros',
  name: 'env',
  version: '1.0.0',
  component: EnvironmentMacro,
  roles: ['ADMIN', 'DEVELOPER'],
  description: `# env macro
  Use this macro to access environment variables

  ## Usage
  @env - returns a JSON object with safe environment variables
  @env(VAR_NAME) - returns the value of the specific environment variable
  `,
  features: [
    {
      feature: 'list',
      featureType: Reactory.FeatureType.function,
      action: ['list', 'show', 'display'],
      description: 'Operation that shows environment variables.',
      stem: 'list'
    },
    {
      feature: 'get',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'fetch', 'retrieve'],
      description: 'Operation that gets a specific environment variable.',
      stem: 'get'
    }
  ],
  stem: 'environment',
  tags: ['env', 'environment', 'variables', 'config'],
  tools: [{
    type: "function",
    function: {
      name: "env",
      description: "Access environment variables",
      parameters: {
        type: "object",
        properties: {
          envKey: {
            type: "string",
            description: "The name of the environment variable to retrieve"
          }
        },
        required: []
      }
    }
  }]
}

// A macro that provides information about the current chat state
export const StateMacro: Macro<unknown, StateMacroProps> = async (
  props: StateMacroProps,
  state: ChatState): Promise<unknown> => {
    // clone the state to avoid modifying the original
    
    const safe_state = { 
      vars: state.vars,
      id: state.id,
      host: state.host,
      user: {
        id: state.user.id,
        email: (state.user as any).loggedIn?.user?.email,
        name: (state.user as any).loggedIn?.user?.name,
        lastName: (state.user as any).loggedIn?.user?.lastName,
      },
      botId: state.personaId,
      persona: state.persona,
      modelId: state.modelId,
      created: state.created,
      updated: state.updated,
    };

    return JSON.stringify(safe_state);
};

export const StateMacroRegistry: MacroComponentDefinition<typeof StateMacro> = {
  nameSpace: 'reactor-macros',
  name: 'state',
  version: '1.0.0',
  component: StateMacro,
  description: `# state macro
  Use this macro to access the current chat state

  ## Usage
  @state - returns a JSON object with the current chat state
  `,
  features: [
    {
      feature: 'get',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'fetch', 'retrieve'],
      description: 'Operation that gets the current chat state.',
      stem: 'get'
    }
  ],
  roles: ['USER'],
  stem: 'state',
  tags: ['state', 'chat', 'session', 'context'],
  tools: [{
    type: "function",
    function: {
      name: "state",
      description: "Access the current chat state object",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  }]
}