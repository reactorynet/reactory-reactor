import Reactory from "@reactorynet/reactory-core";
import * as fs from "fs";
import * as path from "path";
import { service } from "@reactory/server-core/application/decorators";
import {
  IAIPersona,
  IAIPersonaProviderService,
} from "@reactory/server-modules/reactory-reactor/types/service.types";
import PersonaLoaderService, {
  PersonaLoaderOptions,
} from "@reactory/server-modules/reactory-reactor/ai/persona/loader/persona-loader";
import {
  buildSystemPrompt,
  DEFAULT_ROLE_CAPABILITIES,
} from "@reactory/server-modules/reactory-reactor/ai/persona/loader/system-prompt";
import {
  PersonaSourceRef,
  isPathInside,
  isPathInsideReal,
  listProfilePersonaDirs,
  resolveCallingUserId,
  resolveDataRoot,
  resolveLayerDir,
  resolveLegacyPersonaRoot,
  resolveUserAiRoot,
  resolveUserPersonaRoot,
} from "@reactory/server-modules/reactory-reactor/services/reactor/personaSources";

export type PersonaProviderProps = {};
export type PersonaProviderContext = Reactory.Server.IReactoryContext & {};

/**
 * A single persona layer resolved for the current request.
 *
 * `restrictTo` is the containment root every path read for the layer must stay inside
 * (SEC-2). It is only *consumed* for untrusted layers, via `userLayerLoaderOptions()`;
 * trusted (module/operator) layers keep the historical behaviour and their `dir` is enough
 * because `readLayerFile()` contains each read inside the layer directory.
 */
interface PersonaLayer {
  source: 'operator' | 'user';
  dir: string;
  /** Only meaningful for `source === 'user'`; see the note above. */
  restrictTo: string;
}

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
      tags: persona.tags && persona.tags.length > 0 ? persona.tags : ["ai", "persona"],
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

    /**
     * Resolves the on-disk path for a module's root folder (containing `ai/persona`).
     *
     * The authoritative source of truth for the application root is `APPLICATION_ROOT`
     * (`app` for compiled builds, `src` for the development/source tree) - the same env
     * var the rest of the server uses to locate modules. Historically this method guessed
     * the root from `NODE_ENV` alone (`NODE_ENV === "production" ? "app" : "src"`). That
     * silently broke the compiled builds: the YAML personas live under `app/modules`, but
     * depending on which env file was loaded `NODE_ENV` could be anything other than exactly
     * "production" (e.g. "local" or unset), so resolution pointed at a `src/modules` folder
     * that does not exist in the build output and every lookup hit `if (!modulePath) continue`.
     *
     * We now honour `APPLICATION_ROOT`, fall back to the `NODE_ENV` heuristic, and finally
     * self-heal by probing candidate roots for the actual module folder so a mismatched env
     * can no longer cause a silent skip.
     */
  private resolveModulePath(moduleId: string): string | null {
    const serverRoot = process.env.REACTORY_SERVER || process.cwd();

    const candidateRoots = [
      // 1. Canonical, explicitly-configured application root.
      process.env.APPLICATION_ROOT,
      // 2. Legacy heuristic, preserved for envs that don't set APPLICATION_ROOT.
      process.env.NODE_ENV === "production" ? "app" : "src",
      // 3. Both common roots - lets us self-heal when the above guess is wrong.
      "app",
      "src",
    ];

    // Prefer the first candidate whose module folder actually exists on disk so a
    // wrong env setting can't silently resolve to a missing path.
    for (const root of candidateRoots) {
      if (!root) continue;
      try {
        const modulesDir = path.join(serverRoot, root, "modules", moduleId);
        if (fs.existsSync(modulesDir)) {
          return modulesDir;
        }
      } catch {
        // Ignore stat errors and keep probing.
      }
    }

    // Nothing matched on disk - return the primary candidate so callers still get a
    // deterministic path (and a useful warning) even when the module is genuinely absent.
    const primaryRoot = process.env.APPLICATION_ROOT ||
      (process.env.NODE_ENV === "production" ? "app" : "src");
    return path.join(serverRoot, primaryRoot, "modules", moduleId);
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
              const reactorModule = modules.find(m => m.nameSpace === "reactory" || m.nameSpace === "reactor") || modules[0];
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

  /**
   * Resolve the calling user id from the request context only.
   *
   * A user id is never accepted from request arguments for the profile layer — the context
   * is the only trusted source (SEC-1).
   */
  private getCallingUserId(): string | null {
    try {
      return resolveCallingUserId(this.context);
    } catch {
      return null;
    }
  }

  /** The tool function names a persona currently grants (the allow-list for a user layer). */
  private personaToolNames(persona: IAIPersona): string[] {
    return (persona.tools || [])
      .map((tool: any) => tool?.function?.name)
      .filter((name: any): name is string => typeof name === 'string' && name.length > 0);
  }

  /**
   * Build the ordered (low → high precedence) override layers for a persona id.
   *
   * - `operator` — `~/.reactor/ai/persona/<agent>/`, unchanged desktop behaviour.
   * - `user`     — `<dataRoot>/profiles/<userId>/reactor/ai/persona/<agent>/`, only when the
   *                request carries a validated user id and a data root is configured.
   *
   * Both layers use {@link resolveLayerDir}, so their candidate-folder logic cannot drift.
   */
  private resolvePersonaLayers(personaId: string): PersonaLayer[] {
    const layers: PersonaLayer[] = [];

    const legacyRoot = resolveLegacyPersonaRoot();
    if (legacyRoot) {
      const legacyDir = resolveLayerDir(legacyRoot, personaId);
      if (legacyDir) {
        layers.push({ source: 'operator', dir: legacyDir, restrictTo: legacyRoot });
      }
    }

    const userId = this.getCallingUserId();
    if (!userId) return layers;

    if (!resolveDataRoot()) {
      this.context.log?.(
        `AIPersonaProvider: no REACTORY_DATA/APP_DATA_ROOT configured — skipping the profile persona layer for "${personaId}".`,
        {},
        'debug',
        'reactor.AIPersonaProvider',
      );
      return layers;
    }

    const userRoot = resolveUserPersonaRoot(userId);
    const userAiRoot = resolveUserAiRoot(userId);
    if (userRoot && userAiRoot) {
      const userDir = resolveLayerDir(userRoot, personaId);
      if (userDir) {
        layers.push({ source: 'user', dir: userDir, restrictTo: userAiRoot });
      }
    }

    return layers;
  }

  /**
   * Loader restrictions applied to an untrusted profile layer (SEC-3/4/5).
   *
   * The layer may narrow what the underlying persona grants, never widen it:
   * - tools are intersected with the persona's current tool names,
   * - custom tools/macros are ignored,
   * - provider credentials and endpoints are dropped,
   * - prompt includes must stay inside the user's `reactor/ai` tree,
   * - merge semantics are forced so a layer cannot replace/re-identify the persona.
   */
  private userLayerLoaderOptions(persona: IAIPersona, layer: PersonaLayer): PersonaLoaderOptions {
    const roles = Array.isArray(this.context?.user?.roles)
      ? (this.context.user.roles as string[])
      : undefined;

    return {
      baseDir: layer.dir,
      allowedTools: this.personaToolNames(persona),
      disallowCustomTools: true,
      sanitizeConfig: true,
      restrictPromptFilesTo: layer.restrictTo,
      restrictMergeMode: true,
      // SEC-1/F1: user YAML is untrusted, so `${ENV}` / `${ENV:-default}` is NEVER expanded.
      // Without this the layer could read any server environment variable (DB URIs, provider
      // keys, JWT secrets) straight back through `description` / `prompts.system.content`,
      // which the ReactorPersonas query returns to the client.
      processEnvironmentVars: false,
      ...(roles && roles.length > 0 ? { userRoles: roles } : {}),
    };
  }

  /**
   * Read a file that belongs to a layer, refusing anything that escapes the layer directory.
   *
   * @returns The file contents, or `null` when absent or not contained.
   */
  private readLayerFile(layer: PersonaLayer, fileName: string): string | null {
    const candidate = path.join(layer.dir, fileName);

    if (!isPathInside(layer.dir, candidate) || !isPathInsideReal(layer.dir, candidate)) {
      this.context.log?.(
        `AIPersonaProvider: ignoring ${layer.source} layer file "${fileName}" for "${layer.dir}" — outside the layer directory.`,
        {},
        'warning',
        'reactor.AIPersonaProvider',
      );
      return null;
    }

    // Read once and classify the failure instead of stat-then-read: the check/use pair is a
    // TOCTOU race (CodeQL js/file-system-race) and buys nothing — readFileSync already fails
    // cleanly when the path is absent or is a directory.
    try {
      return fs.readFileSync(candidate, 'utf8');
    } catch (err: any) {
      const code = err?.code;

      // ENOENT: the layer simply does not override this file.
      // EISDIR: a directory where a markdown file was expected — also "no override".
      if (code === 'ENOENT' || code === 'EISDIR') return null;

      this.context.error?.(
        `AIPersonaProvider: could not read ${layer.source} layer file ${candidate}: ${err?.message || err}`,
      );
      return null;
    }
  }

  /** Locate `agent.yaml` (or `agent.yml`) inside a layer directory, contained. */
  private findAgentYaml(layer: PersonaLayer): string | null {
    for (const fileName of ['agent.yaml', 'agent.yml']) {
      const candidate = path.join(layer.dir, fileName);
      if (!isPathInside(layer.dir, candidate) || !isPathInsideReal(layer.dir, candidate)) continue;

      // stat only — a preceding existsSync would be a check-then-use race, and statSync
      // already throws when the candidate is absent.
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Absent or unreadable candidate — try the next name.
      }
    }

    return null;
  }

  /**
   * Apply one layer to a persona: `agent.yaml` → `persona.md` → `features.md`, in that order.
   *
   * Every step is individually guarded: a malformed or unreadable file is logged and skipped
   * so the lower layers still produce a usable persona (SEC failure isolation).
   *
   * @param includeYaml - `false` when the persona was *created* from this layer's YAML and
   *                      only the markdown overrides still need applying.
   */
  private applyLayer(
    persona: IAIPersona,
    layer: PersonaLayer,
    options: { includeYaml?: boolean } = {},
  ): { persona: IAIPersona; modified: boolean; applied: boolean } {
    const includeYaml = options.includeYaml !== false;
    let updated: IAIPersona = { ...persona };
    let modified = false;
    let applied = false;

    if (includeYaml) {
      const yamlPath = this.findAgentYaml(layer);
      if (yamlPath) {
        try {
          const yamlContent = fs.readFileSync(yamlPath, 'utf8');
          const loaderOptions: PersonaLoaderOptions = layer.source === 'user'
            // Allow-list is taken from the persona *before* this layer is applied, so the
            // layer cannot widen its own grant.
            ? this.userLayerLoaderOptions(updated, layer)
            : { baseDir: layer.dir };

          updated = this.personaLoader.mergeWithExisting(
            updated,
            yamlContent,
            loaderOptions,
          ) as unknown as IAIPersona;
          modified = true;
          applied = true;
          this.context.log?.(
            `AIPersonaProvider: applied ${layer.source} agent.yaml override for "${persona.id}" from ${yamlPath}`,
            {},
            'debug',
            'reactor.AIPersonaProvider',
          );
        } catch (err: any) {
          this.context.error?.(
            `AIPersonaProvider: failed to apply ${layer.source} agent.yaml from ${yamlPath}: ${err?.message || err}`,
          );
        }
      }
    }

    const personaText = this.readLayerFile(layer, 'persona.md');
    if (personaText !== null && personaText.trim().length > 0) {
      updated.persona = personaText;
      modified = true;
      applied = true;
      this.context.log?.(
        `AIPersonaProvider: applied ${layer.source} persona.md override for "${persona.id}" from ${layer.dir}`,
        {},
        'debug',
        'reactor.AIPersonaProvider',
      );
    }

    const featuresText = this.readLayerFile(layer, 'features.md');
    if (featuresText !== null && featuresText.trim().length > 0) {
      updated.features = featuresText;
      modified = true;
      applied = true;
      this.context.log?.(
        `AIPersonaProvider: applied ${layer.source} features.md override for "${persona.id}" from ${layer.dir}`,
        {},
        'debug',
        'reactor.AIPersonaProvider',
      );
    }

    // `modified` mirrors the pre-change `applyUserOverrides` semantics exactly: a layer that
    // contributed an agent.yaml, a persona.md or a features.md marks the persona for a single
    // system-prompt rebuild after *all* layers have been applied (ticket 2.4). Keeping the
    // legacy trigger is what makes the resolved persona byte-for-byte identical to the old
    // result when only the operator layer is present (§9 / AC7), including the case where the
    // operator YAML supplies only `prompts.system`.
    return { persona: updated, modified, applied };
  }

  private recompileSystemPrompt(persona: IAIPersona): IAIPersona {
    if (!persona?.prompts?.system) return persona;

    try {
      const userRoles = (this.context.user?.roles as string[]) || ['USER'];

      // Same helper (and same variable set) the loader uses to materialise
      // ${buildSystemPrompt()}, so overrides compile identically to module personas.
      const compiledPrompt = buildSystemPrompt({
        persona: persona.persona,
        features: persona.features,
        tools: persona.tools || [],
        resources: persona.resources || [],
        roleCapabilities: DEFAULT_ROLE_CAPABILITIES,
        userRoles,
        onWarning: (message: string) =>
          this.context.log?.(
            `AIPersonaProvider: ${persona.id} — ${message}`,
            {},
            'warning',
            'reactor.AIPersonaProvider',
          ),
      });

      return {
        ...persona,
        prompts: {
          ...persona.prompts,
          system: {
            ...persona.prompts.system,
            content: compiledPrompt,
          },
        },
      };
    } catch (promptErr: any) {
      this.context.error?.(`Failed to re-compile system prompt after overrides: ${promptErr?.message || promptErr}`);
      return persona;
    }
  }

  /**
   * Apply the operator and profile layers to a registry persona, highest precedence last.
   *
   * Never mutates or re-registers the persona: the result is a request-scoped value.
   */
  private applyPersonaLayers(persona: IAIPersona, consumedDirs?: Set<string>): IAIPersona {
    if (!persona?.id) return persona;

    let updated: IAIPersona = persona;
    let modified = false;
    const applied: PersonaSourceRef[] = [];

    let layers: PersonaLayer[] = [];
    try {
      layers = this.resolvePersonaLayers(persona.id);
    } catch (err: any) {
      this.context.log?.(
        `AIPersonaProvider: could not resolve persona layers for "${persona.id}": ${err?.message || err}`,
        {},
        'warning',
        'reactor.AIPersonaProvider',
      );
      return persona;
    }

    for (const layer of layers) {
      try {
        const result = this.applyLayer(updated, layer);
        updated = result.persona;
        modified = modified || result.modified;
        if (result.applied) {
          applied.push({ source: layer.source, path: layer.dir });
          // Remember the directory so `loadProfileOnlyPersonas()` does not consume the same
          // folder a second time under the id its YAML happens to declare.
          consumedDirs?.add(path.resolve(layer.dir));
        }
      } catch (err: any) {
        this.context.log?.(
          `AIPersonaProvider: failed to apply ${layer.source} layer at ${layer.dir} for "${persona.id}": ${err?.message || err}`,
          {},
          'warning',
          'reactor.AIPersonaProvider',
        );
      }
    }

    // Ticket 2.4: exactly one rebuild per persona, after every layer — never per layer, which
    // would discard the earlier text. The trigger matches the pre-change `applyUserOverrides`
    // behaviour (any layer that contributed an agent.yaml, persona.md or features.md), so an
    // operator-only resolution stays byte-for-byte what it was before this feature (§9, AC7).
    if (modified) updated = this.recompileSystemPrompt(updated);
    if (applied.length > 0) updated = { ...updated, personaSources: applied };

    return updated;
  }

  /**
   * Load the personas that exist **only** for the calling user.
   *
   * A profile folder whose `agent.yaml` declares an id the registry does not know becomes a
   * request-scoped persona: it is returned to its owner, is never passed to
   * `registerPersona()` / `modelRegistry.register()`, and therefore cannot leak to another
   * user or survive into the global registry (SEC-7).
   *
   * Because there is no lower layer to inherit from, these personas start with **no tools**
   * (`allowedTools: []`) — a user cannot mint a persona that grants itself capabilities
   * (SEC-4).
   */
  private loadProfileOnlyPersonas(
    knownIds: Set<string>,
    consumedDirs: Set<string> = new Set<string>(),
  ): IAIPersona[] {
    const personas: IAIPersona[] = [];

    const userId = this.getCallingUserId();
    if (!userId) return personas;

    const userRoot = resolveUserPersonaRoot(userId);
    const userAiRoot = resolveUserAiRoot(userId);
    if (!userRoot || !userAiRoot) {
      this.context.log?.(
        'AIPersonaProvider: no profile persona root available — skipping profile-only personas.',
        {},
        'debug',
        'reactor.AIPersonaProvider',
      );
      return personas;
    }

    let dirs: string[] = [];
    try {
      dirs = listProfilePersonaDirs(userId);
    } catch (err: any) {
      this.context.log?.(
        `AIPersonaProvider: could not list profile personas for ${userId}: ${err?.message || err}`,
        {},
        'warning',
        'reactor.AIPersonaProvider',
      );
      return personas;
    }

    for (const dir of dirs) {
      try {
        // One folder is one layer: a directory already consumed as an override for a known
        // persona id must not be emitted a second time under the id its YAML declares.
        if (consumedDirs.has(path.resolve(dir))) {
          this.context.log?.(
            `AIPersonaProvider: profile persona folder ${dir} was consumed as an override layer — not emitted as a profile-only persona.`,
            {},
            'debug',
            'reactor.AIPersonaProvider',
          );
          continue;
        }

        const layer: PersonaLayer = { source: 'user', dir, restrictTo: userAiRoot };
        const yamlPath = this.findAgentYaml(layer);
        if (!yamlPath) {
          this.context.log?.(
            `AIPersonaProvider: profile persona folder ${dir} has no agent.yaml — skipped.`,
            {},
            'debug',
            'reactor.AIPersonaProvider',
          );
          continue;
        }

        const roles = Array.isArray(this.context?.user?.roles)
          ? (this.context.user.roles as string[])
          : undefined;

        const loaded = this.personaLoader.loadFromFile(yamlPath, {
          baseDir: dir,
          allowedTools: [],
          disallowCustomTools: true,
          sanitizeConfig: true,
          restrictPromptFilesTo: userAiRoot,
          restrictMergeMode: true,
          // SEC-1/F1: never expand `${ENV}` from user-authored YAML (same reason as the
          // override path in userLayerLoaderOptions).
          processEnvironmentVars: false,
          ...(roles && roles.length > 0 ? { userRoles: roles } : {}),
        }) as unknown as IAIPersona;

        if (!loaded?.id) continue;

        if (knownIds.has(loaded.id)) {
          this.context.log?.(
            `AIPersonaProvider: profile persona folder ${dir} declares "${loaded.id}", which a lower layer already defines — the folder is ignored because its name does not match the persona id (overrides are resolved by candidate folder name).`,
            {},
            'debug',
            'reactor.AIPersonaProvider',
          );
          continue;
        }

        const result = this.applyLayer(loaded, layer, { includeYaml: false });
        // Same single-rebuild rule as the layer path: only markdown contributed by the
        // profile folder triggers it, so a YAML-only profile persona keeps its own prompts.
        const persona = result.modified
          ? this.recompileSystemPrompt(result.persona)
          : result.persona;

        personas.push({
          ...persona,
          // Marks the persona as request-scoped so GraphQL/clients can badge it and the avatar
          // resolver knows to look in the user's own folder.
          personaSources: [{ source: 'user', path: dir }],
          metadata: { ...(persona as any).metadata, userScoped: true },
        });
        knownIds.add(persona.id);
      } catch (err: any) {
        this.context.log?.(
          `AIPersonaProvider: failed to load profile persona from ${dir}: ${err?.message || err}`,
          {},
          'warning',
          'reactor.AIPersonaProvider',
        );
      }
    }

    return personas;
  }

  async listPersonas(): Promise<IAIPersona[]> {
    const registryPersonas: IAIPersona[] = await this.modelRegistry.getModels<IAIPersona>({
      name: "*aipersona",
    });

    const resolved: IAIPersona[] = [];
    const indexById = new Map<string, number>();
    // Directories already used as an override for a registry persona (see loadProfileOnlyPersonas).
    const consumedDirs = new Set<string>();

    for (const persona of registryPersonas || []) {
      const layered = this.applyPersonaLayers(persona, consumedDirs);
      const existingIdx = indexById.get(layered.id);
      if (existingIdx !== undefined) {
        resolved[existingIdx] = layered;
        continue;
      }

      indexById.set(layered.id, resolved.length);
      resolved.push(layered);
    }

    // Profile-only personas are merged last so a user-scoped definition always wins, and are
    // never registered (SEC-7).
    let profilePersonas: IAIPersona[] = [];
    try {
      profilePersonas = this.loadProfileOnlyPersonas(new Set(indexById.keys()), consumedDirs);
    } catch (err: any) {
      this.context.log?.(
        `AIPersonaProvider: profile persona resolution failed: ${err?.message || err}`,
        {},
        'warning',
        'reactor.AIPersonaProvider',
      );
    }

    for (const persona of profilePersonas) {
      const existingIdx = indexById.get(persona.id);
      if (existingIdx !== undefined) {
        resolved[existingIdx] = persona;
        continue;
      }

      indexById.set(persona.id, resolved.length);
      resolved.push(persona);
    }

    return resolved;
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
