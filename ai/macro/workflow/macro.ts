import Reactory from "@reactorynet/reactory-core";
import { readFileSync } from "fs";
import { ChatState, Macro } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import {
  ServiceRegisterProps,
  RunWorkflowProps,
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepResult,
  WorkflowResult,
} from './types';


// ── Condition evaluation helpers ────────────────────

/**
 * Resolves a dot-path string against an object.
 * e.g. resolveField({ a: { b: 3 } }, 'a.b') => 3
 */
function resolveField(ctx: Record<string, unknown>, field: string): unknown {
  return field.split('.').reduce<unknown>((obj, key) => {
    if (obj !== null && obj !== undefined && typeof obj === 'object') {
      return (obj as Record<string, unknown>)[key];
    }
    return undefined;
  }, ctx);
}

/**
 * Evaluates a single WorkflowCondition against the workflow context object.
 */
function evaluateCondition(condition: WorkflowCondition, ctx: Record<string, unknown>): boolean {
  const fieldValue = resolveField(ctx, condition.field);
  const target = condition.value;

  switch (condition.operator) {
    case 'eq': return fieldValue === target;
    case 'neq': return fieldValue !== target;
    case 'gt': return typeof fieldValue === 'number' && typeof target === 'number' && fieldValue > target;
    case 'gte': return typeof fieldValue === 'number' && typeof target === 'number' && fieldValue >= target;
    case 'lt': return typeof fieldValue === 'number' && typeof target === 'number' && fieldValue < target;
    case 'lte': return typeof fieldValue === 'number' && typeof target === 'number' && fieldValue <= target;
    case 'contains':
      if (typeof fieldValue === 'string' && typeof target === 'string') return fieldValue.includes(target);
      if (Array.isArray(fieldValue)) return fieldValue.includes(target);
      return false;
    case 'not_contains':
      if (typeof fieldValue === 'string' && typeof target === 'string') return !fieldValue.includes(target);
      if (Array.isArray(fieldValue)) return !fieldValue.includes(target);
      return true;
    case 'exists': return fieldValue !== undefined && fieldValue !== null;
    case 'not_exists': return fieldValue === undefined || fieldValue === null;
    case 'truthy': return !!fieldValue;
    case 'falsy': return !fieldValue;
    default: return false;
  }
}

/**
 * Evaluates all conditions; returns true only when every condition passes.
 */
function evaluateConditions(conditions: WorkflowCondition[], ctx: Record<string, unknown>): boolean {
  return conditions.every((c) => evaluateCondition(c, ctx));
}


// ── Parameter interpolation ─────────────────────────

/**
 * Recursively interpolates `{{path}}` tokens inside string values against the
 * workflow context.  Non-string values are returned as-is.
 *
 * Example: `"Hello {{vars.name}}"` with ctx `{ vars: { name: "World" } }` => `"Hello World"`
 */
function interpolateParams(params: Record<string, unknown>, ctx: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(params)) {
    if (typeof val === 'string') {
      result[key] = val.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
        const resolved = resolveField(ctx, path.trim());
        return resolved !== undefined && resolved !== null ? String(resolved) : '';
      });
    } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = interpolateParams(val as Record<string, unknown>, ctx);
    } else {
      result[key] = val;
    }
  }
  return result;
}


// ── Workflow execution engine ───────────────────────

/**
 * Resolves the macro function for a given macro name from the state context.
 * We import lazily to avoid circular dependency with the macro index.
 */
async function resolveMacro(macroName: string): Promise<Macro<unknown> | null> {
  // Lazy import to avoid circular dependency between workflow/macro.ts and ../index.ts
  const { getMacro } = await import('../index');
  return getMacro(macroName) ?? null;
}

/**
 * Executes a single workflow step.
 */
async function executeStep(
  step: WorkflowStep,
  ctx: Record<string, unknown>,
  state: ChatState,
): Promise<WorkflowStepResult> {
  // --- condition gate ---
  if (step.conditions && step.conditions.length > 0) {
    if (!evaluateConditions(step.conditions, ctx)) {
      return {
        stepId: step.id,
        success: true,
        skipped: true,
        skipReason: `Conditions not met for step "${step.label ?? step.id}"`,
      };
    }
  }

  try {
    const macro = await resolveMacro(step.macro);
    if (!macro) {
      return {
        stepId: step.id,
        success: false,
        error: `Macro "${step.macro}" not found in MacroRegistry`,
      };
    }

    // Interpolate parameters from context
    const params = step.params ? interpolateParams(step.params, ctx) : {};
    const result = await macro(params as any, state);

    return {
      stepId: step.id,
      success: true,
      result,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stepId: step.id,
      success: false,
      error: message,
    };
  }
}

/**
 * Runs a complete workflow definition, executing each step sequentially,
 * evaluating conditions, and collecting results.
 */
async function runWorkflow(
  workflow: WorkflowDefinition,
  state: ChatState,
  initialVars: Record<string, unknown> = {},
): Promise<WorkflowResult> {
  const ctx: Record<string, unknown> = {
    vars: { ...state.vars, ...initialVars },
    lastResult: null,
  };

  const results: WorkflowStepResult[] = [];
  let stepsExecuted = 0;
  let stepsSkipped = 0;
  let stepsFailed = 0;

  for (const step of workflow.steps) {
    const stepResult = await executeStep(step, ctx, state);
    results.push(stepResult);

    if (stepResult.skipped) {
      stepsSkipped++;
      continue;
    }

    stepsExecuted++;

    // Store the result in context for downstream steps
    const varName = step.outputVar ?? step.id;
    (ctx.vars as Record<string, unknown>)[varName] = stepResult.result;
    ctx.lastResult = stepResult.result;

    if (!stepResult.success) {
      stepsFailed++;
      if (!step.continueOnError) {
        return {
          success: false,
          workflowName: workflow.name,
          stepsExecuted,
          stepsSkipped,
          stepsFailed,
          results,
          error: `Workflow aborted at step "${step.label ?? step.id}": ${stepResult.error}`,
        };
      }
    }
  }

  return {
    success: stepsFailed === 0,
    workflowName: workflow.name,
    stepsExecuted,
    stepsSkipped,
    stepsFailed,
    results,
  };
}


// ── ServiceRegister macro (existing) ────────────────

/**
 * A macro that lists all services registered in the system or
 * returns the service with the given name / fqn.
 * @param props - ServiceRegisterProps - { action, name, nameSpace, version, props, func, funcParams, format }
 * @param state - the current chat state
 * @returns 
 */
export const ServiceRegister: Macro<string | object | object[], ServiceRegisterProps> = async (props: ServiceRegisterProps, state: ChatState) => {
  
  const list = (format: string = 'string'): string | object => {
    const { services } = state.context;
    if(services && services.length > 0) {
      if(format === 'string') {
        return services.map(s => `${s.id} -> ${s.description || 'No description available'}`).join('\n');
      } else {
        return services;
      }
    } else {
      return 'No services registered';
    }
  }

  const { action, name, nameSpace, version, props: serviceProps = null, func = null, funcParams, format = 'string' } = props;

  if(action) {
    switch(action) {
      case 'list': {
        return list(format);
      }
      case 'get': { 
        if (name && nameSpace && version) {
          const service = state.context?.getService<any>(`${nameSpace}.${name}@${version}`, serviceProps);
          if(service) {
            if(func && funcParams) { 
              const result = await service[func](...funcParams);
              return result;
            } else {
              return service;
            }
          }
        }
        break;
      }
      default: {
        return list();
      }
    }
  } 
  
  //assume we are listing all services
  return list() as string;
}


// ── RunWorkflow macro ───────────────────────────────

/**
 * Macro that executes a multi-step workflow, evaluating conditions between
 * steps and piping results forward via a shared context.
 *
 * The AI agent can supply an inline workflow definition or a plain-English
 * description (the description path is a placeholder for future AI-generated
 * workflow support and currently returns an error).
 */
export const RunWorkflow: Macro<WorkflowResult, RunWorkflowProps> = async (
  props: RunWorkflowProps,
  state: ChatState,
): Promise<WorkflowResult> => {
  const { workflow, description, initialVars = {} } = props;

  if (!workflow && !description) {
    return {
      success: false,
      workflowName: 'unknown',
      stepsExecuted: 0,
      stepsSkipped: 0,
      stepsFailed: 1,
      results: [],
      error: 'Either a "workflow" definition or a "description" must be provided.',
    };
  }

  // If a description was supplied but no workflow, return guidance
  if (!workflow && description) {
    return {
      success: false,
      workflowName: 'ai-generated',
      stepsExecuted: 0,
      stepsSkipped: 0,
      stepsFailed: 0,
      results: [],
      error:
        'AI-generated workflows from plain-English descriptions are not yet supported. ' +
        'Please supply a structured "workflow" definition with steps.',
    };
  }

  // Validate workflow has at least one step
  if (!workflow!.steps || workflow!.steps.length === 0) {
    return {
      success: false,
      workflowName: workflow!.name ?? 'unnamed',
      stepsExecuted: 0,
      stepsSkipped: 0,
      stepsFailed: 1,
      results: [],
      error: 'Workflow must contain at least one step.',
    };
  }

  return runWorkflow(workflow!, state, initialVars);
}

export const ServiceRegisterComponentDefinition: Reactory.IReactoryComponentDefinition<Macro<string | string[] | object | object[]>> = {
  component: ServiceRegister,
  name: 'svc',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: readFileSync(require.resolve('./ServiceRegister.md')).toString(),
  features: [],
  stem: 'mutation',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'graphql', 'mutation', 'service', 'registry'],
  tools: [{
    type: "function",
    function: {
      name: "svc",
      description: "List or interact with registered services",
      icon: "build",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "The action to perform (list, get)"
          },
          name: {
            type: "string",
            description: "The service name"
          },
          nameSpace: {
            type: "string",
            description: "The service namespace"
          },
          version: {
            type: "string",
            description: "The service version"
          },
          props: {
            type: "object",
            description: "Service properties"
          },
          func: {
            type: "string",
            description: "Function to call on the service"
          },
          funcParams: {
            type: "array",
            description: "Parameters for the function call",
            items: {
              type: "string",
              description: "Function parameter value"
            }
          },
          format: {
            type: "string",
            description: "Output format (string or object)"
          }
        },
        required: ["action"]
      }
    }
  }]
};

export const RunWorkflowComponentDefinition: Reactory.IReactoryComponentDefinition<Macro<WorkflowResult, RunWorkflowProps>> = {
  component: RunWorkflow,
  name: 'workflow',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: 'Execute a multi-step workflow with conditional logic and parameter interpolation between steps.',
  features: [],
  stem: 'mutation',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'workflow', 'automation', 'orchestration', 'pipeline'],
  tools: [{
    type: "function",
    function: {
      name: "workflow",
      description: "Execute a multi-step workflow. Each step invokes a registered macro with parameters. Steps can have conditions that gate execution and results pipe forward via {{vars.stepId}} interpolation. Useful for chaining multiple operations (e.g. read file → transform → write).",
      icon: "account_tree",
      parameters: {
        type: "object",
        properties: {
          workflow: {
            type: "object",
            description: "The workflow definition containing name and steps.",
            properties: {
              name: {
                type: "string",
                description: "Unique name for this workflow"
              },
              description: {
                type: "string",
                description: "Human-readable description of what the workflow does"
              },
              steps: {
                type: "array",
                description: "Ordered list of steps to execute",
                items: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      description: "Unique step identifier, also used as the variable name to store the result"
                    },
                    label: {
                      type: "string",
                      description: "Human-readable label for the step"
                    },
                    macro: {
                      type: "string",
                      description: "The name of the macro/tool to invoke (e.g. 'readFile', 'shell', 'git', 'mongoQuery')"
                    },
                    params: {
                      type: "object",
                      description: "Parameters object to pass to the macro. Use {{vars.stepId}} for interpolation from prior step results."
                    },
                    conditions: {
                      type: "array",
                      description: "Optional conditions — all must pass for the step to execute",
                      items: {
                        type: "object",
                        properties: {
                          field: {
                            type: "string",
                            description: "Dot-path into the workflow context (e.g. 'vars.step1.success', 'lastResult')"
                          },
                          operator: {
                            type: "string",
                            description: "Comparison operator: eq, neq, gt, gte, lt, lte, contains, not_contains, exists, not_exists, truthy, falsy"
                          },
                          value: {
                            type: "string",
                            description: "Value to compare against (not needed for exists/truthy/falsy)"
                          }
                        },
                        required: ["field", "operator"]
                      }
                    },
                    outputVar: {
                      type: "string",
                      description: "Variable name to store this step's result under. Defaults to step id."
                    },
                    continueOnError: {
                      type: "boolean",
                      description: "If true, continue the workflow even if this step fails. Default: false."
                    }
                  },
                  required: ["id", "macro"]
                }
              }
            },
            required: ["name", "steps"]
          },
          initialVars: {
            type: "object",
            description: "Initial variables to inject into the workflow context before execution"
          }
        },
        required: ["workflow"]
      }
    }
  }]
};
