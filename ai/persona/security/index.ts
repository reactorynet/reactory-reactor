import { ingest } from "@reactory/server-core/utils/io"
import path from "path";
import appearance from './appearance';
import { IAIPersona, IAIPersonaResource } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { FeatureType } from "@reactorynet/reactory-core";
import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/macro";
import { MacroComponentDefinition, MacroToolDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { 
  SlackGetChannelInfoRegistry, 
  SlackReadMessagesRegistry,
  SlackListChannelsRegistry,
  SlackReadThreadRepliesRegistry 
} from "@reactory/server-modules/reactory-slack/ai/macros/SlackReaderMacros";
import * as lodash from "lodash";

const SECURITY_PERSONA_TEXT = ingest(require.resolve('./persona.md'));
const SECURITY_FEATURES_TEXT = ingest(require.resolve('./features.md'));

const SECURITY_MACROS = [
  { ...SlackReadMessagesRegistry},
  { ...SlackGetChannelInfoRegistry },
  { ...SlackListChannelsRegistry },
  { ...SlackReadThreadRepliesRegistry }
];

const SECURITY_TOOL_INCLUDES = [
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
  'securityScan',
  'vulnerabilityAssessment',
  'threatDetection',
  'incidentResponse',
  'complianceCheck',
  'accessControlAudit',
  'securityMonitoring',
  'forensicAnalysis',
  'penetrationTesting',
  'securityPolicyValidation'
]

const SECURITY_RESOURCES: IAIPersonaResource[] = [
  {
    id: "security-domain-review-document",
    name: "Security Domain Document",
    description: `The current domain document for the Security domain. 
    Review this document to understand the current state of the Security domain, including threat detection systems, 
    compliance frameworks, access control mechanisms, and incident response procedures.`,
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/reviews/security-domain-review.md'),
    created: new Date(),
  },
  {
    id: "security-compliance-policy-document",
    name: "Security Compliance Policy Document",
    description: `The current security compliance policy document outlining security standards, 
    regulatory requirements, audit procedures, and compliance frameworks for the Security domain.`,
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/security/security-compliance-policy.md'),
    created: new Date(),
  },
  {
    id: "security-slack-channels",
    name: "Security related slack channels",
    description: "A yaml file that contains the list of slack channels that are related to the Security domain, including threat alerts, incident response, and security team communications.",
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/security/slack-channels.yaml'),
    created: new Date(),
  },
  {
    id: "threat-intelligence-feeds",
    name: "Threat Intelligence Feeds",
    description: `Configuration files and documentation for threat intelligence feeds, security monitoring systems, and threat detection mechanisms in the Security domain.`,
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/security/threat-intelligence-feeds.yaml'),
    created: new Date(),
  },
  {
    id: "security-incident-playbooks",
    name: "Security Incident Response Playbooks",
    description: "Comprehensive incident response playbooks, escalation procedures, and forensic analysis guidelines for handling security incidents and breaches.",
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/security/incident-response-playbooks.json'),
    created: new Date(),
  }
]

const SECURITY_TOOLS = SECURITY_MACROS.map(m => m.tools).flat().filter(t => t.type === "function")

// Process additional macros from the registry
MacroRegistry.forEach(m => {
  if (m.tools) {
    m.tools.forEach(t => {
      if (t.type === "function" && SECURITY_TOOL_INCLUDES.includes(t.function?.name)) {
        if (!t.roles || t.roles.length === 0) t.roles = m.roles || [];
        SECURITY_TOOLS.push(t);
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
  // @ts-ignore
  SECURITY_MACROS.push(macro);
});

SECURITY_MACROS.forEach(m => { delete m.component; });

// Helper function to get role-specific capabilities
const getRoleCapabilities = (userRoles: string[]): string => {
  if (userRoles.includes('ADMIN')) {
    return 'You have administrative access to all Security domain functions and can perform advanced operations including threat detection management, incident response coordination, and security policy administration.';
  } else if (userRoles.includes('ENGINEER')) {
    return 'You have engineering access to Security technical functions, vulnerability assessment tools, security monitoring systems, and development resources for security applications.';
  } else if (userRoles.includes('USER')) {
    return 'You have standard user access to approved Security functions and can help with common security tasks, compliance checks, and security awareness activities.';
  }
  return 'You have basic access to core Security functions and can assist with general security inquiries, basic threat awareness, and security policy navigation.';
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
    return `
    - Resource: **${name}**: 
      - Description: ${description}
      - URL: ${url}`;
  }).join('\n');
};

// Enhanced system prompt builder
const buildSystemPrompt = (userRoles: string[] = ['USER'], availableTools: any[] = SECURITY_TOOLS) => {
  const toolDescriptions = buildToolDescriptions(availableTools);
  const roleCapabilities = getRoleCapabilities(userRoles);
  const resourceDescription = buildResourceDescriptions(SECURITY_RESOURCES);
  
  return lodash.template(SECURITY_PERSONA_TEXT + '\n\n' + SECURITY_FEATURES_TEXT)({
    date: new Date().toISOString(),
    availableTools: availableTools.length,
    toolDescriptions,
    resourceDescription,
    userRole: userRoles.join(', '),
    roleSpecificCapabilities: roleCapabilities
  });
};

const systemPrompt = buildSystemPrompt();

export const SecurityPersona: IAIPersona = {
  id: "SecuritySamAIPersona",
  name: "Security Sam",
  description: "Security Sam AI Persona - Enhanced with improved tool handling and context management for Security domain",
  persona: SECURITY_PERSONA_TEXT,
  features: SECURITY_FEATURES_TEXT,
  appearance,
  modelId: process.env.GOOGLE_AI_STUDIO_MODEL_ID || "gemini-2.5-pro",
  providerId: "google",  
  maxTokens: 1048576,
  defaultGreeting: "Hello, I am Security Sam, your intelligent AI assistant specializing in the Security domain. I can help you with threat detection, compliance management, incident response, access control, and Slack channel insights. How may I assist you today?",
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
  tools: [...SECURITY_TOOLS],
  // @ts-ignore
  macros: [
    ...SECURITY_MACROS
  ],
  resources: [...SECURITY_RESOURCES],
};

export const SecurityPersonaComponentRegistryEntry: Reactory.IReactoryComponentDefinition<IAIPersona> = {
  nameSpace: "reactory-reactor",
  name: "SecuritySamAIPersona",
  description: `Security Sam AI Persona. Domain-specific AI Assistant focused on Security systems and health monitoring.
  This persona is designed to assist users with Security domain tasks, including but not limited to:
  - Monitoring threat detection, intrusion attempts, and suspicious activities
  - Tracking security compliance, audit requirements, and regulatory adherence
  - Managing Security domain Slack channels and communication
  - Tracking Security service dependencies and integration health
  - Providing insights into access control management and incident response
  - Supporting Security-related troubleshooting and issue resolution
  - Offering recommendations for Security service improvements
  - Assisting with Security analytics and operational intelligence`,
  version: "1.0.0",
  component: SecurityPersona,
  features: [
    { 
      feature: "appearance",
      description: "Security Sam AI Persona Appearance",
      featureType: FeatureType.object,
      action: ["get"],
      stem: "appearance",
    },
    {
      feature: "persona",
      description: "Security Sam AI Persona",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "persona",
    },
    {
      feature: "features",
      description: "Security Sam AI Persona Features",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "features",
    }
  ]
}

// Export the enhanced prompt builder for dynamic use
export { buildSystemPrompt, getRoleCapabilities, buildToolDescriptions };

export default SecurityPersonaComponentRegistryEntry; 