import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorNode } from "@reactory/server-modules/reactory-reactor/types/model.types";
import { getGraphService, serviceUnavailable, trimNode } from "./utils";

export type GetNodeChildrenMacroParams = {
  id: number;
  key?: string;
  filter?: string;
  page?: number;
  pageSize?: number;
};

/**
 * Walk-one-level primitive. Uses the lazy filesystem expansion, so it works on
 * projects that have been cataloged but not fully indexed.
 */
const GetNodeChildrenMacro = async (params: GetNodeChildrenMacroParams, chatState: ChatState) => {
  const { context } = chatState;
  const { id, key, filter } = params;
  const page = Math.max(params.page ?? 1, 1);
  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 200);

  if (id === undefined || id === null) {
    return {
      success: false,
      error: "id parameter is required",
      tool: "graphChildren",
      params,
      instructions: `## Graph Children — Missing Parameter\n\n**id** is required.\n\n### Recovery Options:\n- Use \`searchGraph\` to find node ids\n- Use \`listProjects\` + \`getProject\` to find catalog roots`,
    };
  }

  const graphSvc = getGraphService(chatState);
  if (!graphSvc) return serviceUnavailable("graphChildren", params);

  try {
    const node = await graphSvc.getNode(Number(id), key);
    let children = await graphSvc.getChildren([node as ReactorNode]);

    if (filter) {
      try {
        const rx = new RegExp(filter);
        // The filter only narrows files, never folders (tree stays navigable).
        children = children.filter(
          (c) => c.type === "FOLDER" || rx.test(c.name)
        );
      } catch {
        // Invalid regex — ignore the filter rather than failing the walk.
      }
    }

    const start = (page - 1) * pageSize;
    const paged = children.slice(start, start + pageSize);
    const nodes = paged.map(trimNode);

    return {
      success: true,
      data: {
        parent: trimNode(node),
        nodes,
        count: nodes.length,
        total: children.length,
        page,
        pageSize,
        hasNext: start + pageSize < children.length,
      },
      tool: "graphChildren",
      params,
      instructions: `## Children of ${node.name} (${children.length} total, page ${page})\n\n${nodes
        .map((n) => `- **${n.name}** (${n.type}${n.kind === "symlink" ? `, symlink -> ${n.symlinkTarget ?? "?"}` : ""}, id: ${n.id})`)
        .join("\n") || "_No children._"}\n\n### Next Steps:\n- Expand a child with \`graphChildren\` (pass its id and key)\n- FILE nodes expand into their symbols\n- Symlink nodes never expand — follow the target via its SYMLINK edge instead`,
    };
  } catch (error) {
    context.error("GetNodeChildrenMacro failed", { error, id }, "GetNodeChildrenMacro");
    return {
      success: false,
      error: `Failed to get children: ${(error as Error)?.message ?? "Unknown error"}`,
      tool: "graphChildren",
      params,
      instructions: `## Graph Children — Error\n\n${(error as Error)?.message ?? "Unknown error"}\n\n### Recovery Options:\n- Provide the ancestry \`key\` ("rootId|...|nodeId") — lazy tree nodes need it after a cache expiry\n- Verify the id via \`searchGraph\``,
    };
  }
};

const GetNodeChildrenMacroDefinition: MacroComponentDefinition<typeof GetNodeChildrenMacro> = {
  name: "GetNodeChildren",
  nameSpace: "zepz-engineer",
  description: "Expands one level of a Reactor graph node's children (folders, files, symbols). Works on cataloged projects even before full indexing.",
  component: GetNodeChildrenMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "graphChildren",
  runat: "server",
  icon: "account_tree",
  category: "graph",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      safeForAutoExecution: true,
      function: {
        icon: "account_tree",
        name: "graphChildren",
        description: "Expand one level of a Reactor graph node's children. Folders expand to entries, files expand to symbols.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "number",
              description: "The deterministic node id to expand.",
            },
            key: {
              type: "string",
              description: "Optional ancestry key ('rootId|...|nodeId') for reliable resolution of lazy tree nodes.",
            },
            filter: {
              type: "string",
              description: "Optional regex applied to file names (folders always pass).",
            },
            page: {
              type: "number",
              description: "Page number (default 1).",
              default: 1,
            },
            pageSize: {
              type: "number",
              description: "Children per page (default 50, max 200).",
              default: 50,
            },
          },
          required: ["id"],
        },
      },
    },
  ],
};

export default GetNodeChildrenMacroDefinition;
