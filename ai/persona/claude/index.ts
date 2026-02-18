import { ingest } from "@reactory/server-core/utils/io"
import path from "path";
import appearance from './appearance';
import { IAIPersona, IAIPersonaResource } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { FeatureType } from "@reactorynet/reactory-core";
import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/macro";
import { MacroComponentDefinition, MacroToolDefinition } from "../../openai/types/chat";
import * as lodash from "lodash";

const CLAUDE_PERSONA_TEXT = ingest(require.resolve('./persona.md'));
const CLAUDE_FEATURES_TEXT = ingest(require.resolve('./features.md'));

// Include ALL available tools from the MacroRegistry - Claude has full access
const CLAUDE_TOOL_INCLUDES = [
  // File System
  'readFile',
  'writeFile',
  'listDirectory',
  'pathInfo',
  'snip',
  'insertText',
  'mkdir',
  'rmdir',
  'createModuleStructure',
  // Web / HTTP
  'http',
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'fetch',
  // GraphQL
  'queryGQL',
  'mutationGQL',
  'schemaGQL',
  // Shell
  'shell',
  // User Management
  'getUser',
  'createUser',
  // Workflow
  'svc',
  // Chats
  'chats',
  // MCP
  'mcp',
  // Projects
  'createProject',
  'getProject',
  'updateProject',
  'deleteProject',
  'listProjects',
  'getProjectMetrics',
  'getProjectDocumentation',
  'catalogProject',
  // Data
  'mongo',
  'postgres',
  'mysql',
  'mssql',
  'searchContent',
  'indexContent',
  'deleteIndex',
  // Runtime
  'modules',
  'env',
  'addMacro',
  'var',
  'sliceVariable',
  'datetime',
  'state',
  // Development
  'CodeReviewFile',
  'CodeReview',
  'clone',
  'pull',
  'push',
  'commit',
  'status',
  'checkout',
  'add',
  // Email
  'sendEmail',
];

const CLAUDE_RESOURCES: IAIPersonaResource[] = [
  {
    id: 'reactory-home-folder',
    name: 'Reactory Home Folder',
    description: 'The home folder for the Reactory application.',
    type: 'directory',
    url: path.join(process.env.REACTORY_HOME || process.cwd(), '/'),
    created: new Date(),
  },
  {
    id: 'reactory-data-folder',
    name: 'Reactory Data Folder',
    description: 'The folder containing the Reactory data.',
    type: 'directory',
    url: path.join(process.env.REACTORY_HOME || process.cwd(), '/reactory-data/'),
    created: new Date(),
  },
  {
    id: 'reactory-express-server',
    name: 'Reactory Express Server',
    description: 'The Express server for the Reactory application.',
    type: 'directory',
    url: path.join(process.env.REACTORY_HOME || process.cwd(), '/reactory-express-server/'),
    created: new Date(),
  },
  {
    id: 'reactory-pwa-application',
    name: 'Reactory PWA Application',
    description: 'The PWA application for the Reactory application.',
    type: 'directory',
    url: path.join(process.env.REACTORY_HOME || process.cwd(), '/reactory-pwa-client/'),
    created: new Date(),
  },
  {
    id: "reactor-core-documentation",
    name: "Reactor Core Documentation",
    description: `The core documentation for the Reactory platform.
    Review this documentation to understand the current state of the Reactory platform.`,
    type: "text",
    url: path.join(process.env.REACTORY_HOME || process.cwd(), '/reactory-docs/'),
    created: new Date(),
  },
  {
    id: "reactory-server-modules",
    name: "Reactory Server Modules",
    description: `The source code for the Reactory server modules.
    Review this source code to understand the implementation of the Reactory server modules.`,
    type: "directory",
    url: path.join(process.env.REACTORY_HOME || process.cwd(), '/reactory-express-server/src/modules/'),
    created: new Date(),
  },
  {
    id: "reactory-translation-files",
    name: "Reactory Translation Files",
    description: `The translation files for the Reactory platform.
    Review this translation files to understand the implementation of the Reactory platform.`,
    type: "directory",
    url: path.join(process.env.REACTORY_HOME || process.cwd(), '/reactory-data/i18n/'),
    created: new Date(),
  },
  {
    id: "reactory-express-server-code",
    name: "Reactory Express Server Source Code",
    description: `The source code for the Reactory Express server.
    Review this source code to understand the implementation of the Reactory Express server.`,
    type: "directory",
    url: path.join(process.env.REACTORY_HOME || process.cwd(), '/reactory-express-server/src/'),
    created: new Date(),
  },
];

const CLAUDE_MACROS: MacroComponentDefinition<any>[] = [];

// Process macros from the registry - include all tools matching CLAUDE_TOOL_INCLUDES
MacroRegistry.forEach(m => {
  if (m.tools) {
    m.tools.forEach(t => {
      if (t.type === "function" && CLAUDE_TOOL_INCLUDES.includes(t.function?.name)) {
        if (!t.roles || t.roles.length === 0) t.roles = m.roles || [];
      }
    });
  }
});

// Add macros to the persona
MacroRegistry.forEach(m => {
  const macro = {
    ...m,
    runat: m.runat ?? "server",
  };
  CLAUDE_MACROS.push(macro);
});

CLAUDE_MACROS.forEach(m => { delete m.component; });

let CLAUDE_TOOLS: MacroToolDefinition[] = [];

try {
  CLAUDE_TOOLS = CLAUDE_MACROS
    .map(m => m.tools)
    .flat()
    .filter(t => t?.type === "function" && CLAUDE_TOOL_INCLUDES.includes(t.function?.name));
} catch (error) {
  console.error('Error processing Claude persona macros:', error);
}

// Helper function to get role-specific capabilities
const getRoleCapabilities = (userRoles: string[]): string => {
  if (userRoles.includes('ADMIN')) {
    return 'You have administrative access to all platform functions and can perform advanced operations including code generation, system configuration, database management, and debugging.';
  } else if (userRoles.includes('DEVELOPER')) {
    return 'You have developer access to technical functions, code analysis tools, and development resources.';
  } else if (userRoles.includes('USER')) {
    return 'You have standard user access to approved functions and can help with common development tasks.';
  }
  return 'You have basic access to core functions and can assist with general development inquiries.';
};

// Helper function to build tool descriptions
const buildToolDescriptions = (tools: MacroToolDefinition[]): string => {
  return tools.map(tool => {
    const name = tool.function?.name || 'Unknown';
    const description = tool.function?.description || 'No description available';
    return `- **${name}**: ${description}`;
  }).join('\n');
};

const buildResourceDescriptions = (resources: IAIPersonaResource[]): string => {
  return resources.map(resource => {
    const name = resource.name || 'Unknown';
    const description = resource.description || 'No description available';
    const url = resource.url || 'No URL available';
    return `- **${name}**: ${description} - ${url}`;
  }).join('\n');
};

// System prompt builder
const buildSystemPrompt = (userRoles: string[] = ['USER'], availableTools: MacroToolDefinition[] = CLAUDE_TOOLS) => {
  const toolDescriptions = buildToolDescriptions(availableTools);
  const roleCapabilities = getRoleCapabilities(userRoles);
  const resourceDescription = buildResourceDescriptions(CLAUDE_RESOURCES);

  return lodash.template(CLAUDE_PERSONA_TEXT + '\n\n' + CLAUDE_FEATURES_TEXT)({
    date: new Date().toISOString(),
    toolDescriptions,
    resourceDescription,
    userRole: userRoles.join(', '),
    roleSpecificCapabilities: roleCapabilities,
  });
};

const systemPrompt = buildSystemPrompt();

export const ClaudePersona: IAIPersona = {
  id: "ClaudeAIPersona",
  name: "Claude",
  description: "Claude AI Persona - Anthropic's Claude model integrated into Reactory with full tool access for development, data, and platform management tasks",
  persona: CLAUDE_PERSONA_TEXT,
  features: CLAUDE_FEATURES_TEXT,
  appearance,
  modelId: process.env.ANTHROPIC_MODEL_ID || "claude-sonnet-4-5-20250929",
  providerId: "anthropic",
  defaultGreeting: "Hello, I'm Claude, your AI development partner on the Reactory platform. I can help you with code generation, debugging, architecture review, data operations, and more. What would you like to work on?",
  prompts: {
    system: {
      content: systemPrompt,
      role: "system",
    },
  },
  config: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  tools: [...CLAUDE_TOOLS],
  // @ts-ignore
  macros: [
    ...CLAUDE_MACROS,
  ],
  resources: [...CLAUDE_RESOURCES],
};

export const ClaudePersonaComponentRegistryEntry: Reactory.IReactoryComponentDefinition<IAIPersona> = {
  nameSpace: "reactor",
  name: "ClaudeAIPersona",
  description: `Claude AI Persona. Anthropic's Claude model integrated into the Reactory platform.
  This persona is designed to assist users with a full range of development and platform tasks, including:
  - Code generation, analysis, and review for Reactory modules
  - Debugging and troubleshooting applications
  - Architecture design and improvement recommendations
  - Database operations and data management (MongoDB, PostgreSQL, MySQL, MSSQL)
  - API interactions (REST, GraphQL)
  - Git operations and development workflows
  - Project management and documentation
  - Shell command execution and environment management
  - Full-text search and content indexing`,
  version: "1.0.0",
  component: ClaudePersona,
  features: [
    {
      feature: "appearance",
      description: "Claude AI Persona Appearance",
      featureType: FeatureType.object,
      action: ["get"],
      stem: "appearance",
    },
    {
      feature: "persona",
      description: "Claude AI Persona",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "persona",
    },
    {
      feature: "features",
      description: "Claude AI Persona Features",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "features",
    },
  ],
};

// Export the prompt builder for dynamic use
export { buildSystemPrompt, getRoleCapabilities, buildToolDescriptions };

export default ClaudePersonaComponentRegistryEntry;
