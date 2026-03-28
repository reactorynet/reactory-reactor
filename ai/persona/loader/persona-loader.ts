// @ts-ignore - js-yaml types
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import logger from "@reactory/server-core/logging";
// Local interface definitions to avoid import issues
interface IAIPersona {
  id: string;
  name: string;
  description?: string;
  persona: string;
  features: string;
  modelId?: string;
  providerId?: string;
  defaultGreeting?: string;
  config?: {
    apiKey?: string;
    apiBaseURL?: string;
    project?: string;
  };
  tools?: any[];
  macros?: any[];
  resources?: IAIPersonaResource[];
  prompts?: any;
}

interface IAIPersonaResource {
  id: string;
  name: string;
  description?: string;
  type: string;
  url?: string;
  created: Date;
}

interface IAIPersonaConfig {
  id: string;
  name: string;
  description?: string;
  persona?: string;
  features?: string;
  modelId?: string;
  providerId?: string;
  defaultGreeting?: string;
  config?: {
    apiKey?: string;
    apiBaseURL?: string;
    project?: string;
  };
  tools?: {
    includes?: string[];
    custom?: any[];
  };
  macros?: {
    includes?: string[];
    custom?: any[];
  };
  resources?: IAIPersonaResource[];
  roleCapabilities?: {
    ADMIN?: string;
    ENGINEER?: string;
    USER?: string;
    default?: string;
  };
  prompts?: any;
  merge?: {
    mode?: 'merge' | 'replace' | 'create';
    options?: {
      overwriteExisting?: boolean;
      preserveExistingTools?: boolean;
      preserveExistingMacros?: boolean;
      preserveExistingResources?: boolean;
      updateMetadata?: boolean;
    };
  };
  validation?: {
    required?: string[];
    types?: Record<string, string>;
  };
  metadata?: {
    version?: string;
    created?: string;
    lastModified?: string;
    author?: string;
    tags?: string[];
    componentRegistry?: any;
  };
  environment?: Record<string, string>;
}

interface PersonaLoaderOptions {
  validateOnLoad?: boolean;
  processEnvironmentVars?: boolean;
  mergeMode?: 'merge' | 'replace' | 'create';
}

export class PersonaLoader {
  private static instance: PersonaLoader;
  private macroRegistry: Map<string, any> = new Map();
  private toolRegistry: Map<string, any> = new Map();

  private constructor() {}

  static getInstance(): PersonaLoader {
    if (!PersonaLoader.instance) {
      PersonaLoader.instance = new PersonaLoader();
    }
    return PersonaLoader.instance;
  }

  /**
   * Load a persona configuration from a YAML file
   */
  loadFromFile(filePath: string, options: PersonaLoaderOptions = {}): IAIPersona {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      return this.loadFromString(fileContent, options);
    } catch (error) {
      logger.error(`Failed to load persona from file ${filePath}: ${error}`);
      throw new Error(`Failed to load persona from file ${filePath}: ${error}`);
    }
  }

  /**
   * Load a persona configuration from a YAML string
   */
  loadFromString(yamlContent: string, options: PersonaLoaderOptions = {}): IAIPersona {
    try {
      const config = yaml.load(yamlContent) as IAIPersonaConfig;
      return this.processConfig(config, options);
    } catch (error) {
      logger.error(`Failed to parse YAML content: ${error}`);
      throw new Error(`Failed to parse YAML content: ${error}`);
    }
  }

  /**
   * Load multiple personas from a directory
   */
  loadFromDirectory(dirPath: string, options: PersonaLoaderOptions = {}): IAIPersona[] {
    const personas: IAIPersona[] = [];
    
    try {
      const files = fs.readdirSync(dirPath);
      const yamlFiles = files.filter(file => 
        file.endsWith('agent.yaml') || file.endsWith('agent.yml')
      );

      for (const file of yamlFiles) {
        const filePath = path.join(dirPath, file);
        try {
          const persona = this.loadFromFile(filePath, options);
          personas.push(persona);
        } catch (error) {
          logger.error(`Failed to load persona from ${file}: ${error}`);
        }
      }
    } catch (error) {
      logger.error(`Failed to load personas from directory ${dirPath}: ${error}`);
      throw new Error(`Failed to load personas from directory ${dirPath}: ${error}`);
    }

    return personas;
  }

  /**
   * Merge a YAML configuration with an existing IAIPersona
   */
  mergeWithExisting(
    existingPersona: IAIPersona, 
    yamlConfig: string | IAIPersonaConfig, 
    options: PersonaLoaderOptions = {}
  ): IAIPersona {
    const config = typeof yamlConfig === 'string' 
      ? yaml.load(yamlConfig) as IAIPersonaConfig 
      : yamlConfig;

    const mergeMode = config.merge?.mode || options.mergeMode || 'merge';
    
    switch (mergeMode) {
      case 'replace':
        return this.processConfig(config, options);
      case 'create':
        return this.createNewFromConfig(config, options);
      case 'merge':
      default:
        return this.mergeConfigs(existingPersona, config, options);
    }
  }

  /**
   * Save an IAIPersona to a YAML file
   */
  saveToFile(persona: IAIPersona, filePath: string): void {
    try {
      const config = this.convertPersonaToConfig(persona);
      const yamlContent = yaml.dump(config, {
        indent: 2,
        lineWidth: 120,
        noRefs: true
      });
      fs.writeFileSync(filePath, yamlContent, 'utf8');
    } catch (error) {
      throw new Error(`Failed to save persona to file ${filePath}: ${error}`);
    }
  }

  /**
   * Validate a persona configuration
   */
  validateConfig(config: IAIPersonaConfig): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];
    const required = config.validation?.required || ['id', 'name'];

    // Check required fields
    for (const field of required) {
      if (!config[field as keyof IAIPersonaConfig]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // Check field types
    const types = config.validation?.types || {};
    for (const [field, expectedType] of Object.entries(types)) {
      const value = config[field as keyof IAIPersonaConfig];
      if (value !== undefined) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== expectedType) {
          errors.push(`Field ${field} should be of type ${expectedType}, got ${actualType}`);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Get role capabilities for a specific role
   */
  getRoleCapabilities(persona: IAIPersona, userRoles: string[]): string {
    // This would need to be implemented based on the actual persona structure
    // For now, returning a default message
    return `You have access to ${persona.tools?.length || 0} tools and ${persona.resources?.length || 0} resources.`;
  }

  private processConfig(config: IAIPersonaConfig, options: PersonaLoaderOptions): IAIPersona {
    // Process environment variables if enabled
    if (options.processEnvironmentVars !== false) {
      config = this.processEnvironmentVariables(config);
    }

    // Validate configuration if enabled
    if (options.validateOnLoad !== false) {
      const validation = this.validateConfig(config);
      if (!validation.isValid) {
        throw new Error(`Invalid persona configuration: ${validation.errors.join(', ')}`);
      }
    }

    // Convert config to IAIPersona
    return this.convertConfigToPersona(config);
  }

  private processEnvironmentVariables(config: IAIPersonaConfig): IAIPersonaConfig {
    const processedConfig = JSON.parse(JSON.stringify(config));
    
    const processValue = (value: any): any => {
      if (typeof value === 'string') {
        return value.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
          const [varName, defaultValue] = envVar.split(':-');
          return process.env[varName] || defaultValue || match;
        });
      } else if (Array.isArray(value)) {
        return value.map(processValue);
      } else if (typeof value === 'object' && value !== null) {
        const processed: any = {};
        for (const [key, val] of Object.entries(value)) {
          processed[key] = processValue(val);
        }
        return processed;
      }
      return value;
    };

    return processValue(processedConfig);
  }

  private convertConfigToPersona(config: IAIPersonaConfig): IAIPersona {
    const persona: IAIPersona = {
      id: config.id,
      name: config.name,
      description: config.description || '',
      persona: config.persona || '',
      features: config.features || '',
      modelId: config.modelId || 'gemini-2.5-pro',
      providerId: config.providerId || 'google',
      defaultGreeting: config.defaultGreeting || '',
      config: config.config || {},
      tools: this.resolveTools(config.tools),
      macros: this.resolveMacros(config.macros),
      resources: config.resources || [],
      prompts: config.prompts || {}
    };

    return persona;
  }

  private convertPersonaToConfig(persona: IAIPersona): IAIPersonaConfig {
    return {
      id: persona.id,
      name: persona.name,
      description: persona.description,
      persona: persona.persona,
      features: persona.features,
      modelId: persona.modelId,
      providerId: persona.providerId,
      defaultGreeting: persona.defaultGreeting,
      config: persona.config,
      tools: {
        includes: persona.tools?.map((t: any) => t.function?.name || t.name).filter(Boolean) || []
      },
      macros: {
        includes: persona.macros?.map((m: any) => m.name).filter(Boolean) || []
      },
      resources: persona.resources,
      prompts: persona.prompts,
      metadata: {
        version: '1.0.0',
        created: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        author: 'System',
        tags: ['persona', 'ai', 'assistant']
      }
    };
  }

  private resolveTools(toolsConfig?: { includes?: string[]; custom?: any[] }): any[] {
    const tools: any[] = [];

    if (toolsConfig?.includes) {
      for (const toolName of toolsConfig.includes) {
        // Primary: look up by tool function name (e.g. "readFile", "shell")
        const tool = this.toolRegistry.get(toolName);
        if (tool) {
          tools.push(tool);
        } else {
          // Secondary: check if this name matches a macro, and if so pull all its tools
          const macro = this.macroRegistry.get(toolName);
          if (macro && macro.tools) {
            tools.push(...macro.tools);
          } else {
            logger.warn(`PersonaLoader: Tool "${toolName}" not found in registry (${this.toolRegistry.size} tools registered)`);
          }
        }
      }
    }

    if (toolsConfig?.custom) {
      tools.push(...toolsConfig.custom);
    }

    return tools;
  }

  private resolveMacros(macrosConfig?: { includes?: string[]; custom?: any[] }): any[] {
    const macros: any[] = [];

    if (macrosConfig?.includes) {
      for (const macroName of macrosConfig.includes) {
        // Primary: look up by macro component name (e.g. "readFile", "shell")
        const macro = this.macroRegistry.get(macroName);
        if (macro) {
          macros.push(macro);
        } else {
          // Secondary: find macros that contain a tool with this function name
          let found = false;
          for (const [, registeredMacro] of this.macroRegistry) {
            if (registeredMacro.tools?.some((t: any) =>
              t.type === "function" && t.function?.name === macroName
            )) {
              macros.push(registeredMacro);
              found = true;
              break;
            }
          }
          if (!found) {
            logger.warn(`PersonaLoader: Macro "${macroName}" not found in registry (${this.macroRegistry.size} macros registered)`);
          }
        }
      }
    }

    if (macrosConfig?.custom) {
      macros.push(...macrosConfig.custom);
    }

    return macros;
  }

  private mergeConfigs(existing: IAIPersona, config: IAIPersonaConfig, options: PersonaLoaderOptions): IAIPersona {
    const mergeOptions = config.merge?.options || {};
    
    const merged: IAIPersona = {
      ...existing,
      ...(mergeOptions.overwriteExisting ? {
        name: config.name || existing.name,
        description: config.description || existing.description,
        persona: config.persona || existing.persona,
        features: config.features || existing.features,
        modelId: config.modelId || existing.modelId,
        providerId: config.providerId || existing.providerId,
        defaultGreeting: config.defaultGreeting || existing.defaultGreeting,
        config: { ...existing.config, ...config.config }
      } : {
        name: config.name || existing.name,
        description: config.description || existing.description,
        persona: config.persona || existing.persona,
        features: config.features || existing.features,
        modelId: config.modelId || existing.modelId,
        providerId: config.providerId || existing.providerId,
        defaultGreeting: config.defaultGreeting || existing.defaultGreeting,
        config: { ...existing.config, ...config.config }
      }),
      tools: mergeOptions.preserveExistingTools 
        ? [...(existing.tools || []), ...this.resolveTools(config.tools)]
        : this.resolveTools(config.tools),
      macros: mergeOptions.preserveExistingMacros
        ? [...(existing.macros || []), ...this.resolveMacros(config.macros)]
        : this.resolveMacros(config.macros),
      resources: mergeOptions.preserveExistingResources
        ? [...(existing.resources || []), ...(config.resources || [])]
        : config.resources || [],
      prompts: { ...existing.prompts, ...config.prompts }
    };

    return merged;
  }

  private createNewFromConfig(config: IAIPersonaConfig, options: PersonaLoaderOptions): IAIPersona {
    // Generate a new ID if not provided
    if (!config.id) {
      config.id = `persona-${Date.now()}`;
    }

    return this.processConfig(config, options);
  }

  /**
   * Register a tool in the tool registry
   */
  registerTool(name: string, tool: any): void {
    this.toolRegistry.set(name, tool);
  }

  /**
   * Register a macro in the macro registry
   */
  registerMacro(name: string, macro: any): void {
    this.macroRegistry.set(name, macro);
  }

  /**
   * Get all registered tools
   */
  getRegisteredTools(): Map<string, any> {
    return new Map(this.toolRegistry);
  }

  /**
   * Get all registered macros
   */
  getRegisteredMacros(): Map<string, any> {
    return new Map(this.macroRegistry);
  }
}

// Export a singleton instance
export const personaLoader = PersonaLoader.getInstance();

// Export utility functions
export const loadPersonaFromFile = (filePath: string, options?: PersonaLoaderOptions) => 
  personaLoader.loadFromFile(filePath, options);

export const loadPersonaFromString = (yamlContent: string, options?: PersonaLoaderOptions) => 
  personaLoader.loadFromString(yamlContent, options);

export const loadPersonasFromDirectory = (dirPath: string, options?: PersonaLoaderOptions) => 
  personaLoader.loadFromDirectory(dirPath, options);

export const mergePersonaWithConfig = (
  existingPersona: IAIPersona, 
  yamlConfig: string | IAIPersonaConfig, 
  options?: PersonaLoaderOptions
) => personaLoader.mergeWithExisting(existingPersona, yamlConfig, options);

export const savePersonaToFile = (persona: IAIPersona, filePath: string) => 
  personaLoader.saveToFile(persona, filePath);

export const validatePersonaConfig = (config: IAIPersonaConfig) => 
  personaLoader.validateConfig(config); 