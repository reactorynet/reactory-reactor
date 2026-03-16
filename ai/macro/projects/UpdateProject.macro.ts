import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorProjectService, IReactorProject } from "@reactory/server-modules/reactory-reactor/types/service.types";

export type UpdateProjectMacroParams = {
  idOrPath: string;
  name?: string;
  nameSpace?: string;
  version?: string;
  description?: string;
  repoPath?: string;
  repoUrl?: string;
  projectTypes?: string[];
  projectStatus?: "ACTIVE" | "INACTIVE" | "ARCHIVED" | "DEPRECATED";
  tags?: string[];
  tasksUrl?: string;
  format?: "json" | "markdown" | "summary";
}

const UpdateProjectMacro = async (
  params: UpdateProjectMacroParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    idOrPath,
    name,
    nameSpace,
    version,
    description,
    repoPath,
    repoUrl,
    projectTypes,
    projectStatus,
    tags,
    tasksUrl,
    format = "json",
  } = params;

  if (!idOrPath) {
    return {
      success: false,
      error: "idOrPath parameter is required",
      tool: 'updateProject',
      params: params,
      instructions: `## Update Project \u2014 Missing Parameter\n\n**idOrPath** is required.\n\n### Recovery Options:\n- Use \`listProjects\` to find project IDs`
    };
  }

  try {
    context.debug("Starting UpdateProjectMacro execution", { params }, "UpdateProjectMacro");
    const reactorProjectService = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    
    if (!reactorProjectService) {
      context.error("ReactorProjectService not found", {}, "UpdateProjectMacro");
      return {
        success: false,
        error: "ReactorProjectService is not available",
        tool: 'updateProject',
        params: params,
        instructions: `## Update Project \u2014 Service Unavailable\n\nThe ReactorProjectService is not registered.\n\n### Recovery Options:\n- Use \`svc\` with action="list" to check available services`
      };
    }

    context.debug("ReactorProjectService retrieved successfully", {}, "UpdateProjectMacro");
    
    // First, get the existing project to verify it exists
    const existingProject = await reactorProjectService.getProject(idOrPath);
    
    if (!existingProject) {
      return {
        success: false,
        error: `Project not found with idOrPath: ${idOrPath}`,
        tool: 'updateProject',
        params: params,
        instructions: `## Update Project \u2014 Not Found\n\nNo project matches "${idOrPath}".\n\n### Recovery Options:\n- Use \`listProjects\` to find valid project identifiers`
      };
    }

    context.debug("Existing project found", { projectId: existingProject.id, projectName: existingProject.name }, "UpdateProjectMacro");
    
    // Prepare update data
    const updateData: Partial<IReactorProject> = {
      updated: new Date()
    };

    // Only include fields that are provided
    if (name !== undefined) updateData.name = name;
    if (nameSpace !== undefined) updateData.nameSpace = nameSpace;
    if (version !== undefined) updateData.version = version;
    if (description !== undefined) updateData.description = description;
    if (repoPath !== undefined) updateData.repoPath = repoPath;
    if (repoUrl !== undefined) updateData.repoUrl = repoUrl;
    if (projectTypes !== undefined) updateData.projectTypes = projectTypes as any;
    if (projectStatus !== undefined) updateData.projectStatus = projectStatus as any;
    if (tags !== undefined) updateData.tags = tags;
    if (tasksUrl !== undefined) updateData.tasksUrl = tasksUrl;

    // Update the project
    const updatedProject = await reactorProjectService.updateProject(idOrPath, updateData);

    // Store in chat state for AI reference
    chatState.vars.lastUpdatedProject = updatedProject;

    context.info(`Updated project`, {
      id: updatedProject.id,
      name: updatedProject.name,
      updatedFields: Object.keys(updateData).filter(key => key !== 'updated')
    }, "UpdateProjectMacro");

    let output;
    switch (format) {
      case "markdown":
        output = `
# Project Updated: ${updatedProject.name}

## Updated Project Details
- **ID**: ${updatedProject.id}
- **FQN**: ${updatedProject.fqn}
- **Name**: ${updatedProject.name}
- **Namespace**: ${updatedProject.nameSpace}
- **Version**: ${updatedProject.version}
- **Description**: ${updatedProject.description || 'N/A'}
- **Status**: ${updatedProject.projectStatus || 'N/A'}

## Repository Information
- **Repo Path**: ${updatedProject.repoPath || 'N/A'}
- **Repo URL**: ${updatedProject.repoUrl || 'N/A'}

## Project Types
${updatedProject.projectTypes?.map(type => `- ${type}`).join('\n') || '- N/A'}

## Tags
${updatedProject.tags?.map(tag => `- ${tag}`).join('\n') || '- N/A'}

## Updated
- **Updated At**: ${updatedProject.updated ? new Date(updatedProject.updated).toLocaleString() : 'N/A'}

## Updated Fields
${Object.keys(updateData).filter(key => key !== 'updated').map(field => `- ${field}`).join('\n')}
        `;
        break;
      case "summary":
        output = {
          summary: {
            message: `Project "${updatedProject.name}" updated successfully`,
            action: "updated",
            projectId: updatedProject.id,
            projectName: updatedProject.name,
            updatedAt: updatedProject.updated,
            updatedFields: Object.keys(updateData).filter(key => key !== 'updated')
          },
          project: {
            id: updatedProject.id,
            name: updatedProject.name,
            nameSpace: updatedProject.nameSpace,
            version: updatedProject.version,
            description: updatedProject.description,
            projectStatus: updatedProject.projectStatus,
            repoUrl: updatedProject.repoUrl,
            repoPath: updatedProject.repoPath,
            projectTypes: updatedProject.projectTypes,
            tags: updatedProject.tags,
            updated: updatedProject.updated
          },
          changes: updateData
        };
        break;
      default: // json
        output = {
          summary: {
            message: `Project "${updatedProject.name}" updated successfully`,
            action: "updated",
            projectId: updatedProject.id,
            projectName: updatedProject.name,
            updatedAt: updatedProject.updated,
            updatedFields: Object.keys(updateData).filter(key => key !== 'updated')
          },
          project: updatedProject,
          changes: updateData
        };
    }

    return {
      success: true,
      data: output,
      tool: 'updateProject',
      params: params,
      format: format,
      instructions: `
## Project Update Results

Successfully updated project: "${updatedProject.name}"

### Project Details:
- **Project ID**: ${updatedProject.id}
- **FQN**: ${updatedProject.fqn}
- **Name**: ${updatedProject.name}
- **Namespace**: ${updatedProject.nameSpace}
- **Version**: ${updatedProject.version}
- **Status**: ${updatedProject.projectStatus || 'N/A'}
- **Description**: ${updatedProject.description || 'N/A'}

### Repository Information:
- **Repo Path**: ${updatedProject.repoPath || 'N/A'}
- **Repo URL**: ${updatedProject.repoUrl || 'N/A'}

### Project Types:
${updatedProject.projectTypes?.map(type => `- ${type}`).join('\n') || '- N/A'}

### Tags:
${updatedProject.tags?.map(tag => `- ${tag}`).join('\n') || '- N/A'}

### Updated:
- **Updated At**: ${updatedProject.updated ? new Date(updatedProject.updated).toLocaleString() : 'N/A'}

### Fields Updated:
${Object.keys(updateData).filter(key => key !== 'updated').map(field => `- ${field}`).join('\n')}

### State Variables Available:
- lastUpdatedProject: The updated project

The project has been successfully updated with the specified changes.
      `
    };
    
  } catch (error) {
    context.error("Error updating project", { error, idOrPath }, "UpdateProjectMacro");
    return {
      success: false,
      error: `Failed to update project: ${error?.message ?? "Unknown error"}`,
      tool: 'updateProject',
      params: params,
      instructions: `## Update Project \u2014 Error\n\n${error?.message ?? 'Unknown error'}\n\n### Recovery Options:\n- Verify the parameters and retry\n- Use \`getProject\` to inspect the current state`
    };
  }
};

const UpdateProjectMacroDefinition: MacroComponentDefinition<typeof UpdateProjectMacro> = {
  name: "UpdateProject",
  nameSpace: "zepz-engineer",
  description: `Updates an existing Reactor project with the specified changes. Returns structured data for AI analysis.`,
  component: UpdateProjectMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "updateProject",
  runat: "server",
  icon: "edit",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "edit",
        name: "updateProject",
        description: "Updates an existing Reactor project with the specified changes. Returns structured data for AI analysis.",
        parameters: {
          type: "object",
          properties: {
            idOrPath: {
              type: "string",
              description: "The project ID, FQN, name, or repo path to update.",
            },
            name: {
              type: "string",
              description: "The new name for the project.",
            },
            nameSpace: {
              type: "string",
              description: "The new namespace for the project.",
            },
            version: {
              type: "string",
              description: "The new version for the project.",
            },
            description: {
              type: "string",
              description: "The new description for the project.",
            },
            repoPath: {
              type: "string",
              description: "The new local repository path for the project.",
            },
            repoUrl: {
              type: "string",
              description: "The new remote repository URL for the project.",
            },
            projectTypes: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of new project types (e.g., ['typescript', 'reactjs', 'nodejs']).",
            },
            projectStatus: {
              type: "string",
              enum: ["ACTIVE", "INACTIVE", "ARCHIVED", "DEPRECATED"],
              description: "The new status for the project.",
            },
            tags: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of new tags for the project.",
            },
            tasksUrl: {
              type: "string",
              description: "The new URL to the tasks/project management system.",
            },
            format: {
              type: "string",
              enum: ["json", "markdown", "summary"],
              description: "Output format for the results.",
              default: "json"
            }
          },
          required: ["idOrPath"],
        },
      },
    },
  ],
};

export default UpdateProjectMacroDefinition; 