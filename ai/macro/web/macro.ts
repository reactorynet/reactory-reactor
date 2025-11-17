import yaml from 'js-yaml';
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { URL } from 'url';
import logger from '@reactory/server-core/logging';
import { 
  HttpMacroProps, 
  GetMacroProps, 
  PostMacroProps, 
  PutMacroProps, 
  DeleteMacroProps, 
  PatchMacroProps, 
  FetchMacroProps,
  HttpMacroResult
} from './types';

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
export const HttpMacro: Macro<HttpMacroResult, HttpMacroProps> = async (
  props: HttpMacroProps,
  state: ChatState): Promise<HttpMacroResult> => {
  const startTime = Date.now();
  const { url, method, options, returnFormat = 'text' } = props;
  
  if (!url) {
    return {
      success: false,
      error: 'URL is required',
      tool: 'http',
      params: props
    };
  }

  try {
    // Validate URL
    const parsedUrl = new URL(url.trim());
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        success: false,
        error: 'Invalid URL protocol. Only http and https are allowed.',
        tool: 'http',
        params: props
      };
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
            return {
              success: false,
              error: 'Invalid headers format in options string',
              tool: 'http',
              params: props
            };
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
    
    const requestStartTime = Date.now();
    const response = await fetch(parsedUrl.href, requestInit);
    const responseTime = Date.now() - requestStartTime;
    const executionTime = Date.now() - startTime;

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP error! status: ${response.status} ${response.statusText}`,
        tool: 'http',
        params: props,
        metadata: {
          executionTime,
          timestamp: new Date(),
          user: state.user?.id,
          url: parsedUrl.href,
          method
        }
      };
    }
    
    let content;
    const contentType = response.headers.get('content-type') || 'text/plain';
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    
    switch (returnFormat.toLowerCase()) {
      case 'json':
        content = await response.json();
        break;
      case 'text':
        content = await response.text();
        break;
      case 'blob':
        const blob = await response.blob();
        content = {
          type: blob.type,
          size: blob.size,
          data: 'Blob data (not serializable)'
        };
        break;
      default:
        return {
          success: false,
          error: 'Unsupported return format. Use "json", "text", or "blob".',
          tool: 'http',
          params: props,
          metadata: {
            executionTime,
            timestamp: new Date(),
            user: state.user?.id,
            url: parsedUrl.href,
            method
          }
        };
    }

    // Convert headers to plain object
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastHttpRequest = {
      url: parsedUrl.href,
      method,
      status: response.status,
      responseTime,
      contentType,
      contentLength,
      lastAccessed: new Date()
    };

    // Log request for security
    logger.info(`HttpMacro executed: ${method} ${parsedUrl.href} by user: ${state.user?.id || 'unknown'}, status: ${response.status}`);

    return {
      success: true,
      data: {
        url: parsedUrl.href,
        method,
        status: response.status,
        statusText: response.statusText,
        headers,
        content,
        responseTime,
        contentLength,
        contentType
      },
      tool: 'http',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        url: parsedUrl.href,
        method
      },
      instructions: `
## HTTP Request Results

Successfully completed ${method} request to: **${parsedUrl.hostname}**

### Request Information:
- **URL**: ${parsedUrl.href}
- **Method**: ${method}
- **Status**: ${response.status} ${response.statusText}
- **Response Time**: ${responseTime}ms
- **Content Type**: ${contentType}
- **Content Length**: ${contentLength} bytes
- **Total Execution Time**: ${executionTime}ms

### Available Data:
- **content**: Response content (formatted according to returnFormat)
- **headers**: Response headers as key-value pairs
- **status**: HTTP status code
- **statusText**: HTTP status text
- **responseTime**: Time taken for the HTTP request
- **contentLength**: Size of response content
- **contentType**: MIME type of response

### State Variables Available:
- lastHttpRequest: Complete request information for future reference

### Usage:
- Use the \`content\` field for response data processing
- Use \`headers\` for response metadata analysis
- Use \`status\` and \`statusText\` for error handling
- Use \`data\` for comprehensive request information
      `
    };

  } catch (err) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error in HTTP request to ${url}:`, err);
    
    return {
      success: false,
      error: `HTTP request failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      tool: 'http',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        url: url.trim(),
        method
      }
    };
  }
};

/**
 * HTTP verb-specific macros
 */
export const GetMacro: Macro<HttpMacroResult, GetMacroProps> = async (props: GetMacroProps, state: ChatState): Promise<HttpMacroResult> => {
  const { url, format = 'text', options } = props;
  return HttpMacro({ url, method: 'GET', options, returnFormat: format }, state);
};

export const PostMacro: Macro<HttpMacroResult, PostMacroProps> = async (props: PostMacroProps, state: ChatState): Promise<HttpMacroResult> => {
  const { url, format = 'text', options } = props;
  return HttpMacro({ url, method: 'POST', options, returnFormat: format }, state);
};

export const PutMacro: Macro<HttpMacroResult, PutMacroProps> = async (props: PutMacroProps, state: ChatState): Promise<HttpMacroResult> => {
  const { url, format = 'text', options } = props;
  return HttpMacro({ url, method: 'PUT', options, returnFormat: format }, state);
};

export const DeleteMacro: Macro<HttpMacroResult, DeleteMacroProps> = async (props: DeleteMacroProps, state: ChatState): Promise<HttpMacroResult> => {
  const { url, format = 'text', options } = props;
  return HttpMacro({ url, method: 'DELETE', options, returnFormat: format }, state);
};

export const PatchMacro: Macro<HttpMacroResult, PatchMacroProps> = async (props: PatchMacroProps, state: ChatState): Promise<HttpMacroResult> => {
  const { url, format = 'text', options } = props;
  return HttpMacro({ url, method: 'PATCH', options, returnFormat: format }, state);
};

/**
 * Legacy FetchMacro for backward compatibility
 */
export const FetchMacro: Macro<HttpMacroResult, FetchMacroProps> = async (
  props: FetchMacroProps, 
  state: ChatState): Promise<HttpMacroResult> => { 
  const { url, requestInit, returnFormat = 'text' } = props;
  return HttpMacro({ url, method: requestInit?.method || 'GET', options: requestInit, returnFormat }, state);
};

/**
 * Macro registry entries
 */
export const HttpMacroRegistry: MacroComponentDefinition<typeof HttpMacro> = {
  nameSpace: 'reactor-macros',
  name: 'http',
  version: '1.0.0',
  component: HttpMacro,
  description: 'A base macro for HTTP requests with structured results and metadata',
  features: [],
  stem: 'http',
  roles: ['USER'],
  tags: ['http', 'fetch', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "http",
      description: "Make an HTTP request with comprehensive response metadata",
      icon: "http",
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
  description: 'A macro for HTTP GET requests with structured results and metadata',
  features: [],
  stem: 'get',
  roles: ['USER'],
  tags: ['http', 'get', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "get",
      description: "Make an HTTP GET request with comprehensive response metadata",
      icon: "get_app",
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
  description: 'A macro for HTTP POST requests with structured results and metadata',
  features: [],
  stem: 'post',
  tags: ['http', 'post', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "post",
      description: "Make an HTTP POST request with comprehensive response metadata",
      icon: "send",
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
  description: 'A macro for HTTP PUT requests with structured results and metadata',
  roles: ['USER'],
  features: [],
  stem: 'put',
  tags: ['http', 'put', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "put",
      description: "Make an HTTP PUT request with comprehensive response metadata",
      icon: "edit",
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
  description: 'A macro for HTTP DELETE requests with structured results and metadata',
  roles: ['USER'],
  features: [],
  stem: 'delete',
  tags: ['http', 'delete', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "delete",
      description: "Make an HTTP DELETE request with comprehensive response metadata",
      icon: "delete",
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
  description: 'A macro for HTTP PATCH requests with structured results and metadata',
  roles: ['USER'],
  features: [],
  stem: 'patch',
  tags: ['http', 'patch', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "patch",
      description: "Make an HTTP PATCH request with comprehensive response metadata",
      icon: "update",
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
  description: 'Legacy fetch macro for backward compatibility with structured results and metadata',
  features: [],
  stem: 'fetch',
  roles: ['USER'],
  tags: ['http', 'fetch', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "fetch",
      description: "Legacy fetch macro for HTTP requests with comprehensive response metadata",
      icon: "cloud_download",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the request to"
          },
          requestInit: {
            type: "object",
            description: "Request initialization options"
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