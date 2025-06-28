import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { queryGraph as execql, mutateGraph as execml } from "@reactory/server-core/graph/ReactoryApolloClient";
import Reactory from "@reactory/reactory-core";
import { QueryGQLProps, MutationGQLProps } from './types';
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
 * @param props - QueryGQLProps - { query, variables, options, format, outmap } 
 * @param state - ChatState
 * @returns 
 */
export const QueryGQL: Macro<string | string[] | object | object[], QueryGQLProps> = async (
  props: QueryGQLProps, 
  state: ChatState) => {
  const { 
    query = DEFAULT_GQL, 
    variables = [], 
    options = [], 
    format = 'string',
    outmap = null
  } = props;
  const { user, partner } = state.context;

  if(!user) { 
    return 'No user found';
  }

  if(!partner) {
    return 'No partner found';
  }

  const toObject = (input: string[] | object) => { 
    if (Array.isArray(input)) {
      try {
        return JSON.parse(input.join(' '));
      } catch (err) {
        return {};
      }
    }
    return input || {};
  }

  try {
    const result = await execql(query, toObject(variables), toObject(options), state.context);
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

export const QueryMacroComponentRegister: MacroComponentDefinition<Macro<string | string[] | object | object[]>> = {
  component: QueryGQL,
  name: 'queryGQL',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: 'Executes a GraphQL query with the provided arguments',
  features: [
    { feature: 'queryMacro', featureType: Reactory.FeatureType.function, description: 'executes graphql query', action: [], stem: 'query'}
  ],
  stem: 'query',
  tags: ['macro', 'graphql', 'query'],
  roles: ['DEVELOPER', 'ADMIN'],
  tools: [{
    type: "function",
    function: {
      name: "queryGQL",
      description: "Executes a GraphQL query and returns the result",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The GraphQL query string"
          },
          variables: {
            type: "object",
            description: "Variables for the query as JSON object"
          },
          options: {
            type: "object",
            description: "Options for the query as JSON object"
          },
          format: {
            type: "string",
            enum: ["string", "json"],
            description: "Return format: 'string' or 'json'"
          },
          outmap: {
            type: "object",
            description: "Output mapping configuration"
          }
        },
        required: []
      }
    }
  }]
};

export const MutationGQL: Macro<string | string[] | object | object[], MutationGQLProps> = async (
  props: MutationGQLProps, 
  state: ChatState
  ) => {
  const { 
    query = DEFAULT_GQL, 
    variables = [], 
    options = [], 
    format = 'string',
    outmap = null
  } = props;
  const { user, partner } = state.context;

  if(!user) { 
    return 'No user found';
  }

  if(!partner) {
    return 'No partner found';
  }

  const toObject = (input: string[] | object) => { 
    if (Array.isArray(input)) {
      try {
        return JSON.parse(input.join(' '));
      } catch (err) {
        return {};
      }
    }
    return input || {};
  }

  try {
    const result = await execml(query, toObject(variables), toObject(options), state.context);
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

export const MutationMacroComponentRegister: MacroComponentDefinition<Macro<string | string[] | object | object[]>> = {
  component: MutationGQL,
  name: 'mutationGQL',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: 'Executes a GraphQL mutation with the provided arguments',
  features: [],
  stem: 'mutation',
  tags: ['macro', 'graphql', 'mutation'],
  roles: ['DEVELOPER', 'ADMIN'],
  tools: [{
    type: "function",
    function: {
      name: "mutationGQL",
      description: "Executes a GraphQL mutation and returns the result",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The GraphQL mutation string"
          },
          variables: {
            type: "object",
            description: "Variables for the mutation as JSON object"
          },
          options: {
            type: "object",
            description: "Options for the mutation as JSON object"
          },
          format: {
            type: "string",
            enum: ["string", "json"],
            description: "Return format: 'string' or 'json'"
          },
          outmap: {
            type: "object",
            description: "Output mapping configuration"
          }
        },
        required: []
      }
    }
  }]
};

const SCHEMA_INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        kind
        name
        description
        fields(includeDeprecated: true) {
          name
          description
          args {
            name
            description
            type {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
            defaultValue
          }
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
          isDeprecated
          deprecationReason
        }
        inputFields {
          name
          description
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
          defaultValue
        }
        interfaces {
          kind
          name
        }
        enumValues(includeDeprecated: true) {
          name
          description
          isDeprecated
          deprecationReason
        }
        possibleTypes {
          kind
          name
        }
      }
    }
  }
`;

/**
 * Retrieves the GraphQL schema via introspection with various filtering options
 * @param args - string[] - [ typename, detailLevel, options, format ] 
 * @param state - ChatState
 * @returns Markdown formatted schema information
 */
export const SchemaGQL: Macro<string | string[] | object | object[]> = async (
  args: any[], 
  state: ChatState
) => {
  const [ 
    typename = '',
    detailLevel = 'summary',
    options = [], 
    format = 'markdown'
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
    // Check if the schema is already cached
    let schema: any = state.vars?.GRAPH_SCHEMA;
    if(!schema) {
      const result = await execql(SCHEMA_INTROSPECTION_QUERY, {}, toObject(options), state.context);
      
      if(!result || !result.data || !result.data.__schema) {
        return 'No schema returned';
      }
      schema = result.data.__schema;
      state.vars.GRAPH_SCHEMA = schema; // Cache the schema for future use
    }
  
    // Format output as markdown
    if (typename) {
      // Return details for a specific type
      const type = schema.types.find((t: any)=> t.name === typename);
      if (!type) {
        return `Type "${typename}" not found in schema`;
      }
      
      return formatTypeAsMarkdown(type, detailLevel === 'detail');
    } else {
      // Return only root queries and mutations
      let markdown = '# GraphQL Schema Summary\n\n';
      
      const queryType = schema.types.find(t => t.name === schema.queryType.name);
      const mutationType = schema.types.find(t => t.name === schema.mutationType?.name);
      
      if (queryType) {
        markdown += '## Queries\n\n';
        queryType.fields.forEach((field: any) => {
          markdown += `- **${field.name}**`;
          if (field.description) {
            markdown += `: ${field.description.split('\n')[0]}`;
          }
          markdown += '\n';
        });
        markdown += '\n';
      }
      
      if (mutationType) {
        markdown += '## Mutations\n\n';
        mutationType.fields.forEach((field: any) => {
          markdown += `- **${field.name}**`;
          if (field.description) {
            markdown += `: ${field.description.split('\n')[0]}`;
          }
          markdown += '\n';
        });
      }
      
      return markdown;
    }
  } catch (err) {
    return `Error retrieving GraphQL schema: ${err.message}`;
  }
}

/**
 * Formats a GraphQL type as markdown
 * @param type The GraphQL type to format
 * @param detailed Whether to include detailed information
 * @returns Markdown formatted type information
 */
function formatTypeAsMarkdown(type, detailed = false) {
  let markdown = `# Type: ${type.name}\n\n`;
  
  if (type.description) {
    markdown += `${type.description}\n\n`;
  }
  
  markdown += `**Kind**: ${type.kind}\n\n`;
  
  if (type.fields && type.fields.length > 0) {
    markdown += '## Fields\n\n';
    
    type.fields.forEach((field: any) => {
      markdown += `### ${field.name}\n\n`;
      
      if (field.description) {
        markdown += `${field.description}\n\n`;
      }
      
      markdown += `**Type**: ${formatFieldType(field.type)}\n`;
      
      if (field.isDeprecated) {
        markdown += `**Deprecated**: ${field.deprecationReason || 'Yes'}\n`;
      }
      
      if (detailed && field.args && field.args.length > 0) {
        markdown += '\n**Arguments**:\n\n';
        
        field.args.forEach((arg: any) => {
          markdown += `- \`${arg.name}\`: ${formatFieldType(arg.type)}`;
          
          if (arg.defaultValue) {
            markdown += ` (default: ${arg.defaultValue})`;
          }
          
          if (arg.description) {
            markdown += ` - ${arg.description.split('\n')[0]}`;
          }
          
          markdown += '\n';
        });
      }
      
      markdown += '\n';
    });
  }
  
  if (detailed && type.inputFields && type.inputFields.length > 0) {
    markdown += '## Input Fields\n\n';
    
    type.inputFields.forEach(field => {
      markdown += `- \`${field.name}\`: ${formatFieldType(field.type)}`;
      
      if (field.defaultValue) {
        markdown += ` (default: ${field.defaultValue})`;
      }
      
      if (field.description) {
        markdown += ` - ${field.description.split('\n')[0]}`;
      }
      
      markdown += '\n';
    });
    
    markdown += '\n';
  }
  
  if (detailed && type.enumValues && type.enumValues.length > 0) {
    markdown += '## Enum Values\n\n';
    
    type.enumValues.forEach(value => {
      markdown += `- \`${value.name}\``;
      
      if (value.description) {
        markdown += `: ${value.description.split('\n')[0]}`;
      }
      
      if (value.isDeprecated) {
        markdown += ` (deprecated: ${value.deprecationReason || 'Yes'})`;
      }
      
      markdown += '\n';
    });
  }
  
  return markdown;
}

/**
 * Formats a GraphQL field type
 * @param type The GraphQL field type to format
 * @returns Formatted type string
 */
function formatFieldType(type) {
  if (type.kind === 'NON_NULL') {
    return `${formatFieldType(type.ofType)}!`;
  }
  
  if (type.kind === 'LIST') {
    return `[${formatFieldType(type.ofType)}]`;
  }
  
  return type.name;
}

export const SchemaMacroComponentRegister: MacroComponentDefinition<Macro<string | string[] | object | object[]>> = {
  component: SchemaGQL,
  name: 'schemaGQL',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: 'Retrieves and formats GraphQL schema information. With no parameters, returns only root Queries and Mutations. When a typename is provided, returns details about that specific type.',
  features: [
    { feature: 'schemaGQL', featureType: Reactory.FeatureType.function, description: 'retrieves GraphQL schema', action: [], stem: 'schema'}
  ],
  stem: 'schema',
  tags: ['macro', 'graphql', 'schema', 'introspection'],
  roles: ['DEVELOPER', 'ADMIN'],
  tools: [{
    type: "function",
    function: {
      name: "schemaGQL",
      description: "Retrieves and formats GraphQL schema information",
      parameters: {
        type: "object",
        properties: {
          args: {
            type: "array",
            description: "Arguments for retrieving schema: [typename, detailLevel, options, format]. typename is optional and filters to a specific type. detailLevel can be 'summary' or 'detail'. Options can be a JSON string. format defaults to 'markdown'.",
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