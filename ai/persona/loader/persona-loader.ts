// @ts-ignore - js-yaml types
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';
import {
  IAIPersona,
  IAIPersonaPromptTemplate,
  IAIPersonaResource,
} from '@reactory/server-modules/reactory-reactor/types/service.types';
import {
  MacroComponentDefinition,
  MacroToolDefinition,
} from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import ReactorMacroService from '@reactory/server-modules/reactory-reactor/services/reactor/providers/ReactorMacroService';
import {
  buildSystemPrompt,
  resolvePromptDirectives,
  SystemPromptBuildArgs,
} from './system-prompt';

export interface IAIPersonaConfig {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
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
  toolProfiles?: any[];
  resources?: IAIPersonaResource[];
  roleCapabilities?: {
    ADMIN?: string;
    ENGINEER?: string;
    USER?: string;
    default?: string;
  };
  prompts?: Record<string, IAIPersonaPromptTemplate>;
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

export interface PersonaLoaderOptions {
  validateOnLoad?: boolean;
  processEnvironmentVars?: boolean;
  mergeMode?: 'merge' | 'replace' | 'create';
  /**
   * Directory that relative `prompts.<key>.files` entries are resolved against.
   * `loadFromFile` / `loadFromDirectory` set this automatically to the directory
   * holding the `agent.yaml`. Callers loading from a string should supply it when
   * the YAML references prompt files on disk.
   */
  baseDir?: string;
  /**
   * Roles used when resolving `${roleCapabilities()}` / `${buildSystemPrompt()}`
   * at load time. Defaults to `['USER']`, matching the TypeScript personas.
   */
  userRoles?: string[];
}

@service({
  id: 'reactor.PersonaLoaderService@1.0.0',
  nameSpace: 'reactor',
  name: 'PersonaLoaderService',
  version: '1.0.0',
  description: 'Service for loading and resolving AI persona configurations from YAML files',
  serviceType: 'ai',
  lifeCycle: 'singleton',
  dependencies: [
    { id: 'reactor.ReactorMacroService@1.0.0', alias: 'macroService' },
  ],
})
class PersonaLoaderService implements Reactory.Service.IReactoryService {

  nameSpace: string = 'reactor';
  name: string = 'PersonaLoaderService';
  version: string = '1.0.0';
  description?: string = 'Service for loading and resolving AI persona configurations from YAML files';

  context: Reactory.Server.IReactoryContext;

  //@ts-ignore - injected via dependency autowiring
  private macroService: ReactorMacroService;

  private macroRegistry: Map<string, MacroComponentDefinition<unknown>> = new Map();
  private toolRegistry: Map<string, MacroToolDefinition> = new Map();
  private registriesPopulated: boolean = false;

  constructor(props: Reactory.Service.IReactoryServiceProps, context: Reactory.Server.IReactoryContext) {
    this.context = context;
  }

  toString?(includeVersion?: boolean): string {
    return `${this.nameSpace}.${this.name}${includeVersion ? `@${this.version}` : ''}`;
  }

  getExecutionContext(): Reactory.Server.IReactoryContext {
    return this.context;
  }

  setExecutionContext(context: Reactory.Server.IReactoryContext): void {
    this.context = context;
  }

  setMacroService(macroService: ReactorMacroService): void {
    this.macroService = macroService;
  }

  async onStartup(): Promise<void> {
    this.populateRegistries();
    this.context.log(
      `PersonaLoaderService ${this.context.colors.green('STARTUP OKAY')} — ` +
      `${this.toolRegistry.size} tools, ${this.macroRegistry.size} macros registered`,
      null, 'info', 'reactor.PersonaLoaderService'
    );
  }

  /**
   * Populate the internal tool and macro registries from the ReactorMacroService.
   * Called on startup and can be re-invoked if macros are added at runtime.
   */
  populateRegistries(): void {
    if (!this.macroService) {
      this.context.warn(
        'PersonaLoaderService: macroService dependency not available, registries will be empty',
        null, 'reactor.PersonaLoaderService'
      );
      return;
    }

    const allMacros = this.macroService.listAllMacros();
    for (const macro of allMacros) {
      this.macroRegistry.set(macro.name, macro);

      if (macro.tools) {
        for (const tool of macro.tools) {
          if (tool.type === 'function' && tool.function?.name) {
            this.toolRegistry.set(tool.function.name, tool);
          }
        }
      }
    }

    this.registriesPopulated = true;
  }

  // ─── YAML Loading ────────────────────────────────────────────────────

  /**
   * Load a persona configuration from a YAML file.
   *
   * The file's directory becomes the `baseDir` for relative `prompts.<key>.files`
   * entries, unless the caller supplies one explicitly.
   */
  loadFromFile(filePath: string, options: PersonaLoaderOptions = {}): IAIPersona {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      return this.loadFromString(fileContent, {
        ...options,
        baseDir: options.baseDir || path.dirname(filePath),
      });
    } catch (error) {
      this.context.error(`Failed to load persona from file ${filePath}: ${error}`, null, 'reactor.PersonaLoaderService');
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
      this.context.error(`Failed to parse YAML content: ${error}`, null, 'reactor.PersonaLoaderService');
      throw new Error(`Failed to parse YAML content: ${error}`);
    }
  }

  /**
   * Load multiple personas from a directory.
   * Scans for files ending in `agent.yaml` or `agent.yml`.
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
          this.context.error(`Failed to load persona from ${file}: ${error}`, null, 'reactor.PersonaLoaderService');
        }
      }
    } catch (error) {
      this.context.error(`Failed to load personas from directory ${dirPath}: ${error}`, null, 'reactor.PersonaLoaderService');
      throw new Error(`Failed to load personas from directory ${dirPath}: ${error}`);
    }

    return personas;
  }

  // ─── Merge & Save ────────────────────────────────────────────────────

  /**
   * Merge a YAML configuration with an existing IAIPersona.
   *
   * Supply `options.baseDir` when the override YAML references prompt files with
   * relative paths (see `prompts.<key>.files`).
   */
  mergeWithExisting(
    existingPersona: IAIPersona,
    yamlConfig: string | IAIPersonaConfig,
    options: PersonaLoaderOptions = {}
  ): IAIPersona {
    let config = typeof yamlConfig === 'string'
      ? yaml.load(yamlConfig) as IAIPersonaConfig
      : yamlConfig;

    // Environment substitution applies to overrides too — prompt file paths and
    // resource urls routinely reference ${REACTORY_SERVER} and friends.
    if (options.processEnvironmentVars !== false) {
      config = this.processEnvironmentVariables(config);
    }

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

  // ─── Validation ──────────────────────────────────────────────────────

  /**
   * Validate a persona configuration
   */
  validateConfig(config: IAIPersonaConfig): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];
    const required = config.validation?.required || ['id', 'name'];

    for (const field of required) {
      if (!config[field as keyof IAIPersonaConfig]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

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

    return { isValid: errors.length === 0, errors };
  }

  /**
   * Get role capabilities for a specific role
   */
  getRoleCapabilities(persona: IAIPersona, userRoles: string[]): string {
    return `You have access to ${persona.tools?.length || 0} tools and ${persona.resources?.length || 0} resources.`;
  }

  // ─── Registry Access ─────────────────────────────────────────────────

  getRegisteredTools(): Map<string, MacroToolDefinition> {
    return new Map(this.toolRegistry);
  }

  getRegisteredMacros(): Map<string, MacroComponentDefinition<unknown>> {
    return new Map(this.macroRegistry);
  }

  // ─── Internal Processing ─────────────────────────────────────────────

  private processConfig(config: IAIPersonaConfig, options: PersonaLoaderOptions): IAIPersona {
    if (options.processEnvironmentVars !== false) {
      config = this.processEnvironmentVariables(config);
    }

    if (options.validateOnLoad !== false) {
      const validation = this.validateConfig(config);
      if (!validation.isValid) {
        throw new Error(`Invalid persona configuration: ${validation.errors.join(', ')}`);
      }
    }

    return this.convertConfigToPersona(config, options);
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

  private convertConfigToPersona(config: IAIPersonaConfig, options: PersonaLoaderOptions = {}): IAIPersona {
    // Ensure registries are populated before resolving
    if (!this.registriesPopulated) {
      this.populateRegistries();
    }
    this.context.log(`Converting persona config ${config?.name || 'Unset - check persona config'} to persona interface`)
    const tools = this.resolveTools(config.tools);
    const resources = config.resources || [];
    const prompts = this.resolvePrompts(config, options, tools, resources);

    // A YAML persona that declares no system prompt still needs one — build it from
    // the same elements ${buildSystemPrompt()} would have used.
    if (!prompts.system?.content && (config.persona || config.features)) {
      prompts.system = {
        ...(prompts.system || {}),
        role: 'system',
        content: buildSystemPrompt({
          persona: config.persona || '',
          features: config.features || '',
          tools,
          resources,
          roleCapabilities: (config.roleCapabilities as Record<string, string>) || {},
          userRoles: options.userRoles?.length ? options.userRoles : ['USER'],
        }),
      };
    }

    const persona: IAIPersona = {
      id: config.id,
      name: config.name,
      nameSpace: 'reactor',
      version: '1.0.0',
      description: config.description || '',
      persona: config.persona || '',
      features: config.features || '',
      modelId: config.modelId || 'gemini-2.5-pro',
      providerId: config.providerId || 'google',
      defaultGreeting: config.defaultGreeting || '',
      config: config.config || {},
      tools,
      macros: this.resolveMacros(config.tools, config.macros),
      toolProfiles: config.toolProfiles || [],
      resources,
      prompts,
      tags: config.tags || config.metadata?.tags || [],
    };

    return persona;
  }

  // ─── Prompt Resolution ───────────────────────────────────────────────

  /**
   * Resolves every prompt template declared by a YAML persona.
   *
   * Two things happen here, in order:
   *
   * 1. **File assembly** — when a prompt declares `files: [...]`, each file is read
   *    (relative paths resolve against the agent.yaml's directory) and concatenated
   *    in the order listed, joined by `separator` (default: a blank line). Any inline
   *    `content` is appended after the assembled files, so a prompt can combine both.
   * 2. **Directive resolution** — `${buildSystemPrompt()}` and the other directives in
   *    {@link PROMPT_DIRECTIVES} are replaced with content built from the *same*
   *    elements the TypeScript personas' `buildSystemPrompt()` helper uses: the
   *    persona and features markdown, the resolved tool list, the declared resources
   *    and the role capability map.
   *
   * Variable interpolation for the *conversation* (user, session, partner, …) is not
   * performed here — that remains the responsibility of
   * `ReactorConversationService.startChatSession` / `sendCannedPrompt`.
   *
   * @param config    The (environment-processed) persona configuration.
   * @param options   Loader options — supplies `baseDir` and `userRoles`.
   * @param tools     The resolved tool definitions for this persona.
   * @param resources The resources declared by this persona.
   * @returns A prompts map whose `content` values are fully materialised.
   * @since 1.0.0
   */
  private resolvePrompts(
    config: IAIPersonaConfig,
    options: PersonaLoaderOptions,
    tools: MacroToolDefinition[],
    resources: IAIPersonaResource[],
  ): Record<string, IAIPersonaPromptTemplate> {
    const prompts = config.prompts || {};
    const resolved: Record<string, IAIPersonaPromptTemplate> = {};

    const directiveArgs: SystemPromptBuildArgs = {
      persona: config.persona || '',
      features: config.features || '',
      tools,
      resources,
      roleCapabilities: (config.roleCapabilities as Record<string, string>) || {},
      userRoles: options.userRoles?.length ? options.userRoles : ['USER'],
      onWarning: (message: string) => {
        this.context.warn(
          `PersonaLoaderService [${config.id || 'unknown persona'}]: ${message}`,
          null, 'reactor.PersonaLoaderService'
        );
      },
    };

    for (const [key, template] of Object.entries(prompts)) {
      if (!template || typeof template !== 'object') {
        resolved[key] = template as IAIPersonaPromptTemplate;
        continue;
      }

      const assembled = this.assemblePromptContent(config, key, template, options.baseDir);
      resolved[key] = {
        ...template,
        content: resolvePromptDirectives(assembled, directiveArgs),
      };
    }

    return resolved;
  }

  /**
   * Assembles the raw content for a single prompt template from its `files` array
   * (read in sequence) and/or its inline `content`.
   *
   * Files that cannot be read are logged and skipped so that one missing include does
   * not take down the whole persona.
   *
   * @param config    The persona configuration (used for log context only).
   * @param key       The prompt key, e.g. "system".
   * @param template  The prompt template declaration.
   * @param baseDir   Directory relative paths resolve against.
   * @returns The concatenated prompt content.
   */
  private assemblePromptContent(
    config: IAIPersonaConfig,
    key: string,
    template: IAIPersonaPromptTemplate,
    baseDir?: string,
  ): string {
    const files = template.files;
    if (!Array.isArray(files) || files.length === 0) {
      return template.content || '';
    }

    const separator = template.separator ?? '\n\n';
    const segments: string[] = [];

    for (const file of files) {
      if (typeof file !== 'string' || file.trim().length === 0) continue;

      const resolvedPath = path.isAbsolute(file)
        ? file
        : path.resolve(baseDir || process.cwd(), file);

      try {
        segments.push(fs.readFileSync(resolvedPath, 'utf8'));
      } catch (error) {
        this.context.error(
          `PersonaLoaderService [${config.id || 'unknown persona'}]: could not read prompt file ` +
          `"${file}" for prompt "${key}" (resolved to ${resolvedPath}): ${error}`,
          null, 'reactor.PersonaLoaderService'
        );
      }
    }

    if (template.content) {
      segments.push(template.content);
    }

    if (segments.length === 0) {
      this.context.warn(
        `PersonaLoaderService [${config.id || 'unknown persona'}]: prompt "${key}" declared ` +
        `${files.length} file(s) but none could be read — the prompt will be empty.`,
        null, 'reactor.PersonaLoaderService'
      );
    }

    return segments.join(separator);
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
      toolProfiles: persona.toolProfiles,
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

  /**
   * Resolves tool references from the YAML `tools.includes` array
   * into actual MacroToolDefinition objects using the tool registry.
   */
  public resolveTools(toolsConfig?: { includes?: string[]; custom?: any[] }): MacroToolDefinition[] {
    const tools: MacroToolDefinition[] = [];

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
            this.context.warn(
              `PersonaLoaderService: Tool "${toolName}" not found in registry (${this.toolRegistry.size} tools registered)`,
              null, 'reactor.PersonaLoaderService'
            );
          }
        }
      }
    }

    if (toolsConfig?.custom) {
      tools.push(...toolsConfig.custom);
    }

    return tools;
  }

  /**
   * Resolves macro references from both `tools.includes` and `macros.includes` arrays.
   * For each tool that was resolved, its parent macro is also included so that
   * the conversation has the macro metadata needed for server-side execution.
   */
  public resolveMacros(
    toolsConfig?: { includes?: string[]; custom?: any[] },
    macrosConfig?: { includes?: string[]; custom?: any[] },
  ): MacroComponentDefinition<unknown>[] {
    const macros: MacroComponentDefinition<unknown>[] = [];
    const addedNames = new Set<string>();

    const addMacro = (macro: MacroComponentDefinition<unknown>) => {
      if (!addedNames.has(macro.name)) {
        macros.push(macro);
        addedNames.add(macro.name);
      }
    };

    // Collect macros for every resolved tool from tools.includes.
    // This ensures the conversation stores the macro metadata needed
    // for the server-side executeMacro lookup.
    if (toolsConfig?.includes) {
      for (const toolName of toolsConfig.includes) {
        // Find macro that owns this tool
        for (const [, macro] of this.macroRegistry) {
          if (macro.tools?.some(t => t.type === 'function' && t.function?.name === toolName)) {
            addMacro(macro);
            break;
          }
        }
      }
    }

    // Also resolve explicit macros.includes entries
    if (macrosConfig?.includes) {
      for (const macroName of macrosConfig.includes) {
        const macro = this.macroRegistry.get(macroName);
        if (macro) {
          addMacro(macro);
        } else {
          // Secondary: find macros that contain a tool with this function name
          let found = false;
          for (const [, registeredMacro] of this.macroRegistry) {
            if (registeredMacro.tools?.some((t: any) =>
              t.type === 'function' && t.function?.name === macroName
            )) {
              addMacro(registeredMacro);
              found = true;
              break;
            }
          }
          if (!found) {
            this.context.warn(
              `PersonaLoaderService: Macro "${macroName}" not found in registry (${this.macroRegistry.size} macros registered)`,
              null, 'reactor.PersonaLoaderService'
            );
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

    const tools = mergeOptions.preserveExistingTools
      ? [...(existing.tools || []), ...this.resolveTools(config.tools)]
      : this.resolveTools(config.tools);

    const resources = mergeOptions.preserveExistingResources
      ? [...(existing.resources || []), ...(config.resources || [])]
      : config.resources || [];

    // Prompts declared by the override are resolved against the *merged* persona
    // content, tools and resources, so `${buildSystemPrompt()}` in an override picks
    // up whatever the override itself changed.
    const mergedPromptSource: IAIPersonaConfig = {
      ...config,
      persona: config.persona || existing.persona,
      features: config.features || existing.features,
    };

    const merged: IAIPersona = {
      ...existing,
      name: config.name || existing.name,
      description: config.description || existing.description,
      persona: config.persona || existing.persona,
      features: config.features || existing.features,
      modelId: config.modelId || existing.modelId,
      providerId: config.providerId || existing.providerId,
      defaultGreeting: config.defaultGreeting || existing.defaultGreeting,
      config: { ...existing.config, ...config.config },
      tools,
      macros: mergeOptions.preserveExistingMacros
        ? [...(existing.macros || []), ...this.resolveMacros(config.tools, config.macros)]
        : this.resolveMacros(config.tools, config.macros),
      toolProfiles: config.toolProfiles || existing.toolProfiles || [],
      resources,
      prompts: {
        ...existing.prompts,
        ...this.resolvePrompts(mergedPromptSource, options, tools, resources),
      }
    };

    return merged;
  }

  private createNewFromConfig(config: IAIPersonaConfig, options: PersonaLoaderOptions): IAIPersona {
    if (!config.id) {
      config.id = `persona-${Date.now()}`;
    }
    return this.processConfig(config, options);
  }
}

export default PersonaLoaderService;
