import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { getGraphService, serviceUnavailable, trimLink, trimNode } from "./utils";

export type GetNodeLinksMacroParams = {
  id: number;
  direction?: "in" | "out" | "both";
  types?: string[];
  limit?: number;
};

/** Lists the typed edges touching a node, with resolved endpoint names. */
const GetNodeLinksMacro = async (params: GetNodeLinksMacroParams, chatState: ChatState) => {
  const { context } = chatState;
  const { id, direction = "both", types } = params;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  if (id === undefined || id === null) {
    return {
      success: false,
      error: "id parameter is required",
      tool: "graphLinks",
      params,
      instructions: `## Graph Links — Missing Parameter\n\n**id** is required.\n\n### Recovery Options:\n- Use \`searchGraph\` to find node ids`,
    };
  }

  const graphSvc = getGraphService(chatState);
  if (!graphSvc) return serviceUnavailable("graphLinks", params);

  try {
    const rawLinks = await graphSvc.getNodeLinks([Number(id)], { direction, types, limit });
    const links = rawLinks.map(trimLink);

    const endpointIds = Array.from(
      new Set(links.flatMap((l) => [l.source, l.target]))
    );
    const endpoints = (await graphSvc.getNodes(endpointIds)).map(trimNode);
    const byId = new Map(endpoints.map((n) => [n.id, n]));
    const label = (nid: number) => byId.get(nid)?.name ?? `#${nid}`;

    return {
      success: true,
      data: { links, endpoints, count: links.length },
      tool: "graphLinks",
      params,
      instructions: `## Edges for node ${id} (${links.length}, direction: ${direction})\n\n${links
        .map((l) => `- ${label(l.source)} -${l.types.join("+")}-> ${label(l.target)}${l.title ? ` (${l.title})` : ""}`)
        .join("\n") || "_No edges._"}\n\n### Next Steps:\n- \`getGraphNode\` on any endpoint id for details\n- \`exploreGraph\` for a multi-level walk`,
    };
  } catch (error) {
    context.error("GetNodeLinksMacro failed", { error, id }, "GetNodeLinksMacro");
    return {
      success: false,
      error: `Failed to get links: ${(error as Error)?.message ?? "Unknown error"}`,
      tool: "graphLinks",
      params,
      instructions: `## Graph Links — Error\n\n${(error as Error)?.message ?? "Unknown error"}\n\n### Recovery Options:\n- Verify the id via \`searchGraph\`\n- The project may not be indexed — edges only exist for indexed projects`,
    };
  }
};

const GetNodeLinksMacroDefinition: MacroComponentDefinition<typeof GetNodeLinksMacro> = {
  name: "GetNodeLinks",
  nameSpace: "zepz-engineer",
  description: "Lists the typed edges (dependencies, calls, inheritance, symlinks) touching a Reactor graph node.",
  component: GetNodeLinksMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "graphLinks",
  runat: "server",
  icon: "link",
  category: "graph",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      safeForAutoExecution: true,
      function: {
        icon: "link",
        name: "graphLinks",
        description: "List the typed edges touching a Reactor graph node, with resolved endpoint names.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "number",
              description: "The node id whose edges to list.",
            },
            direction: {
              type: "string",
              enum: ["in", "out", "both"],
              description: "Edge direction (default both).",
              default: "both",
            },
            types: {
              type: "array",
              items: { type: "string" },
              description: "Restrict to these edge types (e.g. DEPENDENCY, CALL, SYMLINK).",
            },
            limit: {
              type: "number",
              description: "Maximum edges (default 50, max 200).",
              default: 50,
            },
          },
          required: ["id"],
        },
      },
    },
  ],
};

export default GetNodeLinksMacroDefinition;
