import { existsSync } from 'fs';
import path from 'path';
import { MacroRegistry } from '../index';
import { CLIENT_ADVERTISED_TOOL_NAMES } from '../../persona/clientTools';

/**
 * Registry contract.
 *
 * `MacroRegistry` is the server's complete list of runnable tools. Entries have
 * gone missing before inside unrelated hunks: the image macro was registered and
 * dropped twice (a523647 / 4fc4b9f / 133bf07 / 13a94ee) with no test noticing.
 * The fix for image was to stop trying to register it at all — it is a client
 * macro — but the underlying hazard remains: dropping a spread from the array is
 * a silent, compile-clean loss of capability.
 *
 * These assertions make such a drop loud. The expected list below is deliberately
 * explicit: adding a server macro means adding its tool name here, and removing
 * one requires a matching edit. That friction is the point.
 */

/** Tools that must be reachable through `MacroRegistry`, grouped by macro family. */
const EXPECTED_SERVER_TOOL_NAMES: string[] = [
  // File system and file management
  'readFile',
  'writeFile',
  'safeEditFile',
  'snip',
  'listDirectory',
  'pathInfo',
  'mkdir',
  'rmdir',
  'createModuleStructure',
  // Code review
  'CodeReview',
  'CodeReviewFile',
  // GraphQL
  'queryGQL',
  'mutationGQL',
  'schemaGQL',
  // Runtime / session tools
  'toolkit',
  'addToolsToSession',
  'removeToolsFromSession',
  'addMacro',
  'reloadPersonas',
  // Shell
  'shell',
  // Users
  'getUser',
  'searchUser',
  'createUser',
  // Web
  'fetch',
  'http',
  // Workflow
  'workflow',
  'svc',
  'executeYamlWorkflow',
  'saveWorkflowYaml',
  'validateWorkflowYaml',
  'deleteWorkflowDefinition',
  'getWorkflowYaml',
  'getWorkflow',
  'listWorkflows',
  'listWorkflowSteps',
  'listWorkflowSchedules',
  'listWorkflowInstances',
  'getWorkflowHistory',
  'getWorkflowErrors',
  'getWorkflowStats',
  'getRecentExecutions',
  'controlWorkflowInstance',
  // Chat sessions and delegation
  'chats',
  'updateChatData',
  // MCP
  'mcp',
  // Projects
  'listProjects',
  'getProject',
  'createProject',
  'updateProject',
  'deleteProject',
  'searchProject',
  'catalogProject',
  'getProjectDocumentation',
  'getProjectMetrics',
  // System graph
  'searchGraph',
  'getGraphNode',
  'graphChildren',
  'exploreGraph',
  'graphLinks',
  'createNodeEdge',
  'deletePerspective',
  // Search / content indexes
  'searchContent',
  'indexContent',
  'deleteIndex',
  'listSearchIndexes',
  'getIndexStats',
  'listExternalSources',
  'registerExternalSource',
  'syncExternalSource',
  // Data connections
  'listDataConnections',
  'postgres',
  'mysql',
  'mssql',
  'mongo',
  'mongoWrite',
  // Applications
  'createApplication',
  'getApplication',
  'listApplications',
  'exportApplication',
  'updateApplicationThemes',
  'updateApplicationRoutes',
  'updateApplicationSettings',
  'updateApplicationAuth',
  'updateApplicationPlugins',
  'updateApplicationMenus',
  // Skills
  'searchSkills',
  'readSkill',
  // Playwright
  'playwright_open_session',
  'playwright_close_session',
  'playwright_navigate',
  'playwright_click',
  'playwright_type',
  'playwright_select',
  'playwright_press_key',
  'playwright_get_content',
  'playwright_inspect',
  'playwright_wait_for',
  'playwright_evaluate',
  'playwright_screenshot',
  'playwright_pdf',
  'playwright_page_info',
  'playwright_list_sessions',
  // Support tickets
  'getSupportTicket',
  'listSupportTickets',
  'createSupportTicket',
  'updateSupportTicket',
  'addSupportTicketComment',
  'getSupportTicketComments',
  'getSupportTicketAttachments',
  'attachSupportTicketFile',
];

const registeredToolNames = (): string[] =>
  MacroRegistry.flatMap((macro) => (macro.tools || []).map((tool: any) => tool?.function?.name))
    .filter((name): name is string => Boolean(name));

const registryAddressableNames = (): string[] =>
  MacroRegistry.flatMap((macro) => [
    macro.name,
    (macro as any).alias,
    ...(macro.tools || []).map((tool: any) => tool?.function?.name),
  ]).filter((name): name is string => Boolean(name));

describe('MacroRegistry contract', () => {
  it('still contains every expected server-side tool', () => {
    const registered = registeredToolNames();

    expect(
      EXPECTED_SERVER_TOOL_NAMES.filter((name) => !registered.includes(name))
    ).toEqual([]);
  });

  it('registers each tool once', () => {
    const registered = registeredToolNames();
    const duplicates = registered.filter((name, index) => registered.indexOf(name) !== index);

    expect(duplicates).toEqual([]);
  });

  it('never registers a client-only tool', () => {
    const addressable = registryAddressableNames();

    expect(CLIENT_ADVERTISED_TOOL_NAMES.filter((name) => addressable.includes(name))).toEqual([]);
  });

  it('has no server-side definition directory for a client-only macro', () => {
    // Every other client macro (form, component, chart, d3) is client-owned with
    // no server file. `image` was the lone exception; keeping a definition around
    // makes it look like a registration is missing. Re-introducing one should
    // fail this test and force a conversation about the design.
    const macroRoot = path.resolve(__dirname, '..');

    expect(
      CLIENT_ADVERTISED_TOOL_NAMES.filter((name) => existsSync(path.join(macroRoot, name)))
    ).toEqual([]);
  });
});
