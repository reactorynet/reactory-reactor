import { existsSync, readFileSync } from "fs";
import Reactory from "@reactorynet/reactory-core";
import {
  ChatState,
  IReactorModule,
  ISkillDefinition,
  Macro,
  MacroComponentDefinition,
} from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import ReactoryModules from "@reactory/server-core/modules";

export interface ReadSkillProps {
  /** Skill FQN, e.g. "reactory-kb.createArticle@1.0.0" */
  id?: string;
  /** Skill name (resolved within an optional nameSpace) */
  name?: string;
  /** nameSpace to narrow name resolution when using the `name` param */
  nameSpace?: string;
}

export interface ReadSkillResult {
  success: boolean;
  id?: string;
  name?: string;
  nameSpace?: string;
  version?: string;
  description?: string;
  tags?: string[];
  content?: string;
  error?: string;
}

function extractUserRoles(user?: unknown): string[] {
  if (!user || typeof user !== "object") return [];

  const src = user as {
    roles?: unknown;
    activeMembership?: { roles?: unknown };
    memberships?: Array<{ roles?: unknown }>;
  };

  const userRoles = Array.isArray(src.roles) ? src.roles : [];
  const activeMembershipRoles = Array.isArray(src.activeMembership?.roles)
    ? src.activeMembership?.roles
    : [];
  const membershipsRoles = Array.isArray(src.memberships)
    ? src.memberships.flatMap((m) => (Array.isArray(m?.roles) ? m.roles : []))
    : [];

  return [...userRoles, ...activeMembershipRoles, ...membershipsRoles].filter(
    (role): role is string => typeof role === "string" && role.trim().length > 0
  );
}

function canAccessSkill(
  skill: ISkillDefinition,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): boolean {
  if (!skill.roles?.length) return true;

  const requiredRoles = skill.roles.filter((role): role is string => !!role?.trim());
  if (requiredRoles.length === 0) return true;

  const runtimeContext = context ?? state.context;

  if (runtimeContext?.hasAnyRole) {
    return runtimeContext.hasAnyRole(requiredRoles);
  }

  const userRoles = extractUserRoles(runtimeContext?.user ?? state.user);
  if (!userRoles.length) return false;

  const roleSet = new Set(userRoles.map((role) => role.toLowerCase()));
  return requiredRoles.some((role) => roleSet.has(role.toLowerCase()));
}

function findSkill(props: ReadSkillProps): ISkillDefinition | undefined {
  const modules = ReactoryModules.enabled as Reactory.Server.IReactoryModule[];

  for (const mod of modules) {
    const reactorMod = mod as IReactorModule;
    if (!reactorMod.reactor?.skills?.length) continue;

    for (const skill of reactorMod.reactor.skills) {
      if (props.id && skill.id === props.id) return skill;
      if (props.name) {
        const nameMatch = skill.name === props.name;
        const nsMatch = !props.nameSpace || skill.nameSpace === props.nameSpace;
        if (nameMatch && nsMatch) return skill;
      }
    }
  }

  return undefined;
}

export const readSkill: Macro<ReadSkillResult, ReadSkillProps> = async (
  props: ReadSkillProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<ReadSkillResult> => {
  if (!props.id && !props.name) {
    return { success: false, error: "Either id or name is required." };
  }

  const skill = findSkill(props);

  if (!skill) {
    const identifier = props.id ?? `${props.nameSpace ? props.nameSpace + "." : ""}${props.name}`;
    return {
      success: false,
      error: `Skill not found: "${identifier}". Use @searchSkills() to discover available skills.`,
    };
  }

  if (!canAccessSkill(skill, state, context)) {
    return {
      success: false,
      error: `Access denied: missing required role for skill "${skill.id}".`,
    };
  }

  if (!existsSync(skill.filePath)) {
    return {
      success: false,
      error: `Skill file not found on disk: ${skill.filePath}`,
    };
  }

  const content = readFileSync(skill.filePath, "utf-8");

  return {
    success: true,
    id: skill.id,
    name: skill.name,
    nameSpace: skill.nameSpace,
    version: skill.version,
    description: skill.description,
    tags: skill.tags,
    content,
  };
};

export const ReadSkillRegistry: MacroComponentDefinition<typeof readSkill> = {
  nameSpace: "reactor-macros",
  name: "readSkill",
  alias: "readSkill",
  version: "1.0.0",
  component: readSkill,
  roles: ["DEVELOPER", "ADMIN", "USER"],
  description: `# readSkill
Reads the full Markdown instructions for a skill from disk.

Call this after @searchSkills() to load a skill's instruction content before executing it.

## Usage
@readSkill(id)
@readSkill(name, nameSpace?)

## Parameters
- **id** (string): Skill FQN, e.g. "reactory-kb.createArticle@1.0.0".
- **name** (string): Skill name, e.g. "createArticle". Used when id is unknown.
- **nameSpace** (string, optional): Narrows name resolution to a specific module nameSpace.

## Example
@readSkill(id: "reactory-kb.createArticle@1.0.0")
`,
  features: [
    {
      feature: "readSkill",
      featureType: Reactory.FeatureType.function,
      action: ["read", "get", "load"],
      description: "Reads the Markdown instruction content of a skill by ID or name.",
      stem: "read",
    },
  ],
  stem: "read",
  tags: ["skills", "catalog", "read", "instructions"],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "readSkill",
        description:
          "Read the full Markdown instruction content of a skill. Use searchSkills first to find the skill id.",
        icon: "menu_book",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: 'Skill FQN, e.g. "reactory-kb.createArticle@1.0.0".',
            },
            name: {
              type: "string",
              description: "Skill name. Used when the full id is not known.",
            },
            nameSpace: {
              type: "string",
              description: "Narrows name resolution to a specific module nameSpace.",
            },
          },
          required: [],
        },
      },
    },
  ],
};
