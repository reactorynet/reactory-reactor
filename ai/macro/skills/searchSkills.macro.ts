import Reactory from "@reactorynet/reactory-core";
import {
  ChatState,
  IReactorModule,
  ISkillDefinition,
  Macro,
  MacroComponentDefinition,
} from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import ReactoryModules from "@reactory/server-core/modules";

export interface SearchSkillsProps {
  /** Free-text query matched against skill name, description, and tags */
  query?: string;
  /** Filter by one or more tags (OR logic) */
  tags?: string[];
  /** Filter by owning module nameSpace */
  nameSpace?: string;
  /** Maximum number of results to return (default: 20) */
  limit?: number;
}

export interface SearchSkillsResult {
  success: boolean;
  skills?: Array<Omit<ISkillDefinition, "filePath">>;
  total?: number;
  error?: string;
  hint?: string;
}

/**
 * Builds a flat skill catalog from all active modules that declare `reactor.skills`.
 * Deduplication is by skill `id`; last writer wins for duplicate IDs.
 */
function buildCatalog(): Map<string, ISkillDefinition> {
  const catalog = new Map<string, ISkillDefinition>();
  const modules = ReactoryModules.enabled as Reactory.Server.IReactoryModule[];

  for (const mod of modules) {
    const reactorMod = mod as IReactorModule;
    if (!reactorMod.reactor?.skills?.length) continue;
    for (const skill of reactorMod.reactor.skills) {
      catalog.set(skill.id, skill);
    }
  }

  return catalog;
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

export const searchSkills: Macro<SearchSkillsResult, SearchSkillsProps> = async (
  props: SearchSkillsProps,
  state: ChatState,
  context?: Reactory.Server.IReactoryContext
): Promise<SearchSkillsResult> => {
  const { query, tags, nameSpace, limit = 20 } = props;

  try {
    const catalog = buildCatalog();

    if (catalog.size === 0) {
      return {
        success: true,
        skills: [],
        total: 0,
        hint: "No skills are registered. Modules contribute skills via their reactor.skills array.",
      };
    }

    const queryLower = query?.toLowerCase().trim();
    const tagSet = tags?.length ? new Set(tags.map((t) => t.toLowerCase())) : null;
    const nameSpaceLower = nameSpace?.toLowerCase().trim();

    let results: ISkillDefinition[] = [];

    for (const skill of catalog.values()) {
      if (!canAccessSkill(skill, state, context)) continue;

      if (nameSpaceLower && skill.nameSpace.toLowerCase() !== nameSpaceLower) continue;

      if (tagSet) {
        const skillTagsLower = (skill.tags ?? []).map((t) => t.toLowerCase());
        const hasMatch = skillTagsLower.some((t) => tagSet.has(t));
        if (!hasMatch) continue;
      }

      if (queryLower) {
        const searchable = [
          skill.name,
          skill.description,
          ...(skill.tags ?? []),
          skill.nameSpace,
        ]
          .join(" ")
          .toLowerCase();
        if (!searchable.includes(queryLower)) continue;
      }

      results.push(skill);
    }

    results = results.slice(0, limit);

    return {
      success: true,
      total: results.length,
      skills: results.map(({ filePath: _omit, ...rest }) => rest),
      hint:
        results.length > 0
          ? "Use @readSkill(id) to load the full instructions for a skill before executing it."
          : "No skills matched. Try a broader query or omit the tags/namespace filters.",
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
};

export const SearchSkillsRegistry: MacroComponentDefinition<typeof searchSkills> = {
  nameSpace: "reactor-macros",
  name: "searchSkills",
  alias: "searchSkills",
  version: "1.0.0",
  component: searchSkills,
  roles: ["DEVELOPER", "ADMIN", "USER"],
  description: `# searchSkills
Searches the aggregated skill catalog contributed by all active Reactory modules.

Returns a list of matching skill definitions (without file content). Use @readSkill(id) 
to load the full Markdown instructions for a skill before executing it.

## Usage
@searchSkills(query?, tags?, nameSpace?, limit?)

## Parameters
- **query** (string, optional): Free-text search matched against name, description, and tags.
- **tags** (string[], optional): Filter to skills tagged with any of the provided values.
- **nameSpace** (string, optional): Restrict results to a specific module nameSpace.
- **limit** (number, optional): Maximum results to return. Defaults to 20.

## Example
@searchSkills(query: "knowledge base article", tags: ["crud"])
`,
  features: [
    {
      feature: "searchSkills",
      featureType: Reactory.FeatureType.function,
      action: ["search", "list", "query"],
      description: "Searches the skill catalog contributed by all active Reactory modules.",
      stem: "search",
    },
  ],
  stem: "search",
  tags: ["skills", "catalog", "search", "discovery"],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "searchSkills",
        description:
          "Search the aggregated skill catalog. Returns matching skill definitions. Use readSkill(id) to load full instructions.",
        icon: "travel_explore",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Free-text search matched against skill name, description, and tags.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Filter to skills tagged with any of the provided values (OR logic).",
            },
            nameSpace: {
              type: "string",
              description: "Restrict results to skills contributed by this module nameSpace.",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return. Defaults to 20.",
            },
          },
          required: [],
        },
      },
    },
  ],
};
