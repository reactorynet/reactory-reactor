/**
 * Type definitions for runtime macros
 * These types define the props structure for runtime macro functions
 */

/**
 * Props for the AddMacro function
 */
export interface AddMacroProps {
  /** The name of the macro to create */
  name: string;
  /** The function code as a string that will be evaluated */
  func: string;
  /** Optional description of the macro */
  description?: string;
  /** Optional parameters for the macro */
  parameters?: Record<string, any>;
}

/**
 * Props for the VariableMacro function
 */
export interface VariableMacroProps {
  /** The key for the variable operation */
  key: string;
  /** The value to set for the variable (omit for get operation, use 'del' for delete, use 'load' to load from database) */
  value?: string;
  /** If true, persist the variable to/from the database (default: false) */
  persist?: boolean;
}

/**
 * Props for the SliceVariableMacro function
 */
export interface SliceVariableMacroProps {
  /** The name of the variable to slice */
  variableName: string;
  /** The predicate to use for slicing (can be a function string or filter criteria) */
  predicate: string;
  /** Optional target variable name to store the sliced result */
  targetVariable?: string;
}

/**
 * Props for the DateTimeMacro function
 */
export interface DateTimeMacroProps {
  /** The format for the date/time output */
  format?: string;
  /** The timezone to use (local, utc, or offset like +05:30, -08:00) */
  timezone?: string;
  /** The date to format (now, today, yesterday, tomorrow, or date string) */
  date?: string;
  /** Optional target variable name to store the formatted date/time */
  targetVariable?: string;
}

/**
 * Props for the ModuleMacro function
 */
export interface ModuleMacroProps {
  /** Whether to show detailed information about modules */
  details?: boolean;
}

/**
 * Props for the EnvironmentMacro function
 */
export interface EnvironmentMacroProps {
  /** The name of the environment variable to retrieve (omit to get safe variables) */
  envKey?: string;
}

/**
 * Props for the StateMacro function
 */
export interface StateMacroProps {
  // No props needed for state macro - it just returns current state
}

/**
 * Status of a single todo item
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/**
 * Execution strategy for todo items
 */
export type TodoExecutionMode = 'series' | 'parallel';

/**
 * A single todo item within a todo list
 */
export interface TodoItem {
  /** Unique identifier for the todo */
  id: string;
  /** Short title / description of the todo */
  title: string;
  /** Detailed description or instructions */
  description?: string;
  /** Current status */
  status: TodoStatus;
  /** Persona id or agent id that this todo is assigned to */
  assignee?: string;
  /** Result or output from executing this todo */
  result?: unknown;
  /** Error message if the todo failed */
  error?: string;
  /** ISO timestamp when the todo was created */
  createdAt: string;
  /** ISO timestamp when the todo was last updated */
  updatedAt: string;
}

/**
 * A todo list managed in the chat state vars
 */
export interface TodoList {
  /** Unique identifier for the todo list */
  id: string;
  /** Human-readable name for the todo list */
  name: string;
  /** Execution strategy: series (one-by-one) or parallel (all at once) */
  executionMode: TodoExecutionMode;
  /** The ordered list of todo items */
  items: TodoItem[];
  /** ISO timestamp when the list was created */
  createdAt: string;
  /** ISO timestamp when the list was last updated */
  updatedAt: string;
}

/**
 * Props for the TodoMacro function
 */
export interface TodoMacroProps {
  /** The action to perform */
  action: 'create' | 'list' | 'get' | 'add' | 'update' | 'assign' | 'remove';
  /** The todo list id (required for all actions except 'create' and 'list') */
  listId?: string;
  /** Name for the todo list (used with 'create') */
  name?: string;
  /** Execution mode for the list (used with 'create', default: 'series') */
  executionMode?: TodoExecutionMode;
  /** The todo item id (required for 'update', 'assign', 'remove') */
  todoId?: string;
  /** Title for a new todo item (used with 'add') */
  title?: string;
  /** Description for a new todo item (used with 'add' or 'update') */
  description?: string;
  /** Status to set (used with 'update') */
  status?: TodoStatus;
  /** Result data to attach (used with 'update') */
  result?: unknown;
  /** Persona or agent id to assign the todo to (used with 'assign') */
  assignee?: string;
}
