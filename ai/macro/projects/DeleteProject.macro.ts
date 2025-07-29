import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorProjectService, IReactorProject } from "@reactory/server-modules/reactory-reactor/types/service.types";

export type DeleteProjectMacroParams = {
  idOrPath: string;
  confirm?: boolean;
  format?: "json" | "markdown" | "summary";
}

const DeleteProjectMacro = async (
  params: DeleteProjectMacroParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    idOrPath,
    confirm = false,
    format = "json",
  } = params;

  if (!idOrPath) {
    return {
      success: false,
      error: "idOrPath parameter is required",
      tool: 'deleteProject',
      params: params
    };
  }

  if (!confirm) {
    return {
      success: false,
      error: "Confirmation required. Set confirm=true to proceed with deletion.",
      tool: 'deleteProject',
      params: params
    };
  }

  try {
    context.debug("Starting DeleteProjectMacro execution", { params }, "DeleteProjectMacro");
    const reactorProjectService = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    
    if (!reactorProjectService) {
      context.error("ReactorProjectService not found", {}, "DeleteProjectMacro");
      return {
        success: false,
        error: "ReactorProjectService is not available",
        tool: 'deleteProject',
        params: params
      };
    }

    context.debug("ReactorProjectService retrieved successfully", {}, "DeleteProjectMacro");
    
    // First, get the project to verify it exists and get its details
    const project = await reactorProjectService.getProject(idOrPath);
    
    if (!project) {
      return {
        success: false,
        error: `Project not found with idOrPath: ${idOrPath}`,
        tool: 'deleteProject',
        params: params
      };
    }

    context.debug("Project found for deletion", { projectId: project.id, projectName: project.name }, "DeleteProjectMacro");
    
    // Store project details before deletion for reference
    const projectDetails = {
      id: project.id,
      name: project.name,
      nameSpace: project.nameSpace,
      version: project.version,
      description: project.description,
      repoUrl: project.repoUrl,
      repoPath: project.repoPath,
      projectTypes: project.projectTypes,
      projectStatus: project.projectStatus
    };

    // Delete the project
    const deleted = await reactorProjectService.deleteProject(idOrPath);

    if (!deleted) {
      return {
        success: false,
        error: `Failed to delete project with idOrPath: ${idOrPath}`,
        tool: 'deleteProject',
        params: params
      };
    }

    // Store in chat state for AI reference
    chatState.vars.lastDeletedProject = projectDetails;

    context.info(`Deleted project`, {
      id: projectDetails.id,
      name: projectDetails.name,
      nameSpace: projectDetails.nameSpace,
      version: projectDetails.version
    }, "DeleteProjectMacro");

    let output;
    switch (format) {
      case "markdown":
        output = `
# Project Deleted: ${projectDetails.name}

## Deleted Project Details
- **ID**: ${projectDetails.id}
- **Name**: ${projectDetails.name}
- **Namespace**: ${projectDetails.nameSpace}
- **Version**: ${projectDetails.version}
- **Description**: ${projectDetails.description || 'N/A'}
- **Status**: ${projectDetails.projectStatus || 'N/A'}

## Repository Information
- **Repo Path**: ${projectDetails.repoPath || 'N/A'}
- **Repo URL**: ${projectDetails.repoUrl || 'N/A'}

## Project Types
${projectDetails.projectTypes?.map(type => `- ${type}`).join('\n') || '- N/A'}

## Deletion Information
- **Deleted At**: ${new Date().toLocaleString()}
- **Deleted By**: ${context.user?.fullName || 'System'}
        `;
        break;
      case "summary":
        output = {
          summary: {
            message: `Project "${projectDetails.name}" deleted successfully`,
            action: "deleted",
            projectId: projectDetails.id,
            projectName: projectDetails.name,
            deletedAt: new Date(),
            deletedBy: context.user?.fullName || 'System'
          },
          project: projectDetails
        };
        break;
      default: // json
        output = {
          summary: {
            message: `Project "${projectDetails.name}" deleted successfully`,
            action: "deleted",
            projectId: projectDetails.id,
            projectName: projectDetails.name,
            deletedAt: new Date(),
            deletedBy: context.user?.fullName || 'System'
          },
          project: projectDetails
        };
    }

    return {
      success: true,
      data: output,
      tool: 'deleteProject',
      params: params,
      format: format,
      instructions: `
## Project Deletion Results

Successfully deleted project: "${projectDetails.name}"

### Deleted Project Details:
- **Project ID**: ${projectDetails.id}
- **Name**: ${projectDetails.name}
- **Namespace**: ${projectDetails.nameSpace}
- **Version**: ${projectDetails.version}
- **Status**: ${projectDetails.projectStatus || 'N/A'}
- **Description**: ${projectDetails.description || 'N/A'}

### Repository Information:
- **Repo Path**: ${projectDetails.repoPath || 'N/A'}
- **Repo URL**: ${projectDetails.repoUrl || 'N/A'}

### Project Types:
${projectDetails.projectTypes?.map(type => `- ${type}`).join('\n') || '- N/A'}

### Deletion Information:
- **Deleted At**: ${new Date().toLocaleString()}
- **Deleted By**: ${context.user?.fullName || 'System'}

### State Variables Available:
- lastDeletedProject: The deleted project details

The project has been permanently deleted from the system. This action cannot be undone.
      `
    };
    
  } catch (error) {
    context.error("Error deleting project", { error, idOrPath }, "DeleteProjectMacro");
    return {
      success: false,
      error: `Failed to delete project: ${error?.message ?? "Unknown error"}`,
      tool: 'deleteProject',
      params: params
    };
  }
};

const DeleteProjectMacroDefinition: MacroComponentDefinition<typeof DeleteProjectMacro> = {
  name: "DeleteProject",
  nameSpace: "zepz-engineer",
  description: `Deletes a Reactor project from the system. Requires confirmation. Returns structured data for AI analysis.`,
  component: DeleteProjectMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "deleteProject",
  runat: "server",
  icon: "delete_forever",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "delete_forever",
        name: "deleteProject",
        description: "Deletes a Reactor project from the system. Requires confirmation. Returns structured data for AI analysis.",
        parameters: {
          type: "object",
          properties: {
            idOrPath: {
              type: "string",
              description: "The project ID, FQN, name, or repo path to delete.",
            },
            confirm: {
              type: "boolean",
              description: "Confirmation flag. Must be set to true to proceed with deletion.",
              default: false
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

export default DeleteProjectMacroDefinition; 