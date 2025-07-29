import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorProjectService, IReactorProject } from "@reactory/server-modules/reactory-reactor/types/service.types";

export type GetProjectMacroParams = {
  idOrPath: string;
  includeDocumentation?: boolean;
  includeMetrics?: boolean;
  format?: "json" | "markdown" | "summary";
}

function getMarkdownProjectDetails(project: Partial<IReactorProject>) {
  return `
# Project Details: ${project.name}

## Basic Information
- **ID**: ${project.id}
- **FQN**: ${project.fqn}
- **Namespace**: ${project.nameSpace}
- **Version**: ${project.version}
- **Status**: ${project.projectStatus || 'N/A'}
- **Description**: ${project.description || 'N/A'}

## Repository Information
- **Repo Path**: ${project.repoPath || 'N/A'}
- **Repo URL**: ${project.repoUrl || 'N/A'}
- **Last Sync**: ${project.lastSync ? new Date(project.lastSync).toLocaleString() : 'N/A'}

## Project Types
${project.projectTypes?.map(type => `- ${type}`).join('\n') || '- N/A'}

## Team Information
- **Owner Team**: ${project.ownerTeam?.name || 'N/A'}
- **Owner**: ${project.owner?.fullName || 'N/A'}
- **Teams**: ${project.teams?.map(team => team.name).join(', ') || 'N/A'}
- **Engineers**: ${project.engineers?.map(eng => eng.fullName).join(', ') || 'N/A'}

## Branch Information
- **Active Branch**: ${project.activeBranch || 'N/A'}
- **Main Branch**: ${project.mainBranch || 'N/A'}
- **Branches**: ${project.branches?.join(', ') || 'N/A'}

## Dependencies
- **Dependencies**: ${project.dependencies?.map(dep => dep.name).join(', ') || 'N/A'}
- **Dependents**: ${project.dependents?.map(dep => dep.name).join(', ') || 'N/A'}

## Tags
${project.tags?.map(tag => `- ${tag}`).join('\n') || '- N/A'}
  `;
}

const GetProjectMacro = async (
  params: GetProjectMacroParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    idOrPath,
    includeDocumentation = false,
    includeMetrics = false,
    format = "json",
  } = params;
  
  if (!idOrPath) {
    return {
      success: false,
      error: "idOrPath parameter is required",
      tool: 'getProject',
      params: params
    };
  }

  try {
    context.debug("Starting GetProjectMacro execution", { params }, "GetProjectMacro");
    const reactorProjectService = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    
    if (!reactorProjectService) {
      context.error("ReactorProjectService not found", {}, "GetProjectMacro");
      return {
        success: false,
        error: "ReactorProjectService is not available",
        tool: 'getProject',
        params: params
      };
    }

    context.debug("ReactorProjectService retrieved successfully", {}, "GetProjectMacro");
        
    const project: Partial<IReactorProject> = await reactorProjectService.getProject(idOrPath);
    
    if (!project) {
      return {
        success: false,
        error: `Project not found with idOrPath: ${idOrPath}`,
        tool: 'getProject',
        params: params
      };
    }

    context.debug("Project retrieved successfully", { projectId: project.id, projectName: project.name }, "GetProjectMacro");

    // Get additional data if requested
    let documentation = null;
    let metrics = null;

    if (includeDocumentation) {
      try {
        documentation = await reactorProjectService.getPrimaryDocumentation(project);
      } catch (docError) {
        context.warn("Failed to get primary documentation", { error: docError }, "GetProjectMacro");
      }
    }

    if (includeMetrics) {
      try {
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - 14 * 24 * 60 * 60 * 1000); // Last 14 days
        metrics = await reactorProjectService.getProjectMetrics(project, startDate, endDate);
      } catch (metricsError) {
        context.warn("Failed to get project metrics", { error: metricsError }, "GetProjectMacro");
      }
    }

    let output;
    switch (format) {
      case "markdown":
        output = getMarkdownProjectDetails(project);
        break;
      case "summary":
        output = {
          summary: {
            message: `Project "${project.name}" retrieved successfully`,
            projectId: project.id,
            projectName: project.name,
            retrievedAt: new Date()
          },
          project: {
            id: project.id,
            name: project.name,
            nameSpace: project.nameSpace,
            version: project.version,
            description: project.description,
            projectTypes: project.projectTypes,
            projectStatus: project.projectStatus,
            repoUrl: project.repoUrl,
            repoPath: project.repoPath,
            lastSync: project.lastSync,
            ownerTeam: project.ownerTeam?.name,
            owner: project.owner?.fullName,
            activeBranch: project.activeBranch,
            mainBranch: project.mainBranch,
            tags: project.tags
          },
          documentation: includeDocumentation ? documentation : null,
          metrics: includeMetrics ? metrics : null
        };
        break;
      default: // json
        output = {
          project,
          documentation: includeDocumentation ? documentation : null,
          metrics: includeMetrics ? metrics : null
        };
    }

    // Store in chat state for AI reference
    if (!chatState.vars) {
      chatState.vars = {};
    }
    chatState.vars.lastRetrievedProject = project;
    chatState.vars.lastProjectDocumentation = documentation;
    chatState.vars.lastProjectMetrics = metrics;

    // @ts-ignore
    await chatState.save();

    return {
      success: true,
      data: output,
      tool: 'getProject',
      params: params,
      format: format,
      instructions: `
## Project Retrieval Results

Successfully retrieved project: "${project.name}"

### Project Details:
- **Project ID**: ${project.id}
- **FQN**: ${project.fqn}
- **Namespace**: ${project.nameSpace}
- **Version**: ${project.version}
- **Status**: ${project.projectStatus || 'N/A'}
- **Description**: ${project.description || 'N/A'}

### Repository Information:
- **Repo Path**: ${project.repoPath || 'N/A'}
- **Repo URL**: ${project.repoUrl || 'N/A'}
- **Last Sync**: ${project.lastSync ? new Date(project.lastSync).toLocaleString() : 'N/A'}

### Project Types:
${project.projectTypes?.map(type => `- ${type}`).join('\n') || '- N/A'}

### Team Information:
- **Owner Team**: ${project.ownerTeam?.name || 'N/A'}
- **Owner**: ${project.owner?.fullName || 'N/A'}
- **Teams**: ${project.teams?.map(team => team.name).join(', ') || 'N/A'}
- **Engineers**: ${project.engineers?.map(eng => eng.fullName).join(', ') || 'N/A'}

${includeDocumentation && documentation ? `
### Primary Documentation:
- **Title**: ${documentation.title}
- **Format**: ${documentation.format}
- **Content Preview**: ${documentation.content?.substring(0, 200)}${documentation.content && documentation.content.length > 200 ? '...' : ''}
` : ''}

${includeMetrics && metrics ? `
### Project Metrics (Last 14 Days):
- **Total Metrics Entries**: ${metrics.length}
- **Date Range**: ${metrics.length > 0 ? `${new Date(metrics[0].date).toLocaleDateString()} to ${new Date(metrics[metrics.length - 1].date).toLocaleDateString()}` : 'N/A'}
` : ''}

### State Variables Available:
- lastRetrievedProject: The retrieved project
- lastProjectDocumentation: Primary documentation (if requested)
- lastProjectMetrics: Project metrics (if requested)

Use this project data for analysis, updates, or further processing.
      `
    };
    
  } catch (error) {
    context.error("Error retrieving project", { error, idOrPath }, "GetProjectMacro");
    return {
      success: false,
      error: `Failed to retrieve project: ${error?.message ?? "Unknown error"}`,
      tool: 'getProject',
      params: params
    };
  }
};

const GetProjectMacroDefinition: MacroComponentDefinition<typeof GetProjectMacro> = {
  name: "GetProject",
  nameSpace: "zepz-engineer",
  description: `Retrieves a specific Reactor project by ID or path. Returns detailed project information for AI analysis.`,
  component: GetProjectMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "getProject",
  runat: "server",
  icon: "folder_open",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "folder_open",
        name: "getProject",
        description: "Retrieves a specific Reactor project by ID or path. Returns detailed project information for AI analysis.",
        parameters: {
          type: "object",
          properties: {
            idOrPath: {
              type: "string",
              description: "The project ID, FQN, name, or repo path to retrieve.",
            },
            includeDocumentation: {
              type: "boolean",
              description: "Whether to include primary documentation in the response.",
              default: false
            },
            includeMetrics: {
              type: "boolean",
              description: "Whether to include project metrics for the last 14 days.",
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

export default GetProjectMacroDefinition; 