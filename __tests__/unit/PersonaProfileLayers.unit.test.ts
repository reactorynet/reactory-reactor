import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import AIPersonaProvider from '../../services/reactor/AIPersonaProvider';
import PersonaLoaderService from '../../ai/persona/loader/persona-loader';
import ReactorPersonaResolver from '../../graphql/resolvers/ReactorPersona';
import {
  resolveUserAvatarPath,
  resolveUserPersonaRoot,
  sanitizeUserId,
} from '../../services/reactor/personaSources';

/**
 * Three-layer persona resolution (REACTORY-302016408/20261111/853651667).
 *
 * Covers AC 1-14 plus the review-driven regressions:
 *  - AC17/F1: untrusted YAML never expands ${ENV}
 *  - AC18/F2: a symlinked profile root cannot expose another user's personas
 *  - AC19/F8: a lean `_id` that stringifies to "[object Object]" falls back to `user.id`
 *  - AC20/F4: the operator layer keeps the pre-change system-prompt rebuild semantics
 *
 * Every test uses throw-away `HOME` and `REACTORY_DATA` roots; the developer's real home
 * and data root are never touched.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

const MACRO_SERVICE: any = {
  listAllMacros: () => [
    {
      name: 'FileSystemMacro',
      tools: [
        { type: 'function', function: { name: 'readFile', description: 'Reads a file from disk' } },
        { type: 'function', function: { name: 'writeFile', description: 'Writes a file to disk' } },
      ],
    },
    {
      name: 'ShellMacro',
      tools: [
        { type: 'function', function: { name: 'shell', description: 'Runs a shell command' } },
      ],
    },
    {
      // N1 regression fixture: a macro that exposes no nameable tools at all.
      name: 'EmptyMacro',
      tools: [],
    },
  ],
};

const BASE_PERSONA_YAML = `
id: "ReactorAIPersona"
name: "Reactor AI Persona"
description: "Base test persona"
persona: |
  # Base Persona
  BASE PERSONA TEXT
features: |
  BASE FEATURES TEXT
config:
  apiKey: "base-key"
  apiBaseURL: "https://base.example/v1"
  streamingPace:
    minChunkSize: 10
tools:
  includes:
    - readFile
prompts:
  system:
    content: "\${buildSystemPrompt()}"
    role: "system"
`;

const PROFILE_ONLY_YAML = `
id: "PersonalAgent"
name: "Personal Agent"
description: "A persona that exists only for its owner"
persona: |
  # Personal Agent
  PERSONAL AGENT TEXT
features: |
  PERSONAL AGENT FEATURES
prompts:
  system:
    content: "\${buildSystemPrompt()}"
    role: "system"
`;

// ── Test environment ────────────────────────────────────────────────────────

let dataRoot: string;
let homeRoot: string;
let fixtureDir: string;
let basePersona: any;

// `import * as fs` yields a Babel namespace wrapper whose properties cannot be redefined;
// spy on the real core module instead — the wrapper getters read through to it.
const realFs: typeof fs = jest.requireActual('fs');

const ORIGINAL_ENV = {
  REACTORY_DATA: process.env.REACTORY_DATA,
  APP_DATA_ROOT: process.env.APP_DATA_ROOT,
  HOME: process.env.HOME,
};

const restoreEnv = () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const profileDir = (userId: string, folder: string): string =>
  path.join(dataRoot, 'profiles', userId, 'reactor', 'ai', 'persona', folder);

const legacyDir = (folder: string): string =>
  path.join(homeRoot, '.reactor', 'ai', 'persona', folder);

const writeText = (dir: string, name: string, content: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
};

const writeBytes = (dir: string, name: string, content: Buffer): string => {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
};

const createContext = (userId?: string | null): any => {
  const context: any = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    colors: { green: (value: string) => value },
  };

  if (userId !== undefined && userId !== null) {
    context.user = { _id: userId, id: userId, roles: ['USER'] };
  }

  return context;
};

const cloneBasePersona = (): any => JSON.parse(JSON.stringify(basePersona));

/**
 * The user persona layer is resolved to its canonical (realpath) form — on macOS `/var` is a
 * symlink to `/private/var`, so tests must compare against realpath, not the lexical path they
 * created the file with.
 */
const canonical = (target: string): string => realFs.realpathSync(target);

/**
 * Build a provider wired to a real `PersonaLoaderService` and a fake model registry that
 * behaves like the real one for `*aipersona` lookups (so registry leakage is observable).
 */
const createProvider = (userId?: string | null, baseOverrides?: Record<string, any>) => {
  const context = createContext(userId);
  const provider = new AIPersonaProvider({} as any, context);

  const loader = new PersonaLoaderService({} as any, context);
  loader.setMacroService(MACRO_SERVICE);
  loader.populateRegistries();
  provider.setPersonaLoader(loader);

  const defs: any[] = [
    {
      nameSpace: 'reactor',
      name: 'ReactorAIPersonaAIPersona',
      version: '1.0.0',
      description: 'base',
      component: { ...cloneBasePersona(), ...(baseOverrides || {}) },
    },
  ];

  const register = jest.fn((definition: any) => {
    defs.push(definition);
  });

  const getModels = jest.fn(async (query: any) => {
    const name = typeof query?.name === 'string' ? query.name.toLowerCase() : '*';

    return defs
      .filter((definition) => {
        const defName = String(definition.name).toLowerCase();
        if (name === '*' || name === '*aipersona') return defName.endsWith('aipersona');
        return defName === name;
      })
      .map((definition) => definition.component);
  });

  provider.setModelRegistry({ register, getModels } as any);

  return { provider, context, loader, register, getModels, defs };
};

/**
 * A loader wired straight to the macro registry, for assertions that must observe raw loader
 * behaviour (e.g. prompt-include filtering) without the provider's post-merge prompt rebuild.
 */
const createLoader = (context: any = createContext()) => {
  const loader = new PersonaLoaderService({} as any, context);
  loader.setMacroService(MACRO_SERVICE);
  loader.populateRegistries();
  return loader;
};

const logMessages = (context: any): string[] =>
  [...context.log.mock.calls, ...context.warn.mock.calls, ...context.error.mock.calls]
    .map((call: any[]) => String(call[0]));

const toolNames = (persona: any): string[] =>
  (persona.tools || [])
    .map((tool: any) => tool?.function?.name)
    .filter((name: any): name is string => typeof name === 'string');

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-profile-fixture-'));
  writeText(fixtureDir, 'base.agent.yaml', BASE_PERSONA_YAML);

  const loader = new PersonaLoaderService({} as any, createContext());
  loader.setMacroService(MACRO_SERVICE);
  loader.populateRegistries();
  basePersona = loader.loadFromFile(path.join(fixtureDir, 'base.agent.yaml'));
});

afterAll(() => {
  if (fixtureDir) (fs as any).rmSync(fixtureDir, { recursive: true, force: true });
});

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-profile-data-'));
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-profile-home-'));

  process.env.REACTORY_DATA = dataRoot;
  delete process.env.APP_DATA_ROOT;
  process.env.HOME = homeRoot;
});

afterEach(() => {
  if (dataRoot) (fs as any).rmSync(dataRoot, { recursive: true, force: true });
  if (homeRoot) (fs as any).rmSync(homeRoot, { recursive: true, force: true });
  delete process.env.QA_PROBE_SECRET;
  restoreEnv();
  jest.restoreAllMocks();
});

// ── AC 1-8: layer resolution ────────────────────────────────────────────────

describe('profile layer overrides', () => {
  it('AC1: applies a profile persona.md for its owner only, without a restart', async () => {
    writeText(profileDir('userA', 'ReactorAIPersona'), 'persona.md', 'USER A PERSONA');

    const owner = createProvider('userA');
    const ownerPersona = await owner.provider.getPersona('ReactorAIPersona');
    expect(ownerPersona.persona).toContain('USER A PERSONA');

    const other = createProvider('userB');
    const otherPersona = await other.provider.getPersona('ReactorAIPersona');
    expect(otherPersona.persona).toContain('BASE PERSONA TEXT');
    expect(otherPersona.persona).not.toContain('USER A PERSONA');

    // Request time: editing the file is picked up by the next call on the same instance.
    writeText(profileDir('userA', 'ReactorAIPersona'), 'persona.md', 'USER A UPDATED');
    const updated = await owner.provider.getPersona('ReactorAIPersona');
    expect(updated.persona).toContain('USER A UPDATED');
  });

  it('AC2: profile layer wins over the operator layer, which wins over the module default', async () => {
    writeText(legacyDir('ReactorAIPersona'), 'persona.md', 'OPERATOR PERSONA');
    writeText(profileDir('userA', 'ReactorAIPersona'), 'persona.md', 'PROFILE PERSONA');

    let persona = await createProvider('userA').provider.getPersona('ReactorAIPersona');
    expect(persona.persona).toContain('PROFILE PERSONA');

    (fs as any).rmSync(profileDir('userA', 'ReactorAIPersona'), { recursive: true, force: true });
    persona = await createProvider('userA').provider.getPersona('ReactorAIPersona');
    expect(persona.persona).toContain('OPERATOR PERSONA');
    expect(persona.persona).not.toContain('PROFILE PERSONA');

    (fs as any).rmSync(legacyDir('ReactorAIPersona'), { recursive: true, force: true });
    persona = await createProvider('userA').provider.getPersona('ReactorAIPersona');
    expect(persona.persona).toContain('BASE PERSONA TEXT');
    expect(persona.persona).not.toContain('OPERATOR PERSONA');
  });

  it('AC3: composes agent.yaml then persona.md then features.md, later files winning', async () => {
    const dir = profileDir('userA', 'ReactorAIPersona');
    writeText(dir, 'agent.yaml', `
id: "ReactorAIPersona"
name: "Composed Persona"
description: "YAML DESCRIPTION"
persona: |
  YAML PERSONA TEXT
features: |
  YAML FEATURES TEXT
`);
    writeText(dir, 'persona.md', 'MD PERSONA TEXT');
    writeText(dir, 'features.md', 'MD FEATURES TEXT');

    const { provider } = createProvider('userA');
    const persona = await provider.getPersona('ReactorAIPersona');

    expect(persona.name).toBe('Composed Persona');
    expect(persona.description).toBe('YAML DESCRIPTION');
    expect(persona.persona).toContain('MD PERSONA TEXT');
    expect(persona.features).toContain('MD FEATURES TEXT');

    // The system prompt is rebuilt once, after all layers, from the merged content.
    const system = persona.prompts?.system?.content || '';
    expect(system).toContain('MD PERSONA TEXT');
    expect(system).toContain('MD FEATURES TEXT');
    expect(system).not.toContain('YAML PERSONA TEXT');
  });

  it('AC4: a profile-only persona appears for its owner and is marked user-scoped', async () => {
    const dir = profileDir('userA', 'personal-agent');
    writeText(dir, 'agent.yaml', PROFILE_ONLY_YAML);

    const { provider } = createProvider('userA');

    const personas = await provider.listPersonas();
    const personal = personas.find((persona: any) => persona.id === 'PersonalAgent');
    expect(personal).toBeTruthy();
    expect(personal.persona).toContain('PERSONAL AGENT TEXT');
    expect(personal.personaSources).toEqual([{ source: 'user', path: canonical(dir) }]);
    expect(personal.metadata?.userScoped).toBe(true);

    const byId = await provider.getPersona('PersonalAgent');
    expect(byId.id).toBe('PersonalAgent');
  });

  it('AC5: a profile-only persona is invisible to other users and never registered', async () => {
    writeText(profileDir('userA', 'personal-agent'), 'agent.yaml', PROFILE_ONLY_YAML);

    const owner = createProvider('userA');
    await owner.provider.listPersonas();
    // SEC-7: the profile-only persona must never be handed to registerPersona().
    expect(owner.register).not.toHaveBeenCalled();
    const registeredModels = await owner.getModels({ name: '*aipersona' });
    expect(registeredModels.map((persona: any) => persona.id)).not.toContain('PersonalAgent');

    const other = createProvider('userB');
    const otherPersonas = await other.provider.listPersonas();
    expect(otherPersonas.map((persona: any) => persona.id)).not.toContain('PersonalAgent');
    await expect(other.provider.getPersona('PersonalAgent')).rejects.toThrow(/not found/i);
  });

  it('AC6: a profile override of a module persona is returned as exactly one entry', async () => {
    const dir = profileDir('userA', 'ReactorAIPersona');
    writeText(dir, 'agent.yaml', `
id: "ReactorAIPersona"
name: "Override Persona"
`);
    writeText(dir, 'persona.md', 'PROFILE CONTENT');

    const { provider } = createProvider('userA');
    const personas = await provider.listPersonas();
    const matching = personas.filter((persona: any) => persona.id === 'ReactorAIPersona');

    expect(matching).toHaveLength(1);
    expect(matching[0].name).toBe('Override Persona');
    expect(matching[0].persona).toContain('PROFILE CONTENT');
  });

  it('AC7: no user context keeps module + operator behaviour and ignores profile layers', async () => {
    writeText(legacyDir('ReactorAIPersona'), 'persona.md', 'OPERATOR PERSONA');
    writeText(profileDir('userA', 'ReactorAIPersona'), 'persona.md', 'PROFILE PERSONA');

    const { provider } = createProvider();
    const personas = await provider.listPersonas();
    const persona = personas.find((candidate: any) => candidate.id === 'ReactorAIPersona');

    expect(personas).toHaveLength(1);
    expect(persona.persona).toContain('OPERATOR PERSONA');
    expect(persona.persona).not.toContain('PROFILE PERSONA');
  });

  it('AC8: resolves the data root from REACTORY_DATA, then APP_DATA_ROOT, and skips without either', async () => {
    writeText(profileDir('userA', 'ReactorAIPersona'), 'persona.md', 'PROFILE PERSONA');

    // a) REACTORY_DATA only.
    process.env.REACTORY_DATA = dataRoot;
    delete process.env.APP_DATA_ROOT;
    let persona = await createProvider('userA').provider.getPersona('ReactorAIPersona');
    expect(persona.persona).toContain('PROFILE PERSONA');

    // b) APP_DATA_ROOT only.
    delete process.env.REACTORY_DATA;
    process.env.APP_DATA_ROOT = dataRoot;
    persona = await createProvider('userA').provider.getPersona('ReactorAIPersona');
    expect(persona.persona).toContain('PROFILE PERSONA');

    // c) neither — layer 3 is skipped with a debug log, and nothing throws.
    delete process.env.REACTORY_DATA;
    delete process.env.APP_DATA_ROOT;
    const { provider, context } = createProvider('userA');
    persona = await provider.getPersona('ReactorAIPersona');
    expect(persona.persona).toContain('BASE PERSONA TEXT');
    expect(logMessages(context).some((message) => message.includes('no REACTORY_DATA/APP_DATA_ROOT'))).toBe(true);
  });
});

// ── AC 9-14 + AC 17-20: security and robustness ─────────────────────────────

describe('profile layer security', () => {
  it('AC9: rejects malicious user ids before any read', async () => {
    writeText(profileDir('userA', 'ReactorAIPersona'), 'persona.md', 'PROFILE PERSONA');

    const readSpy = jest.spyOn(realFs, 'readFileSync');
    const realDataRoot = realFs.realpathSync(dataRoot);

    for (const userId of ['..', '../../etc/passwd', 'a\\..\\b', 'a\0b', '.hidden', '', '   ']) {
      expect(sanitizeUserId(userId)).toBeNull();

      const { provider } = createProvider(userId as string);
      const persona = await provider.getPersona('ReactorAIPersona');
      expect(persona.persona).toContain('BASE PERSONA TEXT');
    }

    const readPaths = readSpy.mock.calls
      .map((call: any[]) => call[0])
      .filter((file: any) => typeof file === 'string')
      .map((file: string) => path.resolve(file));

    // A rejected user id must not cause a single read inside the data root.
    const dataRootReads = readPaths.filter(
      (readPath) => readPath === realDataRoot || readPath.startsWith(realDataRoot + path.sep),
    );
    expect(dataRootReads).toEqual([]);

    readSpy.mockRestore();
  });

  it('AC10: rejects absolute and traversing prompt includes', async () => {
    const dir = profileDir('userA', 'ReactorAIPersona');
    const yamlPath = writeText(dir, 'agent.yaml', `
id: "ReactorAIPersona"
name: "Escape Test"
prompts:
  system:
    files:
      - "/etc/passwd"
      - "../../../secret.md"
    content: "SAFE INLINE CONTENT"
    role: "system"
`);

    // A file that `../../../secret.md` would reach if traversal were allowed.
    writeText(path.join(dataRoot, 'profiles', 'userA'), 'secret.md', 'TOP SECRET CONTENT');

    // (a) Through the provider: the resolved persona must never carry either file's contents,
    //     and the rejected includes are logged.
    const { provider, context } = createProvider('userA');
    const persona = await provider.getPersona('ReactorAIPersona');
    const serialised = JSON.stringify(persona);

    expect(serialised).not.toContain('TOP SECRET CONTENT');
    expect(serialised).not.toContain('root:');
    expect(logMessages(context).some((message) => message.includes('outside'))).toBe(true);

    // (b) At the loader: both includes are skipped, so only the inline content survives.
    //     Asserted directly because the provider rebuilds prompts.system once a layer applies.
    const loaderContext = createContext();
    const loader = createLoader(loaderContext);
    const direct = loader.loadFromFile(yamlPath, {
      baseDir: dir,
      restrictPromptFilesTo: path.join(dataRoot, 'profiles', 'userA', 'reactor', 'ai'),
      processEnvironmentVars: false,
    }) as any;

    const directContent = direct.prompts?.system?.content || '';
    expect(directContent).toContain('SAFE INLINE CONTENT');
    expect(directContent).not.toContain('TOP SECRET CONTENT');
    expect(directContent).not.toContain('root:');
    expect(
      logMessages(loaderContext).filter((message) => message.includes('outside')).length,
    ).toBe(2);
  });

  it('AC11: a profile layer cannot add tools, macros or tool profiles beyond the underlying persona', async () => {
    writeText(profileDir('userA', 'ReactorAIPersona'), 'agent.yaml', `
id: "ReactorAIPersona"
name: "Tool Escalation"
tools:
  includes:
    - readFile
    - shell
    - writeFile
  custom:
    - type: "function"
      function:
        name: "rm_rf"
        description: "Dangerous custom tool"
macros:
  includes:
    - ShellMacro
  custom:
    - name: "EvilMacro"
      tools: []
toolProfiles:
  - name: "escalation"
    description: "Tries to smuggle tools through a tool profile"
    tools:
      - readFile
      - shell
      - writeFile
`);

    const { provider, context } = createProvider('userA');
    const persona = await provider.getPersona('ReactorAIPersona');

    expect(toolNames(persona)).toEqual(['readFile']);
    expect(toolNames(persona)).not.toContain('shell');
    expect(toolNames(persona)).not.toContain('writeFile');
    expect(toolNames(persona)).not.toContain('rm_rf');

    const macroNames = (persona.macros || []).map((macro: any) => macro?.name);
    expect(macroNames).not.toContain('ShellMacro');
    expect(macroNames).not.toContain('EvilMacro');

    // F5: a tool profile is a second door to tools — it is intersected as well.
    const profiles = persona.toolProfiles || [];
    const escalation = profiles.find((profile: any) => profile?.name === 'escalation');
    expect(escalation?.tools).toEqual(['readFile']);
    expect(JSON.stringify(profiles)).not.toContain('shell');
    expect(JSON.stringify(profiles)).not.toContain('writeFile');

    const messages = logMessages(context);
    expect(messages.some((message) => message.includes('"shell"'))).toBe(true);
    expect(messages.some((message) => message.includes('custom tool'))).toBe(true);
    expect(messages.some((message) => message.includes('tool profile "escalation"'))).toBe(true);
  });

  it('AC12: a profile layer cannot override provider credentials, endpoints or model selection', async () => {
    writeText(profileDir('userA', 'ReactorAIPersona'), 'agent.yaml', `
id: "ReactorAIPersona"
name: "Config Attempt"
modelId: "gpt-5"
providerId: "openai"
config:
  apiKey: "sk-attacker"
  apiBaseURL: "https://evil.example/v1"
  apiEndpoint: "https://evil.example"
  apiOrg: "attacker-org"
  apiVersion: "v9"
  project: "attacker-project"
  defaultSearchIndexes:
    - "personal-index"
  streamingPace:
    minChunkSize: 5
`);

    const { provider } = createProvider('userA');
    const persona = await provider.getPersona('ReactorAIPersona');

    expect(persona.config?.apiKey).toBe('base-key');
    expect(persona.config?.apiBaseURL).toBe('https://base.example/v1');
    expect(persona.config?.apiEndpoint).toBeUndefined();
    expect(persona.config?.apiOrg).toBeUndefined();
    expect(persona.config?.apiVersion).toBeUndefined();
    expect(persona.config?.project).toBeUndefined();

    // F6: the layer may not pick the model/provider either, so it cannot bill an arbitrary
    // (possibly expensive) configured model to the service.
    const base = cloneBasePersona();
    expect(persona.modelId).toBe(base.modelId);
    expect(persona.providerId).toBe(base.providerId);

    // Non-sensitive keys still apply.
    expect(persona.config?.defaultSearchIndexes).toEqual(['personal-index']);
    expect(persona.config?.streamingPace?.minChunkSize).toBe(5);
    // Omission of `tools` must not strip the persona's tools.
    expect(toolNames(persona)).toEqual(['readFile']);
  });

  it('AC13: avatars stay per user and are never copied into the shared namespace', async () => {
    const dirA = profileDir('userA', 'ReactorAIPersona');
    writeText(dirA, 'persona.md', 'USER A PERSONA');
    const avatarA = writeBytes(dirA, 'avatar.png', Buffer.from('89504e470d0a1a0a0000000d', 'hex'));

    const copySpy = jest.spyOn(realFs, 'copyFileSync');
    const { provider, context } = createProvider('userA');
    const personas = await provider.listPersonas();

    expect(copySpy).not.toHaveBeenCalled();
    copySpy.mockRestore();

    const dirB = profileDir('userB', 'ReactorAIPersona');
    writeText(dirB, 'persona.md', 'USER B PERSONA');
    const avatarB = writeBytes(dirB, 'avatar.png', Buffer.from('89504e470d0a1a0affffff', 'hex'));

    expect(resolveUserAvatarPath('userA', 'ReactorAIPersona')).toBe(canonical(avatarA));
    expect(resolveUserAvatarPath('userB', 'ReactorAIPersona')).toBe(canonical(avatarB));
    expect(avatarA).not.toBe(avatarB);

    const resolver = new ReactorPersonaResolver();
    const url = await resolver.ReactorAIPersonaAvatar(personas[0] as any, {}, context);
    expect(url).toContain('profiles/userA/reactor/ai/persona/ReactorAIPersona/avatar.png');

    // A profile-only persona whose folder name differs from its id still resolves its own
    // avatar (the provider records the layer path on the persona).
    const personalDir = profileDir('userA', 'personal-agent');
    writeText(personalDir, 'agent.yaml', PROFILE_ONLY_YAML);
    writeBytes(personalDir, 'avatar.png', Buffer.from('89504e470d0a1a0a22222222', 'hex'));

    const withPersonal = await provider.listPersonas();
    const personal = withPersonal.find((candidate: any) => candidate.id === 'PersonalAgent');
    expect(personal?.personaSources?.[0]?.path).toBe(canonical(personalDir));

    const personalUrl = await resolver.ReactorAIPersonaAvatar(personal as any, {}, context);
    expect(personalUrl).toContain('profiles/userA/reactor/ai/persona/personal-agent/avatar.png');

    // No shared-namespace writes happened while resolving either user.
    expect(fs.existsSync(path.join(dataRoot, 'profiles', 'reactor', 'personas'))).toBe(false);
  });

  it('AC14: malformed or unreadable profile input is logged and contained', async () => {
    // A profile-only folder with invalid YAML.
    writeText(profileDir('userA', 'broken-agent'), 'agent.yaml', 'id: [unclosed\nname: "Broken"\n');

    // A folder that matches the module persona but whose persona.md cannot be read as a file.
    const brokenOverride = profileDir('userA', 'ReactorAIPersona');
    fs.mkdirSync(path.join(brokenOverride, 'persona.md'), { recursive: true });

    const { provider, context } = createProvider('userA');
    const personas = await provider.listPersonas();

    expect(personas).toHaveLength(1);
    const persona = await provider.getPersona('ReactorAIPersona');
    expect(persona.persona).toContain('BASE PERSONA TEXT');
    expect(persona.features).toContain('BASE FEATURES TEXT');
    expect(logMessages(context).some((message) => message.includes('failed to load profile persona'))).toBe(true);
  });

  it('AC17 (F1): a user layer never expands ${ENV} — override and profile-only paths', async () => {
    const SECRET = 'leak-me-9f3c';
    process.env.QA_PROBE_SECRET = SECRET;

    // (a) Override path: mergeWithExisting must not substitute.
    writeText(profileDir('userA', 'ReactorAIPersona'), 'agent.yaml', `
id: "ReactorAIPersona"
name: "Env Probe"
description: "\${QA_PROBE_SECRET}"
persona: "ENV PROBE PERSONA"
prompts:
  system:
    content: "\${QA_PROBE_SECRET}"
    role: "system"
`);

    const overridden = await createProvider('userA').provider.getPersona('ReactorAIPersona');
    expect(overridden.description).toBe('${QA_PROBE_SECRET}');
    expect(JSON.stringify(overridden)).not.toContain(SECRET);

    // (b) Profile-only path: loadFromFile must not substitute either.
    writeText(profileDir('userA', 'env-agent'), 'agent.yaml', `
id: "EnvProbeAgent"
name: "Env Probe Agent"
description: "\${QA_PROBE_SECRET}"
persona: "ENV PROBE ONLY"
prompts:
  system:
    content: "\${QA_PROBE_SECRET}"
    role: "system"
`);

    const personal = await createProvider('userA').provider.getPersona('EnvProbeAgent');
    expect(personal.description).toBe('${QA_PROBE_SECRET}');
    expect(personal.prompts?.system?.content).toBe('${QA_PROBE_SECRET}');
    expect(JSON.stringify(personal)).not.toContain(SECRET);

    // (c) Control: the trusted operator layer still expands ${ENV}, so the flag is scoped to
    //     untrusted layers rather than disabling substitution globally. The user override from
    //     (a) is removed first so it cannot shadow the operator layer.
    (fs as any).rmSync(profileDir('userA', 'ReactorAIPersona'), { recursive: true, force: true });
    writeText(legacyDir('ReactorAIPersona'), 'agent.yaml', `
id: "ReactorAIPersona"
description: "\${QA_PROBE_SECRET}"
`);

    const operatorPersona = await createProvider('userA').provider.getPersona('ReactorAIPersona');
    expect(operatorPersona.description).toBe(SECRET);
  });

  it('AC18 (F2): a symlinked profile root cannot expose another user\'s personas', async () => {
    // userB has a real persona layer.
    writeText(profileDir('userB', 'ReactorAIPersona'), 'persona.md', 'USER B SECRET PERSONA');

    // userA's `reactor/ai` is a symlink to userB's.
    const userAReactor = path.join(dataRoot, 'profiles', 'userA', 'reactor');
    fs.mkdirSync(userAReactor, { recursive: true });
    const userBAi = path.join(dataRoot, 'profiles', 'userB', 'reactor', 'ai');
    fs.symlinkSync(userBAi, path.join(userAReactor, 'ai'), 'dir');

    // The canonical root resolver refuses the redirect outright.
    expect(resolveUserPersonaRoot('userA')).toBeNull();

    // And the resolved persona is the base one, with no read touching userB's files.
    const readSpy = jest.spyOn(realFs, 'readFileSync');
    const persona = await createProvider('userA').provider.getPersona('ReactorAIPersona');

    expect(persona.persona).toContain('BASE PERSONA TEXT');
    expect(persona.persona).not.toContain('USER B SECRET PERSONA');

    const userBPath = realFs.realpathSync(path.join(dataRoot, 'profiles', 'userB'));
    const readsIntoUserB = readSpy.mock.calls
      .map((call: any[]) => call[0])
      .filter((file: any) => typeof file === 'string')
      .map((file: string) => path.resolve(file))
      .filter((file: string) => file === userBPath || file.startsWith(userBPath + path.sep));

    expect(readsIntoUserB).toEqual([]);
    readSpy.mockRestore();
  });

  it('AC19 (F8): a lean _id that stringifies to [object Object] falls back to user.id', async () => {
    writeText(profileDir('userA', 'ReactorAIPersona'), 'persona.md', 'USER A PERSONA');

    const context = createContext();
    context.user = { _id: {}, id: 'userA', roles: ['USER'] };

    const provider = new AIPersonaProvider({} as any, context);
    provider.setPersonaLoader(createLoader(context));
    provider.setModelRegistry({
      register: jest.fn(),
      getModels: jest.fn(async () => [cloneBasePersona()]),
    } as any);

    const persona = await provider.getPersona('ReactorAIPersona');
    expect(persona.persona).toContain('USER A PERSONA');
  });

  it('AC21 (F7): the persona badge is reachable through the GraphQL schema', async () => {
    const schemaPath = path.resolve(__dirname, '../../graphql/schema/ReactorPersona.graphql');
    const sdl = fs.readFileSync(schemaPath, 'utf8');

    expect(sdl).toContain('type ReactorPersonaSource');
    expect(sdl).toMatch(/type ReactorPersona \{[\s\S]*personaSources: \[ReactorPersonaSource\]/);
    expect(sdl).toMatch(/type ReactorPersona \{[\s\S]*userScoped: Boolean/);

    const resolver = new ReactorPersonaResolver();
    writeText(profileDir('userA', 'personal-agent'), 'agent.yaml', PROFILE_ONLY_YAML);

    const { provider } = createProvider('userA');
    const personal = await provider.getPersona('PersonalAgent');

    await expect(resolver.ReactorAIPersonaSources(personal)).resolves.toEqual([
      { source: 'user', path: canonical(profileDir('userA', 'personal-agent')) },
    ]);
    await expect(resolver.ReactorAIPersonaUserScoped(personal)).resolves.toBe(true);
    await expect(
      resolver.ReactorAIPersonaUserScoped(cloneBasePersona()),
    ).resolves.toBe(false);
  });

  it('AC22 (D2): a user layer that omits resources keeps the base persona resources', async () => {
    const baseResources = [
      {
        id: 'kb',
        name: 'Knowledge Base',
        description: 'Persona knowledge',
        type: 'url' as const,
        url: 'https://kb.example/persona.md',
        created: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];

    // A layer that only renames the persona must not strip its resources...
    writeText(profileDir('userA', 'ReactorAIPersona'), 'agent.yaml', `
id: "ReactorAIPersona"
name: "Renamed Only"
`);

    // The base persona renders its resource list through ${resourceDescription}, so the prompt
    // assertion below observes the resource reaching the rebuilt system prompt.
    const baseWithResourceTemplate = {
      resources: baseResources,
      persona: '# Base Persona\nBASE PERSONA TEXT\n\n${resourceDescription}',
    };

    const kept = await createProvider('userA', baseWithResourceTemplate)
      .provider.getPersona('ReactorAIPersona');

    expect(kept.name).toBe('Renamed Only');
    expect(kept.resources).toHaveLength(1);
    expect(kept.resources?.[0]?.url).toBe('https://kb.example/persona.md');
    // ...and the resource must survive into the rebuilt system prompt too.
    expect(kept.prompts?.system?.content || '').toContain('https://kb.example/persona.md');

    // An explicit list still replaces, so a layer remains in control when it says so.
    writeText(profileDir('userA', 'ReactorAIPersona'), 'agent.yaml', `
id: "ReactorAIPersona"
resources:
  - id: "own"
    name: "Own Resource"
    type: "url"
    url: "https://own.example/doc.md"
    created: "2026-01-01T00:00:00.000Z"
`);

    const replaced = await createProvider('userA', baseWithResourceTemplate)
      .provider.getPersona('ReactorAIPersona');

    expect(replaced.resources).toHaveLength(1);
    expect(replaced.resources?.[0]?.id).toBe('own');
  });

  it('AC23 (N1): a macro that grants no tools cannot be admitted by a user layer', async () => {
    writeText(profileDir('userA', 'ReactorAIPersona'), 'agent.yaml', `
id: "ReactorAIPersona"
macros:
  includes:
    - EmptyMacro
`);

    const { provider, context } = createProvider('userA');
    const persona = await provider.getPersona('ReactorAIPersona');

    const macroNames = (persona.macros || []).map((macro: any) => macro?.name);
    expect(macroNames).not.toContain('EmptyMacro');
    expect(
      logMessages(context).some((message) => message.includes('EmptyMacro')),
    ).toBe(true);
  });

  it('AC24 (N3): one profile folder is consumed once, as an override', async () => {
    // `reactor` is a candidate folder name for ReactorAIPersona, but the YAML declares
    // SideAgent — the folder must be used as the override only, not emitted twice.
    const dir = profileDir('userA', 'reactor');
    writeText(dir, 'agent.yaml', `
id: "SideAgent"
name: "Side Agent"
`);
    writeText(dir, 'persona.md', 'OVERRIDE FOLDER PERSONA');

    const { provider } = createProvider('userA');
    const personas = await provider.listPersonas();
    const ids = personas.map((persona: any) => persona.id);

    expect(ids).toEqual(['ReactorAIPersona']);
    expect(ids).not.toContain('SideAgent');
    expect(personas[0].persona).toContain('OVERRIDE FOLDER PERSONA');
  });

  it('AC25 (D1): the loader README has one three-layer section and states the real rebuild rule', () => {
    const readmePath = path.resolve(__dirname, '../../ai/persona/loader/README.md');
    const readme = fs.readFileSync(readmePath, 'utf8');
    const lines = readme.split('\n');

    // Guards the AC16 regression: the block was once inserted twice, the first copy torn off
    // mid-table-row and spliced into the document title.
    expect(readme.startsWith('# IAIPersona YAML Configuration System')).toBe(true);
    expect(readme.split('# IAIPersona YAML Configuration System')).toHaveLength(2);
    expect(readme.split('## Three-layer persona resolution')).toHaveLength(2);
    expect(readme.split('| Requirement | Behaviour |')).toHaveLength(2);
    expect(readme.split('```').length % 2).toBe(1);

    // Every security-table row must open with its own bolded label (one row was beheaded).
    const tableStart = lines.findIndex((line) => line.startsWith('| Requirement | Behaviour |'));
    expect(tableStart).toBeGreaterThan(-1);

    const rows: string[] = [];
    for (let i = tableStart + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
      rows.push(lines[i]);
    }

    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) expect(row).toMatch(/^\| \*\*[A-Za-z ]+\*\* \|/);

    // The documented rebuild rule must match the code and AC20 — a layer-supplied
    // prompts.system is replaced, not kept.
    expect(readme).toContain('`prompts.system` is rebuilt **once**, after every layer has been applied');
    expect(readme).not.toContain('a layer that ships its own prompt\ncontent keeps it');
  });

  it('AC20 (F4): the operator layer keeps the pre-change system-prompt rebuild semantics', async () => {
    // No layer at all: the module prompt is untouched.
    const bare = await createProvider('userA').provider.getPersona('ReactorAIPersona');
    expect(bare.prompts?.system?.content).toContain('BASE PERSONA TEXT');

    // Operator YAML that supplies only prompts.system: the pre-change provider rebuilt
    // prompts.system from persona+features whenever a layer merged any YAML, overwriting the
    // operator's prompt. That result is preserved (one rebuild, after all layers).
    writeText(legacyDir('ReactorAIPersona'), 'agent.yaml', `
id: "ReactorAIPersona"
prompts:
  system:
    content: "OPERATOR CUSTOM PROMPT"
    role: "system"
`);

    const operatorOnly = await createProvider('userA').provider.getPersona('ReactorAIPersona');
    const operatorPrompt = operatorOnly.prompts?.system?.content || '';
    expect(operatorPrompt).not.toBe('OPERATOR CUSTOM PROMPT');
    expect(operatorPrompt).toContain('BASE PERSONA TEXT');
    expect(operatorPrompt).toContain('BASE FEATURES TEXT');

    // A profile markdown layer still triggers exactly one rebuild, from the merged content.
    writeText(profileDir('userA', 'ReactorAIPersona'), 'persona.md', 'PROFILE PERSONA TEXT');
    const withProfile = await createProvider('userA').provider.getPersona('ReactorAIPersona');
    const profilePrompt = withProfile.prompts?.system?.content || '';
    expect(profilePrompt).toContain('PROFILE PERSONA TEXT');
    expect(profilePrompt).not.toContain('OPERATOR CUSTOM PROMPT');
  });
});
