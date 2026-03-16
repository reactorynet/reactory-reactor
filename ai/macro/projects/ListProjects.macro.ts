import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorProjectService, IReactorProject, PageReactorProjectResult, PagedFilter } from "@reactory/server-modules/reactory-reactor/types/service.types";

export type ListProjectsMacroParams = {
  search?: string;
  businessUnit?: string;
  ownerTeam?: string;
  owner?: string;
  system?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  format?: "json" | "markdown" | "summary";
}

function getMarkdownTable(projects: Partial<IReactorProject>[]) {
  return `
| Name | Namespace | Version | Description | Project Types | Status | Last Sync |
|------|-----------|---------|-------------|---------------|--------|-----------|
${projects.map(p => `| ${p.name} | ${p.nameSpace} | ${p.version} | ${p.description?.substring(0, 50) || 'N/A'} | ${p.projectTypes?.join(', ') || 'N/A'} | ${p.projectStatus || 'N/A'} | ${p.lastSync ? new Date(p.lastSync).toLocaleDateString() : 'N/A'} |`).join("\n")}
  `;
}

const ListProjectsMacro = async (
  params: ListProjectsMacroParams = {
    page: 1,
    pageSize: 10,
    format: "json",
  },
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    search,
    businessUnit,
    ownerTeam,
    owner,
    system,
    status,
    page = 1,
    pageSize = 10,
    format = "json",
  } = params;
  
  try {
    context.debug("Starting ListProjectsMacro execution", { params }, "ListProjectsMacro");
    const reactorProjectService = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    
    if (!reactorProjectService) {
      context.error("ReactorProjectService not found", {}, "ListProjectsMacro");
      return {
        success: false,
        error: "ReactorProjectService is not available",
        tool: 'listProjects',
        params: params,
        instructions: `## List Projects \u2014 Service Unavailable\n\nThe ReactorProjectService is not registered.\n\n### Recovery Options:\n- Use \`svc\` with action="list" to check available services\n- Verify the reactor module is loaded with \`modules\``
      };
    }

    context.debug("ReactorProjectService retrieved successfully", {}, "ListProjectsMacro");
    
    const filter: Partial<PagedFilter> = {
      search,
      businessUnit,
      ownerTeam,
      owner,
      system,
      status,
      paging: {
        page,
        pageSize,
      }
    };
        
    const result: PageReactorProjectResult = await reactorProjectService.getProjects(filter);
    
    context.debug("Projects retrieved", { count: result?.projects?.length ?? 0 }, "ListProjectsMacro");
    
    if (!result.projects || result.projects.length === 0) {
      return {
        success: true,
        data: {
          summary: {
            totalProjects: 0,
            page,
            pageSize,
            hasNext: false,
            message: "No projects found matching the specified criteria."
          },
          projects: [] as Partial<IReactorProject>[]
        },
        tool: 'listProjects',
        params: params,
        format: format,
        instructions: `## List Projects \u2014 No Results\n\nNo projects match the current filters.\n\n### Suggestions:\n- Use \`listProjects\` without filters to see all projects\n- Use \`catalogProject\` to catalog a new project from a repository`
      };
    }

    // Group projects by status for better AI analysis
    const projectsByStatus = {
      active: result.projects.filter(p => p.projectStatus === 'ACTIVE'),
      inactive: result.projects.filter(p => p.projectStatus === 'INACTIVE'),
      archived: result.projects.filter(p => p.projectStatus === 'ARCHIVED'),
      deprecated: result.projects.filter(p => p.projectStatus === 'DEPRECATED'),
      unknown: result.projects.filter(p => !p.projectStatus)
    };

    const summary = {
      totalProjects: result.paging.total,
      page,
      pageSize,
      hasNext: result.paging.hasNext,
      byStatus: {
        active: projectsByStatus.active.length,
        inactive: projectsByStatus.inactive.length,
        archived: projectsByStatus.archived.length,
        deprecated: projectsByStatus.deprecated.length,
        unknown: projectsByStatus.unknown.length
      },
      filters: {
        search,
        businessUnit,
        ownerTeam,
        owner,
        system,
        status
      }
    };

    let output;
    switch (format) {
      case "markdown":
        output = getMarkdownTable(result.projects);
        break;
      case "summary":
        output = {
          summary,
          projects: result.projects.map(p => ({
            id: p.id,
            name: p.name,
            nameSpace: p.nameSpace,
            version: p.version,
            description: p.description,
            projectTypes: p.projectTypes,
            projectStatus: p.projectStatus,
            lastSync: p.lastSync,
            repoUrl: p.repoUrl,
            repoPath: p.repoPath
          }))
        };
        break;
      default: // json
        output = {
          summary,
          projects: result.projects,
          projectsByStatus
        };
    }

    // Store in chat state for AI reference
    if (!chatState.vars) {
      chatState.vars = {};
    }
    chatState.vars.listedProjects = result.projects;
    chatState.vars.projectsByStatus = projectsByStatus;
    chatState.vars.projectSummary = summary;

    // @ts-ignore
    await chatState.save();

    return {
      success: true,
      data: output,
      tool: 'listProjects',
      params: params,
      format: format,
      instructions: `
## Project Listing Results

Found ${result.projects.length} projects matching your criteria (${result.paging.total} total).

### Summary:
- **Total Projects**: ${result.paging.total}
- **Current Page**: ${page} of ${Math.ceil(result.paging.total / pageSize)}
- **Page Size**: ${pageSize}
- **Has Next Page**: ${result.paging.hasNext ? 'Yes' : 'No'}

### Projects by Status:
- **Active**: ${projectsByStatus.active.length}
- **Inactive**: ${projectsByStatus.inactive.length}
- **Archived**: ${projectsByStatus.archived.length}
- **Deprecated**: ${projectsByStatus.deprecated.length}
- **Unknown Status**: ${projectsByStatus.unknown.length}

### Available Data:
- **Full Project Objects**: Complete project data with all fields
- **Grouped by Status**: Projects organized by status
- **Summary Statistics**: Counts and metadata for analysis

### State Variables Available:
- listedProjects: All retrieved projects
- projectsByStatus: Projects grouped by status
- projectSummary: Summary statistics and metadata

Use this data to analyze project patterns, identify trends, or select specific projects for further processing.
      `
    };
    
  } catch (error) {
    context.error("Error listing projects", { error }, "ListProjectsMacro");
    return {
      success: false,
      error: `Failed to list projects: ${error?.message ?? "Unknown error"}`,
      tool: 'listProjects',
      params: params,
      instructions: `## List Projects \u2014 Error\n\n${error?.message ?? 'Unknown error'}\n\n### Recovery Options:\n- Retry the request\n- Use \`svc\` to verify ReactorProjectService is available`
    };
  }
};

const ListProjectsMacroDefinition: MacroComponentDefinition<typeof ListProjectsMacro> = {
  name: "ListProjects",
  nameSpace: "zepz-engineer",
  description: `Lists all Reactor projects in the system using filters to narrow down results. Returns structured data for AI analysis.`,
  component: ListProjectsMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "listProjects",
  runat: "server",
  icon: "folder",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "folder",
        name: "listProjects",
        description: "Lists all Reactor projects in the system using filters to narrow down the results. Returns structured data for AI analysis.",
        parameters: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "Search term to filter projects by name.",
            },
            businessUnit: {
              type: "string",
              description: "Filter projects by business unit ID.",
            },
            ownerTeam: {
              type: "string",
              description: "Filter projects by owner team ID.",
            },
            owner: {
              type: "string",
              description: "Filter projects by owner user ID.",
            },
            system: {
              type: "string",
              description: "Filter projects by system ID.",
            },
            status: {
              type: "string",
              enum: ["ACTIVE", "INACTIVE", "ARCHIVED", "DEPRECATED"],
              description: "Filter projects by status.",
            },
            page: {
              type: "number",
              description: "Page number for pagination.",
              default: 1
            },
            pageSize: {
              type: "number",
              description: "Number of projects per page.",
              default: 10
            },
            format: {
              type: "string",
              enum: ["json", "markdown", "summary"],
              description: "Output format for the results.",
              default: "json"
            }
          },
          required: [],
        },
      },
    },
  ],
};

export default ListProjectsMacroDefinition; 