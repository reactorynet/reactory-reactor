

/**
 * Defines a function that formats and array of pathInfos into a string
 */
export type DirectoryListFormatter = (pathInfos: PathInfo[]) => string;

/**
 * Defines a service that can format a list of path infos into a string
 */
export type DirectoryListFormatterService = Reactory.Service.IReactoryService & {
  formatter: DirectoryListFormatter;
}

/**
 * Properties for ServiceRegister macro
 */
export interface ServiceRegisterProps {
  /** The action to perform: 'list' or 'get' */
  action?: 'list' | 'get';
  /** The service name (for get action) */
  name?: string;
  /** The service namespace (for get action) */
  nameSpace?: string;
  /** The service version (for get action) */
  version?: string;
  /** Properties for service initialization */
  props?: any;
  /** Function to call on the service */
  func?: string;
  /** Parameters for the function call */
  funcParams?: any[];
  /** Format for list output */
  format?: 'string' | 'object';
}

// ── Workflow types ──────────────────────────────────

/**
 * Supported condition operators for workflow conditional steps.
 */
export type WorkflowConditionOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'not_contains'
  | 'exists' | 'not_exists'
  | 'truthy' | 'falsy';

/**
 * A single condition that must evaluate to true for a workflow step to execute.
 */
export interface WorkflowCondition {
  /** A dot-path into the workflow context (e.g. "vars.myVar" or "lastResult.success") */
  field: string;
  /** The operator to apply */
  operator: WorkflowConditionOperator;
  /** The value to compare against (not required for exists / truthy / falsy) */
  value?: unknown;
}

/**
 * A single step in a workflow definition.
 */
export interface WorkflowStep {
  /** Unique identifier for this step */
  id: string;
  /** Human-readable label */
  label?: string;
  /** The macro or tool name to execute for this step */
  macro: string;
  /** Parameters to pass to the macro */
  params?: Record<string, unknown>;
  /** Optional conditions that all must pass for the step to run. If empty, always runs. */
  conditions?: WorkflowCondition[];
  /** Variable name to store this step's result under (defaults to step.id) */
  outputVar?: string;
  /** If true, continue the workflow even when this step fails */
  continueOnError?: boolean;
}

/**
 * A workflow definition that can be executed as a sequence of macro steps.
 */
export interface WorkflowDefinition {
  /** A unique name for the workflow */
  name: string;
  /** Optional description */
  description?: string;
  /** Ordered list of steps to execute */
  steps: WorkflowStep[];
}

/**
 * Props for the RunWorkflow macro.
 */
export interface RunWorkflowProps {
  /** Inline workflow definition */
  workflow?: WorkflowDefinition;
  /** Plain-English description of the workflow to run (for AI-generated flows) */
  description?: string;
  /** Initial variables to inject into the workflow context */
  initialVars?: Record<string, unknown>;
}

/**
 * Result of a single completed workflow step.
 */
export interface WorkflowStepResult {
  stepId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Result of a complete workflow execution.
 */
export interface WorkflowResult {
  success: boolean;
  workflowName: string;
  stepsExecuted: number;
  stepsSkipped: number;
  stepsFailed: number;
  results: WorkflowStepResult[];
  error?: string;
}

/**
 * Defines a Path Informaiton object that contains information about a file or directory
 */
export type PathInfo = {
  name: string;
  extension: string;
  size: number;
  created?: Date;
  modified?: Date;
  accessed?: Date;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  isBlockDevice?: boolean;
  isCharacterDevice?: boolean;
  isFIFO?: boolean;
  isSocket?: boolean;
  isWritable: boolean;
  isReadable: boolean;
  isExecutable: boolean;
  owner: string;
  group: string;
  mode?: string;
  path?: string;
  absolutePath?: string;
  relativePath?: string;
  parentPath?: string;
  parentAbsolutePath?: string;
  parentRelativePath?: string;
  error?: Error;
}

