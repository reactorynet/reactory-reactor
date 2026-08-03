import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { getGraphService, serviceUnavailable, trimNode } from "./utils";

export type GetGraphNodeMacroParams = {
  id: number;
  key?: string;
};

/** Full detail for a single graph node plus a summary of its edges by type. */
const GetGraphNodeMacro = async (params: GetGraphNodeMacroParams, chatState: ChatState) => {
  const { context } = chatState;
  const { id, key } = params;

  if (id === undefined || id === null) {
    return {
      success: false,
      error: "id parameter is required",
      tool: "getGraphNode",
      params,
      instructions: `## Get Graph Node — Missing Parameter\n\n**id** is required (a deterministic node id).\n\n### Recovery Options:\n- Use \`searchGraph\` to find node ids by name`,
    };
  }

  const graphSvc = getGraphService(chatState);
  if (!graphSvc) return serviceUnavailable("getGraphNode", params);

  try {
    let node;
    try {
      node = await graphSvc.getNode(Number(id), key);
    } catch {
      // Fall back to the batch resolver (persisted graph / placeholder).
      [node] = await graphSvc.getNodes([Number(id)]);
    }

    const links = await graphSvc.getNodeLinks([Number(id)], { limit: 25 });
    const outByType: Record<string, number> = {};
    const inByType: Record<string, number> = {};
    for (const link of links) {
      const types = (link.types ?? []).map(String);
      const bucket = link.source === Number(id) ? outByType : inByType;
      for (const t of types) bucket[t] = (bucket[t] ?? 0) + 1;
    }

    const trimmed = trimNode(node);
    return {
      success: true,
      data: { node: trimmed, linkSummary: { outgoing: outByType, incoming: inByType, sampled: links.length } },
      tool: "getGraphNode",
      params,
      instructions: `## Graph Node: ${trimmed.name}\n\n- **Id**: ${trimmed.id}\n- **Type**: ${trimmed.type}${trimmed.kind ? ` (${trimmed.kind})` : ""}\n- **Path**: ${trimmed.path ?? "N/A"}\n- **Key**: ${trimmed.key ?? "N/A"}\n- **Parent**: ${trimmed.parentId ?? "none"}\n${trimmed.symlinkTarget ? `- **Symlink target**: ${trimmed.symlinkTarget}\n` : ""}\n### Link Summary (sampled ${links.length}):\n- Outgoing: ${JSON.stringify(outByType)}\n- Incoming: ${JSON.stringify(inByType)}\n\n### Next Steps:\n- \`graphChildren\` to expand children\n- \`graphLinks\` for the full edge list\n- \`exploreGraph\` for the surrounding neighbourhood`,
    };
  } catch (error) {
    context.error("GetGraphNodeMacro failed", { error, id }, "GetGraphNodeMacro");
    return {
      success: false,
      error: `Failed to get node: ${(error as Error)?.message ?? "Unknown error"}`,
      tool: "getGraphNode",
      params,
      instructions: `## Get Graph Node — Error\n\n${(error as Error)?.message ?? "Unknown error"}\n\n### Recovery Options:\n- Verify the id via \`searchGraph\`\n- Provide the ancestry \`key\` ("rootId|...|nodeId") for lazy tree nodes`,
    };
  }
};

const GetGraphNodeMacroDefinition: MacroComponentDefinition<typeof GetGraphNodeMacro> = {
  name: "GetGraphNode",
  nameSpace: "zepz-engineer",
  description: "Retrieves a single Reactor graph node by id with a summary of its incoming/outgoing edges by type.",
  component: GetGraphNodeMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "getGraphNode",
  runat: "server",
  icon: "hub",
  category: "graph",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      safeForAutoExecution: true,
      function: {
        icon: "hub",
        name: "getGraphNode",
        description: "Get a Reactor graph node by id, including a per-type summary of its incoming and outgoing edges.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "number",
              description: "The deterministic node id (from searchGraph or a prior traversal).",
            },
            key: {
              type: "string",
              description: "Optional ancestry key ('rootId|...|nodeId') for lazily-materialized tree nodes.",
            },
          },
          required: ["id"],
        },
      },
    },
  ],
};

export default GetGraphNodeMacroDefinition;
