import { BOOKTUTOR_MACRO_TOOLS } from './macros';

/**
 * Tools BookTutor will claim from the server-side `MacroRegistry`.
 *
 * Client tools (`form`, `component`, `chart`, `d3`, `image`) are intentionally
 * absent: they have no registry entry and are advertised by the client at
 * session creation via `syncClientCapabilities`. See `../clientTools.ts`.
 */
export const BOOKTUTOR_TOOL_INCLUDES: string[] = [
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
  // NOTE: client-only tools are not listed here — the client advertises them.
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
  'track_progress',
  'updateChatData',
];

export default BOOKTUTOR_TOOL_INCLUDES;
