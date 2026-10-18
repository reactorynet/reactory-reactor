/**
 * Tools WorkflowWill will claim from the server-side `MacroRegistry`.
 *
 * Client tools (`form`, `component`, `chart`, `d3`, `image`) are intentionally
 * absent: they have no registry entry and are advertised by the client at
 * session creation via `syncClientCapabilities`. See `../clientTools.ts`.
 */
export const WORKFLOW_TOOL_INCLUDES: string[] = [
  'toolkit',
  'readFile',
  'writeFile',
  'safeEditFile',
  'snip',
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
  'httpPost',
  'httpGet',
  'httpPut',
  'httpDelete',
  'httpPatch',
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
  'amq',
  // System graph traversal tools
  'searchGraph',
  'getGraphNode',
  'graphChildren',
  'exploreGraph',
  'graphLinks',
  'createNodeEdge',
  'loadGraphPerspective',
  'deletePerspective',
  // Project management & cataloging tools
  'listProjects',
  'getProject',
  'createProject',
  'updateProject',
  'deleteProject',
  'searchProject',
  'catalogProject',
  // Skills tools
  'readSkill',
  'searchSkills',
  // UI & Side Panel Component mounting tools
  // NOTE: client-only tools are not listed here — the client advertises them.
  'side_panel_state',
  'host_fields',
  'host_field_update',
  'macros',
  'logout',
  // Chat & agent delegation
  'chats',
  'updateChatData',
];

export default WORKFLOW_TOOL_INCLUDES;
