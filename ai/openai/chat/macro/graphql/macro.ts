import { ChatState, Macro } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { queryGraph as execql, mutateGraph as execml } from "@reactory/server-core/graph/ReactoryApolloClient";
import Reactory from "@reactory/reactory-core";
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

export const QueryMacroComponentRegister: Reactory.IReactoryComponentDefinition<Macro<string | string[] | object | object[]>> = {
  component: QueryGQL,
  name: 'queryMacro',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: 'Executes a GraphQL query with the provided arguments',
  features: [
    { feature: 'queryMacro', featureType: Reactory.FeatureType.function, description: 'executes graphql query', action: [], stem: 'query'}
  ],
  stem: 'mutation',
  tags: ['macro', 'graphql', 'mutation'],
  tools: [{
    type: "function",
    function: {
      name: "queryGQL",
      description: "Executes a GraphQL query and returns the result",
      parameters: {
        type: "object",
        properties: {
          args: {
            type: "array",
            description: "Arguments for executing a GraphQL query: [query, variables, options, format, outmap]. query is required, variables and options can be JSON strings, format can be 'string' or 'json', outmap is for mapping output fields.",
            items: {
              type: "string"
            }
          },
        },
        required: ["args"]
      }
    }
  }]
};

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

export const MutationMacroComponentRegister: Reactory.IReactoryComponentDefinition<Macro<string | string[] | object | object[]>> = {
  component: MutationGQL,
  name: 'mutationMacro',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: 'Executes a GraphQL mutation with the provided arguments',
  features: [],
  stem: 'mutation',
  tags: ['macro', 'graphql', 'mutation'],
  tools: [{
    type: "function",
    function: {
      name: "mutationGQL",
      description: "Executes a GraphQL mutation and returns the result",
      parameters: {
        type: "object",
        properties: {
          args: {
            type: "array",
            description: "Arguments for executing a GraphQL mutation: [query, variables, options, format, outmap]. query is required, variables and options can be JSON strings, format can be 'string' or 'json', outmap is for mapping output fields.",
            items: {
              type: "string"
            }
          },
        },
        required: ["args"]
      }
    }
  }]
};