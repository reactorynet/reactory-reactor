/**
 * Type definitions for MCP (Model Context Protocol) macros
 * These types define the props structure for MCP macro functions
 */

/**
 * Props for the McpCli function
 */
export interface McpCliProps {
  /** The command to execute */
  command: 'capabilities' | 'prompts' | 'tools' | 'resources' | 'add-connection' | 'connect' | 'disconnect' | 'connections' | 'call-tool';
  /** Client ID for operations that require it */
  id?: string;
  /** URL for connection operations */
  url?: string;
  /** Transport type for connections */
  transport?: 'sse' | 'stdio' | 'websocket';
  /** Tool name for tool execution */
  toolName?: string;
  /** Additional parameters for tool execution */
  toolParams?: string[];
  /** Format for response (json, text) */
  format?: 'json' | 'text';
}
