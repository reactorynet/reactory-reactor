import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import { executeMacro } from "..";
import { AddMacroProps } from './types';

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
  
  try {
    if(!name || !func) {
      return {
        error: "Macro name and function are required",
        success: false
      };
    }

    // the func will be text that we need to evaluate 
    // to create the function
    let macroFunc;

    try {
      macroFunc = eval(func);
    } catch (err) {
      return {
        error: `Could not create macro function: ${err}`,
        success: false
      };
    }
    
    if(typeof macroFunc !== 'function') {
      return {
        error: "Macro function is not a function",
        success: false
      };
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

    return {
      result: `Macro ${name} added to state: use @${name} to call it`,
      success: true,
      operation: 'create',
      macroName: name,
      macroDescription: description,
      parameters: parameters,
      nameSpace: 'runtime-macro',
      version: '1.0.0'
    };
  } catch (err) {
    return {
      error: `Error in addMacro: ${err instanceof Error ? err.message : 'Unknown error'}`,
      success: false
    };
  }
}

export const AddMacroRegistry: MacroComponentDefinition<typeof AddMacro> = {
  nameSpace: 'reactor-macros',
  name: 'addMacro',
  alias: 'addMacro',
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