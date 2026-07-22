import { ingest } from "@reactory/server-core/utils/io"
import path from "path";
import appearance from './appearance';
import { IAIPersona, IAIPersonaResource } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { FeatureType } from "@reactorynet/reactory-core";
import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/macro";
import { MacroComponentDefinition, MacroToolDefinition } from "../../openai/types/chat";
import * as lodash from "lodash";

const WORKFLOW_PERSONA_TEXT = ingest(require.resolve('./persona.md'));
const WORKFLOW_FEATURES_TEXT = ingest(require.resolve('./features.md'));

const WORKFLOW_TOOL_INCLUDES = [
  'readFile',
  'writeFile',
  'listDirectory',
  'shell',
  'todo',
  'var',
  'svc',
  'queryGQL',
  'mutationGQL',
  'modules',
  'env',
  'state',
  'datetime',
  'http',  
  'controlWorkflowInstance',
  'executeYamlWorkflow',
  'getRecentExecutions',
  'getWorkflow',
  'getWorkflowErrors',
  'getWorkflowHistory',
  'getWorkflowStats',
  'getWorkflowYaml',
  'listWorkflowInstances',
  'listWorkflows',
  'listWorkflowSchedules',
  'listWorkflowSteps',
  'saveWorkflowYaml',
  'validateWorkflowYaml',
  'deleteWorkflowDefinition',
  'workflow',
  'amq'
];

const REACTORY_HOME = process.env.REACTORY_HOME || process.cwd();
const REACTORY_SERVER = process.env.REACTORY_SERVER || path.join(REACTORY_HOME, 'reactory-express-server');
const REACTORY_DATA = process.env.REACTORY_DATA || path.join(REACTORY_HOME, 'reactory-data');

const WORKFLOW_RESOURCES: IAIPersonaResource[] = [
  {
    id: 'reactory-home-folder',
    name: 'Reactory Home Folder',
    description: 'The home folder for the Reactory application.',
    type: 'directory',
    url: path.join(REACTORY_HOME, '/'),
    created: new Date(),
  },
  {
    id: 'reactory-express-server',
    name: 'Reactory Express Server',
    description: 'The Express server for the Reactory application. Use this to read workflow source code, step implementations, and module definitions.',
    type: 'directory',
    url: path.join(REACTORY_SERVER, '/'),
    created: new Date(),
  },
  {
    id: 'reactory-server-modules',
    name: 'Reactory Server Modules',
    description: `The source code for all Reactory server modules.
    Review module index.ts files to understand how workflowSteps are registered and exported.`,
    type: 'directory',
    url: path.join(REACTORY_SERVER, '/src/modules/'),
    created: new Date(),
  },
  {
    id: 'workflow-engine-source',
    name: 'Workflow Engine Source Code',
    description: `The core workflow engine source code including WorkflowRunner, YamlWorkflowExecutor, YamlStepRegistry,
    BaseYamlStep, all core step implementations, the YAML parser, validators, and code workflow samples.
    This is the primary reference for understanding workflow internals.`,
    type: 'directory',
    url: path.join(REACTORY_SERVER, '/src/modules/reactory-core/workflow/'),
    created: new Date(),
  },
  {
    id: 'yaml-workflow-schema',
    name: 'YAML Workflow Schema',
    description: `The JSON schema for validating YAML workflow definitions.
    This schema defines the structure, required fields, and validation rules for workflows.`,
    type: 'file',
    url: path.join(REACTORY_SERVER, '/src/modules/reactory-core/workflow/schema/workflow.schema.json'),
    created: new Date(),
  },
  {
    id: 'workflow-schedule-configs',
    name: 'Workflow Schedule Configurations',
    description: `YAML schedule configuration files that define automated workflow execution with cron patterns,
    workflow FQN references, input parameters, and retry policies.`,
    type: 'directory',
    url: path.join(REACTORY_HOME, '/reactory-data/workflows/schedules'),
    created: new Date(),
  },
  {
    id: 'reactory-docs',
    name: 'Reactory Documentation',
    description: `The core documentation for the Reactory platform.
    Review this documentation to understand the overall platform architecture and conventions.`,
    type: 'text',
    url: path.join(REACTORY_HOME, '/reactory-docs/'),
    created: new Date(),
  },
  {
    id: 'ai-agent-home-folder',
    name: 'AI Agent Home Folder',
    description: 'The home folder for WorkflowWill, where you can read and write files as needed.',
    type: 'directory',
    url: path.join(REACTORY_DATA, '/profiles/reactor/personas/workflowwill'),
    created: new Date(),
  },
  {
    id: 'ai-agent-workspace',
    name: 'AI Agent Skills',
    description: 'Manage and retrieve unique skills and abilities here. This folder is intended for storing any custom tools, functions, or resources that WorkflowWill can utilize to enhance its workflow design and development capabilities.',
    type: 'directory',
    url: path.join(REACTORY_DATA, '/profiles/reactor/personas/workflow/workspace/skills'),
    created: new Date(),
  },
  {
    id: 'ai-agent-workspace',
    name: 'AI Agent Workspace',
    description: 'The workspace folder for WorkflowWill, where you can read and write draft workflows and working files.',
    type: 'directory',
    url: path.join(REACTORY_DATA, '/profiles/reactor/personas/workflowwill/workspace'),
    created: new Date(),
  },
];

const WORKFLOW_MACROS: MacroComponentDefinition<any>[] = [];

// Process macros from the registry
MacroRegistry.forEach(m => {
  if (m.tools) {
    m.tools.forEach(t => {
      if (t.type === "function" && WORKFLOW_TOOL_INCLUDES.includes(t.function?.name)) {
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
  WORKFLOW_MACROS.push(macro);
});

WORKFLOW_MACROS.forEach(m => { delete m.component; });

let WORKFLOW_TOOLS: any[] = [];

try {
  WORKFLOW_TOOLS = WORKFLOW_MACROS.map(m => m.tools).flat().filter(t => {
    if (t.type === "function" && WORKFLOW_TOOL_INCLUDES.indexOf(t?.function?.name as string) >= 0) {
      return true;
    }
    return false;
  });
} catch (error) {
  console.error('Error processing workflow macros:', error);
}

// Helper function to get role-specific capabilities
const getRoleCapabilities = (userRoles: string[]): string => {
  if (userRoles.includes('ADMIN')) {
    return 'You have administrative access to all workflow functions and can perform advanced operations including custom step development, workflow scheduling, security configuration, and direct module step registration.';
  } else if (userRoles.includes('DEVELOPER')) {
    return 'You have developer access to workflow design tools, YAML and code workflow generation, step configuration, debugging resources, and workflow optimization capabilities.';
  } else if (userRoles.includes('USER')) {
    return 'You have standard user access to workflow design assistance and can help with building and configuring YAML workflows using registered step types.';
  }
  return 'You have basic access to workflow guidance and can assist with understanding workflow concepts and reviewing existing workflow definitions.';
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
const buildSystemPrompt = (userRoles: string[] = ['USER'], availableTools: any[] = WORKFLOW_TOOLS) => {
  const toolDescriptions = buildToolDescriptions(availableTools);
  const roleCapabilities = getRoleCapabilities(userRoles);
  const resourceDescription = buildResourceDescriptions(WORKFLOW_RESOURCES);

  return lodash.template(WORKFLOW_PERSONA_TEXT + '\n\n' + WORKFLOW_FEATURES_TEXT, {
    'interpolate': /<%=([\s\S]+?)%>/g
  })({
    date: new Date().toISOString(),
    toolDescriptions,
    resourceDescription,
    userRole: userRoles.join(', '),
    roleSpecificCapabilities: roleCapabilities
  });
};

const systemPrompt = buildSystemPrompt();

export const WorkflowWillPersona: IAIPersona = {
  id: "WorkflowWillAIPersona",
  name: "WorkflowWill",
  description: "WorkflowWill AI Persona - Specialized exclusively in designing, building, debugging, and optimizing YAML and Code-based workflows for the Reactory Workflow Engine",
  persona: WORKFLOW_PERSONA_TEXT,
  features: WORKFLOW_FEATURES_TEXT,
  appearance,
  modelId: process.env.GOOGLE_AI_STUDIO_MODEL_ID || "gemini-3-pro-preview",
  providerId: "google",
  defaultGreeting: "Hello, I am WorkflowWill, your dedicated workflow architect for the Reactory platform. I specialize exclusively in designing and building YAML and Code-based workflows for the Reactory Workflow Engine. Whether you need to create a new workflow, debug an existing one, build custom steps, or optimize execution patterns, I am here to help. What workflow challenge can I assist you with today?",
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
  tools: [...WORKFLOW_TOOLS],  
  // @ts-ignore
  macros: [
    ...WORKFLOW_MACROS
  ],
  resources: [...WORKFLOW_RESOURCES],
}

export const WorkflowWillPersonaComponentRegistryEntry: Reactory.IReactoryComponentDefinition<IAIPersona> = {
  nameSpace: "reactor",
  name: "WorkflowWillAIPersona",
  description: `WorkflowWill AI Persona. Domain-specific AI Assistant focused exclusively on Reactory Workflow Engine development.
  This persona is designed to assist users with workflow tasks, including but not limited to:
  - Designing and architecting YAML and Code-based workflows for the Reactory platform
  - Generating production-ready YAML workflow definitions with steps, dependencies, conditions, and error handling
  - Generating TypeScript code workflows using the workflow-es library patterns
  - Configuring all 12 core step types and reactor module extended step types
  - Debugging workflow execution issues and template variable resolution
  - Optimizing workflow performance with parallelization and error handling strategies
  - Developing custom step implementations extending BaseYamlStep
  - Guiding module-level step registration via IReactoryModule.workflowSteps
  - Creating workflow schedule configurations for automated execution
  - Migrating workflows between YAML and Code formats`,
  version: "1.0.0",
  component: WorkflowWillPersona,
  features: [
    {
      feature: "appearance",
      description: "WorkflowWill AI Persona Appearance",
      featureType: FeatureType.object,
      action: ["get"],
      stem: "appearance",
    },
    {
      feature: "persona",
      description: "WorkflowWill AI Persona",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "persona",
    },
    {
      feature: "features",
      description: "WorkflowWill AI Persona Features",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "features",
    }
  ]
}

// Export the enhanced prompt builder for dynamic use
export { buildSystemPrompt, getRoleCapabilities, buildToolDescriptions };

export default WorkflowWillPersonaComponentRegistryEntry;
