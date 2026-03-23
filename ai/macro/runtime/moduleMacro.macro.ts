import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import modules from '@reactory/server-core/modules';
import { ModuleMacroProps } from './types';

// a macro that describes modules installed in reactory
export const ModuleMacro: Macro<unknown, ModuleMacroProps> = async (
  props: ModuleMacroProps,
  state: ChatState): Promise<unknown> => {    
    const { details = false } = props;
    
    try {
      const describeModule = (module: Reactory.Server.IReactoryModule) => { 
        if (details) {
          return {
            id: `${module.nameSpace}.${module.name}@${module.version}`,
            nameSpace: module.nameSpace,
            name: module.name,
            version: module.version,
            dependencies: module.dependencies,
            services: module.services.map((service) => service.id)
          };
        } else {
          return {
            id: `${module.nameSpace}.${module.name}@${module.version}`,
            nameSpace: module.nameSpace,
            name: module.name,
            version: module.version
          };
        }
      };
      
      const modulesList = modules.enabled?.map((mod) => describeModule(mod)) || [];
      
      const namespaces = [...new Set(modulesList.map((m: any) => m.nameSpace))];

      return {
        result: modulesList,
        success: true,
        operation: 'list',
        modules: modulesList,
        count: modulesList.length,
        details: details,
        instructions: `## Installed Modules (${modulesList.length})\n\n${modulesList.length} module${modulesList.length !== 1 ? 's' : ''} across ${namespaces.length} namespace${namespaces.length !== 1 ? 's' : ''}: ${namespaces.join(', ')}\n\n### Available Data:\n- **modules**: Array of module objects (id, nameSpace, name, version${details ? ', dependencies, services' : ''})\n- **count**: Total number of modules\n- **details**: ${details ? 'Detailed view (includes dependencies and services)' : 'Summary view — set details=true for dependencies and services'}\n\n### Suggested Next Steps:\n- Use \`modules\` with details=true to see service registrations and dependencies\n- Use \`queryGQL\` to interact with module-specific GraphQL endpoints\n- Use \`state\` to see current session context`
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      return {
        error: `Error in modules macro: ${errMsg}`,
        success: false,
        instructions: `## Modules — Error\n\nFailed to list installed modules.\n\n### Error Details:\n- **Message**: ${errMsg}\n\n### Recovery Options:\n- Retry the \`modules\` tool\n- Use \`state\` to check session health`
      };
    }
};

export const ModuleMacroRegistry: MacroComponentDefinition<typeof ModuleMacro> = { 
  nameSpace: 'reactor-macros',
  name: 'modules',
  alias: 'modules',
  version: '1.0.0',
  component: ModuleMacro,
  roles: ['ADMIN', 'DEVELOPER'],
  description: `# modules macro
  Use this macro to list the modules installed in reactory
  
  ## Usage
  @modules - lists the modules installed in reactory
  `,
  features: [
    {
      feature: 'list',
      featureType: Reactory.FeatureType.function,
      action: ['list', 'show', 'display'],
      description: 'Operation that lists the modules installed in reactory.',
      stem: 'list'
    }
  ],
  stem: 'list',
  tags: ['list', 'modules', 'installed'],
  tools: [{
    type: "function",
    safeForAutoExecution: true,
    function: {
      name: "modules",
      description: "Lists modules installed in the Reactory system",
      parameters: {
        type: "object",
        properties: {
          details: {
            type: "boolean",
            description: "Show detailed information about the modules"
          }
        },
        required: []
      }
    }
  }]
} 