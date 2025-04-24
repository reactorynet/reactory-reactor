import yaml from 'js-yaml';
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { URL } from 'url';

/**
 * Utility function to parse string options in format "key=value,key2=value2" or YAML format
 */
const parseStringOptions = (optionsString: string): Record<string, string> => {
  if (!optionsString) return {};
  
  // Check if the input might be YAML
  const trimmedStr = optionsString.trim();
  if (
    trimmedStr.startsWith('---') || 
    trimmedStr.includes('\n') ||
    trimmedStr.match(/^\s*[\w-]+:\s*/)
  ) {
    try {
      // Try to parse as YAML
      const parsed = yaml.load(trimmedStr);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, string>;
      }
    } catch (e) {
      // If YAML parsing fails, fall back to the original method
      console.warn('Failed to parse as YAML, falling back to simple parsing:', e);
    }
  }
  
  // Original key=value parsing
  return optionsString.split(',').reduce((acc, pair) => {
    const [key, value] = pair.split('=').map(part => part.trim());
    if (key && value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {} as Record<string, string>);
};

/**
 * Base HTTP macro that handles all HTTP requests
 */
export const HttpMacro: Macro<string> = async (
  args: any[],
  state: ChatState
) => {
  const [url, method, options, returnFormat = 'text'] = args;
  
  try {
    if (!url) {
      throw new Error('URL is required');
    }
    
    // Validate URL
    const parsedUrl = new URL(url.trim());
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid URL protocol. Only http and https are allowed.');
    }
    
    // Process options
    let requestInit: RequestInit = { method };
    
    if (options) {
      if (typeof options === 'string') {
        // Parse string options
        const parsedOptions = parseStringOptions(options);
        
        // Handle common options
        if (parsedOptions.headers) {
          try {
            requestInit.headers = JSON.parse(parsedOptions.headers);
          } catch (e) {
            throw new Error('Invalid headers format in options string');
          }
        }
        
        if (parsedOptions.body) {
          requestInit.body = parsedOptions.body;
        }
        
        // Add other options directly
        Object.entries(parsedOptions).forEach(([key, value]) => {
          if (!['headers', 'body'].includes(key)) {
            (requestInit as any)[key] = value;
          }
        });
      } else if (typeof options === 'function') {
        // Handle async function options
        const functionResult = await options();
        requestInit = { ...requestInit, ...functionResult };
      } else if (typeof options === 'object') {
        // Handle object options
        requestInit = { ...requestInit, ...options };
      }
    }
    
    const response = await fetch(parsedUrl.href, requestInit);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    let data;
    switch (returnFormat.toLowerCase()) {
      case 'json':
        data = await response.json();
        break;
      case 'text':
        data = await response.text();
        break;
      case 'blob':
        data = await response.blob();
        break;
      default:
        throw new Error('Unsupported return format. Use "json", "text", or "blob".');
    }
    
    return JSON.stringify(data);
  } catch (err) {
    console.error(`Error in HTTP request to ${url}:`, err);
    return JSON.stringify({ error: err.message });
  }
};

/**
 * HTTP verb-specific macros
 */
export const GetMacro: Macro<string> = async (args: any[], state: ChatState) => {
  const [url, format = 'text', options] = args;
  return HttpMacro([url, 'GET', options, format], state);
};

export const PostMacro: Macro<string> = async (args: any[], state: ChatState) => {
  const [url, format = 'text', options] = args;
  return HttpMacro([url, 'POST', options, format], state);
};

export const PutMacro: Macro<string> = async (args: any[], state: ChatState) => {
  const [url, format = 'text', options] = args;
  return HttpMacro([url, 'PUT', options, format], state);
};

export const DeleteMacro: Macro<string> = async (args: any[], state: ChatState) => {
  const [url, format = 'text', options] = args;
  return HttpMacro([url, 'DELETE', options, format], state);
};

export const PatchMacro: Macro<string> = async (args: any[], state: ChatState) => {
  const [url, format = 'text', options] = args;
  return HttpMacro([url, 'PATCH', options, format], state);
};

/**
 * Legacy FetchMacro for backward compatibility
 */
export const FetchMacro: Macro<string> = async (
  args: any[], 
  state: ChatState) => { 
  const [ url, requestInit, returnFormat = 'text' ] = args;
  return HttpMacro([url, requestInit?.method || 'GET', requestInit, returnFormat], state);
};

/**
 * Macro registry entries
 */
export const HttpMacroRegistry: MacroComponentDefinition<typeof HttpMacro> = {
  nameSpace: 'reactor-macros',
  name: 'http',
  version: '1.0.0',
  component: HttpMacro,
  description: 'A base macro for HTTP requests',
  features: [],
  stem: 'http',
  roles: ['USER'],
  tags: ['http', 'fetch', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "http",
      description: "Make an HTTP request",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the request to"
          },
          method: {
            type: "string",
            description: "The HTTP method to use"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          },
          returnFormat: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          }
        },
        required: ["url", "method"]
      }
    }
  }]
};

export const GetMacroRegistry: MacroComponentDefinition<typeof GetMacro> = {
  nameSpace: 'reactor-macros',
  name: 'get',
  version: '1.0.0',
  component: GetMacro,
  description: 'A macro for HTTP GET requests',
  features: [],
  stem: 'get',
  roles: ['USER'],
  tags: ['http', 'get', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "get",
      description: "Make an HTTP GET request",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the GET request to"
          },
          format: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          }
        },
        required: ["url"]
      }
    }
  }]
};

export const PostMacroRegistry: MacroComponentDefinition<typeof PostMacro> = {
  nameSpace: 'reactor-macros',
  name: 'post',
  version: '1.0.0',
  component: PostMacro,
  roles: ['USER'],
  description: 'A macro for HTTP POST requests',
  features: [],
  stem: 'post',
  tags: ['http', 'post', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "post",
      description: "Make an HTTP POST request",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the POST request to"
          },
          format: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          }
        },
        required: ["url"]
      }
    }
  }]
};

export const PutMacroRegistry: MacroComponentDefinition<typeof PutMacro> = {
  nameSpace: 'reactor-macros',
  name: 'put',
  version: '1.0.0',
  component: PutMacro,
  description: 'A macro for HTTP PUT requests',
  roles: ['USER'],
  features: [],
  stem: 'put',
  tags: ['http', 'put', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "put",
      description: "Make an HTTP PUT request",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the PUT request to"
          },
          format: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          }
        },
        required: ["url"]
      }
    }
  }]
};

export const DeleteMacroRegistry: MacroComponentDefinition<typeof DeleteMacro> = {
  nameSpace: 'reactor-macros',
  name: 'delete',
  version: '1.0.0',
  component: DeleteMacro,
  description: 'A macro for HTTP DELETE requests',
  features: [],
  stem: 'delete',
  tags: ['http', 'delete', 'url', 'api'],
  roles: ['USER'],
  tools: [{
    type: "function",
    function: {
      name: "delete",
      description: "Make an HTTP DELETE request",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the DELETE request to"
          },
          format: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          }
        },
        required: ["url"]
      }
    }
  }]
};

export const PatchMacroRegistry: MacroComponentDefinition<typeof PatchMacro> = {
  nameSpace: 'reactor-macros',
  name: 'patch',
  version: '1.0.0',
  component: PatchMacro,
  description: 'A macro for HTTP PATCH requests',
  features: [],
  stem: 'patch',
  tags: ['http', 'patch', 'url', 'api'],
  roles: ['USER'],
  tools: [{
    type: "function",
    function: {
      name: "patch",
      description: "Make an HTTP PATCH request",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the PATCH request to"
          },
          format: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          }
        },
        required: ["url"]
      }
    }
  }]
};

export const FetchMacroRegistry: MacroComponentDefinition<typeof FetchMacro> = {
  nameSpace: 'reactor-macros',
  name: 'fetch',
  version: '1.0.0',
  component: FetchMacro,
  description: 'A macro that fetches data from the given URL and returns it as text or JSON',
  features: [],
  stem: 'fetch',
  tags: ['fetch', 'http', 'url', 'data', 'json'],
  roles: ['USER'],
  tools: [{
    type: "function",
    function: {
      name: "fetch",
      description: "Fetch data from a URL",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch data from"
          },
          requestInit: {
            type: "object",
            description: "The request init object"
          },
          returnFormat: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          }
        },
        required: ["url"]
      }
    }
  }]
};

export const WebMacros: Reactory.IReactoryComponentDefinition<Macro<unknown>>[] = [
  FetchMacroRegistry,
  HttpMacroRegistry,
  GetMacroRegistry,
  PostMacroRegistry,
  PutMacroRegistry,
  DeleteMacroRegistry,
  PatchMacroRegistry
];