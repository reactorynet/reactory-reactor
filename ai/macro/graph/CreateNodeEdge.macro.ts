import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorNode, ReactorNodeLink } from "@reactory/server-modules/reactory-reactor/types/model.types";
import { getGraphService, serviceUnavailable, trimLink, trimNode } from "./utils";

export type CreateNodeEdgeMacroParams = {
  from: number;
  to: number;
  types?: string[];
  title?: string;
  description?: string;
};

const VALID_EDGE_TYPES = [
  "INPUT",
  "OUTPUT",
  "DEPENDENCY",
  "CONNECTION",
  "INFERRED",
  "DIRECT",
  "CALL",
  "INHERITS",
  "IMPLEMENTS",
  "REFERENCE",
];

/**
 * Creates (or updates — edge ids are deterministic on endpoints + primary
 * type) a typed edge between two graph nodes. This is the write counterpart
 * to the read-only graph traversal tools, and is deliberately NOT flagged
 * safeForAutoExecution: in safe_auto/plan modes the agent must get approval.
 */
const CreateNodeEdgeMacro = async (params: CreateNodeEdgeMacroParams, chatState: ChatState) => {
  const { context } = chatState;
  const { from, to, title, description } = params;
  const types = (params.types?.length ? params.types : ["DIRECT"]).map((t) => String(t).toUpperCase());

  const fail = (error: string, recovery: string) => ({
    success: false,
    error,
    tool: "createNodeEdge",
    params,
    instructions: `## Create Node Edge — Failed\n\n${error}\n\n### Recovery Options:\n${recovery}`,
  });

  if (from === undefined || from === null || to === undefined || to === null) {
    return fail(
      "Both 'from' and 'to' node ids are required",
      "- Use `searchGraph` or `exploreGraph` to find the endpoint node ids"
    );
  }
  if (Number(from) === Number(to)) {
    return fail(
      "'from' and 'to' must be different nodes (self-edges are not allowed)",
      "- Verify the endpoint ids — they are identical"
    );
  }
  const invalidTypes = types.filter((t) => !VALID_EDGE_TYPES.includes(t));
  if (invalidTypes.length) {
    return fail(
      `Unknown edge type(s): ${invalidTypes.join(", ")}`,
      `- Valid types: ${VALID_EDGE_TYPES.join(", ")}\n- SYMLINK and CONTAINS are system-managed and cannot be created manually`
    );
  }

  const graphSvc = getGraphService(chatState);
  if (!graphSvc) return serviceUnavailable("createNodeEdge", params);

  try {
    // Resolve endpoints first so the result names them (placeholders are
    // allowed — edges may point at not-yet-materialized nodes by design).
    const [sourceNode, targetNode] = await graphSvc.getNodes([Number(from), Number(to)]);

    const link = await graphSvc.createLink(
      { id: Number(from) } as ReactorNode,
      types[0],
      { id: Number(to) } as ReactorNode
    );
    const updated = await graphSvc.updateLink({
      ...link,
      types,
      title: title ?? link.title,
      description: description ?? link.description,
    } as ReactorNodeLink);

    const trimmed = trimLink(updated);
    const source = trimNode(sourceNode);
    const target = trimNode(targetNode);

    return {
      success: true,
      data: { link: trimmed, source, target },
      tool: "createNodeEdge",
      params,
      instructions: `## Edge Created\n\n**${source.name}** (${source.id}) -${trimmed.types.join("+")}-> **${target.name}** (${target.id})\n\n- **Edge id**: ${trimmed.id}\n- **Title**: ${trimmed.title ?? "N/A"}\n${source.name.startsWith("#") || target.name.startsWith("#") ? "\n> ⚠️ One endpoint is an unresolved placeholder — verify the node id is correct.\n" : ""}\n### Next Steps:\n- \`graphLinks\` on either endpoint to confirm the edge\n- Edge ids are deterministic on (from, to, primary type) — re-running with the same endpoints updates rather than duplicates`,
    };
  } catch (error) {
    context.error("CreateNodeEdgeMacro failed", { error, from, to }, "CreateNodeEdgeMacro");
    return fail(
      `Failed to create edge: ${(error as Error)?.message ?? "Unknown error"}`,
      "- Verify both node ids via `searchGraph`\n- Retry with a single primary type (e.g. DEPENDENCY)"
    );
  }
};

const CreateNodeEdgeMacroDefinition: MacroComponentDefinition<typeof CreateNodeEdgeMacro> = {
  name: "CreateNodeEdge",
  nameSpace: "zepz-engineer",
  description: "Creates a typed edge (dependency, call, reference...) between two Reactor graph nodes. Idempotent on (from, to, primary type).",
  component: CreateNodeEdgeMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "createNodeEdge",
  runat: "server",
  icon: "add_link",
  category: "graph",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      // Write operation — requires approval in safe_auto/plan modes.
      safeForAutoExecution: false,
      function: {
        icon: "add_link",
        name: "createNodeEdge",
        description: "Create a typed edge between two Reactor graph nodes (by id). Idempotent: re-creating the same (from, to, primary type) updates the existing edge.",
        parameters: {
          type: "object",
          properties: {
            from: {
              type: "number",
              description: "Source node id (from searchGraph/exploreGraph).",
            },
            to: {
              type: "number",
              description: "Target node id.",
            },
            types: {
              type: "array",
              items: { type: "string", enum: VALID_EDGE_TYPES },
              description: "Relationship types (default [DIRECT]). First entry is the primary type used for the deterministic edge id.",
            },
            title: {
              type: "string",
              description: "Short human label for the edge (e.g. the symbol or API being referenced).",
            },
            description: {
              type: "string",
              description: "Longer description of why the relationship exists.",
            },
          },
          required: ["from", "to"],
        },
      },
    },
  ],
};

export default CreateNodeEdgeMacroDefinition;
