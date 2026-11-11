# IAIPersona YAML Configuration System

This system provides a comprehensive YAML-based configuration approach for IAIPersona definitions, allowing you to load personas from YAML config files and merge them with existing definitions or create new ones.

## Overview

The system consists of:

1. **YAML Template** (`persona-template.yaml`) - A comprehensive template for IAIPersona configurations
2. **Persona Loader** (`persona-loader.ts`) - TypeScript utility for loading, merging, and managing persona configurations
3. **Usage Examples** (`persona-usage-example.ts`) - Comprehensive examples demonstrating all functionality

## Features

- ✅ Load personas from YAML files or strings
- ✅ Merge YAML configurations with existing personas
- ✅ Create new personas from YAML templates
- ✅ Validate persona configurations
- ✅ Save personas to YAML format
- ✅ Environment variable substitution
- ✅ Role-based capabilities management
- ✅ Tool and macro registry integration
- ✅ Resource management
- ✅ TypeScript support with full type safety

## Three-layer persona resolution (module → operator → user)

Persona content is resolved from up to **three** layers, lowest precedence first. Layers
are applied **at request time** by `AIPersonaProvider.listPersonas()` / `getPersona()` —
adding, editing or deleting a layer file never requires a server restart or `@reloadPersonas()`.

| # | Layer | Root | Trust |
| - | ----- | ---- | ----- |
| 1 | **module default** | `<module>/ai/persona/<agent>/` | trusted (code) |
| 2 | **operator override** | `~/.reactor/ai/persona/<agent>/` | trusted (process operator) |
| 3 | **calling user** | `<REACTORY_DATA>/profiles/<USERID>/reactor/ai/persona/<agent>/` | **untrusted** |

`<REACTORY_DATA>` is `process.env.REACTORY_DATA`, falling back to `process.env.APP_DATA_ROOT`.
If neither is set, layer 3 is skipped (debug log) and layers 1-2 behave exactly as before.

### Directory contract

Every layer folder is optional and may contain any subset of:

```
<agent>/
  agent.yaml      # or agent.yml — merged into the persona
  persona.md      # replaces the `persona` markdown
  features.md     # replaces the `features` markdown
  prompts/        # files referenced by prompts.<key>.files
    *.md
  avatar.png      # per-user avatar (layer 3 only; never copied elsewhere)
```

Within a single layer the files compose in this order, each one winning over what came
before for the fields it sets:

1. `agent.yaml` / `agent.yml` — `mergeWithExisting()` (scalars, config, tools, macros,
   resources, prompts)
2. `persona.md` — replaces `persona` when non-empty
3. `features.md` — replaces `features` when non-empty

`prompts.system` is rebuilt **once**, after every layer has been applied — never per layer,
which would discard the earlier text. The trigger matches the pre-change `~/.reactor`
behaviour: any layer that contributed an `agent.yaml` (even one that only sets `name`), a
`persona.md` or a `features.md` marks the persona for one rebuild from the merged
`persona` + `features`. **Trade-off:** a layer that ships its own `prompts.system` has that
content replaced by the generated prompt whenever the persona also has `persona`/`features`
— this is long-standing operator behaviour, pinned by test AC20, not a new restriction.

### Which folder is used for a persona id?

Both the operator and the user layer use the same candidate list (one helper, so they
cannot drift):

1. exact id — `ReactorAIPersona`
2. lower-case id — `reactoraipersona`
3. id with `aipersona` stripped, lower-cased — `reactor`

The first candidate that exists as a directory wins.

### Overrides vs. profile-only personas

- If the profile directory matches an **existing** persona id, its contents override the
  module/operator layers for that user only. Other users keep the lower-layer result.
- If a profile directory's `agent.yaml` declares an id the registry does not know (for
  example `PersonalAgent` in `profiles/<user>/reactor/ai/persona/personal-agent/`), that
  persona is **profile-only**: it appears in `listPersonas()` and resolves through
  `getPersona(id)` for its owner, and nowhere else.
- Profile-only personas are **never** registered with `modelRegistry.register()`. They are
  request-scoped values: another user cannot see them, they do not survive into the global
  registry, and they disappear when the profile folder does.
- If a profile folder and a module define the same id, `listPersonas()` returns exactly one
  entry, with the profile content.

A profile persona carries `personaSources: [{ source: 'user', path }]` (and
`metadata.userScoped: true` for profile-only personas) so clients can badge it as personal.

### Omitting a field leaves the lower layer alone

An override is *additive*: a field the layer does not mention keeps the value the lower
layer produced. This applies to `tools` (including `tools.custom`/`macros.custom`, which are
ignored outright for user layers), `macros`, `toolProfiles`, `resources`, `config`, `prompts`
and the markdown files. So an `agent.yaml` containing only

```yaml
id: "ReactorAIPersona"
name: "Reactor (my setup)"
```

renames the persona and keeps its tools, resources and prompts untouched. Declaring a field
**replaces** it with the declared value (and for tools/toolProfiles, with the intersected
subset the persona already grants).

### One folder is one layer

`listProfilePersonaDirs()` consumes every directory under `persona/` exactly once. A folder
whose name is a candidate for an existing persona id (for example `persona/reactor/`) but
whose `agent.yaml` declares a different id is used as that persona's **override**; it is not
additionally emitted as a profile-only persona under the declared id. Keep folder names and
declared ids aligned to avoid confusing results.

### Profile-only personas and model selection

A profile layer may not choose `modelId`/`providerId` (SEC-5 hardening). An **override** keeps
the underlying persona's model/provider. A **profile-only** persona has no lower layer to
inherit from, so it falls back to the loader defaults (`gemini-2.5-pro` / `google`). On a
deployment configured for a different provider, give the user an operator-level persona to
override instead of declaring one from scratch.

### Security restrictions for the user layer

The profile layer is user-authored input, so the loader runs it with restrictions the
trusted layers do not use:

| Requirement | Behaviour |
| ----------- | --------- |
| **User id** | Taken from `context.user` only (`_id` then `id`, first candidate that validates wins), validated with `^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$`. `.`, `..`, `/`, `\` and null bytes are rejected before any read. A user id is never read from request arguments. |
| **Containment** | `<dataRoot>/profiles/<userId>` and its `reactor/ai` subtree are **canonicalised with `realpath`** and must resolve inside `realpath(<dataRoot>/profiles)`, keeping the `<userId>` basename. The canonical root is then used as `restrictTo` for every later `path.relative`/`realpath` check, so a symlinked `profiles/<userId>` or `profiles/<userId>/reactor/ai` cannot borrow another user's tree. If the tree does not exist, the layer is skipped. |
| **Environment expansion** | `${ENV}` / `${ENV:-default}` substitution is **disabled** for user layers (`processEnvironmentVars: false`). Otherwise a user could read any server variable (DB URIs, provider keys, JWT secrets) through `description` or `prompts.system.content`, both of which the `ReactorPersonas` query returns. The trusted module and `~/.reactor` layers keep substitution. |
| **Prompt includes** | `prompts.<key>.files` may only name **relative** paths inside the user's `reactor/ai` tree. Absolute paths and `..` are skipped with a warning and never read. |
| **Tools** | The layer's resolved tools are intersected with the tools the underlying persona already grants. `tools.custom` and `macros.custom` are ignored, and so are macros that are not already granted. `toolProfiles[].tools` is intersected the same way (a tool profile is a second door to the same registry), and profiles left with nothing permitted are dropped. A profile-only persona starts with **no tools** — an untrusted layer can narrow capabilities, never add them. |
| **Provider config** | Only `config.defaultSearchIndexes` and `config.streamingPace` are copied from the layer. `apiKey`, `apiBaseURL`, `apiEndpoint`, `apiOrg`, `apiVersion` and `project` are ignored, so a user cannot redirect provider traffic or inject credentials. |
| **Model selection** | `modelId` and `providerId` are also ignored for user layers. They cannot leak credentials, but they would let a user bill an arbitrary (possibly expensive) configured model to the service. Provider/model choice stays with the module or operator persona. |
| **Merge mode** | `merge.mode` is forced to `merge`; a user layer cannot replace or re-identify a persona it only overrides. |
| **Avatars** | Resolved from the user's own folder (`.../persona/<agent>/avatar.png`). Nothing is written into the shared `profiles/reactor/personas/**` namespace, so two users with the same persona id cannot collide. |
| **Failure isolation** | Invalid YAML, unreadable files and rejected includes are logged and skipped; `listPersonas()` and chat turns still return the lower-layer persona. |
| **Logging** | Only source paths and dropped tool/macro names are logged — never secret values from the layer. |

### Sample profile tree

```
<REACTORY_DATA>/profiles/65f0c1d2e3a4b5c6d7e8f901/reactor/ai/persona/reactor/
  agent.yaml
  persona.md
  features.md
  prompts/
    00-identity.md
    10-house-rules.md
  avatar.png
```

`agent.yaml` — only the fields the user wants to change:

```yaml
id: "ReactorAIPersona"          # must match the persona being personalised
name: "Reactor (my setup)"
description: "My personal Reactor assistant"
tools:
  includes:                     # may only repeat tools the persona already grants
    - readFile
config:
  defaultSearchIndexes:         # non-sensitive keys only
    - "my-project-docs"
  streamingPace:
    minChunkSize: 40
prompts:
  system:
    files:
      - "prompts/00-identity.md"
      - "prompts/10-house-rules.md"
    role: "system"
```

`persona.md` — wins over the `persona` field above:

```markdown
# Reactor — personal

You are my Reactor assistant. Keep answers short and cite file paths.
```

`features.md` — wins over `features`:

```markdown
## How I want you to work

- Prefer TypeScript.
- Show the exact command you ran.
```

`prompts/00-identity.md` and `prompts/10-house-rules.md` are concatenated in order (a
missing file is logged and skipped). Includes are only read from inside
`profiles/<userId>/reactor/ai/`.

### Declaring a persona that exists only for one user

`profiles/<userId>/reactor/ai/persona/personal-agent/agent.yaml`:

```yaml
id: "PersonalAgent"
name: "Personal Agent"
description: "A persona that exists only for me"
persona: |
  # Personal Agent
  You help me with my own notes and tasks.
features: |
  ## Scope
  Personal projects only.
prompts:
  system:
    content: "${buildSystemPrompt()}"
    role: "system"
```

It appears in that user's `listPersonas()` (marked `metadata.userScoped: true`) and is
absent for every other user and from `modelRegistry.getModels({ name: '*aipersona' })`.

### Limitations

- **No user identity in system/workflow contexts.** `ProcessAITicket`, scheduled agents
  and other non-user runs have no `context.user`, so they resolve layers 1-2 only. A
  personal persona is therefore not available to background automation.
- **No caching.** Nothing is cached between calls, so edits are visible immediately. The
  cost per `listPersonas()` / `getPersona()` is a `realpath` + `stat` per layer directory
  for every registry persona, plus a full read, YAML parse and validation of **every**
  profile `agent.yaml` (needed to learn its declared id). On a busy chat path with many
  personas this is real work; if latency shows up, a `(path, mtimeMs, size)`-keyed cache
  cleared by `reloadPersonas()` is the intended remedy.
- **No UI, persistence or cross-device sync.** Profile personas are files on the server.
- **Profile persona tools.** Because a profile-only persona has no underlying grant, it
  has no tools. Tool access must be granted by a module or operator persona.

## Quick Start

### 1. Install Dependencies

```bash
npm install js-yaml @types/js-yaml
```

### 2. Basic Usage

```typescript
import { loadPersonaFromFile, mergePersonaWithConfig } from './persona-loader';

// Load a persona from YAML file
const persona = loadPersonaFromFile('./my-persona.yaml');

// Merge with existing persona
const updatedPersona = mergePersonaWithConfig(existingPersona, yamlConfig);
```

### 3. Create a New Persona

```yaml
# my-persona.yaml
id: "my-persona"
name: "My Persona"
description: "A custom persona for my domain"
modelId: "gemini-2.5-pro"
providerId: "google"
defaultGreeting: "Hello, I am your AI assistant!"

persona: |
  # My Persona
  I am a specialized AI assistant for your domain.
  
  ## Background
  [Your persona background here]

features: |
  # Your Capabilities and Guidelines
  [Your features and capabilities here]

tools:
  includes:
    - readFile
    - writeFile
    - http
    - listDirectory

macros:
  includes:
    - NewRequestMacroDefinition
    - ListRequestsMacroDefinition

resources:
  - id: "domain-document"
    name: "Domain Document"
    description: "Your domain documentation"
    type: "text"
    url: "/docs/domain.md"
    created: "2024-01-01T00:00:00.000Z"
```

## YAML Template Structure

The `persona-template.yaml` file provides a comprehensive template with all available configuration options:

### Basic Information
```yaml
id: "TemplatePersonaId"                    # Required: Unique identifier
name: "Template Persona Name"              # Required: Display name
description: "Template Persona Description"
```

### Model Configuration
```yaml
modelId: "${GOOGLE_AI_STUDIO_MODEL_ID:-gemini-2.5-pro}"
providerId: "google"
```

### API Configuration
```yaml
config:
  apiKey: "${GOOGLE_AI_STUDIO_API_KEY}"
  apiBaseURL: "${GOOGLE_AI_API_URL}"
  project: "${GOOGLE_AI_STUDIO_PROJECT_ID}"
```

### Persona Content
```yaml
persona: |
  # Template Persona Content
  [Your persona definition in markdown]

features: |
  # Your Capabilities and Guidelines
  [Your features and capabilities in markdown]
```

### Tools and Macros
```yaml
tools:
  includes:
    - readFile
    - writeFile
    - http
    # Add domain-specific tools here

macros:
  includes:
    - NewRequestMacroDefinition
    - ListRequestsMacroDefinition
    # Add domain-specific macros here
```

### Resources
```yaml
resources:
  - id: "domain-review-document"
    name: "Domain Review Document"
    description: "Domain documentation and review"
    type: "text"
    url: "${APP_DATA_ROOT}/profiles/zepz-engineer/domains/reviews/[domain]-domain-review.md"
    created: "${new Date().toISOString()}"
```

### Role Capabilities
```yaml
roleCapabilities:
  ADMIN: "You have administrative access to all [Domain] functions..."
  ENGINEER: "You have engineering access to [Domain] technical functions..."
  USER: "You have standard user access to approved [Domain] functions..."
  default: "You have basic access to core [Domain] functions..."
```

### Prompts

Prompt content is resolved **at load time** by the loader, so a YAML agent's prompts
reach the model fully materialised — exactly like a TypeScript persona's
`buildSystemPrompt()` output.

#### Loader directives

Zero-argument directives written as `${directive()}` are replaced while the agent.yaml
is read from disk:

| Directive | Resolves to |
| --- | --- |
| `${buildSystemPrompt()}` (alias `${buildSystemContent()}`) | `persona` + `features`, rendered with the standard variables |
| `${personaContent()}` | the rendered `persona` block |
| `${featuresContent()}` | the rendered `features` block |
| `${toolDescriptions()}` | `- **tool**: description` list for the resolved tools |
| `${resourceDescriptions()}` | `- **name**: description - url` list for the declared resources |
| `${roleCapabilities()}` | capability blurb for the resolving roles |

The variables available inside `persona` / `features` markdown are the same set the
TypeScript personas supply: `date`, `userRole`, `roleSpecificCapabilities`,
`toolDescriptions`, `resourceDescription`, `availableTools`, plus `tools` and
`resources`. Unknown `${something()}` tokens and literal `${...}` code samples are left
untouched.

```yaml
prompts:
  system:
    content: "${buildSystemPrompt()}"
    role: "system"
```

If a persona declares no `prompts.system`, the loader synthesises one from `persona`
and `features` automatically.

#### Assembling prompts from files

Instead of one inline blob, a prompt may list files that are read and concatenated **in
sequence**. Relative paths resolve against the directory holding the `agent.yaml`;
absolute paths and `${ENV_VAR}` prefixes are supported.

```yaml
prompts:
  system:
    files:
      - "prompts/00-identity.md"
      - "prompts/10-house-rules.md"
      - "${REACTORY_SERVER}/src/modules/my-module/docs/playbook.md"
    separator: "\n\n---\n\n"   # optional, defaults to a blank line
    content: "Always answer in British English."   # optional, appended last
    role: "system"
```

Files that cannot be read are logged and skipped, so a single missing include never
takes the persona down. Directives inside the assembled files are resolved too.

#### What the loader does *not* do

Conversation-level variables — `${user.name}`, `${session_id}`, `${reviewArea}` and any
other canned-prompt parameters — are deliberately left in place. They are interpolated
later by `ReactorConversationService.startChatSession` (system prompt) and
`sendCannedPrompt` (named prompts).

### Merge Configuration
```yaml
merge:
  mode: "merge"  # Options: "merge", "replace", "create"
  options:
    overwriteExisting: false
    preserveExistingTools: true
    preserveExistingMacros: true
    preserveExistingResources: true
    updateMetadata: true
```

### Validation
```yaml
validation:
  required:
    - id
    - name
    - description
    - persona
    - features
  types:
    id: "string"
    name: "string"
    description: "string"
```

## Persona Loader API

### Core Functions

#### `loadPersonaFromFile(filePath: string, options?: PersonaLoaderOptions): IAIPersona`
Load a persona from a YAML file.

```typescript
const persona = loadPersonaFromFile('./persona.yaml');
```

#### `loadPersonaFromString(yamlContent: string, options?: PersonaLoaderOptions): IAIPersona`
Load a persona from a YAML string.

```typescript
const persona = loadPersonaFromString(yamlContent);
```

#### `loadPersonasFromDirectory(dirPath: string, options?: PersonaLoaderOptions): IAIPersona[]`
Load multiple personas from a directory.

```typescript
const personas = loadPersonasFromDirectory('./personas');
```

#### `mergePersonaWithConfig(existingPersona: IAIPersona, yamlConfig: string | IAIPersonaConfig, options?: PersonaLoaderOptions): IAIPersona`
Merge a YAML configuration with an existing persona.

```typescript
const mergedPersona = mergePersonaWithConfig(existingPersona, yamlConfig);
```

#### `savePersonaToFile(persona: IAIPersona, filePath: string): void`
Save a persona to a YAML file.

```typescript
savePersonaToFile(persona, './output.yaml');
```

#### `validatePersonaConfig(config: IAIPersonaConfig): { isValid: boolean; errors: string[] }`
Validate a persona configuration.

```typescript
const result = validatePersonaConfig(config);
if (!result.isValid) {
  console.error('Validation errors:', result.errors);
}
```

### PersonaLoader Class

#### Singleton Instance
```typescript
import { personaLoader } from './persona-loader';

// Use the singleton instance
const persona = personaLoader.loadFromFile('./persona.yaml');
```

#### Registry Management
```typescript
// Register tools and macros
personaLoader.registerTool('myTool', toolDefinition);
personaLoader.registerMacro('myMacro', macroDefinition);

// Get registered items
const tools = personaLoader.getRegisteredTools();
const macros = personaLoader.getRegisteredMacros();
```

### Options

#### PersonaLoaderOptions
```typescript
interface PersonaLoaderOptions {
  validateOnLoad?: boolean;        // Default: true
  processEnvironmentVars?: boolean; // Default: true
  mergeMode?: 'merge' | 'replace' | 'create'; // Default: 'merge'
  baseDir?: string;                // Directory relative prompt `files` resolve against.
                                   // Set automatically by loadFromFile/loadFromDirectory.
  userRoles?: string[];            // Roles used for ${roleCapabilities()}. Default: ['USER']
  processEnvironmentVars?: boolean;// Default: true. Pass false for untrusted layers.

  // ── Restrictions for UNTRUSTED (user profile) layers ────────────────────
  // All optional; omitting them preserves the historical trusted-layer behaviour.
  allowedTools?: string[];         // Tool names the layer may resolve (never widens).
  disallowCustomTools?: boolean;   // Ignore `tools.custom` and `macros.custom`.
  sanitizeConfig?: boolean;        // Copy only defaultSearchIndexes / streamingPace.
  restrictPromptFilesTo?: string;  // Root every prompts.<key>.files entry must stay inside.
  restrictMergeMode?: boolean;     // Force merge semantics (ignore merge.mode).
}
```

## Environment Variable Substitution

The system supports environment variable substitution in YAML configurations:

```yaml
modelId: "${GOOGLE_AI_STUDIO_MODEL_ID:-gemini-2.5-pro}"
apiKey: "${GOOGLE_AI_STUDIO_API_KEY}"
url: "${APP_DATA_ROOT}/profiles/domain/review.md"
```

- `${VARIABLE_NAME}` - Required variable
- `${VARIABLE_NAME:-default}` - Variable with default value
- `${new Date().toISOString()}` - Dynamic date generation

## Merge Modes

### 1. Merge Mode (`merge`)
Combines YAML configuration with existing persona, preserving existing data.

```yaml
merge:
  mode: "merge"
  options:
    overwriteExisting: false
    preserveExistingTools: true
    preserveExistingMacros: true
    preserveExistingResources: true
```

### 2. Replace Mode (`replace`)
Completely replaces the existing persona with the YAML configuration.

```yaml
merge:
  mode: "replace"
```

### 3. Create Mode (`create`)
Creates a new persona from the YAML configuration (generates new ID if needed).

```yaml
merge:
  mode: "create"
```

## Validation

The system provides comprehensive validation:

### Required Fields
```yaml
validation:
  required:
    - id
    - name
    - description
    - persona
    - features
```

### Type Validation
```yaml
validation:
  types:
    id: "string"
    name: "string"
    description: "string"
    tools: "array"
    macros: "array"
    resources: "array"
```

## Best Practices

### 1. Use Environment Variables
```yaml
# Good
apiKey: "${GOOGLE_AI_STUDIO_API_KEY}"
url: "${APP_DATA_ROOT}/profiles/domain/review.md"

# Avoid
apiKey: "hardcoded-key"
url: "/hardcoded/path"
```

### 2. Organize Resources
```yaml
resources:
  - id: "domain-review"
    name: "Domain Review Document"
    description: "Current domain state and architecture"
    type: "text"
    url: "${APP_DATA_ROOT}/profiles/domain/review.md"
  
  - id: "domain-policy"
    name: "Domain Policy Document"
    description: "Domain policies and procedures"
    type: "text"
    url: "${APP_DATA_ROOT}/profiles/domain/policy.md"
```

### 3. Use Descriptive Names
```yaml
# Good
id: "security-sam-persona"
name: "Security Sam"
description: "AI assistant specializing in security domain"

# Avoid
id: "persona1"
name: "Assistant"
description: "AI assistant"
```

### 4. Include Comprehensive Features
```yaml
features: |
  # Your Capabilities and Guidelines
  
  You have access to tools that you can call via the tool interface.
  
  ## Domain Tool Usage Principles:
  1. **Always use tool results**: Present relevant information directly
  2. **Be efficient**: Summarize key information and provide details when relevant
  3. **Be specific**: Extract and present data clearly from tool results
  4. **Handle errors gracefully**: Explain failures and suggest alternatives
  5. **Don't repeat requests**: Don't ask for information you already have
  
  ## Domain Response Guidelines:
  - Present service information directly rather than asking for it again
  - Use markdown formatting for better readability
  - Include relevant IDs, names, and metadata when available
```

## Troubleshooting

### Common Issues

#### 1. Import Errors
```typescript
// If you get import errors, use local interfaces
interface IAIPersona {
  id: string;
  name: string;
  // ... other properties
}
```

#### 2. Environment Variable Not Found
```yaml
# Check that environment variables are set
apiKey: "${GOOGLE_AI_STUDIO_API_KEY}"  # Will fail if not set

# Use defaults for optional variables
modelId: "${GOOGLE_AI_STUDIO_MODEL_ID:-gemini-2.5-pro}"
```

#### 3. Validation Errors
```typescript
// Check validation results
const result = validatePersonaConfig(config);
if (!result.isValid) {
  console.error('Validation errors:', result.errors);
}
```

#### 4. Tool/Macro Not Found
```typescript
// Register missing tools/macros
personaLoader.registerTool('myTool', toolDefinition);
personaLoader.registerMacro('myMacro', macroDefinition);
```

### Debug Mode

Enable debug logging:

```typescript
const persona = loadPersonaFromFile('./persona.yaml', {
  validateOnLoad: true,
  processEnvironmentVars: true
});
```

## Examples

See `persona-usage-example.ts` for comprehensive examples covering:

1. Loading personas from files
2. Loading personas from strings
3. Loading multiple personas from directories
4. Creating new personas from YAML
5. Saving personas to YAML
6. Advanced merging scenarios
7. Role capabilities management
8. Configuration validation

## API Reference

### Interfaces

#### IAIPersona
```typescript
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
```

#### IAIPersonaResource
```typescript
interface IAIPersonaResource {
  id: string;
  name: string;
  description?: string;
  type: string;
  url?: string;
  created: Date;
}
```

#### IAIPersonaConfig
```typescript
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
```

## Contributing

1. Follow the existing code style
2. Add comprehensive tests for new features
3. Update documentation for API changes
4. Ensure all examples work correctly

## License

This project is part of the Reactory framework and follows the same licensing terms.
