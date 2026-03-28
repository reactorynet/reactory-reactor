import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { URL } from "url";
import { ChatState } from "../../openai/types/chat";
import { loadSessionMcpConfig } from "./session-config";

export const loadClientsFromSession = (state: ChatState) => {
  if (!state.mcpClients) {
    state.mcpClients = [];
  }
  
  if (state.sessionFolder) {
    const config = loadSessionMcpConfig(state.sessionFolder);
    for (const conn of config.connections) {
      const exists = state.mcpClients.find(c => c.id === conn.id);
      if (!exists && conn.url) {
        const client = new Client({
          name: conn.serverName,
          version: '1.0.0',
        });
        
        const baseUrl = conn.url.endsWith('/') ? conn.url : `${conn.url}/`;
        const sseTransport = new StreamableHTTPClientTransport(new URL(baseUrl));
        
        sseTransport.requestInit = {
          credentials: 'include',
          headers: {
            'Authorization': state.auth?.token ? `Bearer ${state.auth.token}` : '',
            'x-client-key': state.clientKey || '',
            'x-client-pwd': state.clientSecret || ''
          }
        };
        
        state.mcpClients.push({
          id: conn.id,
          client,
          name: conn.serverName,
          description: conn.description || `MCP Client for ${conn.serverName}`,
          transports: {
            sse: sseTransport
          }
        });
      }
    }
  }
};
