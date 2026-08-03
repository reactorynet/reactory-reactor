import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { getGraphService, serviceUnavailable, trimNode } from "./utils";

export type SearchGraphMacroParams = {
  term: string;
  projectName?: string;
  nameSpace?: string;
  limit?: number;
};

/**
 * Entry point for graph exploration: find node ids by name/description, then
 * follow up with getGraphNode / graphChildren / exploreGraph.
 */
const SearchGraphMacro = async (params: SearchGraphMacroParams, chatState: ChatState) => {
  const { context } = chatState;
  const { term, projectName, nameSpace } = params;
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);

  if (!term || term.trim().length === 0) {
    return {
      success: false,
      error: "term parameter is required",
      tool: "searchGraph",
      params,
      instructions: `## Search Graph — Missing Parameter\n\n**term** is required.\n\n### Recovery Options:\n- Provide a file name, symbol name or free-text term\n- Scope with projectName + nameSpace for indexed-content search`,
    };
  }

  const graphSvc = getGraphService(chatState);
  if (!graphSvc) return serviceUnavailable("searchGraph", params);

  try {
    const results = await graphSvc.searchNodes(term, {
      name: projectName,
      nameSpace,
      limit,
    });
    const nodes = results.map(trimNode);

    return {
      success: true,
      data: { nodes, count: nodes.length },
      tool: "searchGraph",
      params,
      instructions: `## Graph Search Results\n\nFound ${nodes.length} node(s) matching "${term}"${projectName ? ` in ${nameSpace}.${projectName}` : ""}.\n\n${nodes
        .slice(0, 10)
        .map((n) => `- **${n.name}** (${n.type}, id: ${n.id})${n.path ? ` — ${n.path}` : ""}`)
        .join("\n")}\n\n### Next Steps:\n- Use \`getGraphNode\` with an id for full node details + link summary\n- Use \`exploreGraph\` with rootId to walk the neighbourhood\n- Use \`graphChildren\` to expand a folder/file one level`,
    };
  } catch (error) {
    context.error("SearchGraphMacro failed", { error, term }, "SearchGraphMacro");
    return {
      success: false,
      error: `Graph search failed: ${(error as Error)?.message ?? "Unknown error"}`,
      tool: "searchGraph",
      params,
      instructions: `## Search Graph — Error\n\n${(error as Error)?.message ?? "Unknown error"}\n\n### Recovery Options:\n- Retry without projectName/nameSpace scoping\n- Use \`listProjects\` to verify the project exists and is cataloged`,
    };
  }
};

const SearchGraphMacroDefinition: MacroComponentDefinition<typeof SearchGraphMacro> = {
  name: "SearchGraph",
  nameSpace: "zepz-engineer",
  description: "Searches the Reactor system graph for nodes by name or description. The entry point for walking a cataloged codebase graph.",
  component: SearchGraphMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "searchGraph",
  runat: "server",
  icon: "search",
  category: "graph",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      safeForAutoExecution: true,
      function: {
        icon: "search",
        name: "searchGraph",
        description: "Search the Reactor system graph for nodes (files, folders, symbols) by name or description. Returns node ids for follow-up traversal tools.",
        parameters: {
          type: "object",
          properties: {
            term: {
              type: "string",
              description: "The search term — file name, symbol name or free text.",
            },
            projectName: {
              type: "string",
              description: "Optional project name — with nameSpace, searches the project's content index.",
            },
            nameSpace: {
              type: "string",
              description: "Optional project nameSpace, used with projectName.",
            },
            limit: {
              type: "number",
              description: "Maximum results (default 20, max 50).",
              default: 20,
            },
          },
          required: ["term"],
        },
      },
    },
  ],
};

export default SearchGraphMacroDefinition;
