import { ingest } from "@reactory/server-core/utils/io"
import path from "path";
import appearance from './appearance';
import { IAIPersona, IAIPersonaResource } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { FeatureType } from "@reactory/reactory-core";
import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/macro";
import { MacroComponentDefinition, MacroToolDefinition } from "../../openai/types/chat";
import * as lodash from "lodash";

const REACTOR_PERSONA_TEXT = ingest(require.resolve('./persona.md'));
const REACTOR_FEATURES_TEXT = ingest(require.resolve('./features.md'));

const REACTOR_TOOL_INCLUDES = [
  'readFile',
  'writeFile',
  'http',
  'httpPost',
  'httpGet',
  'httpPut',
  'httpDelete',
  'httpPatch',
  'listDirectory',
  'shell',
  'codebase_search',
  'grep_search',
  'file_search',
  'run_terminal_cmd',
  'edit_file',
  'search_replace',
  'delete_file',
  'list_dir'
];

const REACTOR_RESOURCES: IAIPersonaResource[] = [
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

const REACTOR_MACROS: MacroComponentDefinition<any>[] = [];

// Process macros from the registry
MacroRegistry.forEach(m => {
  if (m.tools) {
    m.tools.forEach(t => {
      if (t.type === "function" && REACTOR_TOOL_INCLUDES.includes(t.function?.name)) {
        if (!t.roles || t.roles.length === 0) t.roles = m.roles || [];
      }
    });
  }
});

// Add the macro tools to the tools array
MacroRegistry.forEach(m => {
  const macro = {
    ...m,
    runat: m.runat ?? "server",
  };
  REACTOR_MACROS.push(macro);
});

REACTOR_MACROS.forEach(m => { delete m.component; });

let REACTOR_TOOLS: any[] = [];


try { 
  REACTOR_TOOLS = REACTOR_MACROS.map(m => m.tools).flat().filter(t => { 
    if (t.type === "function") {
      return true;
    }

    return false;
  });
} catch (error) {
  console.error('Error processing macros:', error);
}

// Helper function to get role-specific capabilities
const getRoleCapabilities = (userRoles: string[]): string => {
  if (userRoles.includes('ADMIN')) {
    return 'You have administrative access to all Reactor module functions and can perform advanced operations including code generation, system configuration, and debugging.';
  } else if (userRoles.includes('DEVELOPER')) {
    return 'You have developer access to Reactor technical functions, code analysis tools, and development resources.';
  } else if (userRoles.includes('USER')) {
    return 'You have standard user access to approved Reactor functions and can help with common development tasks.';
  }
  return 'You have basic access to core Reactor functions and can assist with general development inquiries.';
};

// Helper function to build tool descriptions
const buildToolDescriptions = (tools: any[]): string => {
  return tools.map(tool => {
    const name = tool.function?.name || tool.name || 'Unknown';
    const description = tool.function?.description || tool.description || 'No description available';
    return `- **${name}**: ${description}`;
  }).join('\n');
};

const buildResourceDescriptions = (resources: any[]): string => {
  return resources.map(resource => {
    const name = resource.name || 'Unknown';
    const description = resource.description || 'No description available';
    const url = resource.url || 'No URL available';
    return `- **${name}**: ${description} - ${url}`;
  }).join('\n');
};

// Enhanced system prompt builder
const buildSystemPrompt = (userRoles: string[] = ['USER'], availableTools: any[] = REACTOR_TOOLS) => {
  const toolDescriptions = buildToolDescriptions(availableTools);
  const roleCapabilities = getRoleCapabilities(userRoles);
  const resourceDescription = buildResourceDescriptions(REACTOR_RESOURCES);
  
  return lodash.template(REACTOR_PERSONA_TEXT + '\n\n' + REACTOR_FEATURES_TEXT)({
    date: new Date().toISOString(),
    toolDescriptions,
    resourceDescription,
    userRole: userRoles.join(', '),
    roleSpecificCapabilities: roleCapabilities
  });
};

const systemPrompt = buildSystemPrompt();

export const ReactoryPersona: IAIPersona = {
  id: "ReactorAIPersona",
  name: "Reactor",
  description: "Reactor AI Persona - Enhanced with improved tool handling and context management for Reactory and Reactor modules",
  persona: REACTOR_PERSONA_TEXT,
  features: REACTOR_FEATURES_TEXT,
  appearance,
  modelId: process.env.GOOGLE_AI_STUDIO_MODEL_ID || "gemini-2.5-pro",
  providerId: "google",  
  defaultGreeting: "Hello, I am Reactor, your intelligent AI assistant specializing in Reactory and Reactor modules. I can help you with code generation, debugging, documentation, and development tasks. How may I assist you today?",
  prompts: {
    system: {
      content: systemPrompt,
      role: "system",
    },
  },
  config: {
    apiKey: process.env.GOOGLE_AI_STUDIO_API_KEY,
    apiBaseURL: process.env.GOOGLE_AI_API_URL, 
    project: process.env.GOOGLE_AI_STUDIO_PROJECT_ID,
  },
  tools: [...REACTOR_TOOLS],
  // @ts-ignore
  macros: [
    ...REACTOR_MACROS
  ],
  resources: [...REACTOR_RESOURCES],
}

export const ReactoryPersonaComponentRegistryEntry: Reactory.IReactoryComponentDefinition<IAIPersona> = {
  nameSpace: "reactor",
  name: "ReactoryAIPersona",
  description: `Reactor AI Persona. Domain-specific AI Assistant focused on Reactory and Reactor modules.
  This persona is designed to assist users with Reactory and Reactor development tasks, including but not limited to:
  - Code generation and analysis for Reactory and Reactor modules
  - Debugging and troubleshooting Reactory and Reactor applications
  - Documentation generation and maintenance for Reactory and Reactor projects
  - Development workflow optimization and best practices
  - Module integration and configuration assistance
  - Testing and quality assurance for Reactory and Reactor code
  - Performance optimization and code review
  - Providing insights into Reactory and Reactor architecture and patterns`,
  version: "1.0.0",
  component: ReactoryPersona,
  features: [
    { 
      feature: "appearance",
      description: "Reactor AI Persona Appearance",
      featureType: FeatureType.object,
      action: ["get"],
      stem: "appearance",
    },
    {
      feature: "persona",
      description: "Reactor AI Persona",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "persona",
    },
    {
      feature: "features",
      description: "Reactor AI Persona Features",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "features",
    }
  ]
}

// Export the enhanced prompt builder for dynamic use
export { buildSystemPrompt, getRoleCapabilities, buildToolDescriptions };

export default ReactoryPersonaComponentRegistryEntry;