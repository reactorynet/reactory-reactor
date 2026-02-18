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
