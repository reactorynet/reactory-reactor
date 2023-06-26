import { ChatState, Macro } from "modules/reactor/ai/openai/types/chat";
import { execql, execml } from "graph/client";
const DEFAULT_GQL = `
  query ApiStatus { 
    apiStatus {
      when
      status
    }
  }
`;
/**
 * Executes a GraphQL query and returns the result
 * @param args - string[] - [ query, variables, options, format ] 
 * @param context - Reactory.Server.IReactoryContext
 * @returns 
 */
export const QueryGQL: Macro<string | string[] | object | object[]> = async (
  args: any[], 
  state: ChatState) => {
  const [ 
    query = DEFAULT_GQL, 
    variables = [], 
    options = [], 
    format = 'string',
    outmap = null
  ] = args;
  const { user, partner } = state.context;

  if(!user) { 
    return 'No user found';
  }

  if(!partner) {
    return 'No partner found';
  }

  const toObject = (str: string[]) => { 
    try {
      return JSON.parse(str.join(' '));
    } catch (err) {
      return {};
    }
  }

  try {
    const result = await execql(query, toObject(variables), toObject(options), user, partner);
    if(result) { 
      if(format === 'string') {
        return JSON.stringify(result);
      } 

      if(format === 'json') {
        return result;
      }
    } else {
      return 'No result returned';
    }
  } catch (err) {
    return `Error executing GraphQL query: ${err.message}`;
  }
}

export const MutationGQL: Macro<string | string[] | object | object[]> = async (
  args: any[], 
  state: ChatState
  ) => {
  const [ 
    query = DEFAULT_GQL, 
    variables = [], 
    options = [], 
    format = 'string',
    outmap = null
  ] = args;
  const { user, partner } = state.context;

  if(!user) { 
    return 'No user found';
  }

  if(!partner) {
    return 'No partner found';
  }

  const toObject = (str: string[]) => { 
    try {
      return JSON.parse(str.join(' '));
    } catch (err) {
      return {};
    }
  }

  try {
    const result = await execml(query, toObject(variables), toObject(options), user, partner);
    if(result) { 
      if(format === 'string') {
        return JSON.stringify(result);
      } 

      if(format === 'json') {
        return result;
      }
    } else {
      return 'No result returned';
    }
  } catch (err) {
    return `Error executing GraphQL mutation: ${err.message}`;
  }
}