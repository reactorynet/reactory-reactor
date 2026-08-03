import Reactory from "@reactorynet/reactory-core";
import * as fs from "fs";
import * as path from "path";
import { service } from "@reactory/server-core/application/decorators";
import {
  IAIPersona,
  IAIPersonaProviderService,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import PersonaLoaderService from "@reactory/server-modules/reactory-reactor/ai/persona/loader/persona-loader";
import {
  buildSystemPrompt,
  DEFAULT_ROLE_CAPABILITIES,
} from "@reactory/server-modules/reactory-reactor/ai/persona/loader/system-prompt";

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
    { id: "reactor.PersonaLoaderService@1.0.0", alias: "personaLoader" },
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

  //@ts-ignore - injected via dependency autowiring
  private personaLoader: PersonaLoaderService;

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

  setModelRegistry(modelRegistry: Reactory.Service.TReactoryModelRegistryService): void {
    this.modelRegistry = modelRegistry;
  }

  setPersonaLoader(personaLoader: PersonaLoaderService): void {
    this.personaLoader = personaLoader;
  }

  async reloadPersonas(): Promise<{ success: boolean; totalLoaded: number }> {
    const { log } = this.context;
    const modules = this.context.modules || [];
    let totalLoaded = 0;

    log(`AIPersonaProvider reloading personas — scanning ${modules.length} module(s) for AI personas...`, {}, "info", "reactor.AIPersonaProvider");

    for (const mod of modules) {
      if (!mod.id) continue;

      const modulePath = this.resolveModulePath(mod.id);
      if (!modulePath) continue;

      const personaDir = path.join(modulePath, "ai", "persona");
      if (!fs.existsSync(personaDir)) continue;

      log(`Found persona directory for module ${mod.id}: ${personaDir}`, {}, "debug", "reactor.AIPersonaProvider");

      const subdirs = fs.readdirSync(personaDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const subdir of subdirs) {
        const subdirPath = path.join(personaDir, subdir.name);
        try {
          const personas = this.personaLoader.loadFromDirectory(subdirPath) as unknown as IAIPersona[];
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

          // copy avatar.png to public storage if present
          const avatarPath = path.join(subdirPath, "avatar.png");
          if (fs.existsSync(avatarPath)) {
            const personaName = subdirPath.split(path.sep).pop();
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

    // we will also check the ~/.reactor directory for any persona definitions that may have been added by the user
    const userPersonaDir = path.join(process.env.HOME || process.env.USERPROFILE || "", ".reactor", "ai", "persona");
    if (fs.existsSync(userPersonaDir)) {
      log(`Found user persona directory: ${userPersonaDir}`, {}, "debug", "reactor.AIPersonaProvider");
      const subdirs = fs.readdirSync(userPersonaDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const subdir of subdirs) {
        const subdirPath = path.join(userPersonaDir, subdir.name);
        try {
          const personas = this.personaLoader.loadFromDirectory(subdirPath) as unknown as IAIPersona[];
          for (const persona of personas) {
            try {
              // Register under the loaded reactor module (or first loaded module) so it is visible to getModels()
              const reactorModule = modules.find(m => m.nameSpace === "reactor") || modules[0];
              this.registerPersona(persona, reactorModule || { id: "user", name: "User", nameSpace: "user" } as Reactory.Server.IReactoryModule);
              totalLoaded++;
              log(
                `Registered user AI persona "\ ${persona.name}" (${persona.id}) from user directory (subdirectory ${subdir.name})`,
                {},
                "debug",
                "reactor.AIPersonaProvider",
              );
            } catch (regErr) {
              log(
                `Failed to register user persona "${persona.id}" from user directory (subdirectory ${subdir.name}): ${regErr}`,
                { error: regErr },
                "error",
                "reactor.AIPersonaProvider",
              );
            }
          }

          // copy avatar.png to public storage if present
          const avatarPath = path.join(subdirPath, "avatar.png");
          if (fs.existsSync(avatarPath)) {
            const personaName = subdirPath.split(path.sep).pop();
            const publicAvatarDir = path.join(process.env.REACTORY_DATA as string, "profiles", "reactor", "personas", personaName);
            if (!fs.existsSync(publicAvatarDir)) {
              fs.mkdirSync(publicAvatarDir, { recursive: true });
            }
            const targetAvatarPath = path.join(publicAvatarDir, "avatar.png");
            fs.copyFileSync(avatarPath, targetAvatarPath);
          }
        } catch (subdirErr) {
          log(
            `Failed to load user personas from ${subdirPath}: ${subdirErr}`,
            { error: subdirErr },
            "warning",
            "reactor.AIPersonaProvider",
          );
        }
      }
    }
    log(
      `AIPersonaProvider reload complete — loaded ${totalLoaded} persona(s) across ${modules.length} module(s)`,
      {},
      "info",
      "reactor.AIPersonaProvider",
    );

    return { success: true, totalLoaded };
  }

  async onStartup(): Promise<void> {
    await this.reloadPersonas();
  }

  private applyUserOverrides(persona: IAIPersona): IAIPersona {
    if (!persona) return persona;

    const userPersonaDir = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".reactor",
      "ai",
      "persona"
    );

    if (!fs.existsSync(userPersonaDir)) return persona;

    // We check three candidate directories for the agent ID:
    // 1. Exact ID (e.g., "ReactorAIPersona")
    // 2. Lowercase ID (e.g., "reactoraipersona")
    // 3. Normalized ID (e.g., "reactor" for "ReactorAIPersona" or "Reactor")
    const candidates = [
      persona.id,
      persona.id.toLowerCase(),
      persona.id.replace(/aipersona/i, "").toLowerCase(),
    ];

    let overrideDir = "";
    for (const cand of candidates) {
      const dir = path.join(userPersonaDir, cand);
      if (fs.existsSync(dir)) {
        overrideDir = dir;
        break;
      }
    }

    if (!overrideDir) return persona;

    const personaOverridePath = path.join(overrideDir, "persona.md");
    const featuresOverridePath = path.join(overrideDir, "features.md");
    const agentYamlPath = fs.existsSync(path.join(overrideDir, "agent.yaml"))
      ? path.join(overrideDir, "agent.yaml")
      : fs.existsSync(path.join(overrideDir, "agent.yml"))
        ? path.join(overrideDir, "agent.yml")
        : "";

    let modified = false;
    let updatedPersona = { ...persona };

    if (agentYamlPath) {
      try {
        const yamlContent = fs.readFileSync(agentYamlPath, "utf8");
        // baseDir lets the override resolve relative prompts.<key>.files entries
        // against its own directory (~/.reactor/ai/persona/<agent>).
        updatedPersona = this.personaLoader.mergeWithExisting(updatedPersona, yamlContent, {
          baseDir: path.dirname(agentYamlPath),
        });
        modified = true;
        this.context.log?.(
          `AIPersonaProvider: Applied user agent.yaml override for "${persona.id}" from ${agentYamlPath}`,
          {},
          "debug",
          "reactor.AIPersonaProvider"
          );
      } catch (err: any) {
        this.context.error?.(`Failed to merge user agent.yaml override from ${agentYamlPath}: ${err.message}`);
      }
    }

    if (fs.existsSync(personaOverridePath)) {
      try {
        const customPersonaText = fs.readFileSync(personaOverridePath, "utf8");
        if (customPersonaText.trim().length > 0) {
          updatedPersona.persona = customPersonaText;
          modified = true;
          this.context.log?.(
            `AIPersonaProvider: Applied user persona override for "${persona.id}" from ${personaOverridePath}`,
            {},
            "debug",
            "reactor.AIPersonaProvider"
          );
        }
      } catch (err: any) {
        this.context.error?.(`Failed to read user persona override from ${personaOverridePath}: ${err.message}`);
      }
    }

    if (fs.existsSync(featuresOverridePath)) {
      try {
        const customFeaturesText = fs.readFileSync(featuresOverridePath, "utf8");
        if (customFeaturesText.trim().length > 0) {
          updatedPersona.features = customFeaturesText;
          modified = true;
          this.context.log?.(
            `AIPersonaProvider: Applied user features override for "${persona.id}" from ${featuresOverridePath}`,
            {},
            "debug",
            "reactor.AIPersonaProvider"
          );
        }
      } catch (err: any) {
        this.context.error?.(`Failed to read user features override from ${featuresOverridePath}: ${err.message}`);
      }
    }

    // If we modified either the persona prompt or features, and the persona has a system prompt template,
    // we must rebuild the prompt content dynamically to reflect the overrides!
    if (modified && updatedPersona.prompts?.system) {
      try {
        const userRoles = (this.context.user?.roles as string[]) || ["USER"];

        // Rebuilt with the same helper the persona loader uses to materialise
        // ${buildSystemPrompt()} — so overrides get the identical variable set
        // (date, userRole, roleSpecificCapabilities, toolDescriptions,
        // resourceDescription, availableTools) regardless of persona flavour.
        const compiledPrompt = buildSystemPrompt({
          persona: updatedPersona.persona,
          features: updatedPersona.features,
          tools: updatedPersona.tools || [],
          resources: updatedPersona.resources || [],
          roleCapabilities: DEFAULT_ROLE_CAPABILITIES,
          userRoles,
          onWarning: (message: string) =>
            this.context.log?.(
              `AIPersonaProvider: ${persona.id} — ${message}`,
              {},
              "warning",
              "reactor.AIPersonaProvider",
            ),
        });

        updatedPersona.prompts.system = {
          ...updatedPersona.prompts.system,
          content: compiledPrompt,
        };
      } catch (promptErr: any) {
        this.context.error?.(`Failed to re-compile system prompt after overrides: ${promptErr.message}`);
      }
    }

    return updatedPersona;
  }

  async listPersonas(): Promise<IAIPersona[]> {
    let personas: IAIPersona[] = await this.modelRegistry.getModels<IAIPersona>({
      name: "*aipersona",
    });

    return personas.map(p => this.applyUserOverrides(p));
  }

  async getPersona(id: string): Promise<IAIPersona> {
    const personas: IAIPersona[] = await this.listPersonas();
    const persona = personas.find((persona) => persona.id === id);
    if (!persona) {
      throw new Error(`Persona with id ${id} not found`);
    }
    return persona;
  }

  async loadPersonaYaml(
    yamlContentOrFilePath: string,
    options: { fromFile?: boolean, targetModule: Reactory.Server.IReactoryModule },
  ): Promise<IAIPersona> {
    const persona = (options?.fromFile
      ? this.personaLoader.loadFromFile(yamlContentOrFilePath)
      : this.personaLoader.loadFromString(yamlContentOrFilePath)) as unknown as IAIPersona;

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
