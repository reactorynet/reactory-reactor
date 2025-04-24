import Reactory from "@reactory/reactory-core";
import { ChatState, Macro, MacroComponentDefinition, MacroToolDefinition } from "../../../types/chat";
import { executeMacro } from "..";
import modules from '@reactory/server-core/modules';

/**
 * A macro that allows the user to or the llm to add a function to the chat state.
 * This is useful for creating custom functions that can be used in the chat.
 * @param args - The arguments for the macro: [name, function, description, parameters]
 * @param state 
 */
export const AddMacro: Macro<unknown> = async (
  args: any[],
  state: ChatState): Promise<unknown> => {
  
  const [name, func, description, parameters] = args;
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
          args: {
            type: 'array',
            description: `Arguments for the macro:
            - name: string - the name of the macro
            - func: string - the function of the macro
            - description: string - the description of the macro
            - parameters: string array - the parameters of the macro`,
            items: {
              type: "string"
            } 
          }
          
        },
        required: ["args"]
      }
    }
  }]
}

// a macro that allows the user to store, retrieve or remove a variable in the chat state
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
            description: "The value to set for the variable (omit for get operation)"
          },
        },
        required: ["key"]
      }
    }
  }]
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
          args: {
            type: "array",
            description: `Arguments for the macro:
            - details: boolean - show detailed information about the modules`,
            items: { 
              type: "string"
            }
          }
        },
        required: []
      }
    }
  }]
}

// a macro that provides information about the environment variables
export const EnvironmentMacro: Macro<unknown> = async (
  args: any[],
  state: ChatState): Promise<unknown> => {
    // If a specific environment variable is requested
    if(args.length > 0 && typeof args[0] === 'string') {
      const envKey = args[0];
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
      'REACTORY_NATIVE'
    ];
    
    allowedVars.forEach(varName => {
      if (process.env[varName]) {
        safeEnvVars[varName] = process.env[varName] as string;
      }
    });
    
    return safeEnvVars[args[0]] || `No environment variable ${args[0]} found`;
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
          args: {
            type: "array",
            description: `Arguments for the macro:
            - envKey: string - the name of the environment variable to retrieve
          `,
            items: {
              type: "string"
            }
          }
        },
        required: []
      }
    }
  }]
}

// A macro that provides information about the current chat state
export const StateMacro: Macro<unknown> = async (
  args: any[],
  state: ChatState): Promise<unknown> => {
    // clone the state to avoid modifying the original
    
    const safe_state = { 
      vars: state.vars,
      id: state.id,
      host: state.host,
      user: {
        id: state.user.id,
        email: state.user.loggedIn.user.email,
        name: state.user.loggedIn.user.name,
        lastName: state.user.loggedIn.user.lastName,
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
  stem: 'state',
  tags: ['state', 'chat', 'session', 'context'],
  tools: [{
    type: "function",
    function: {
      name: "state",
      description: "Access the current chat state object",
      parameters: {
        type: "object",
        properties: {
          args: {
            type: "array",
            description: `Arguments for the macro:
            - none
          `,
            items: {
              type: "string"
            }
          }
        },
        required: []
      }
    }
  }]
}