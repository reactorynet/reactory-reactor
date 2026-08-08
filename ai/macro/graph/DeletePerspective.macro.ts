import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorGraphPerspectiveModel } from "@reactory/server-modules/reactory-reactor/models/ReactorGraphPerspective";
import { ObjectId } from "mongodb";

export type DeletePerspectiveMacroParams = {
  id?: string;
  name?: string;
  projectId?: string;
  confirm?: boolean;
  format?: "json" | "markdown" | "summary";
};

const DeletePerspectiveMacro = async (
  params: DeletePerspectiveMacroParams,
  chatState: ChatState
) => {
  const { context } = chatState;
  const {
    id,
    name,
    projectId,
    confirm = true,
    format = "json",
  } = params;

  if (!id && !name && !projectId) {
    return {
      success: false,
      error: "At least one parameter (id, name, or projectId) is required.",
      tool: 'deletePerspective',
      params: params,
      instructions: `## Delete Perspective — Missing Parameters\n\nProvide at least one of: **id**, **name**, or **projectId**.`
    };
  }

  try {
    context.debug("Starting DeletePerspectiveMacro execution", { params }, "DeletePerspectiveMacro");

    const query: any = {};
    const conditions: any[] = [];

    if (id) {
      if (ObjectId.isValid(id)) {
        conditions.push({ _id: new ObjectId(id) });
      }
      conditions.push({ name: id }, { projectId: id });
    }

    if (name) {
      conditions.push({ name });
    }

    if (projectId) {
      conditions.push({ projectId });
    }

    query.$or = conditions;

    const matchedPerspectives = await ReactorGraphPerspectiveModel.find(query).lean();

    if (!matchedPerspectives || matchedPerspectives.length === 0) {
      return {
        success: false,
        error: `No perspectives found matching parameters.`,
        tool: 'deletePerspective',
        params: params,
        instructions: `## Delete Perspective — Not Found\n\nNo perspective matched the query.`
      };
    }

    const deleteResult = await ReactorGraphPerspectiveModel.deleteMany(query);

    const summary = {
      message: `Successfully deleted ${deleteResult.deletedCount} perspective(s).`,
      deletedCount: deleteResult.deletedCount,
      perspectives: matchedPerspectives.map(p => ({
        id: p._id?.toString(),
        name: p.name,
        projectId: p.projectId,
        owner: p.owner,
      })),
    };

    chatState.vars.lastDeletedPerspective = summary;

    return {
      success: true,
      data: summary,
      tool: 'deletePerspective',
      params: params,
      format,
      instructions: `
## Perspective Deletion Results

Successfully deleted **${deleteResult.deletedCount}** perspective(s):

${matchedPerspectives.map(p => `- **Name**: ${p.name} (ID: ${p._id}, Project: ${p.projectId || 'N/A'})`).join('\n')}
`
    };

  } catch (error) {
    context.error("Error deleting perspective", { error, params }, "DeletePerspectiveMacro");
    return {
      success: false,
      error: `Failed to delete perspective: ${(error as Error)?.message ?? "Unknown error"}`,
      tool: 'deletePerspective',
      params: params,
      instructions: `## Delete Perspective — Error\n\n${(error as Error)?.message ?? 'Unknown error'}`
    };
  }
};

const DeletePerspectiveMacroDefinition: MacroComponentDefinition<typeof DeletePerspectiveMacro> = {
  name: "DeletePerspective",
  nameSpace: "zepz-engineer",
  description: `Deletes one or more system graph perspectives by ID, name, or project ID.`,
  component: DeletePerspectiveMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "deletePerspective",
  runat: "server",
  icon: "delete_sweep",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "delete_sweep",
        name: "deletePerspective",
        description: "Deletes one or more system graph perspectives by ID, name, or project ID.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Perspective ID, name, or project ID to match.",
            },
            name: {
              type: "string",
              description: "Perspective name to delete.",
            },
            projectId: {
              type: "string",
              description: "Project ID whose perspectives should be deleted.",
            },
            confirm: {
              type: "boolean",
              description: "Confirmation flag (default true).",
              default: true,
            },
            format: {
              type: "string",
              enum: ["json", "markdown", "summary"],
              description: "Output format.",
              default: "json",
            },
          },
        },
      },
    },
  ],
};

export default DeletePerspectiveMacroDefinition;
