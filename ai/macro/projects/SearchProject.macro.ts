import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorProjectService } from "@reactory/server-modules/reactory-reactor/types/service.types";

export type OutputFormat = "json" | "markdown" | "summary" | "detailed";

export interface SearchProjectMacroParams {
  projectName?: string;
  name?: string;
  projectId?: string;
  idOrPath?: string;
  nameSpace?: string;
  query: string;
  fields?: string[];
  limit?: number;
  offset?: number;
  format?: OutputFormat;
}

const SearchProjectMacro = async (
  params: SearchProjectMacroParams,
  chatState: ChatState,
) => {
  const { context } = chatState;
  const {
    projectName,
    name,
    projectId,
    idOrPath,
    nameSpace = "reactory",
    query,
    fields,
    limit = 10,
    offset = 0,
    format = "json",
  } = params;

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: "Search query is required and cannot be empty.",
      tool: 'searchProject',
      params
    };
  }

  const targetProjectIdentifier = projectName || name || projectId || idOrPath;
  if (!targetProjectIdentifier) {
    return {
      success: false,
      error: "Project identifier (projectName, name, projectId, or idOrPath) is required.",
      tool: 'searchProject',
      params
    };
  }

  try {
    context.debug("Starting SearchProjectMacro execution", { params }, "SearchProjectMacro");
    
    let resolvedNameSpace = nameSpace;
    let resolvedProjectName = targetProjectIdentifier;

    const reactorProjectService = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    if (reactorProjectService) {
      try {
        const project = await reactorProjectService.getProject(targetProjectIdentifier);
        if (project) {
          if (project.name) resolvedProjectName = project.name;
          if (project.nameSpace) resolvedNameSpace = project.nameSpace;
        }
      } catch {
        // Fall back to using explicit parameters if service lookup throws
      }
    }

    const indexName = `reactor_graph_${resolvedNameSpace}_${resolvedProjectName}`;

    const searchService = context.getService<Reactory.Service.ISearchService>("core.ReactorySearchService@1.0.0");
    if (!searchService) {
      return {
        success: false,
        error: "ReactorySearchService (core.ReactorySearchService@1.0.0) is not available",
        tool: 'searchProject',
        params
      };
    }

    const startTime = Date.now();
    const searchResult = await searchService.search(indexName, query, fields, limit, offset);
    const executionTime = Date.now() - startTime;

    const hits = searchResult?.results || [];
    const totalHits = searchResult?.total || hits.length;

    const results = hits.map((item: any) => ({
      id: item.id || item._id,
      name: item.name,
      path: item.path,
      type: item.type,
      source: item.source ? (item.source.length > 300 ? item.source.substring(0, 300) + '...' : item.source) : null,
      score: item._score || 1,
    }));

    chatState.vars = chatState.vars || {};
    chatState.vars.lastProjectSearchResults = {
      project: resolvedProjectName,
      nameSpace: resolvedNameSpace,
      indexName,
      query,
      totalHits,
      returnedHits: results.length,
      results
    };

    let output;
    switch (format) {
      case "markdown":
        output = `
# Search Results for Project: ${resolvedProjectName}

**Index**: ${indexName}
**Query**: ${query}
**Total Results**: ${totalHits}
**Execution Time**: ${executionTime}ms

## Matching Files & Content

${results.map((r, i) => `
### ${i + 1}. ${r.name || r.path || r.id}
- **Type**: ${typeof r.type === 'object' ? r.type.name || r.type.id : r.type}
- **Path**: \`${r.path || 'N/A'}\`

\`\`\`
${r.source || 'No snippet preview'}
\`\`\`
`).join('\n')}
        `;
        break;

      case "summary":
        output = {
          summary: {
            projectName: resolvedProjectName,
            nameSpace: resolvedNameSpace,
            indexName,
            query,
            totalHits,
            returnedResults: results.length,
            executionTime
          },
          results: results.map(r => ({
            id: r.id,
            name: r.name,
            path: r.path,
            type: r.type,
            preview: r.source ? r.source.substring(0, 100) + '...' : null
          }))
        };
        break;

      default: // json & detailed
        output = {
          projectName: resolvedProjectName,
          nameSpace: resolvedNameSpace,
          indexName,
          query,
          totalHits,
          returnedHits: results.length,
          executionTime,
          results
        };
    }

    return {
      success: true,
      data: output,
      tool: 'searchProject',
      params,
      format,
      instructions: `
## Project Search Results

Searched project **"${resolvedProjectName}"** (index \`${indexName}\`) for **"${query}"**:

- **Total Results**: ${totalHits}
- **Results Returned**: ${results.length}
- **Execution Time**: ${executionTime}ms

${results.length === 0 ? 
  'No matching files or symbols found in project search index.' :
  `### Top Matching Files:\n${results.slice(0, 5).map(r => `- **${r.name || r.path || r.id}**: \`${r.path || 'N/A'}\``).join('\n')}`
}
`
    };

  } catch (error) {
    context.error("Error performing project search", { error, params }, "SearchProjectMacro");
    return {
      success: false,
      error: `Project search failed: ${(error as Error)?.message || "Unknown error"}`,
      tool: 'searchProject',
      params
    };
  }
};

const SearchProjectMacroDefinition: MacroComponentDefinition<typeof SearchProjectMacro> = {
  name: "SearchProject",
  nameSpace: "reactor-macros",
  alias: "searchProject",
  description: "Performs full-text search across files, code, and documentation indexed for a specific Reactor project.",
  component: SearchProjectMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "searchProject",
  icon: "manage_search",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      safeForAutoExecution: true,
      function: {
        icon: "manage_search",
        name: "searchProject",
        description: "Performs full-text search across files, code, and documentation scoped to a specific Reactor project.",
        parameters: {
          type: "object",
          properties: {
            projectName: {
              type: "string",
              description: "The name, FQN, or ID of the project to search.",
            },
            nameSpace: {
              type: "string",
              description: "Project namespace (default 'reactory').",
              default: "reactory"
            },
            query: {
              type: "string",
              description: "Search query string.",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description: "Fields to restrict search to.",
            },
            limit: {
              type: "number",
              description: "Maximum results to return (default 10).",
              default: 10,
            },
            offset: {
              type: "number",
              description: "Offset for pagination (default 0).",
              default: 0,
            },
            format: {
              type: "string",
              enum: ["json", "markdown", "summary", "detailed"],
              description: "Output format.",
              default: "json",
            },
          },
          required: ["query"],
        },
      },
    },
  ],
};

export default SearchProjectMacroDefinition;
