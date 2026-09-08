import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorProjectService, IReactorProject, IReactorProjectFileSpec } from "@reactory/server-modules/reactory-reactor/types/service.types";

export type GetProjectMacroParams = {
  idOrPath: string;
  includeDocumentation?: boolean;
  includeMetrics?: boolean;
  format?: "json" | "markdown" | "summary";
  includeFiles?: boolean;
  fileSearch?: string;
  page?: number;
  pageSize?: number;
}

export interface ProjectFileSummary {
  totalFiles: number;
  matchingFiles: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  hasNext: boolean;
  breakdown: Record<string, number>;
  note?: string;
}

function getMarkdownProjectDetails(
  project: Partial<IReactorProject>,
  fileSummary: ProjectFileSummary,
  pagedFiles: Partial<IReactorProjectFileSpec>[],
  shouldIncludeFiles: boolean
) {
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

## Project Files
- **Total Files**: ${fileSummary.totalFiles}
${fileSummary.breakdown && Object.keys(fileSummary.breakdown).length > 0 ? Object.entries(fileSummary.breakdown).map(([type, count]) => `  - ${type}: ${count}`).join('\n') : '  - None'}
${shouldIncludeFiles ? `
### Files (Page ${fileSummary.page} of ${fileSummary.totalPages || 1}, ${fileSummary.matchingFiles} total matches)
${pagedFiles.map((f, i) => `${((fileSummary.page || 1) - 1) * (fileSummary.pageSize || 20) + i + 1}. \`${f.path}\` (${f.type || 'file'})`).join('\n') || '_No files match the criteria._'}
${fileSummary.hasNext ? `\n_More files available. Use page=${(fileSummary.page || 1) + 1} to view the next page._` : ''}
` : `
> _File list omitted to prevent context bloat (${fileSummary.totalFiles} files). Use \`includeFiles: true\` or \`fileSearch: "pattern"\` to search and paginate files._
`}
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
    includeFiles,
    fileSearch,
    page,
    pageSize,
  } = params;
  
  if (!idOrPath) {
    return {
      success: false,
      error: "idOrPath parameter is required",
      tool: 'getProject',
      params: params,
      instructions: `## Get Project — Missing Parameter\n\n**idOrPath** is required. Provide a project ID or FQN path.\n\n### Recovery Options:\n- Use \`listProjects\` to find project IDs\n- Format: namespace.name@version or MongoDB ObjectId`
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
        params: params,
        instructions: `## Get Project — Service Unavailable\n\nThe ReactorProjectService is not registered.\n\n### Recovery Options:\n- Use \`svc\` with action="list" to check available services\n- Verify the reactor module is loaded`
      };
    }

    context.debug("ReactorProjectService retrieved successfully", {}, "GetProjectMacro");
        
    const rawProject: Partial<IReactorProject> = await reactorProjectService.getProject(idOrPath);
    
    if (!rawProject) {
      return {
        success: false,
        error: `Project not found with idOrPath: ${idOrPath}`,
        tool: 'getProject',
        params: params,
        instructions: `## Get Project — Not Found\n\nNo project matches "${idOrPath}".\n\n### Recovery Options:\n- Use \`listProjects\` to see available projects\n- Check the format: namespace.name@version or ObjectId`
      };
    }

    context.debug("Project retrieved successfully", { projectId: rawProject.id, projectName: rawProject.name }, "GetProjectMacro");

    // Process child files: extract, summarize, filter, paginate
    const allFiles: Partial<IReactorProjectFileSpec>[] = Array.isArray(rawProject.files) ? rawProject.files : [];
    const totalFiles = allFiles.length;

    const fileTypesBreakdown: Record<string, number> = {};
    for (const f of allFiles) {
      const type = f.type || 'unknown';
      fileTypesBreakdown[type] = (fileTypesBreakdown[type] || 0) + 1;
    }

    // Determine if child files should be returned in the response
    const shouldIncludeFiles = includeFiles === true || (includeFiles !== false && (
      (fileSearch !== undefined && fileSearch.trim().length > 0) ||
      page !== undefined ||
      pageSize !== undefined
    ));

    let filteredFiles = allFiles;
    if (fileSearch && fileSearch.trim().length > 0) {
      const searchTerm = fileSearch.trim();
      try {
        const rx = new RegExp(searchTerm, 'i');
        filteredFiles = allFiles.filter(f => rx.test(f.path || '') || rx.test(f.type || ''));
      } catch {
        const lower = searchTerm.toLowerCase();
        filteredFiles = allFiles.filter(f => 
          (f.path && f.path.toLowerCase().includes(lower)) || 
          (f.type && f.type.toLowerCase().includes(lower))
        );
      }
    }

    const matchingFiles = filteredFiles.length;
    const currentPage = Math.max(page ?? 1, 1);
    const currentPageSize = Math.min(Math.max(pageSize ?? 20, 1), 100);
    const totalPages = matchingFiles > 0 ? Math.ceil(matchingFiles / currentPageSize) : 0;
    const start = (currentPage - 1) * currentPageSize;
    const pagedFiles = shouldIncludeFiles ? filteredFiles.slice(start, start + currentPageSize) : [];

    const fileSummary: ProjectFileSummary = {
      totalFiles,
      matchingFiles: fileSearch ? matchingFiles : totalFiles,
      page: shouldIncludeFiles ? currentPage : undefined,
      pageSize: shouldIncludeFiles ? currentPageSize : undefined,
      totalPages: shouldIncludeFiles ? totalPages : undefined,
      hasNext: shouldIncludeFiles ? (start + currentPageSize < matchingFiles) : false,
      breakdown: fileTypesBreakdown,
      ...(!shouldIncludeFiles && totalFiles > 0 ? {
        note: `File list omitted to prevent context bloat (${totalFiles} total files). Use includeFiles=true or fileSearch to inspect files.`
      } : {})
    };

    // Sanitize project so we never dump thousands of files into response or state
    const project: Partial<IReactorProject> = {
      ...rawProject,
      files: pagedFiles,
      fileSummary: fileSummary as any
    };

    // Get additional data if requested
    let documentation = null;
    let metrics = null;

    if (includeDocumentation) {
      try {
        documentation = await reactorProjectService.getPrimaryDocumentation(rawProject);
      } catch (docError) {
        context.warn("Failed to get primary documentation", { error: docError }, "GetProjectMacro");
      }
    }

    if (includeMetrics) {
      try {
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - 14 * 24 * 60 * 60 * 1000); // Last 14 days
        metrics = await reactorProjectService.getProjectMetrics(rawProject, startDate, endDate);
      } catch (metricsError) {
        context.warn("Failed to get project metrics", { error: metricsError }, "GetProjectMacro");
      }
    }

    let output;
    switch (format) {
      case "markdown":
        output = getMarkdownProjectDetails(project, fileSummary, pagedFiles, shouldIncludeFiles);
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
            tags: project.tags,
            fileSummary
          },
          files: shouldIncludeFiles ? pagedFiles : undefined,
          documentation: includeDocumentation ? documentation : null,
          metrics: includeMetrics ? metrics : null
        };
        break;
      default: // json
        output = {
          project,
          fileSummary,
          files: shouldIncludeFiles ? pagedFiles : undefined,
          documentation: includeDocumentation ? documentation : null,
          metrics: includeMetrics ? metrics : null
        };
    }

    // Store in chat state for AI reference (using sanitized project to prevent bloat)
    if (!chatState.vars) {
      chatState.vars = {};
    }
    chatState.vars.lastRetrievedProject = project;
    chatState.vars.lastProjectFileSummary = fileSummary;
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

### Child Files:
- **Total Files**: ${fileSummary.totalFiles}
${shouldIncludeFiles ? `
- **Matching Files**: ${fileSummary.matchingFiles}${fileSearch ? ` (filter: "${fileSearch}")` : ''}
- **Pagination**: Page ${fileSummary.page} of ${fileSummary.totalPages || 1} (showing ${pagedFiles.length} files)
- **Has Next Page**: ${fileSummary.hasNext ? `Yes (use page=${(fileSummary.page || 1) + 1})` : 'No'}
${pagedFiles.slice(0, 5).map(f => `- \`${f.path}\` (${f.type || 'file'})`).join('\n')}
${pagedFiles.length > 5 ? `_...and ${pagedFiles.length - 5} more on this page._` : ''}
` : `
- **File List**: Omitted to keep output lean.
- **Tip**: To search or paginate child files, call \`getProject\` with \`fileSearch: "pattern"\`, \`includeFiles: true\`, or \`page: 1, pageSize: 20\`. Alternatively, use \`searchProject\` for full-text search across files and docs, or \`graphChildren\` to browse directory hierarchy.
`}

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
- lastRetrievedProject: The retrieved project (with paged/sanitized files)
- lastProjectFileSummary: Summary of files, counts, and breakdowns
- lastProjectDocumentation: Primary documentation (if requested)
- lastProjectMetrics: Project metrics (if requested)
      `
    };
    
  } catch (error) {
    context.error("Error retrieving project", { error, idOrPath }, "GetProjectMacro");
    return {
      success: false,
      error: `Failed to retrieve project: ${error?.message ?? "Unknown error"}`,
      tool: 'getProject',
      params: params,
      instructions: `## Get Project — Error\n\n${error?.message ?? 'Unknown error'}\n\n### Recovery Options:\n- Verify the idOrPath is valid\n- Use \`listProjects\` to find valid project identifiers`
    };
  }
};

const GetProjectMacroDefinition: MacroComponentDefinition<typeof GetProjectMacro> = {
  name: "GetProject",
  nameSpace: "zepz-engineer",
  description: `Retrieves a specific Reactor project by ID or path. Returns detailed project information for AI analysis with bounded, paginated child files.`,
  component: GetProjectMacro,
  version: "1.1.0",
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
        description: "Retrieves a specific Reactor project by ID or path. Returns detailed project information for AI analysis with search and pagination for child files.",
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
            },
            includeFiles: {
              type: "boolean",
              description: "Whether to include child files in the response (default: false unless fileSearch, page, or pageSize is provided).",
              default: false
            },
            fileSearch: {
              type: "string",
              description: "Filter child file paths by substring or regex pattern (e.g. 'routes', '.ts', 'src/auth').",
            },
            page: {
              type: "number",
              description: "Page number for child files pagination (1-based, default: 1).",
              default: 1
            },
            pageSize: {
              type: "number",
              description: "Number of child files per page (default: 20, max: 100).",
              default: 20
            }
          },
          required: ["idOrPath"],
        },
      },
    },
  ],
};

export default GetProjectMacroDefinition;
