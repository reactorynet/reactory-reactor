import { ingest } from "@reactory/server-core/utils/io"
import path from "path";
import { registerModuleSearchIndexes } from '@reactory/server-modules/reactory-reactor/services/graph/searchIndexCatalog';
import appearance from './appearance';
import { IAIPersona, IAIPersonaResource } from "@reactory/server-modules/reactory-reactor/types/service.types";
import { FeatureType } from "@reactorynet/reactory-core";
import { MacroRegistry } from "@reactory/server-modules/reactory-reactor/ai/macro";
import { MacroComponentDefinition, MacroToolDefinition } from "../../openai/types/chat";
import * as lodash from "lodash";
import { BOOKTUTOR_MACROS as IMPORTED_BOOKTUTOR_MACROS, BOOKTUTOR_MACRO_TOOLS } from './macros';

const BOOKTUTOR_PERSONA_TEXT = ingest(require.resolve('./persona.md'));
const BOOKTUTOR_FEATURES_TEXT = ingest(require.resolve('./features.md'));

const BOOKTUTOR_TOOL_INCLUDES = [
  // Execution & CLI
  'shell',
  // File & Code Management
  'readFile',
  'writeFile',
  'safeEditFile',
  'snip',
  'listDirectory',
  'pathInfo',
  'mkdir',
  'rmdir',
  'createModuleStructure',
  // Code Review & QA
  'CodeReview',
  'CodeReviewFile',
  // Database & GraphQL
  'queryGQL',
  'mutationGQL',
  'schemaGQL',
  'postgres',
  'mongo',
  'mongoWrite',
  // UI & Side Panel Tools
  'form',
  'component',
  'chart',
  'd3',
  'image',
  'side_panel_state',
  'amq',
  // Tasks, Workflow & Sub-agent Communication
  'todo',
  'chats',
  'workflow',
  'executeYamlWorkflow',
  'listWorkflows',
  'getWorkflow',
  'datetime',
  'var',
  'sliceVariable',
  'modules',
  'env',
  'state',
  // Search & Knowledge
  'grep_search',
  'file_search',
  'codebase_search',
  'searchGraph',
  'getGraphNode',
  'graphChildren',
  'exploreGraph',
  'graphLinks',
  'searchContent',
  'listSearchIndexes',
  'getIndexStats',
  // Domain Specific Macros
  ...BOOKTUTOR_MACRO_TOOLS,
  'get_book_page',
  'list_books',
  'list_chapters',
  'track_progress'
];

const APP_DATA_ROOT = process.env.APP_DATA_ROOT || process.env.REACTORY_DATA
const BOOKTUTOR_DATA_ROOT = path.join(APP_DATA_ROOT, 'guideai/booktutor');

// Make BookTutor's indexes discoverable in the tenant-safe search catalog
// (Providers Session 08). Registration is idempotent by index name.
registerModuleSearchIndexes([
  { index: "book-catalog", title: "BookTutor catalog", description: "Book titles, authors and subjects available to the BookTutor agent" },
  { index: "book-chapters", title: "BookTutor chapters", description: "Full chapter content of the BookTutor library" },
  { index: "book-glossary", title: "BookTutor glossary", description: "Glossary terms and definitions from the BookTutor library" },
]);

const BOOKTUTOR_RESOURCES: IAIPersonaResource[] = [
  {
    id: 'booktutor-library',
    name: 'BookTutor Library',
    description: 'The main library directory containing all books available for tutoring sessions.',
    type: 'directory',
    url: path.join(BOOKTUTOR_DATA_ROOT, 'library/'),
    created: new Date(),
  },
  {
    id: 'booktutor-catalog',
    name: 'Book Catalog Index',
    description: 'Master catalog containing metadata for all books in the library, including titles, authors, subjects, and chapter listings.',
    type: 'file',
    url: path.join(BOOKTUTOR_DATA_ROOT, 'library/catalog.json'),
    created: new Date(),
  },
  {
    id: 'booktutor-search-index',
    name: 'Book Search Index',
    description: 'Search index for quick keyword and content lookup across all books and chapters.',
    type: 'file',
    url: path.join(BOOKTUTOR_DATA_ROOT, 'library/search-index.json'),
    created: new Date(),
  },
  {
    id: 'learning-paths',
    name: 'Learning Paths',
    description: 'Directory containing predefined and custom learning paths created from book content.',
    type: 'directory',
    url: path.join(BOOKTUTOR_DATA_ROOT, 'learning-paths/'),
    created: new Date(),
  },
  {
    id: 'user-progress',
    name: 'User Progress Tracking',
    description: 'Directory for storing user learning progress and session data.',
    type: 'directory',
    url: path.join(BOOKTUTOR_DATA_ROOT, 'progress/'),
    created: new Date(),
  },
  {
    id: 'educational-resources',
    name: 'Educational Resources',
    description: 'Additional educational materials, templates, and tools for enhanced learning experiences.',
    type: 'directory', 
    url: path.join(BOOKTUTOR_DATA_ROOT, 'resources/'),
    created: new Date(),
  }
];

// Process macros from the registry and add book-specific ones
(MacroRegistry || []).forEach(m => {
  if (m.tools) {
    m.tools.forEach(t => {
      if (t.type === "function" && BOOKTUTOR_TOOL_INCLUDES.includes(t.function?.name)) {
        if (!t.roles || t.roles.length === 0) t.roles = m.roles || [];
      }
    });
  }
});

// Add the macro tools to the tools array
const ALL_BOOKTUTOR_MACROS = [...IMPORTED_BOOKTUTOR_MACROS];
(MacroRegistry || []).forEach(m => {
  if (m.tools?.some(t => t.type === "function" && BOOKTUTOR_TOOL_INCLUDES.includes(t.function?.name))) {
    const macro = {
      ...m,
      runat: m.runat ?? "server",
    };
    ALL_BOOKTUTOR_MACROS.push(macro);
  }
});

ALL_BOOKTUTOR_MACROS.forEach(m => { delete m.component; });

let BOOKTUTOR_TOOLS: any[] = [];

try { 
  BOOKTUTOR_TOOLS = ALL_BOOKTUTOR_MACROS.map(m => m.tools).flat().filter(t => { 
    if (t.type === "function") {
      return true;
    }
    return false;
  });
} catch (error) {
  console.error('Error processing BookTutor macros:', error);
}

// Helper function to get role-specific educational capabilities
const getRoleCapabilities = (userRoles: string[]): string => {
  if (userRoles.includes('ADMIN')) {
    return 'You have administrative access to all BookTutor functions including library management, advanced search capabilities, and educational content creation tools.';
  } else if (userRoles.includes('DEVELOPER')) {
    return 'You have developer access to BookTutor technical functions including content indexing, search optimization, and learning path development tools.';
  } else if (userRoles.includes('USER')) {
    return 'You have full access to all educational features including book search, content access, learning path creation, and progress tracking.';
  }
  return 'You have basic access to core BookTutor educational functions and can assist with fundamental learning activities.';
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

// Enhanced system prompt builder for educational context
const buildSystemPrompt = (userRoles: string[] = ['USER'], availableTools: any[] = BOOKTUTOR_TOOLS) => {
  const toolDescriptions = buildToolDescriptions(availableTools);
  const roleCapabilities = getRoleCapabilities(userRoles);
  const resourceDescription = buildResourceDescriptions(BOOKTUTOR_RESOURCES);
  
  return lodash.template(BOOKTUTOR_PERSONA_TEXT + '\n\n' + BOOKTUTOR_FEATURES_TEXT)({
    date: new Date().toISOString(),
    toolDescriptions,
    resourceDescription,
    userRole: userRoles.join(', '),
    roleSpecificCapabilities: roleCapabilities
  });
};

const systemPrompt = buildSystemPrompt();

export const BookTutorPersona: IAIPersona = {
  id: "BookTutorAIPersona",
  name: "BookTutor",
  description: "BookTutor AI Persona - Intelligent educational assistant with access to comprehensive book library and advanced search capabilities for personalized learning experiences",
  persona: BOOKTUTOR_PERSONA_TEXT,
  features: BOOKTUTOR_FEATURES_TEXT,
  appearance,
  modelId: process.env.GOOGLE_AI_STUDIO_MODEL_ID || "gemini-2.5-pro",
  providerId: "google",  
  defaultGreeting: "Hello! I'm BookTutor, your intelligent educational assistant. I have access to a comprehensive library of books organized by chapters and equipped with advanced search capabilities. I can help you learn new concepts, find specific information, create personalized learning paths, and track your progress. What would you like to learn today?",
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
    // BookTutor's well-known indexes — searchContent's default scope for this
    // persona (the global book-* fallback was removed in Providers Session 08).
    defaultSearchIndexes: ["book-catalog", "book-chapters", "book-glossary"],
  },
  tools: [...BOOKTUTOR_TOOLS],
  // @ts-ignore
  macros: [
    ...ALL_BOOKTUTOR_MACROS
  ],
  resources: [...BOOKTUTOR_RESOURCES],
}

export const BookTutorPersonaComponentRegistryEntry: Reactory.IReactoryComponentDefinition<IAIPersona> = {
  nameSpace: "reactor",
  name: "BookTutorAIPersona",
  description: `BookTutor AI Persona. Educational AI Assistant specialized in book-based learning and tutoring.
  This persona is designed to assist users with educational tasks, including but not limited to:
  - Searching and analyzing content from a comprehensive book library
  - Creating personalized learning paths based on available book content
  - Providing detailed explanations and tutoring on various subjects
  - Tracking learning progress and adapting teaching methods
  - Cross-referencing information from multiple books and chapters
  - Creating educational exercises and assessments from book content
  - Assisting with research and study planning
  - Providing reading comprehension and analysis support
  - Generating study guides and summaries from book material
  - Offering interactive learning experiences with immediate feedback`,
  version: "1.0.0",
  component: BookTutorPersona,
  features: [
    { 
      feature: "appearance",
      description: "BookTutor AI Persona Appearance",
      featureType: FeatureType.object,
      action: ["get"],
      stem: "appearance",
    },
    {
      feature: "persona",
      description: "BookTutor AI Persona",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "persona",
    },
    {
      feature: "features",
      description: "BookTutor AI Persona Features",
      featureType: FeatureType.string,
      action: ["get"],
      stem: "features",
    },
    {
      feature: "library",
      description: "BookTutor Library Access",
      featureType: FeatureType.object,
      action: ["get", "search"],
      stem: "library",
    },
    {
      feature: "search",
      description: "Book Content Search",
      featureType: FeatureType.function,
      action: ["search"],
      stem: "search",
    }
  ]
}

// Export the enhanced prompt builder for dynamic use
export { buildSystemPrompt, getRoleCapabilities, buildToolDescriptions };

export default BookTutorPersonaComponentRegistryEntry;
