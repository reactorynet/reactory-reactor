import * as lodash from 'lodash';
import { IAIPersonaResource } from '@reactory/server-modules/reactory-reactor/types/service.types';

/**
 * Shared system-prompt assembly helpers.
 *
 * TypeScript personas (see `ai/persona/<name>/index.ts`) each define a local
 * `buildSystemPrompt()` that concatenates `persona.md` + `features.md` and renders
 * the result with lodash templating, supplying a small, well-known set of variables
 * (`date`, `toolDescriptions`, `resourceDescription`, `userRole`,
 * `roleSpecificCapabilities`, `availableTools`).
 *
 * YAML personas declare the exact same intent by writing:
 *
 * ```yaml
 * prompts:
 *   system:
 *     content: "${buildSystemPrompt()}"
 *     role: "system"
 * ```
 *
 * This module provides the single implementation both worlds resolve to, so a YAML
 * agent's system prompt is materialised at load time instead of being handed to the
 * model as the literal string `${buildSystemPrompt()}`.
 *
 * @since 1.0.0
 */

/** Variables made available to persona / features templates. */
export interface SystemPromptTemplateData {
  date: string;
  userRole: string;
  roleSpecificCapabilities: string;
  toolDescriptions: string;
  resourceDescription: string;
  /** Alias of `resourceDescription` — both spellings appear in existing personas. */
  resourceDescriptions: string;
  availableTools: number;
  tools: any[];
  resources: IAIPersonaResource[];
  [key: string]: any;
}

/** Inputs required to assemble a system prompt for a persona. */
export interface SystemPromptBuildArgs {
  /** The persona (identity / background) markdown. */
  persona?: string;
  /** The features (capabilities / guidelines) markdown. */
  features?: string;
  /** Resolved tool definitions available to the persona. */
  tools?: any[];
  /** Resources declared by the persona. */
  resources?: IAIPersonaResource[];
  /** Role → capability description map, as declared in `roleCapabilities`. */
  roleCapabilities?: Record<string, string>;
  /** The roles to resolve capabilities for. Defaults to `['USER']`. */
  userRoles?: string[];
  /** Additional template variables, merged over the defaults. */
  extra?: Record<string, any>;
  /** Optional warning sink — used to surface template failures to the service log. */
  onWarning?: (message: string) => void;
}

/**
 * Renders a `- **name**: description` bullet list for the supplied tools.
 */
export const buildToolDescriptions = (tools: any[] = []): string => {
  return (tools || [])
    .map((tool) => {
      const name = tool?.function?.name || tool?.name || 'Unknown';
      const description =
        tool?.function?.description || tool?.description || 'No description available';
      return `- **${name}**: ${description}`;
    })
    .join('\n');
};

/**
 * Renders a `- **name**: description - url` bullet list for the supplied resources.
 */
export const buildResourceDescriptions = (resources: IAIPersonaResource[] = []): string => {
  return (resources || [])
    .map((resource) => {
      const name = resource?.name || 'Unknown';
      const description = resource?.description || 'No description available';
      const url = resource?.url || 'No URL available';
      return `- **${name}**: ${description} - ${url}`;
    })
    .join('\n');
};

/**
 * Fallback capability blurbs used when a persona declares no `roleCapabilities`
 * (or declares none matching the resolving roles). Mirrors the wording the
 * TypeScript personas use in their local `getRoleCapabilities` helpers.
 */
export const DEFAULT_ROLE_CAPABILITIES: Record<string, string> = {
  ADMIN:
    'You have administrative access to all Reactor module functions and can perform advanced ' +
    'operations including code generation, system configuration, and debugging.',
  DEVELOPER:
    'You have developer access to Reactor technical functions, code analysis tools, and development resources.',
  ENGINEER:
    'You have engineering access to Reactor technical functions, code analysis tools, and development resources.',
  USER:
    'You have standard user access to approved Reactor functions and can help with common development tasks.',
  default:
    'You have basic access to core Reactor functions and can assist with general development inquiries.',
};

/**
 * Resolves the capability blurb for the supplied roles from a `roleCapabilities` map.
 * The first matching role wins; falls back to the map's `default` entry and then to
 * {@link DEFAULT_ROLE_CAPABILITIES}.
 */
export const getRoleCapabilities = (
  roleCapabilities: Record<string, string> = {},
  userRoles: string[] = ['USER'],
): string => {
  const lookup = (capabilities: Record<string, string>): string | undefined => {
    for (const role of userRoles || []) {
      if (!role) continue;
      const match =
        capabilities[role] ||
        capabilities[role.toUpperCase()] ||
        capabilities[role.toLowerCase()];
      if (match) return match;
    }
    return capabilities.default || capabilities.DEFAULT;
  };

  return lookup(roleCapabilities || {}) || lookup(DEFAULT_ROLE_CAPABILITIES) || '';
};

/**
 * Builds the variable bag handed to the persona / features templates.
 */
export const buildTemplateData = (args: SystemPromptBuildArgs): SystemPromptTemplateData => {
  const tools = args.tools || [];
  const resources = args.resources || [];
  const userRoles = args.userRoles?.length ? args.userRoles : ['USER'];
  const resourceDescription = buildResourceDescriptions(resources);

  return {
    date: new Date().toISOString(),
    userRole: userRoles.join(', '),
    roleSpecificCapabilities: getRoleCapabilities(args.roleCapabilities, userRoles),
    toolDescriptions: buildToolDescriptions(tools),
    resourceDescription,
    resourceDescriptions: resourceDescription,
    availableTools: tools.length,
    tools,
    resources,
    ...(args.extra || {}),
  };
};

/**
 * Renders persona markdown with lodash templating, degrading gracefully.
 *
 * Persona markdown legitimately contains literal `${...}` fragments (workflow syntax
 * examples, shell snippets, code blocks) which lodash's default ES delimiter would try
 * to compile — throwing at compile time for expressions it cannot parse and at render
 * time (`ReferenceError`) for identifiers that are not supplied. We therefore attempt
 * three passes, in decreasing capability:
 *
 * 1. lodash defaults — supports both `<%= %>` and `${}` (what most personas expect).
 * 2. `<%= %>` only — the ES delimiter is disabled, leaving `${...}` literals intact.
 * 3. Raw text — nothing is interpolated, but the prompt is never lost.
 */
export const renderPromptTemplate = (
  text: string,
  data: Record<string, any>,
  onWarning?: (message: string) => void,
): string => {
  if (!text) return '';

  try {
    return lodash.template(text)(data);
  } catch (esError) {
    try {
      const rendered = lodash.template(text, { interpolate: /<%=([\s\S]+?)%>/g })(data);
      onWarning?.(
        `Prompt template contains literal \${...} syntax that could not be interpolated ` +
        `(${(esError as Error)?.message || esError}); rendered with the <%= %> delimiter only.`,
      );
      return rendered;
    } catch (classicError) {
      onWarning?.(
        `Prompt template could not be rendered (${(classicError as Error)?.message || classicError}); ` +
        `using the raw content.`,
      );
      return text;
    }
  }
};

/**
 * Assembles a persona's system prompt from its `persona` and `features` content,
 * mirroring the `buildSystemPrompt()` helper implemented by the TypeScript personas.
 */
export const buildSystemPrompt = (args: SystemPromptBuildArgs): string => {
  const parts = [args.persona, args.features].filter(
    (part) => typeof part === 'string' && part.trim().length > 0,
  );
  return renderPromptTemplate(parts.join('\n\n'), buildTemplateData(args), args.onWarning);
};

/**
 * A directive is a zero-argument function call embedded in YAML prompt content —
 * e.g. `${buildSystemPrompt()}` — that the loader resolves at load time.
 */
export type PromptDirectiveResolver = (args: SystemPromptBuildArgs) => string;

/**
 * The directives a YAML persona may use inside `prompts.<key>.content` (or inside any
 * file listed in `prompts.<key>.files`). Unknown `${something()}` tokens are left
 * untouched so that documented code samples survive.
 */
export const PROMPT_DIRECTIVES: Record<string, PromptDirectiveResolver> = {
  /** The full persona + features system prompt. */
  buildSystemPrompt: (args) => buildSystemPrompt(args),
  /** Alias of `buildSystemPrompt` — both names are accepted. */
  buildSystemContent: (args) => buildSystemPrompt(args),
  /** Just the persona (identity) block, rendered. */
  personaContent: (args) =>
    renderPromptTemplate(args.persona || '', buildTemplateData(args), args.onWarning),
  /** Just the features (capabilities) block, rendered. */
  featuresContent: (args) =>
    renderPromptTemplate(args.features || '', buildTemplateData(args), args.onWarning),
  /** The tool bullet list. */
  toolDescriptions: (args) => buildToolDescriptions(args.tools),
  /** The resource bullet list. */
  resourceDescriptions: (args) => buildResourceDescriptions(args.resources),
  /** The capability blurb for the resolving roles. */
  roleCapabilities: (args) => getRoleCapabilities(args.roleCapabilities, args.userRoles),
};

const DIRECTIVE_PATTERN = /\$\{\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(\s*\)\s*\}/g;

/**
 * Replaces every known `${directive()}` token in `content` with its resolved value.
 *
 * Note: the replacer is a function, so `$&`-style sequences occurring inside generated
 * prompt text are inserted verbatim rather than being treated as replacement patterns.
 *
 * @param content The raw prompt content (inline or assembled from files).
 * @param args    The persona elements the directives draw on.
 * @returns The content with all recognised directives resolved.
 */
export const resolvePromptDirectives = (
  content: string,
  args: SystemPromptBuildArgs,
): string => {
  if (!content || content.indexOf('${') === -1) return content;

  return content.replace(DIRECTIVE_PATTERN, (match, directiveName: string) => {
    const resolver = PROMPT_DIRECTIVES[directiveName];
    if (!resolver) return match;
    try {
      return resolver(args) ?? '';
    } catch (error) {
      args.onWarning?.(
        `Prompt directive "${directiveName}()" failed to resolve: ${(error as Error)?.message || error}`,
      );
      return match;
    }
  });
};

/**
 * True when the content still references a directive the loader knows how to resolve.
 * Useful as a guard for callers that consume persona prompts directly.
 */
export const hasUnresolvedPromptDirectives = (content?: string): boolean => {
  if (!content) return false;
  DIRECTIVE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DIRECTIVE_PATTERN.exec(content)) !== null) {
    if (PROMPT_DIRECTIVES[match[1]]) {
      DIRECTIVE_PATTERN.lastIndex = 0;
      return true;
    }
  }
  return false;
};

export default {
  DEFAULT_ROLE_CAPABILITIES,
  buildSystemPrompt,
  buildTemplateData,
  buildToolDescriptions,
  buildResourceDescriptions,
  getRoleCapabilities,
  renderPromptTemplate,
  resolvePromptDirectives,
  hasUnresolvedPromptDirectives,
  PROMPT_DIRECTIVES,
};
