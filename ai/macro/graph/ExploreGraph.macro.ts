import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { adjacencyMarkdown, getGraphService, serviceUnavailable, trimLink, trimNode } from "./utils";

export type ExploreGraphMacroParams = {
  rootId: number;
  depth?: number;
  direction?: "in" | "out" | "both";
  linkTypes?: string[];
  nodeTypes?: string[];
  limit?: number;
};

/**
 * Bounded neighbourhood walk over the persisted graph. Token-safe: capped
 * limits, trimmed node shapes, compact adjacency-list rendering.
 */
const ExploreGraphMacro = async (params: ExploreGraphMacroParams, chatState: ChatState) => {
  const { context } = chatState;
  const { rootId, direction = "both", linkTypes, nodeTypes } = params;
  const depth = Math.min(Math.max(params.depth ?? 2, 1), 3);
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);

  if (rootId === undefined || rootId === null) {
    return {
      success: false,
      error: "rootId parameter is required",
      tool: "exploreGraph",
      params,
      instructions: `## Explore Graph — Missing Parameter\n\n**rootId** is required.\n\n### Recovery Options:\n- Use \`searchGraph\` to find a starting node id`,
    };
  }

  const graphSvc = getGraphService(chatState);
  if (!graphSvc) return serviceUnavailable("exploreGraph", params);

  try {
    const subgraph = await graphSvc.getSubgraph(Number(rootId), {
      depth,
      direction,
      linkTypes,
      nodeTypes,
      limit,
      // Persisted-graph only — lazy materialization is not token-safe here.
      materialize: false,
    });

    const nodes = subgraph.nodes.map(trimNode);
    const links = subgraph.links.map(trimLink);

    return {
      success: true,
      data: {
        rootId: subgraph.rootId,
        nodes,
        links,
        truncated: subgraph.truncated,
        stats: subgraph.stats,
      },
      tool: "exploreGraph",
      params,
      instructions: `## Graph Neighbourhood (root ${rootId}, depth ${depth})\n\n${subgraph.truncated ? "> ⚠️ Result truncated — narrow with linkTypes/nodeTypes or reduce depth.\n\n" : ""}${nodes.length} node(s), ${links.length} edge(s):\n\n${adjacencyMarkdown(nodes, links)}\n\n### Next Steps:\n- \`getGraphNode\` for detail on any node id\n- \`graphChildren\` to lazily expand un-indexed folders\n- Re-run with linkTypes (e.g. ["DEPENDENCY","CALL"]) to focus the walk`,
    };
  } catch (error) {
    context.error("ExploreGraphMacro failed", { error, rootId }, "ExploreGraphMacro");
    return {
      success: false,
      error: `Graph exploration failed: ${(error as Error)?.message ?? "Unknown error"}`,
      tool: "exploreGraph",
      params,
      instructions: `## Explore Graph — Error\n\n${(error as Error)?.message ?? "Unknown error"}\n\n### Recovery Options:\n- Verify rootId via \`searchGraph\`\n- The project may not be indexed yet — use \`catalogProject\` first, or walk lazily with \`graphChildren\``,
    };
  }
};

const ExploreGraphMacroDefinition: MacroComponentDefinition<typeof ExploreGraphMacro> = {
  name: "ExploreGraph",
  nameSpace: "zepz-engineer",
  description: "Walks a bounded neighbourhood of the Reactor system graph around a root node, returning nodes and typed edges as a compact adjacency list.",
  component: ExploreGraphMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "exploreGraph",
  runat: "server",
  icon: "share",
  category: "graph",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      safeForAutoExecution: true,
      function: {
        icon: "share",
        name: "exploreGraph",
        description: "Walk a bounded neighbourhood of the Reactor system graph from a root node id. Returns nodes and typed edges (DEPENDENCY, CALL, INHERITS, SYMLINK, CONTAINS...).",
        parameters: {
          type: "object",
          properties: {
            rootId: {
              type: "number",
              description: "The node id to start the walk from.",
            },
            depth: {
              type: "number",
              description: "BFS depth (default 2, max 3).",
              default: 2,
            },
            direction: {
              type: "string",
              enum: ["in", "out", "both"],
              description: "Edge direction to follow (default both).",
              default: "both",
            },
            linkTypes: {
              type: "array",
              items: { type: "string" },
              description: "Restrict to these edge types (e.g. DEPENDENCY, CALL, INHERITS, IMPLEMENTS, SYMLINK, CONTAINS).",
            },
            nodeTypes: {
              type: "array",
              items: { type: "string" },
              description: "Restrict result nodes to these types (e.g. FILE, FOLDER, FUNCTION).",
            },
            limit: {
              type: "number",
              description: "Maximum nodes returned (default 100, max 200).",
              default: 100,
            },
          },
          required: ["rootId"],
        },
      },
    },
  ],
};

export default ExploreGraphMacroDefinition;
