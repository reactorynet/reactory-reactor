import { ingest } from "@reactory/server-core/utils/io"
import path from "path";
import appearance from './appearance';
import { IAIPersona, IAIPersonaResource } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { FeatureType } from "@reactorynet/reactory-core";
import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/macro";
import { MacroComponentDefinition, MacroToolDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import NewRequestMacroDefinition from "@reactory/server-modules/zepz-engineer/ai/macros/requests/NewRequest.macro";
import ListRequestsMacroDefinition from "@reactory/server-modules/zepz-engineer/ai/macros/requests/ListRequests.macro";
import CatalogRequestsMacroDefinition from "@reactory/server-modules/zepz-engineer/ai/macros/requests/CatalogRequests.macro";
import UpdateRequestEntriesMacroDefinition from "@reactory/server-modules/zepz-engineer/ai/macros/requests/UpdateRequestEntries.macro";
import UpdateRequestEntryMacroDefinition from "@reactory/server-modules/zepz-engineer/ai/macros/requests/UpdateRequestEntry.macro";
import ListUnProcessedRequestEntriesMacroDefinition from "@reactory/server-modules/zepz-engineer/ai/macros/requests/ListUnProcessedRequestEntries.macro";
import { 
  SlackGetChannelInfoRegistry, 
  SlackReadMessagesRegistry,
  SlackListChannelsRegistry,
  SlackReadThreadRepliesRegistry 
} from "@reactory/server-modules/reactory-slack/ai/macros/SlackReaderMacros";
import * as lodash from "lodash";

const INFRASTRUCTURE_PERSONA_TEXT = ingest(require.resolve('./persona.md'));
const INFRASTRUCTURE_FEATURES_TEXT = ingest(require.resolve('./features.md'));

const INFRASTRUCTURE_MACROS = [
  { ...NewRequestMacroDefinition}, 
  { ...ListRequestsMacroDefinition},
  { ...CatalogRequestsMacroDefinition},
  { ...UpdateRequestEntriesMacroDefinition},
  { ...UpdateRequestEntryMacroDefinition},
  { ...ListUnProcessedRequestEntriesMacroDefinition},
  { ...SlackReadMessagesRegistry},
  { ...SlackGetChannelInfoRegistry },
  { ...SlackListChannelsRegistry },
  { ...SlackReadThreadRepliesRegistry }
];

const INFRATOOL_INCLUDES = [
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
]

const INFRASTRUCTURE_RESOURCES: IAIPersonaResource[] = [
  {
    id: "infrastructure-domain-review-document",
    name: "Infrastructure Domain Document",
    description: `The current domain document for the Infrastructure domain. 
    Review this document to understand the current state of the Infrastructure domain.`,
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/reviews/infrastructure-domain-review.md'),
    created: new Date(),
  },
  {
    id: "corp-it-domain-review-document",
    name: "Corp IT Domain Document",
    description: `The current domain document for the Corp IT domain. 
    Review this document to understand the current state of the Corp IT domain.`,
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/reviews/corp-it-domain-review.md'),
    created: new Date(),
  },
  {
    id: "infrastructure-slack-channels",
    name: "Infrastructure related slack channels",
    description: "A yaml file that contains the list of slack channels that are related to the Infrastructure domain.",
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/infrastructure/slack-channels.yaml'),
    created: new Date(),
  },
  {
    id: "infrastructure-project-list",
    name: "Infrastructure Project List",
    description: `A yaml file that contains the list of projects that are related to the Infrastructure domain.
    If the file does not exist, you can create one. You can use the list requests tool to list all requests related to the Infrastructure domain.`,
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/infrastructure/projects.yaml'),
    created: new Date(),
  },
  {
    id: "incidents-folder",
    name: "Incidents Folder",
    description: "The root directory for all incidents related to all domains.",
    type: "directory",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/postmortem/'),
    created: new Date(),
  },
  {
    id: "repositories-root",
    name: "Repositories Root",
    description: "The root directory for all repositories related to the Infrastructure and other domains.",
    type: "directory",
    url: path.join(process.env.HOME, '/Source/Zepz-Engineering/'),
    created: new Date(),
  }
]

const INFRASTRUCTURE_TOOLS = INFRASTRUCTURE_MACROS.map(m => m.tools).flat().filter(t => t.type === "function")

// Process additional macros from the registry
MacroRegistry.forEach(m => {
  if (m.tools) {
    m.tools.forEach(t => {
      if (t.type === "function" && INFRATOOL_INCLUDES.includes(t.function?.name)) {
        if (!t.roles || t.roles.length === 0) t.roles = m.roles || [];
        INFRASTRUCTURE_TOOLS.push(t);
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
  INFRASTRUCTURE_MACROS.push(macro);
});

INFRASTRUCTURE_MACROS.forEach(m => { delete m.component; });

// Helper function to get role-specific capabilities
const getRoleCapabilities = (userRoles: string[]): string => {
  if (userRoles.includes('ADMIN')) {
    return 'You have administrative access to all Infrastructure domain functions and can perform advanced operations.';
  } else if (userRoles.includes('ENGINEER')) {
    return 'You have engineering access to Infrastructure technical functions, debugging tools, and development resources.';
  } else if (userRoles.includes('USER')) {
    return 'You have standard user access to approved Infrastructure functions and can help with common Infrastructure tasks.';
  }
  return 'You have basic access to core Infrastructure functions and can assist with general Infrastructure inquiries.';
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
const buildSystemPrompt = (userRoles: string[] = ['USER'], availableTools: any[] = INFRASTRUCTURE_TOOLS) => {
  const toolDescriptions = buildToolDescriptions(availableTools);
  const roleCapabilities = getRoleCapabilities(userRoles);
  const resourceDescription = buildResourceDescriptions(INFRASTRUCTURE_RESOURCES);
  
  return lodash.template(INFRASTRUCTURE_PERSONA_TEXT + '\n\n' + INFRASTRUCTURE_FEATURES_TEXT)({
    date: new Date().toISOString(),
    // availableTools: availableTools.length,
    // toolDescriptions,
    resourceDescription,
    userRole: userRoles.join(', '),
    roleSpecificCapabilities: roleCapabilities
  });
};

const systemPrompt = buildSystemPrompt();

export const InfrastructurePersona: IAIPersona = {
  id: "InfrastructureIvyAIPersona",
  name: "Infrastructure Ivy",
  description: "Infrastructure Ivy AI Persona - Enhanced with improved tool handling and context management for Infrastructure domain",
  persona: INFRASTRUCTURE_PERSONA_TEXT,
  features: INFRASTRUCTURE_FEATURES_TEXT,
  appearance,
  modelId: process.env.GOOGLE_AI_STUDIO_MODEL_ID || "gemini-2.5-pro",
  providerId: "google",  
  defaultGreeting: "Hello, I am Infrastructure Ivy, your intelligent AI assistant specializing in the Infrastructure domain. I can help you with Terraform, GitHub, Kubernetes, AWS, and Slack channel insights. How may I assist you today?",
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
  tools: [...INFRASTRUCTURE_TOOLS],
  // @ts-ignore
  macros: [
    ...INFRASTRUCTURE_MACROS
  ],
  resources: [...INFRASTRUCTURE_RESOURCES],
};

export const InfrastructurePersonaComponentRegistryEntry: Reactory.IReactoryComponentDefinition<IAIPersona> = {
  nameSpace: "reactory-reactor",
  name: "InfrastructureIvyAIPersona",
  description: `Infrastructure Ivy AI Persona. Domain-specific AI Assistant focused on Infrastructure systems and health monitoring.
  This persona is designed to assist users with Infrastructure domain tasks, including but not limited to:
  - Monitoring Terraform Infrastructure as Code, state management, and deployment automation
  - Tracking GitHub operations, CI/CD pipelines, and version control systems
  - Managing Infrastructure domain Slack channels and communication
  - Tracking Infrastructure service dependencies and integration health
  - Providing insights into Kubernetes administration and AWS infrastructure
  - Supporting Infrastructure-related troubleshooting and issue resolution
  - Offering recommendations for Infrastructure service improvements
  - Assisting with Infrastructure analytics and operational intelligence`,
  version: "1.0.0",
  component: InfrastructurePersona,
  features: [
    { 
      feature: "appearance",
      description: "Infrastructure Ivy AI Persona Appearance",
      featureType: FeatureType.object,
      action: ["get"],
      stem: "appearance",
    },
    {
      feature: "persona",
      description: "Infrastructure Ivy AI Persona",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "persona",
    },
    {
      feature: "features",
      description: "Infrastructure Ivy AI Persona Features",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "features",
    }
  ]
}

// Export the enhanced prompt builder for dynamic use
export { buildSystemPrompt, getRoleCapabilities, buildToolDescriptions };

export default InfrastructurePersonaComponentRegistryEntry; 