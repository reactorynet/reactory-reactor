import yaml from 'js-yaml';
import * as fs from 'fs';
import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import {
  IReactoryWorkflowService,
  IWorkflowDefinitionInput,
} from "@reactory/server-modules/reactory-core/services/Workflow/types";

export interface ValidateWorkflowYamlProps {
  yamlContent?: string;
  definition?: IWorkflowDefinitionInput;
  filePath?: string | null;
}

export const validateWorkflowYaml: Macro<unknown, ValidateWorkflowYamlProps> = async (
  props: ValidateWorkflowYamlProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<unknown> => {
  let { yamlContent, definition, filePath = null } = props;
  const ctx = context || state.context;

  try {
    if (!ctx) return { success: false, error: "No execution context available." };

    // If filePath is provided, read the YAML content from the file
    if (filePath) {
      try {
        yamlContent = fs.readFileSync(filePath, 'utf8');
      } catch (readErr: any) {
        return {
          success: false,
          isValid: false,
          errors: [{ field: 'filePath', message: `Failed to read file at '${filePath}': ${readErr.message || String(readErr)}`, code: 'FILE_READ_ERROR' }],
        };
      }
    }

    if (!yamlContent && !definition) {
      return { success: false, error: "Provide either 'yamlContent' (raw YAML), 'filePath' (path to a YAML file), or a structured 'definition'." };
     }

    const workflowService = ctx.getService('core.ReactoryWorkflowService@1.0.0') as IReactoryWorkflowService;
    if (!workflowService) {
      return { success: false, error: "core.ReactoryWorkflowService@1.0.0 is not available in the context." };
     }

    let parsedDefinition: IWorkflowDefinitionInput;
    if (definition) {
      parsedDefinition = definition;
     } else {
      try {
        const parsed = yaml.load(yamlContent as string);
        if (!parsed || typeof parsed !== 'object') {
          return {
            success: false,
            isValid: false,
            errors: [{ field: 'yamlContent', message: 'YAML content must be a valid workflow object', code: 'INVALID_CONTENT' }],
           };
         }
        parsedDefinition = parsed as IWorkflowDefinitionInput;
       } catch (parseErr: any) {
        return {
          success: false,
          isValid: false,
          errors: [{ field: 'yamlContent', message: parseErr.message || String(parseErr), code: 'YAML_PARSE_ERROR' }],
         };
       }
     }

    const result = await workflowService.validateWorkflowDefinition(parsedDefinition);

    return {
      success: true,
      isValid: result.isValid,
      errors: result.errors,
      warnings: result.warnings,
      hint: result.isValid
         ? "Definition passes structural validation. Safe to persist via saveWorkflowYaml."
         : "Fix the reported errors before calling saveWorkflowYaml.",
     };
   } catch (err: any) {
    ctx?.log(`validateWorkflowYaml Macro Error: ${err.message}`, 'error');
    return { success: false, error: err.message };
   }
};

export const ValidateWorkflowYamlRegistry: MacroComponentDefinition<typeof validateWorkflowYaml> = {
  nameSpace: 'reactor-macros',
  name: 'validateWorkflowYaml',
  alias: 'validateWorkflowYaml',
  version: '1.0.0',
  component: validateWorkflowYaml,
  roles: ['ADMIN', 'DEVELOPER', 'WORKFLOW_ADMIN', 'WORKFLOW_OPERATOR'],
  description: `# validateWorkflowYaml
  Dry-run validation for a workflow definition. Accepts raw YAML (parsed in the macro), a file path to a YAML file (read and parsed automatically), or a structured definition object,
  and returns structural errors and warnings without writing anything to the catalog.

   ## Usage
   @validateWorkflowYaml({ yamlContent })
   @validateWorkflowYaml({ filePath })
   @validateWorkflowYaml({ definition })
   `,
  features: [
     {
      feature: 'validateWorkflowYaml',
      featureType: Reactory.FeatureType.function,
      action: ['validate', 'check', 'lint'],
      description: 'Validates a workflow definition without persisting it.',
      stem: 'query',
     },
    ],
  stem: 'query',
  tags: ['workflow', 'yaml', 'validate', 'dry-run', 'lint'],
  tools: [
     {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "validateWorkflowYaml",
        description: "Validates a workflow definition without saving it. Pass either yamlContent (raw YAML), filePath (path to a YAML file on disk), or a structured definition. Use this before saveWorkflowYaml to catch errors early.",
        parameters: {
          type: "object",
          properties: {
            yamlContent: {
              type: "string",
              description: "Raw YAML source text for the workflow definition. Will be parsed and validated.",
             },
            filePath: {
              type: "string",
              description: "File system path to a YAML file containing the workflow definition. The file will be read and its contents parsed as YAML.",
             },
            definition: {
              type: "object",
              description: "Structured workflow definition input (IWorkflowDefinitionInput). Use when you already have the parsed object.",
             },
           },
          required: [],
         },
       },
     },
    ],
};