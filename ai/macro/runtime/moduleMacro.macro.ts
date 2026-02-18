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
      
      return {
        result: modulesList,
        success: true,
        operation: 'list',
        modules: modulesList,
        count: modulesList.length,
        details: details
      };
    } catch (err) {
      return {
        error: `Error in modules macro: ${err instanceof Error ? err.message : 'Unknown error'}`,
        success: false
      };
    }
};

export const ModuleMacroRegistry: MacroComponentDefinition<typeof ModuleMacro> = { 
  nameSpace: 'reactor-macros',
  name: 'modules',
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