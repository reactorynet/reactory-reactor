import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorProjectService, IReactorProject, IReactorProjectMetrics } from "@reactory/server-modules/reactory-reactor/types/service.types";

export type GetProjectMetricsMacroParams = {
  idOrPath: string;
  startDate?: string;
  endDate?: string;
  format?: "json" | "markdown" | "summary";
}

function getMarkdownMetricsTable(metrics: IReactorProjectMetrics[]) {
  return `
| Date | Incidents | Errors | Deployments | Active Deployments | Active Branches | Total Branches | Active Tasks | Total Teams | Total Engineers |
|------|-----------|--------|-------------|-------------------|-----------------|----------------|--------------|-------------|-----------------|
${metrics.map(m => `| ${new Date(m.date).toLocaleDateString()} | ${m.incidents} | ${m.errors} | ${m.deployments} | ${m.activeDeployments} | ${m.activeBranches} | ${m.totalBrances} | ${m.activeTasks} | ${m.totalTeams} | ${m.totalEngineers} |`).join("\n")}
  `;
}

const GetProjectMetricsMacro = async (
  params: GetProjectMetricsMacroParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    idOrPath,
    startDate,
    endDate,
    format = "json",
  } = params;

  if (!idOrPath) {
    return {
      success: false,
      error: "idOrPath parameter is required",
      tool: 'getProjectMetrics',
      params: params,
      instructions: `## Get Metrics \u2014 Missing Parameter\n\n**idOrPath** is required.\n\n### Recovery Options:\n- Use \`listProjects\` to find project IDs`
    };
  }

  try {
    context.debug("Starting GetProjectMetricsMacro execution", { params }, "GetProjectMetricsMacro");
    const reactorProjectService = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    
    if (!reactorProjectService) {
      context.error("ReactorProjectService not found", {}, "GetProjectMetricsMacro");
      return {
        success: false,
        error: "ReactorProjectService is not available",
        tool: 'getProjectMetrics',
        params: params,
        instructions: `## Get Metrics \u2014 Service Unavailable\n\nThe ReactorProjectService is not registered.`
      };
    }

    context.debug("ReactorProjectService retrieved successfully", {}, "GetProjectMetricsMacro");
    
    // First, get the project to verify it exists
    const project = await reactorProjectService.getProject(idOrPath);
    
    if (!project) {
      return {
        success: false,
        error: `Project not found with idOrPath: ${idOrPath}`,
        tool: 'getProjectMetrics',
        params: params,
        instructions: `## Get Metrics \u2014 Project Not Found\n\nNo project matches "${idOrPath}".\n\n### Recovery Options:\n- Use \`listProjects\` to find valid project identifiers`
      };
    }

    context.debug("Project found", { projectId: project.id, projectName: project.name }, "GetProjectMetricsMacro");
    
    // Parse dates
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000); // Default to last 14 days
    
    // Get project metrics
    const metrics = await reactorProjectService.getProjectMetrics(project, start, end);

    // Store in chat state for AI reference
    chatState.vars.lastProjectMetrics = metrics;

    context.debug("Project metrics retrieved", { 
      projectId: project.id, 
      projectName: project.name,
      metricsCount: metrics.length,
      dateRange: { start: start.toISOString(), end: end.toISOString() }
    }, "GetProjectMetricsMacro");

    if (!metrics || metrics.length === 0) {
      return {
        success: true,
        data: {
          summary: {
            message: `No metrics found for project "${project.name}" in the specified date range`,
            projectId: project.id,
            projectName: project.name,
            dateRange: { start: start.toISOString(), end: end.toISOString() },
            metricsCount: 0
          },
          project: {
            id: project.id,
            name: project.name,
            nameSpace: project.nameSpace,
            version: project.version
          },
          metrics: []
        },
        tool: 'getProjectMetrics',
        params: params,
        format: format,
        instructions: `## Project Metrics \u2014 No Data\n\nNo metrics found for **${project.name}** between ${start.toISOString().split('T')[0]} and ${end.toISOString().split('T')[0]}.\n\n### Suggestions:\n- Try a wider date range with startDate and endDate parameters\n- Verify the project has been generating metrics data`
      };
    }

    // Calculate summary statistics
    const totalIncidents = metrics.reduce((sum, m) => sum + m.incidents, 0);
    const totalErrors = metrics.reduce((sum, m) => sum + m.errors, 0);
    const totalDeployments = metrics.reduce((sum, m) => sum + m.deployments, 0);
    const avgActiveDeployments = metrics.reduce((sum, m) => sum + m.activeDeployments, 0) / metrics.length;
    const avgActiveBranches = metrics.reduce((sum, m) => sum + m.activeBranches, 0) / metrics.length;
    const avgActiveTasks = metrics.reduce((sum, m) => sum + m.activeTasks, 0) / metrics.length;

    const summary = {
      message: `Metrics retrieved for project "${project.name}"`,
      projectId: project.id,
      projectName: project.name,
      dateRange: { start: start.toISOString(), end: end.toISOString() },
      metricsCount: metrics.length,
      totals: {
        incidents: totalIncidents,
        errors: totalErrors,
        deployments: totalDeployments
      },
      averages: {
        activeDeployments: Math.round(avgActiveDeployments * 100) / 100,
        activeBranches: Math.round(avgActiveBranches * 100) / 100,
        activeTasks: Math.round(avgActiveTasks * 100) / 100
      }
    };

    let output;
    switch (format) {
      case "markdown":
        output = `
# Project Metrics: ${project.name}

## Summary
- **Project**: ${project.name} (${project.nameSpace}@${project.version})
- **Date Range**: ${start.toLocaleDateString()} to ${end.toLocaleDateString()}
- **Metrics Entries**: ${metrics.length}

## Totals
- **Total Incidents**: ${totalIncidents}
- **Total Errors**: ${totalErrors}
- **Total Deployments**: ${totalDeployments}

## Averages
- **Average Active Deployments**: ${Math.round(avgActiveDeployments * 100) / 100}
- **Average Active Branches**: ${Math.round(avgActiveBranches * 100) / 100}
- **Average Active Tasks**: ${Math.round(avgActiveTasks * 100) / 100}

## Daily Metrics
${getMarkdownMetricsTable(metrics)}
        `;
        break;
      case "summary":
        output = {
          summary,
          project: {
            id: project.id,
            name: project.name,
            nameSpace: project.nameSpace,
            version: project.version
          },
          metrics: metrics.map(m => ({
            date: m.date,
            incidents: m.incidents,
            errors: m.errors,
            deployments: m.deployments,
            activeDeployments: m.activeDeployments,
            activeBranches: m.activeBranches,
            totalBranches: m.totalBrances,
            activeTasks: m.activeTasks,
            totalTeams: m.totalTeams,
            totalEngineers: m.totalEngineers
          }))
        };
        break;
      default: // json
        output = {
          summary,
          project: {
            id: project.id,
            name: project.name,
            nameSpace: project.nameSpace,
            version: project.version
          },
          metrics
        };
    }

    return {
      success: true,
      data: output,
      tool: 'getProjectMetrics',
      params: params,
      format: format,
      instructions: `
## Project Metrics Results

Retrieved metrics for project: "${project.name}"

### Project Details:
- **Project ID**: ${project.id}
- **Name**: ${project.name}
- **Namespace**: ${project.nameSpace}
- **Version**: ${project.version}

### Date Range:
- **Start Date**: ${start.toLocaleDateString()}
- **End Date**: ${end.toLocaleDateString()}
- **Metrics Entries**: ${metrics.length}

### Summary Statistics:
- **Total Incidents**: ${totalIncidents}
- **Total Errors**: ${totalErrors}
- **Total Deployments**: ${totalDeployments}
- **Average Active Deployments**: ${Math.round(avgActiveDeployments * 100) / 100}
- **Average Active Branches**: ${Math.round(avgActiveBranches * 100) / 100}
- **Average Active Tasks**: ${Math.round(avgActiveTasks * 100) / 100}

### Metrics Breakdown:
${metrics.length > 0 ? `
${metrics.slice(0, 5).map(m => `
**${new Date(m.date).toLocaleDateString()}**
- Incidents: ${m.incidents}
- Errors: ${m.errors}
- Deployments: ${m.deployments}
- Active Deployments: ${m.activeDeployments}
- Active Branches: ${m.activeBranches}
- Active Tasks: ${m.activeTasks}
`).join('\n')}${metrics.length > 5 ? `\n... and ${metrics.length - 5} more entries` : ''}
` : 'No metrics available'}

### State Variables Available:
- lastProjectMetrics: The retrieved project metrics

Use this metrics data for project health analysis, trend identification, or performance reporting.
      `
    };
    
  } catch (error) {
    context.error("Error retrieving project metrics", { error, idOrPath }, "GetProjectMetricsMacro");
    return {
      success: false,
      error: `Failed to retrieve project metrics: ${error?.message ?? "Unknown error"}`,
      tool: 'getProjectMetrics',
      params: params,
      instructions: `## Get Metrics \u2014 Error\n\n${error?.message ?? 'Unknown error'}\n\n### Recovery Options:\n- Verify the project exists with \`getProject\`\n- Try a different date range`
    };
  }
};

const GetProjectMetricsMacroDefinition: MacroComponentDefinition<typeof GetProjectMetricsMacro> = {
  name: "GetProjectMetrics",
  nameSpace: "zepz-engineer",
  description: `Retrieves metrics for a specific Reactor project over a specified time period. Returns structured data for AI analysis.`,
  component: GetProjectMetricsMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "getProjectMetrics",
  runat: "server",
  icon: "analytics",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "analytics",
        name: "getProjectMetrics",
        description: "Retrieves metrics for a specific Reactor project over a specified time period. Returns structured data for AI analysis.",
        parameters: {
          type: "object",
          properties: {
            idOrPath: {
              type: "string",
              description: "The project ID, FQN, name, or repo path to get metrics for.",
            },
            startDate: {
              type: "string",
              format: "date-time",
              description: "Start date for metrics (ISO string). Defaults to 14 days ago.",
            },
            endDate: {
              type: "string",
              format: "date-time",
              description: "End date for metrics (ISO string). Defaults to current date.",
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

export default GetProjectMetricsMacroDefinition; 