
/**
 * Shared JSON-RPC 2.0 helpers for Reactor MCP server and handlers.
 */
export const RPCResponse = (result: any, id: string | number | null) => {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
};

export const RPCError = (code: number, message: string, id: string | number | null) => {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: code,
      message: message
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
