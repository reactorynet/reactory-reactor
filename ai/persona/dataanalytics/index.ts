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

const DATAANALYTICS_PERSONA_TEXT = ingest(require.resolve('./persona.md'));
const DATAANALYTICS_FEATURES_TEXT = ingest(require.resolve('./features.md'));

const DATAANALYTICS_MACROS = [
  { ...SlackReadMessagesRegistry},
  { ...SlackGetChannelInfoRegistry },
  { ...SlackListChannelsRegistry },
  { ...SlackReadThreadRepliesRegistry }
];

const DATAANALYTICS_TOOL_INCLUDES = [
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
  'sqlQuery',
  'dataValidation',
  'schemaValidation',
  'dataQualityCheck',
  'pipelineMonitoring',
  'metricsCollection',
  'reportGeneration',
  'dashboardUpdate',
  'mlModelValidation',
  'dataLineageTracking'
]

const DATAANALYTICS_RESOURCES: IAIPersonaResource[] = [
  {
    id: "dataanalytics-domain-review-document",
    name: "Data Analytics Domain Document",
    description: `The current domain document for the Data Analytics domain. 
    Review this document to understand the current state of the Data Analytics domain, including ETL pipelines, 
    data warehouses, analytics platforms, and machine learning operations.`,
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/reviews/dataanalytics-domain-review.md'),
    created: new Date(),
  },
  {
    id: "data-governance-policy-document",
    name: "Data Governance Policy Document",
    description: `The current data governance policy document outlining data quality standards, 
    privacy regulations, data lineage requirements, and compliance frameworks for the Data Analytics domain.`,
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/dataanalytics/data-governance-policy.md'),
    created: new Date(),
  },
  {
    id: "dataanalytics-slack-channels",
    name: "Data Analytics related slack channels",
    description: "A yaml file that contains the list of slack channels that are related to the Data Analytics domain, including ETL monitoring, data quality alerts, and analytics team communications.",
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/dataanalytics/slack-channels.yaml'),
    created: new Date(),
  },
  {
    id: "etl-pipeline-configurations",
    name: "ETL Pipeline Configurations",
    description: "Configuration files and documentation for all ETL pipelines, data transformation workflows, and data integration processes in the Data Analytics domain.",
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/dataanalytics/etl-configurations.yaml'),
    created: new Date(),
  },
  {
    id: "data-quality-metrics",
    name: "Data Quality Metrics Dashboard",
    description: "Real-time data quality metrics, validation rules, and monitoring dashboards for tracking data integrity across all analytics systems and data warehouses.",
    type: "text",
    url: path.join(process.env.APP_DATA_ROOT, '/profiles/zepz-engineer/domains/dataanalytics/data-quality-metrics.json'),
    created: new Date(),
  }
]

const DATAANALYTICS_TOOLS = (DATAANALYTICS_MACROS || []).flatMap(m => m?.tools || []).filter(t => t?.type === "function");

// Process additional macros from the registry
(MacroRegistry || []).forEach(m => {
  if (m.tools) {
    m.tools.forEach(t => {
      if (t.type === "function" && DATAANALYTICS_TOOL_INCLUDES.includes(t.function?.name)) {
        if (!t.roles || t.roles.length === 0) t.roles = m.roles || [];
        DATAANALYTICS_TOOLS.push(t);
      }
    });
  }
});

// Add the macro tools to the tools array
(MacroRegistry || []).forEach(m => {
  const macro = {
    ...m,
    runat: m.runat ?? "server",
  };
  // @ts-ignore
  DATAANALYTICS_MACROS.push(macro);
});

DATAANALYTICS_MACROS.forEach(m => { delete m.component; });

// Helper function to get role-specific capabilities
const getRoleCapabilities = (userRoles: string[]): string => {
  if (userRoles.includes('ADMIN')) {
    return 'You have administrative access to all Data and Analytics domain functions and can perform advanced operations including data pipeline management, ML model deployment, and analytics platform administration.';
  } else if (userRoles.includes('ENGINEER')) {
    return 'You have engineering access to Data and Analytics technical functions, ETL pipeline debugging, data quality monitoring, and development resources for analytics applications.';
  } else if (userRoles.includes('USER')) {
    return 'You have standard user access to approved Data and Analytics functions and can help with common data analysis tasks, report generation, and analytics platform usage.';
  }
  return 'You have basic access to core Data and Analytics functions and can assist with general data inquiries, basic reporting, and analytics platform navigation.';
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
const buildSystemPrompt = (userRoles: string[] = ['USER'], availableTools: any[] = DATAANALYTICS_TOOLS) => {
  const toolDescriptions = buildToolDescriptions(availableTools);
  const roleCapabilities = getRoleCapabilities(userRoles);
  const resourceDescription = buildResourceDescriptions(DATAANALYTICS_RESOURCES);
  
  return lodash.template(DATAANALYTICS_PERSONA_TEXT + '\n\n' + DATAANALYTICS_FEATURES_TEXT)({
    date: new Date().toISOString(),        
    resourceDescription,
    userRole: userRoles.join(', '),
    roleSpecificCapabilities: roleCapabilities
  });
};

const systemPrompt = buildSystemPrompt();

export const DataAnalyticsPersona: IAIPersona = {
  id: "DataAnalyticsDanaAIPersona",
  name: "Data Analytics Dana",
  description: "Data Analytics Dana AI Persona - Enhanced with improved tool handling and context management for Data and Analytics domain",
  persona: DATAANALYTICS_PERSONA_TEXT,
  features: DATAANALYTICS_FEATURES_TEXT,
  appearance,
  modelId: process.env.GOOGLE_AI_STUDIO_MODEL_ID || "gemini-2.5-pro",
  providerId: "google",  
  defaultGreeting: "Hello, I am Data Analytics Dana, your intelligent AI assistant specializing in the Data and Analytics domain. I can help you with ETL pipelines, analytics platforms, machine learning operations, data quality monitoring, and Slack channel insights. How may I assist you today?",
  prompts: {
    system: {
      content: systemPrompt,
      role: "system",
    },
    catalogAndCategorizeMessages: {
      content: `I have retrieved \${catalogedIds.length} messages from \${sourceType} source "\${sourceId}". 
        Categorize the messages into the existing requests or create new requests.
        Below are existing requests and the request ids and texts from the collected messages:

        \${catalogedIds.map(msg => \`\${msg.requestEntryId} - \${msg.requestText}\`).join('\n\n')}

        Here are the existing requests:
        \${existingRequests.map(req => \`id: \${req.id} \\n - name: \${req.name} \\n - description: \${req.description} \\n - type: \${req.type}\`).join('\n\n')}
        Call the tool "createNewRequest" to create a new request. Only use this tool if the request text is not already in the existing requests.
        Call the tool "updateRequestEntries" to categorize the messages into the existing requests or create newly created requests in a batch.
        
        For each message, detect the language of the message and translate it to English if it is not in English.
        For each message, detect the sentiment of the message and categorize it as positive, negative or neutral.
        For each message, detect the tone of the message and categorize it as formal, informal or neutral.
        For each message, detect the urgency of the message and categorize it as low, medium or high.
        For each message, detect the importance of the message and categorize it as low, medium or high.
        For each message, detect the relevance of the message and categorize it as low, medium or high.
        For each message, detect the category of the message and categorize it as feature request, bug report, support request or general inquiry.

        Only use the tools createNewRequest and updateRequestEntries to categorize the messages.
        Do not ask for permission to use the tools, just perform the task.               
        `,
      role: "user",
      parameters: {
        type: "object",
        properties: {
          sourceType: {
            type: "string",
            description: "The type of the source to read messages from.",
          },
          sourceId: {
            type: "string",
            description: "The ID of the source to read messages from.",
          },
          catalogedIds: {
            type: "array",
            description: "The IDs of the messages to categorize.",
            items: {
              type: "object",
              properties: {
                requestEntryId: {
                  type: "number",
                  description: "The ID of the request entry.",
                },
                requestText: {
                  type: "string",
                  description: "The text of the request.",
                },
              },
            },
          },
        },
      },
    },
  },
  config: {
    apiKey: process.env.GOOGLE_AI_STUDIO_API_KEY,
    apiBaseURL: process.env.GOOGLE_AI_API_URL, 
    project: process.env.GOOGLE_AI_STUDIO_PROJECT_ID,
  },
  tools: [...DATAANALYTICS_TOOLS],
  // @ts-ignore
  macros: [
    ...DATAANALYTICS_MACROS
  ],
  resources: [...DATAANALYTICS_RESOURCES],
};

export const DataAnalyticsPersonaComponentRegistryEntry: Reactory.IReactoryComponentDefinition<IAIPersona> = {
  nameSpace: "reactory-reactor",
  name: "DataAnalyticsDanaAIPersona",
  description: `Data Analytics Dana AI Persona. Domain-specific AI Assistant focused on Data and Analytics systems and health monitoring.
  This persona is designed to assist users with Data and Analytics domain tasks, including but not limited to:
  - Monitoring ETL pipelines, data transformation, and data quality processes
  - Tracking analytics platforms, business intelligence tools, and reporting systems
  - Managing Data and Analytics domain Slack channels and communication
  - Tracking Data and Analytics service dependencies and integration health
  - Providing insights into machine learning operations and data governance
  - Supporting Data and Analytics-related troubleshooting and issue resolution
  - Offering recommendations for Data and Analytics service improvements
  - Assisting with Data and Analytics analytics and operational intelligence`,
  version: "1.0.0",
  component: DataAnalyticsPersona,
  features: [
    { 
      feature: "appearance",
      description: "Data Analytics Dana AI Persona Appearance",
      featureType: FeatureType.object,
      action: ["get"],
      stem: "appearance",
    },
    {
      feature: "persona",
      description: "Data Analytics Dana AI Persona",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "persona",
    },
    {
      feature: "features",
      description: "Data Analytics Dana AI Persona Features",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "features",
    }
  ]
}

// Export the enhanced prompt builder for dynamic use
export { buildSystemPrompt, getRoleCapabilities, buildToolDescriptions };

export default DataAnalyticsPersonaComponentRegistryEntry; 