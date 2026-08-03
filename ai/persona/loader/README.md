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