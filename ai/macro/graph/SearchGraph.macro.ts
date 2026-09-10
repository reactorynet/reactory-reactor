import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { adjacencyMarkdown, getGraphService, serviceUnavailable, trimLink, trimNode, TrimmedGraphNode } from "./utils";

/**
 * Bound on how many edges to request when rendering the richer markdown
 * format. searchGraph's node set is already capped ≤ 50 (server-side limit)
 * so this only needs to comfortably cover edges touching that many nodes.
 */
const LINK_FETCH_LIMIT = 200;

/**
 * Defensive, macro-local size cap. searchGraph already trims nodes and clamps
 * limit ≤ 50 server-side, but neither of those bounds the payload if individual
 * fields (e.g. deeply nested monorepo paths, symlink targets) are unusually
 * long. Rather than depending solely on the shared ToolResultProcessor guard
 * to catch an oversized result after the fact, drop the heaviest optional
 * fields first and, if still too large, truncate the node list itself with an
 * explicit notice telling the caller how to narrow the query.
 */
const NODE_PAYLOAD_BUDGET = 8000;

function capNodePayload(nodes: TrimmedGraphNode[]): { nodes: TrimmedGraphNode[]; truncated: boolean; note?: string } {
  const size = (n: TrimmedGraphNode[]) => {
    try {
      return JSON.stringify(n).length;
    } catch {
      return Infinity;
    }
  };

  if (size(nodes) <= NODE_PAYLOAD_BUDGET) {
    return { nodes, truncated: false };
  }

  // Step 1: drop lower-value optional fields (path/kind/language/symlinkTarget)
  // before resorting to dropping whole nodes.
  const slimmed = nodes.map(({ id, name, type, key, parentId }) => ({ id, name, type, key, parentId }));
  if (size(slimmed) <= NODE_PAYLOAD_BUDGET) {
    return {
      nodes: slimmed,
      truncated: true,
      note: `Result fields were slimmed (path/kind/language/symlinkTarget dropped) to stay within the ${NODE_PAYLOAD_BUDGET}-character payload budget. Use getGraphNode with an id for full node details.`,
    };
  }

  // Step 2: still too large — clip the node count outright.
  let clipped = slimmed;
  while (clipped.length > 1 && size(clipped) > NODE_PAYLOAD_BUDGET) {
    clipped = clipped.slice(0, Math.ceil(clipped.length / 2));
  }
  return {
    nodes: clipped,
    truncated: true,
    note: `Result set was too large even after slimming fields; truncated to ${clipped.length} of ${nodes.length} node(s). Narrow your \`term\` or lower \`limit\` and re-run for the remaining matches.`,
  };
}

export type SearchGraphMacroParams = {
  term: string;
  projectName?: string;
  nameSpace?: string;
  limit?: number;
  /**
   * "json" (default) returns the existing { nodes, count } shape unchanged.
   * "markdown" additionally fetches the edges connecting the matched nodes to
   * one another and renders a compact adjacency-list via adjacencyMarkdown —
   * far fewer tokens than the equivalent JSON and shows how the results
   * relate to each other without an extra exploreGraph round-trip.
   */
  format?: "json" | "markdown";
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

  const format = params.format === "markdown" ? "markdown" : "json";

  try {
    const results = await graphSvc.searchNodes(term, {
      name: projectName,
      nameSpace,
      limit,
    });
    const trimmedNodes = results.map(trimNode);
    const { nodes, truncated, note } = capNodePayload(trimmedNodes);

    const baseInstructions = (extra?: string) =>
      `## Graph Search Results\n\nFound ${nodes.length} node(s) matching "${term}"${projectName ? ` in ${nameSpace}.${projectName}` : ""}.\n\n${
        extra ?? nodes
          .slice(0, 10)
          .map((n) => `- **${n.name}** (${n.type}, id: ${n.id})${n.path ? ` — ${n.path}` : ""}`)
          .join("\n")
      }${truncated ? `\n\n### Note:\n${note}` : ""}\n\n### Next Steps:\n- Use \`getGraphNode\` with an id for full node details + link summary\n- Use \`exploreGraph\` with rootId to walk the neighbourhood\n- Use \`graphChildren\` to expand a folder/file one level`;

    if (format === "markdown" && nodes.length > 0) {
      // Richer option: fetch edges touching the matched nodes and keep only
      // those where BOTH endpoints are within our result set, so the rendered
      // adjacency reflects how the search results relate to *each other*
      // rather than fanning out to every dependent of a popular hub node.
      const idSet = new Set(nodes.map((n) => n.id));
      let internalLinks: ReturnType<typeof trimLink>[] = [];
      try {
        const rawLinks = await graphSvc.getNodeLinks(Array.from(idSet), {
          direction: "both",
          limit: LINK_FETCH_LIMIT,
        });
        internalLinks = rawLinks
          .map(trimLink)
          .filter((l) => idSet.has(l.source) && idSet.has(l.target));
      } catch (linkError) {
        // Graceful degradation: if link lookup fails for any reason, fall back
        // to rendering the node list alone (adjacencyMarkdown handles an empty
        // links array by listing every node as "unlinked").
        context.warn("SearchGraphMacro link fetch failed, falling back to node-only markdown", { linkError }, "SearchGraphMacro");
      }

      const markdown = adjacencyMarkdown(nodes, internalLinks);

      return {
        success: true,
        data: markdown,
        tool: "searchGraph",
        params,
        instructions: baseInstructions(`${nodes.length} node(s), ${internalLinks.length} edge(s) among them:\n\n${markdown}`),
      };
    }

    return {
      success: true,
      data: { nodes, count: nodes.length, ...(truncated ? { truncated: true, totalMatched: trimmedNodes.length } : {}) },
      tool: "searchGraph",
      params,
      instructions: baseInstructions(),
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
            format: {
              type: "string",
              enum: ["json", "markdown"],
              description: "'json' (default) returns { nodes, count }. 'markdown' additionally fetches edges among the matched nodes and renders a compact adjacency list — fewer tokens and shows how results relate to each other.",
              default: "json",
            },
          },
          required: ["term"],
        },
      },
    },
  ],
};

export default SearchGraphMacroDefinition;
