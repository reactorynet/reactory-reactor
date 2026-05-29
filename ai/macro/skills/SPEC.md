# Reactor Skills System — Specification

## Overview

A **skill** is a markdown instruction file that teaches the Reactor AI agent how to perform a specific, well-defined task within the Reactory platform. Skills are discovered at runtime via a searchable catalog, and their content is loaded on demand so the agent can follow the instructions without prior training.

Skills are modular: any Reactory server module can contribute skills to the catalog by declaring them in the `reactor.skills` array of its `IReactoryModule` definition. The Reactor module aggregates all contributed skills at startup.

---

## Skill Definition (`ISkillDefinition`)

Each skill is described by the following structure (TypeScript interface defined in `chat.ts`):

```ts
interface ISkillDefinition {
  id: string;           // Unique FQN, e.g. "reactory-kb.createArticle@1.0.0"
  name: string;         // Human-readable name, e.g. "createArticle"
  description: string;  // One-paragraph summary used for catalog search
  namespace: string;    // Owning module namespace, e.g. "reactory-kb"
  version: string;      // Semver string, e.g. "1.0.0"
  filePath: string;     // Absolute path to the skill Markdown file on disk
  tags?: string[];      // Categorisation, e.g. ["knowledge-base", "content", "crud"]
  roles?: string[];     // Required user roles, e.g. ["ADMIN", "DEVELOPER"]
  parameters?: Schema;  // Optional JSON Schema describing skill input parameters
  examples?: string[];  // Optional example invocation strings shown in search results
}
```

### `id` convention

`{namespace}.{name}@{version}` — must be unique across all loaded modules.

### `filePath` convention

The path **must be absolute** or resolvable via `require.resolve()`. Modules should use:

```ts
filePath: require.resolve('./skills/createArticle.md')
```

---

## Skill File Format

A skill file is a plain Markdown document. There is no required schema, but the following structure is recommended for best agent comprehension:

```markdown
# Skill Name

## Purpose
One-paragraph description of what the skill does and when to use it.

## Prerequisites
- Required services, roles, data, or context.

## Parameters
| Name        | Type   | Required | Description          |
|-------------|--------|----------|----------------------|
| articleId   | string | yes      | The article ID       |

## Steps
1. Step one description...
2. Step two description...

## Examples
\`\`\`
@searchSkills(query: "knowledge base")
\`\`\`

## Notes
Any caveats or edge cases.
```

---

## Module Integration

To contribute skills from a module, add a `skills` array to the module's `reactor` property:

```ts
// src/modules/my-module/index.ts
import { MyModuleSkills } from './skills';

const MyModule: IReactorModule = {
  id: 'my-module',
  // ...
  reactor: {
    macros: [],
    skills: MyModuleSkills,  // ISkillDefinition[]
  },
};
```

Where `MyModuleSkills` is an array of `ISkillDefinition` objects:

```ts
// src/modules/my-module/skills/index.ts
import { ISkillDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

export const MyModuleSkills: ISkillDefinition[] = [
  {
    id: 'my-module.doSomething@1.0.0',
    name: 'doSomething',
    description: 'Performs a specific task in My Module. Use this skill when...',
    namespace: 'my-module',
    version: '1.0.0',
    filePath: require.resolve('./doSomething.md'),
    tags: ['my-module', 'task'],
    roles: ['DEVELOPER'],
  },
];
```

---

## Discovery and Usage

### Step 1: Search the catalog

The agent uses the `searchSkills` macro to find relevant skills:

```
@searchSkills(query: "create knowledge base article", tags: ["knowledge-base"])
```

The macro returns a list of matching `ISkillDefinition` objects (without file content).

### Step 2: Read the skill instructions

Once the agent identifies the relevant skill, it reads the file content using the `readSkill` macro:

```
@readSkill(id: "reactory-kb.createArticle@1.0.0")
```

This returns the full Markdown content of the skill file.

### Step 3: Execute

The agent follows the instructions in the skill file to complete the requested task.

---

## Catalog Aggregation

The `searchSkills` macro builds the catalog lazily on first call by:

1. Iterating all loaded modules via `ReactoryModules`.
2. For each module that satisfies `IReactorModule` (has a `reactor.skills` array), collecting the skill definitions.
3. Deduplicating by `id` (last writer wins for duplicate IDs across modules).

The catalog is a flat `Map<string, ISkillDefinition>` keyed by `id`.

---

## Macros

| Macro          | Description                                                        |
|----------------|--------------------------------------------------------------------|
| `searchSkills` | Search the aggregated skill catalog by query, tags, or namespace   |
| `readSkill`    | Read the full Markdown content of a skill file by ID or name       |

---

## Future Considerations

- **Skill versioning**: Support multiple versions of the same skill simultaneously.
- **Skill chaining**: Allow skills to declare dependencies on other skills.
- **Skill validation**: Validate skill file existence and format at module load time.
- **Skill caching**: Cache catalog builds across requests with invalidation on module reload.
- **Skill permissions**: Enforce `roles` check before returning a skill in search results.
