/**
 * Type definitions for MCP (Model Context Protocol) macros
 */

export interface McpCliProps {
  /** The command to execute */
  command:
    | 'capabilities'
    | 'prompts'
    | 'tools'
    | 'resources'
    | 'add-connection'
    | 'connect'
    | 'disconnect'
    | 'connections'
    | 'call-tool'
    | 'available';
  /** Client ID for operations that require it */
  id?: string;
  /**
   * URL for http connections. Required when `transport` is 'http' (or legacy 'sse').
   * Ignored for stdio.
   */
  url?: string;
  /**
   * Transport kind:
   * - `http`  — Streamable HTTP (MCP spec). Default for remote servers.
   * - `stdio` — local child-process transport. Desktop/electron and gated server
   *   deployments only. Command/args/env are never agent-supplied; they are
   *   resolved from the `available.yaml` catalog entry matched by `id`.
   * - `sse`   — deprecated alias for `http`; accepted for back-compat with legacy
   *   session state and older catalog files.
   */
  transport?: 'http' | 'stdio' | 'sse';
  /** Tool name for call-tool */
  toolName?: string;
  /**
   * Structured arguments object for call-tool. Preferred shape; matches the remote
   * tool's input schema directly.
   */
  toolArgs?: Record<string, unknown>;
  /**
   * Deprecated. Positional string arguments; wrapped as `{ args: [...] }` when
   * `toolArgs` is absent. Prefer `toolArgs` for new callers.
   */
  toolParams?: string[];
  /** Format for response (json, text) */
  format?: 'json' | 'text';
}
