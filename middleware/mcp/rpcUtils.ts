
/**
 * Shared JSON-RPC 2.0 helpers for Reactor MCP server and handlers.
 */
import { PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR } from "./types";

export const RPCResponse = (result: any, id: string | number | null) => {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
};

export const RPCError = (code: number, message: string, id: string | number | null, data?: any) => {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: code,
      message: message,
      ...(data && { data })
    }
  };
};

export const RPCNotification = (method: string, params: any) => {
  return {
    jsonrpc: "2.0",
    method,
    params
  };
};

/**
 * Validate JSON-RPC request format
 */
export const validateRPCRequest = (rpc: any): { valid: boolean; error?: any } => {
  if (!rpc || typeof rpc !== 'object') {
    return { 
      valid: false, 
      error: RPCError(PARSE_ERROR, "Invalid JSON", null) 
    };
  }

  if (rpc.jsonrpc !== "2.0") {
    return { 
      valid: false, 
      error: RPCError(INVALID_REQUEST, "Invalid JSON-RPC version", rpc.id) 
    };
  }

  if (!rpc.method || typeof rpc.method !== 'string') {
    return { 
      valid: false, 
      error: RPCError(INVALID_REQUEST, "Missing or invalid method", rpc.id) 
    };
  }

  return { valid: true };
};

/**
 * Validate request size to prevent DoS attacks
 */
export const validateRequestSize = (rpc: any, maxSize: number = 1024 * 1024): { valid: boolean; error?: any } => {
  const requestSize = JSON.stringify(rpc).length;
  if (requestSize > maxSize) {
    return {
      valid: false,
      error: RPCError(INVALID_REQUEST, `Request too large (${requestSize} bytes)`, rpc.id)
    };
  }
  return { valid: true };
};

/**
 * Send progress notification via SSE
 */
export const sendProgressNotification = (
  sessionData: any, 
  progressToken: string | number, 
  progress: number, 
  total?: number
) => {
  if (!sessionData?.sseRes) return false;
  
  try {
    const notification = RPCNotification("notifications/progress", {
      progressToken,
      progress,
      ...(total !== undefined && { total })
    });
    
    sessionData.sseRes.write(`event: message\n`);
    sessionData.sseRes.write(`data: ${JSON.stringify(notification)}\n\n`);
    return true;
  } catch (error) {
    console.warn("[MCP] Failed to send progress notification:", error);
    return false;
  }
};

/**
 * Send logging notification via SSE
 */
export const sendLogNotification = (
  sessionData: any,
  level: string,
  message: string,
  logger?: string
) => {
  if (!sessionData?.sseRes) return false;
  
  try {
    const notification = RPCNotification("notifications/message", {
      level,
      data: message,
      ...(logger && { logger })
    });
    
    sessionData.sseRes.write(`event: message\n`);
    sessionData.sseRes.write(`data: ${JSON.stringify(notification)}\n\n`);
    return true;
  } catch (error) {
    console.warn("[MCP] Failed to send log notification:", error);
    return false;
  }
};

/**
 * Safe JSON stringify with error handling
 */
export const safeStringify = (obj: any): string => {
  try {
    return JSON.stringify(obj);
  } catch (error) {
    return JSON.stringify({ error: "Failed to serialize object", message: error.message });
  }
};

/**
 * Sanitize input to prevent injection attacks
 */
export const sanitizeInput = (input: any): any => {
  if (typeof input === 'string') {
    // Basic XSS prevention
    return input
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }
  
  if (Array.isArray(input)) {
    return input.map(sanitizeInput);
  }
  
  if (typeof input === 'object' && input !== null) {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(input)) {
      sanitized[key] = sanitizeInput(value);
    }
    return sanitized;
  }
  
  return input;
};
