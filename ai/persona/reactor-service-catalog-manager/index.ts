import { ingest } from "@reactory/server-core/utils/io"
import appearance from './appearance';
import { IAIPersona } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { FeatureType } from "@reactorynet/reactory-core";
import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/macro";
import { MacroComponentDefinition, MacroToolDefinition } from "../../openai/types/chat";
import ProjectMacros from "@reactory/server-modules/reactory-reactor/ai/macro/projects";

const REACTOR_PERSONA_TEXT = ingest(require.resolve('./persona.md'));
const REACTOR_FEATURES_TEXT = ingest(require.resolve('./features.md'));

// Project-specific macros
const PROJECT_MACROS = [...ProjectMacros];

// Define tools that should be included regardless of their source
const CATALOG_TOOL_INCLUDES = [
  'readFile',
  'writeFile',
  'listDirectory',
  'http',
  'httpGet',
  'gql',
  'queryGQL',
  'mutationGQL'
];

// Extract tools from project macros
const REACTOR_TOOLS: MacroToolDefinition[] = PROJECT_MACROS
  .map(m => m.tools)
  .flat()
  .filter(t => t && t.type === "function");

// Add additional tools from the registry that match our includes list
(MacroRegistry || []).forEach(m => {
  if (m.tools) {
    m.tools.forEach(t => {
      if (t.type === "function" && 
          (CATALOG_TOOL_INCLUDES.includes(t.function?.name) || 
           t.function?.name?.toLowerCase().includes('project'))) {
        if (!t.roles || t.roles.length === 0) t.roles = m.roles || [];
        if (!REACTOR_TOOLS.some(rt => rt.function?.name === t.function?.name)) {
          REACTOR_TOOLS.push(t);
        }
      }
    });
  }
});

// Helper function to build tool descriptions
const buildToolDescriptions = (tools: any[]): string => {
  return tools.map(tool => {
    const name = tool.function?.name || tool.name || 'Unknown';
    const description = tool.function?.description || tool.description || 'No description available';
    return `- **${name}**: ${description}`;
  }).join('\n');
};

// Collect all macros
const REACTOR_MACROS: MacroComponentDefinition<any>[] = [...PROJECT_MACROS];

// Add additional macros from the registry
(MacroRegistry || []).forEach(m => {
  if (!REACTOR_MACROS.some(rm => rm.name === m.name)) {
    const macro = {
      ...m,
      runat: m.runat ?? "server",
    };
    REACTOR_MACROS.push(macro);
  }
});

// Enhanced system prompt with tool descriptions
const toolDescriptions = buildToolDescriptions(REACTOR_TOOLS);
const systemPrompt = `${REACTOR_PERSONA_TEXT}\n\n${REACTOR_FEATURES_TEXT}\n\n## Available Tools:\n${toolDescriptions}`;

export const ReactoryServiceCatalogPersona: IAIPersona = {
  id: "ReactorServiceCatalogManagerAIPersona",
  name: "Reactor Service Catalog Manager",
  description: "Reactor Service Catalog Manager. This persona is designed to assist users with managing the Reactor service catalog, including adding, updating, and retrieving service catalog items and projects.",
  persona: REACTOR_PERSONA_TEXT,
  features: REACTOR_FEATURES_TEXT,
  appearance,
  modelId: process.env.GOOGLE_AI_STUDIO_MODEL_ID || "gemini-2.5-pro",
  providerId: "google",
  defaultGreeting: "Hello, I am Reactor Service Catalog Manager. I can help you manage Reactory projects, services, and the service catalog. How may I assist you today?",
  prompts: {
    "system": { 
      content: systemPrompt,
      role: "system",
    },
  },
  config: {
    apiKey: process.env.GOOGLE_AI_STUDIO_API_KEY,
    apiBaseURL: process.env.GOOGLE_AI_API_URL, 
    project: process.env.GOOGLE_AI_STUDIO_PROJECT_ID,
  },
  tools: REACTOR_TOOLS,
  macros: REACTOR_MACROS,
}

export const ReactoryPersonaComponentRegistryEntry: Reactory.IReactoryComponentDefinition<IAIPersona> = {
  nameSpace: "reactor",
  name: "ReactoryAIPersona",
  description: `Reactor Service Catalog Manager AI Persona. Specialized AI Assistant for managing Reactory projects and services.
  This persona is designed to assist users with service catalog management tasks, including but not limited to:
  - Creating, updating, and deleting projects in the Reactory ecosystem
  - Cataloging projects and their capabilities
  - Retrieving project documentation and metrics
  - Managing service catalog items and dependencies
  - Assisting with project setup and configuration
  - Providing insights into project health and status
  - Offering recommendations for project improvements
  - Helping users navigate the Reactory project ecosystem`,
  version: "1.0.0",
  component: ReactoryServiceCatalogPersona,
  features: [
    { 
      feature: "appearance",
      description: "Reactory AI Persona Appearance",
      featureType: FeatureType.object,
      action: ["get"],
      stem: "appearance",
    },
    {
      feature: "persona",
      description: "Reactory AI Persona",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "persona",
    },
    {
      feature: "features",
      description: "Reactory AI Persona Features",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "features",
    }
  ]
}
