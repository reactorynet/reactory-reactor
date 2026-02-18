/**
 * Standardized error codes for the Reactor macro system.
 *
 * All macros should use these codes when returning error responses,
 * allowing consumers (AI agents, UI, logs) to programmatically
 * identify error categories without parsing free-text messages.
 *
 * Convention:
 * - MACRO_*        → Generic macro execution errors
 * - VALIDATION_*   → Input validation errors
 * - AUTH_*         → Authentication / authorization errors
 * - IO_*          → File system, network, and database I/O
 * - SHELL_*       → Shell / command execution errors
 * - GIT_*         → Git-specific errors
 * - DB_*          → Database-specific errors
 * - GRAPHQL_*     → GraphQL query / mutation errors
 * - MCP_*         → MCP protocol errors
 * - TIMEOUT_*     → Timeout errors
 */
export enum MacroErrorCode {
  // ── Generic ──────────────────────────────
  /** Catch-all for unexpected macro failures */
  MACRO_UNKNOWN_ERROR = 'MACRO_UNKNOWN_ERROR',
  /** The requested macro/operation was not found */
  MACRO_NOT_FOUND = 'MACRO_NOT_FOUND',
  /** The requested operation is not supported */
  MACRO_UNSUPPORTED_OPERATION = 'MACRO_UNSUPPORTED_OPERATION',

  // ── Validation ───────────────────────────
  /** A required parameter is missing */
  VALIDATION_REQUIRED_PARAM = 'VALIDATION_REQUIRED_PARAM',
  /** A parameter has an invalid value or type */
  VALIDATION_INVALID_PARAM = 'VALIDATION_INVALID_PARAM',
  /** Input fails a format or pattern check */
  VALIDATION_FORMAT_ERROR = 'VALIDATION_FORMAT_ERROR',

  // ── Auth ─────────────────────────────────
  /** User is not authenticated */
  AUTH_NOT_AUTHENTICATED = 'AUTH_NOT_AUTHENTICATED',
  /** User does not have the required role/permission */
  AUTH_ACCESS_DENIED = 'AUTH_ACCESS_DENIED',

  // ── I/O (File System) ───────────────────
  /** File or directory was not found */
  IO_NOT_FOUND = 'IO_NOT_FOUND',
  /** Permission denied for a file operation */
  IO_PERMISSION_DENIED = 'IO_PERMISSION_DENIED',
  /** Path traversal attempt was blocked */
  IO_PATH_TRAVERSAL = 'IO_PATH_TRAVERSAL',
  /** General file read/write failure */
  IO_READ_WRITE_ERROR = 'IO_READ_WRITE_ERROR',

  // ── Shell ────────────────────────────────
  /** A shell command was blocked by the security filter */
  SHELL_COMMAND_BLOCKED = 'SHELL_COMMAND_BLOCKED',
  /** A shell command exited with a non-zero code */
  SHELL_EXECUTION_ERROR = 'SHELL_EXECUTION_ERROR',
  /** A shell command timed out */
  SHELL_TIMEOUT = 'SHELL_TIMEOUT',

  // ── Git ──────────────────────────────────
  /** A git operation failed */
  GIT_OPERATION_FAILED = 'GIT_OPERATION_FAILED',
  /** The target is not a valid git repository */
  GIT_NOT_A_REPO = 'GIT_NOT_A_REPO',

  // ── Database ─────────────────────────────
  /** Database connection could not be established */
  DB_CONNECTION_ERROR = 'DB_CONNECTION_ERROR',
  /** Database connection ID not found in partner settings */
  DB_CONNECTION_NOT_FOUND = 'DB_CONNECTION_NOT_FOUND',
  /** A database query or write failed */
  DB_QUERY_ERROR = 'DB_QUERY_ERROR',
  /** A write operation was rejected by validation */
  DB_WRITE_VALIDATION_ERROR = 'DB_WRITE_VALIDATION_ERROR',

  // ── GraphQL ──────────────────────────────
  /** A GraphQL query/mutation returned errors */
  GRAPHQL_EXECUTION_ERROR = 'GRAPHQL_EXECUTION_ERROR',
  /** The GraphQL endpoint could not be reached */
  GRAPHQL_CONNECTION_ERROR = 'GRAPHQL_CONNECTION_ERROR',

  // ── MCP ──────────────────────────────────
  /** An MCP protocol operation failed */
  MCP_PROTOCOL_ERROR = 'MCP_PROTOCOL_ERROR',
  /** MCP client/server connection failed */
  MCP_CONNECTION_ERROR = 'MCP_CONNECTION_ERROR',

  // ── Network / Fetch ──────────────────────
  /** A network request failed (timeout, DNS, etc.) */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** The remote server returned an HTTP error status */
  NETWORK_HTTP_ERROR = 'NETWORK_HTTP_ERROR',

  // ── Timeout ──────────────────────────────
  /** A generic operation timed out */
  TIMEOUT = 'TIMEOUT',
}

/**
 * A structured macro error that carries a code, a human message, and optional details.
 */
export interface MacroError {
  /** Standardized error code */
  code: MacroErrorCode;
  /** Human-readable error message */
  message: string;
  /** Optional additional detail (stack, params, etc.) */
  details?: unknown;
}

/**
 * Helper to create a `MacroError` object.
 */
export function createMacroError(
  code: MacroErrorCode,
  message: string,
  details?: unknown
): MacroError {
  return { code, message, details };
}
