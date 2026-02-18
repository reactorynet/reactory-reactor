import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import { executeMacro } from "..";
import { VariableMacroProps, SliceVariableMacroProps } from './types';

// a macro that allows the user to store, retrieve or remove a variable in the chat state
export const VariableMacro: Macro<unknown, VariableMacroProps> = async (
  props: VariableMacroProps,
  state: ChatState): Promise<unknown> => {
  const { key, value } = props;
  try {

    if(!state) {
      return {
        error: "Chat state is not defined",
        success: false
      };
    }

    if(!state.vars) {
      state.vars = {};
    }

    if(value === undefined || value === null) {
      return {
        result: state.vars[key || ''],
        success: true,
        operation: 'get',
        key: key,
        value: state.vars[key || '']
      };
    }

    if(value === 'del') {
      delete state.vars[key];
      return {
        result: `Variable ${key} deleted`,
        success: true,
        operation: 'delete',
        key: key
      };
    }

    if(value && typeof value === 'string' && value.startsWith('@')) {
      // process the inner macro
      const result = await executeMacro<unknown>(value, state);
      state = result.state;
      state.vars[key] = result.error ? result.error : result.value;
    } else {
      state.vars[key] = value;
    }
    
    return {
      result: `Variable ${key} set to ${value}`,
      success: true,
      operation: 'set',
      key: key,
      value: value
    };
  } catch (err) {
    return {
      error: `Error in variable macro: ${err instanceof Error ? err.message : 'Unknown error'}`,
      success: false
    };
  }
};

// a macro that slices data from a variable based on a predicate
export const SliceVariableMacro: Macro<unknown, SliceVariableMacroProps> = async (
  props: SliceVariableMacroProps,
  state: ChatState): Promise<unknown> => {
  const { variableName, predicate, targetVariable } = props;
  
  try {
    if (!state || !state.vars) {
      return {
        error: "Chat state or variables not defined",
        success: false
      };
    }

    const sourceData = state.vars[variableName];
    if (sourceData === undefined || sourceData === null) {
      return {
        error: `Variable '${variableName}' not found`,
        success: false
      };
    }

    let slicedResult: any;

    // Handle different data types and predicate types
    if (Array.isArray(sourceData)) {
      // For arrays, try to evaluate predicate as a filter function
      try {
        const filterFunction = eval(`(${predicate})`);
        if (typeof filterFunction === 'function') {
          slicedResult = sourceData.filter(filterFunction);
        } else {
          // If predicate is not a function, try to parse as index range or other criteria
          slicedResult = parseArrayPredicate(sourceData, predicate);
        }
      } catch (evalError) {
        // If eval fails, try to parse as index range or other criteria
        slicedResult = parseArrayPredicate(sourceData, predicate);
      }
    } else if (typeof sourceData === 'object' && sourceData !== null) {
      // For objects, try to extract properties based on predicate
      slicedResult = parseObjectPredicate(sourceData, predicate);
    } else if (typeof sourceData === 'string') {
      // For strings, try to slice based on predicate
      slicedResult = parseStringPredicate(sourceData, predicate);
    } else {
      return {
        error: `Cannot slice data of type ${typeof sourceData}`,
        success: false
      };
    }

    // Store result in target variable if specified, otherwise return it
    if (targetVariable) {
      state.vars[targetVariable] = slicedResult;
      return {
        result: `Sliced data from '${variableName}' stored in '${targetVariable}'`,
        success: true,
        operation: 'store',
        sourceVariable: variableName,
        targetVariable: targetVariable,
        slicedData: slicedResult
      };
    } else {
      return {
        result: slicedResult,
        success: true,
        operation: 'slice',
        sourceVariable: variableName,
        predicate: predicate,
        slicedData: slicedResult
      };
    }

  } catch (err) {
    return {
      error: `Error in sliceVariable macro: ${err instanceof Error ? err.message : 'Unknown error'}`,
      success: false
    };
  }
};

// Helper function to parse array predicates
function parseArrayPredicate(array: any[], predicate: string): any[] {
  // Try to parse as index range (e.g., "0:5", "1:-1", ":3")
  const rangeMatch = predicate.match(/^(-?\d*):(-?\d*)$/);
  if (rangeMatch) {
    const start = rangeMatch[1] === '' ? 0 : parseInt(rangeMatch[1]);
    const end = rangeMatch[2] === '' ? array.length : parseInt(rangeMatch[2]);
    return array.slice(start, end);
  }

  // Try to parse as specific indices (e.g., "0,2,4")
  const indicesMatch = predicate.match(/^(\d+(?:,\d+)*)$/);
  if (indicesMatch) {
    const indices = predicate.split(',').map(i => parseInt(i.trim()));
    return indices.map(i => array[i]).filter(item => item !== undefined);
  }

  // Try to parse as a simple condition (e.g., "length > 5", "type === 'string'")
  try {
    const conditionFunction = eval(`(item, index, array) => ${predicate}`);
    return array.filter(conditionFunction);
  } catch {
    throw new Error(`Invalid predicate format: ${predicate}`);
  }
}

// Helper function to parse object predicates
function parseObjectPredicate(obj: any, predicate: string): any {
  // Try to parse as property path (e.g., "user.name", "data.items")
  if (predicate.includes('.')) {
    const keys = predicate.split('.');
    let result = obj;
    for (const key of keys) {
      if (result && typeof result === 'object' && key in result) {
        result = result[key];
      } else {
        return undefined;
      }
    }
    return result;
  }

  // Try to parse as specific property names (e.g., "name,email,age")
  if (predicate.includes(',')) {
    const keys = predicate.split(',').map(k => k.trim());
    const result: any = {};
    keys.forEach(key => {
      if (key in obj) {
        result[key] = obj[key];
      }
    });
    return result;
  }

  // Try to parse as a condition
  try {
    const conditionFunction = eval(`(value, key, obj) => ${predicate}`);
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (conditionFunction(value, key, obj)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    // If all else fails, try to get the property directly
    return obj[predicate];
  }
}

// Helper function to parse string predicates
function parseStringPredicate(str: string, predicate: string): string {
  // Try to parse as index range (e.g., "0:10", "5:-1")
  const rangeMatch = predicate.match(/^(-?\d*):(-?\d*)$/);
  if (rangeMatch) {
    const start = rangeMatch[1] === '' ? 0 : parseInt(rangeMatch[1]);
    const end = rangeMatch[2] === '' ? str.length : parseInt(rangeMatch[2]);
    return str.slice(start, end);
  }

  // Try to parse as specific indices (e.g., "0,5,10")
  const indicesMatch = predicate.match(/^(\d+(?:,\d+)*)$/);
  if (indicesMatch) {
    const indices = predicate.split(',').map(i => parseInt(i.trim()));
    return indices.map(i => str[i]).join('');
  }

  // Try to parse as a condition
  try {
    const conditionFunction = eval(`(char, index, str) => ${predicate}`);
    return str.split('').filter(conditionFunction).join('');
  } catch {
    throw new Error(`Invalid string predicate format: ${predicate}`);
  }
}

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

export const SliceVariableMacroRegistry: MacroComponentDefinition<typeof SliceVariableMacro> = {
  nameSpace: 'reactor-macros',
  name: 'sliceVariable',
  version: '1.0.0',
  component: SliceVariableMacro,
  roles: ['ADMIN', 'DEVELOPER'],
  description: `# sliceVariable macro
  Use this macro to slice data from a variable based on a predicate
  
  ## Usage
  @sliceVariable(variableName, predicate) - slices data and returns the result
  @sliceVariable(variableName, predicate, targetVariable) - slices data and stores in target variable
  
  ## Examples
  Arrays:
  - @sliceVariable(myArray, "0:5") - get first 5 elements
  - @sliceVariable(myArray, "item > 5") - filter elements greater than 5
  - @sliceVariable(myArray, "0,2,4") - get elements at indices 0, 2, 4
  
  Objects:
  - @sliceVariable(myObject, "user.name") - get nested property
  - @sliceVariable(myObject, "name,email,age") - get specific properties
  - @sliceVariable(myObject, "value > 10") - filter properties by value
  
  Strings:
  - @sliceVariable(myString, "0:10") - get first 10 characters
  - @sliceVariable(myString, "char !== ' '") - remove spaces
  `,
  features: [
    {
      feature: 'slice',
      featureType: Reactory.FeatureType.function,
      action: ['slice', 'filter', 'extract', 'subset'],
      description: 'Operation that slices or filters data from a variable.',
      stem: 'slice'
    }
  ],
  stem: 'slice',
  tags: ['slice', 'filter', 'data', 'extract', 'subset'],
  tools: [{
    type: "function",
    function: {
      name: "sliceVariable",
      description: "Slice data from a variable based on a predicate",
      parameters: {
        type: "object",
        properties: {
          variableName: {
            type: "string",
            description: "The name of the variable to slice"
          },
          predicate: {
            type: "string",
            description: "The predicate to use for slicing (function, range, condition, or property path)"
          },
          targetVariable: {
            type: "string",
            description: "Optional target variable name to store the sliced result"
          }
        },
        required: ["variableName", "predicate"]
      }
    }
  }]
} 