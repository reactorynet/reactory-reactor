import Reactory from "@reactorynet/reactory-core";
import * as fs from "fs";
import * as path from "path";
import { service } from "@reactory/server-core/application/decorators";
import {
  IAIPersona,
  IAIPersonaProviderService,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import { personaLoader } from "@reactory/server-modules/reactory-reactor/ai/persona/loader/persona-loader";
import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/macro";

export type PersonaProviderProps = {};
export type PersonaProviderContext = Reactory.Server.IReactoryContext & {};

@service({
  id: "reactor.AIPersonaProvider@1.0.0",
  nameSpace: "reactor",
  name: "AIPersonaProvider",
  version: "1.0.0",
  description: "Service for managing AI Personas",
  serviceType: "ai",
  dependencies: [
    { id: "core.ReactoryModelRegistry@1.0.0", alias: "modelRegistry" },    
  ],
})
class AIPersonaProvider
  implements Reactory.Service.IReactoryDefaultService, IAIPersonaProviderService
{

  description?: string = "Service for managing AI Personas";
  tags?: string[] = ["ai", "persona"];
  nameSpace: string = "reactor";
  name: string = "AIPersonaProvider";
  version: string = "1.0.0";

  context: Reactory.Server.IReactoryContext;

  //@ts-ignore
  private modelRegistry: Reactory.Service.TReactoryModelRegistryService;

  constructor(
    props: Reactory.Service.IReactoryServiceProps,
    context: PersonaProviderContext
  ) {
    this.context = context;    
  }

  toString?(includeVersion?: boolean): string {
    return `${this.nameSpace}.${this.name}${includeVersion ?  `@${this.version}` : ''}`;
  }

  getExecutionContext(): Reactory.Server.IReactoryContext {
    return this.context;
  }
  setExecutionContext(context: Reactory.Server.IReactoryContext): void {
    this.context = context
  }

  private registerPersona(
    persona: IAIPersona,
    targetModule: Reactory.Server.IReactoryModule,
  ): void {
    const componentDef: Reactory.IReactoryComponentDefinition<IAIPersona> = {
      nameSpace: targetModule.nameSpace,
      name: `${persona.id}AIPersona`,
      version: "1.0.0",
      component: persona,
      description: persona.description || `AI Persona: ${persona.name}`,
      tags: ["ai", "persona"],
    };

    this.modelRegistry.register(componentDef, true);

    if (!targetModule.models) {
      targetModule.models = [];
    }
    const existingIdx = targetModule.models.findIndex(
      (m) => m.name === componentDef.name && m.nameSpace === componentDef.nameSpace,
    );
    if (existingIdx >= 0) {
      targetModule.models[existingIdx] = componentDef as Reactory.IReactoryComponentDefinition<unknown>;
    } else {
      targetModule.models.push(componentDef as Reactory.IReactoryComponentDefinition<unknown>);
    }
  }

  private resolveModulePath(moduleId: string): string | null {
    try {
      return path.join(process.env.REACTORY_SERVER as string, process.env.NODE_ENV === "production" ? "app" : "src", "modules", moduleId);      
    } catch {
      return null;
    }
  }

  async onStartup(): Promise<void> {
    const { log } = this.context;
    const modules = this.context.modules || [];
    let totalLoaded = 0;

    // Populate the PersonaLoader's tool and macro registries from the global MacroRegistry.
    // Without this, YAML-based personas that reference tools/macros by name via
    // `tools.includes` and `macros.includes` would resolve to empty arrays because
    // the PersonaLoader's internal registries would be empty.
    let toolCount = 0;
    let macroCount = 0;
    for (const macro of MacroRegistry) {
      // Register the macro by its component name (e.g. "FsMacroRegistry", "shell")
      personaLoader.registerMacro(macro.name, macro);
      macroCount++;

      // Register each tool by its function name (e.g. "readFile", "writeFile", "http")
      if (macro.tools) {
        for (const tool of macro.tools) {
          if (tool.type === "function" && tool.function?.name) {
            personaLoader.registerTool(tool.function.name, tool);
            toolCount++;
          }
        }
      }
    }
    log(`AIPersonaProvider: Registered ${toolCount} tools and ${macroCount} macros in PersonaLoader registry`, {}, "debug", "reactor.AIPersonaProvider");

    log(`AIPersonaProvider starting up — scanning ${modules.length} module(s) for AI personas...`, {}, "info", "reactor.AIPersonaProvider");

    for (const mod of modules) {
      if (!mod.id) continue;

      const modulePath = this.resolveModulePath(mod.id);
      if (!modulePath) continue;

      const personaDir = path.join(modulePath, "ai", "persona");
      if (!fs.existsSync(personaDir)) continue;

      log(`Found persona directory for module ${mod.id}: ${personaDir}`, {}, "debug", "reactor.AIPersonaProvider");

      // Check in subdirectories of personaDir for any additional persona YAML files
      if (fs.existsSync(personaDir)) {
        const subdirs = fs.readdirSync(personaDir, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const subdir of subdirs) {
          const subdirPath = path.join(personaDir, subdir.name);
          try {
            const personas = personaLoader.loadFromDirectory(subdirPath, { targetModule: mod }) as unknown as IAIPersona[];
            for (const persona of personas) {
              try {
                this.registerPersona(persona, mod);
                totalLoaded++;
                log(
                  `Registered AI persona "${persona.name}" (${persona.id}) from module ${mod.id} (subdirectory ${subdir.name})`,
                  {},
                  "debug",
                  "reactor.AIPersonaProvider",
                );
              } catch (regErr) {
                log(
                  `Failed to register persona "${persona.id}" from module ${mod.id} (subdirectory ${subdir.name}): ${regErr}`,
                  { error: regErr },
                  "error",
                  "reactor.AIPersonaProvider",
                );
              }
            }

            // check if the subdir has an avatar.png and if so, copy it to the public/avatars directory with the name {persona.id}.png
            const avatarPath = path.join(subdirPath, "avatar.png");
            if (fs.existsSync(avatarPath)) {
              const personaName = subdirPath.split(path.sep).pop(); // get the name of the subdir as the persona name
              const publicAvatarDir = path.join(process.env.REACTORY_DATA as string, "profiles", "reactor", "personas", personaName);
              if (!fs.existsSync(publicAvatarDir)) {
                fs.mkdirSync(publicAvatarDir, { recursive: true });
              }
              const targetAvatarPath = path.join(publicAvatarDir, "avatar.png");
              fs.copyFileSync(avatarPath, targetAvatarPath);
            }
          } catch (subdirErr) {
            log(
              `Failed to load personas from ${subdirPath}: ${subdirErr}`,
              { error: subdirErr },
              "warning",
              "reactor.AIPersonaProvider",
            );
          }
        }
      }
    }

    log(
      `AIPersonaProvider startup complete — loaded ${totalLoaded} persona(s) across ${modules.length} module(s)`,
      {},
      "info",
      "reactor.AIPersonaProvider",
    );
  }

  async listPersonas(): Promise<IAIPersona[]> {
    // collect all 
    let personas: IAIPersona[] = await this.modelRegistry.getModels<IAIPersona>({
      name: "*aipersona",
    });

    return personas;
  }

  async getPersona(id: string): Promise<IAIPersona> {
    const personas: IAIPersona[] = await this.listPersonas();
    const persona = personas.find((persona) => persona.id === id);
    if (!persona) {
      throw new Error(`Persona with id ${id} not found`);
    }
    return persona;
  }

  setModelRegistry(modelRegistry: Reactory.Service.TReactoryModelRegistryService): void { 
    this.modelRegistry = modelRegistry;
  }

  async loadPersonaYaml(
    yamlContentOrFilePath: string,
    options: { fromFile?: boolean, targetModule: Reactory.Server.IReactoryModule },
  ): Promise<IAIPersona> {
    const persona = (options?.fromFile
      ? personaLoader.loadFromFile(yamlContentOrFilePath)
      : personaLoader.loadFromString(yamlContentOrFilePath)) as unknown as IAIPersona;

    this.registerPersona(persona, options?.targetModule);

    this.context.log(
      `Loaded and registered AI persona "${persona.name}" (${persona.id}) via loadPersonaYaml`,
      {},
      "debug",
      "reactor.AIPersonaProvider",
    );

    return persona;
  }

  async createPersona(params: IAIPersona): Promise<IAIPersona> {
    throw new Error("Method not implemented.");
  }

  async updatePersona(params: IAIPersona): Promise<IAIPersona> {
    throw new Error("Method not implemented.");
  }

  async deletePersona(id: string): Promise<IAIPersona> {
    throw new Error("Method not implemented.");
  }
}


export default AIPersonaProvider;