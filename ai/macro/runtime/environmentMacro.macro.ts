import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import { EnvironmentMacroProps } from './types';

// a macro that provides information about the environment variables
export const EnvironmentMacro: Macro<unknown, EnvironmentMacroProps> = async (
  props: EnvironmentMacroProps,
  state: ChatState): Promise<unknown> => {
    const { envKey } = props;
    
    try {
      // If a specific environment variable is requested
      if(envKey && typeof envKey === 'string') {
        const value = process.env[envKey];
        if (value) {
          return {
            result: value,
            success: true,
            operation: 'get',
            envKey: envKey,
            value: value,
            instructions: `## Environment Variable Retrieved\n\nSuccessfully read **${envKey}**.\n\n### Available Data:\n- **value**: The value of ${envKey}\n- **envKey**: The variable name queried\n\n### Suggested Next Steps:\n- Use \`var\` to store this value for later reference\n- Use \`env\` without parameters to list all safe environment variables`
          };
        } else {
          return {
            error: `Environment variable ${envKey} not found`,
            success: false,
            envKey: envKey,
            instructions: `## Environment Variable — Not Found\n\n**${envKey}** is not set in the current environment.\n\n### Recovery Options:\n- Use \`env\` without parameters to list available variables\n- Check the variable name spelling (names are case-sensitive)`
          };
        }
      }
      
      // Return all environment variables (or a safe subset)
      const safeEnvVars: Record<string, string> = {};
      // Option to filter sensitive variables or only include specific ones
      const allowedVars = [
        'NODE_ENV', 
        'PORT', 
        'HOST', 
        'APP_VERSION', 
        'APP_NAME', 
        'REACTORY_HOME', 
        'REACTORY_SERVER',
        'REACTORY_CLIENT',
        'REACTORY_DATA',
        'REACTORY_NATIVE',
        'HOME'
      ];
      
      allowedVars.forEach(varName => {
        if (process.env[varName]) {
          safeEnvVars[varName] = process.env[varName] as string;
        }
      });
      
      const envCount = Object.keys(safeEnvVars).length;
      const envList = Object.entries(safeEnvVars).map(([k, v]) => `- **${k}**: ${v}`).join('\n');

      return {
        result: safeEnvVars,
        success: true,
        operation: 'list',
        environmentVariables: safeEnvVars,
        count: envCount,
        instructions: `## Environment Variables (${envCount} available)\n\n${envList}\n\n### Available Data:\n- **environmentVariables**: Object with all safe environment variable key-value pairs\n- **count**: Number of variables returned\n\n### Suggested Next Steps:\n- Use \`env\` with a specific envKey to retrieve a single variable\n- Use \`var\` to store an env value for later reference\n- Only safe/non-secret variables are exposed; sensitive keys are filtered`
      };
    } catch (err) {
      return {
        error: `Error in environment macro: ${err instanceof Error ? err.message : 'Unknown error'}`,
        success: false
      };
    }
};

export const EnvironmentMacroRegistry: MacroComponentDefinition<typeof EnvironmentMacro> = {
  nameSpace: 'reactor-macros',
  name: 'env',
  version: '1.0.0',
  alias: 'env',
  component: EnvironmentMacro,
  roles: ['ADMIN', 'DEVELOPER'],
  description: `# env macro
  Use this macro to access environment variables

  ## Usage
  @env - returns a JSON object with safe environment variables
  @env(VAR_NAME) - returns the value of the specific environment variable
  `,
  features: [
    {
      feature: 'list',
      featureType: Reactory.FeatureType.function,
      action: ['list', 'show', 'display'],
      description: 'Operation that shows environment variables.',
      stem: 'list'
    },
    {
      feature: 'get',
      featureType: Reactory.FeatureType.function,
      action: ['get', 'fetch', 'retrieve'],
      description: 'Operation that gets a specific environment variable.',
      stem: 'get'
    }
  ],
  stem: 'environment',
  tags: ['env', 'environment', 'variables', 'config'],
  tools: [{
    type: "function",
    safeForAutoExecution: true,
    function: {
      name: "env",
      description: "Access environment variables",
      parameters: {
        type: "object",
        properties: {
          envKey: {
            type: "string",
            description: "The name of the environment variable to retrieve"
          }
        },
        required: []
      }
    }
  }]
} 