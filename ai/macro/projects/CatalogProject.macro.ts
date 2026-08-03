import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorProjectService, IReactorProject } from "@reactory/server-modules/reactory-reactor/types/service.types";

export type CatalogProjectMacroParams = {
  name: string;
  nameSpace: string;
  version: string;
  repoPath?: string;
  repoUrl?: string;
  description?: string;
  organization?: {
    name: string;
  };
  businessUnit?: {
    name: string;
  };
  ownerTeam?: {
    name: string;
  };
  tags?: string[];
  format?: "json" | "markdown" | "summary";
}

const CatalogProjectMacro = async (
  params: CatalogProjectMacroParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    name,
    nameSpace,
    version,
    repoPath,
    repoUrl,
    description,
    organization,
    businessUnit,
    ownerTeam,
    tags = [],
    format = "json",
  } = params;

  if (!name || !nameSpace || !version) {
    return {
      success: false,
      error: "Missing required parameters: name, nameSpace, and version are required.",
      tool: 'catalogProject',
      params: params,
      instructions: `## Catalog Project \u2014 Missing Parameters\n\nRequired: **name**, **nameSpace**, **version**.\n\n### Usage:\n- catalogProject with name="MyApp", nameSpace="org", version="1.0.0", repoPath="/path/to/repo"\n- Also requires either repoPath or repoUrl`
    };
  }

  if (!repoPath && !repoUrl) {
    return {
      success: false,
      error: "Either repoPath or repoUrl is required for cataloging a project.",
      tool: 'catalogProject',
      params: params,
      instructions: `## Catalog Project \u2014 Missing Repository\n\nEither **repoPath** (local) or **repoUrl** (remote) is required.`
    };
  }

  try {
    context.debug("Starting CatalogProjectMacro execution", { params }, "CatalogProjectMacro");
    const reactorProjectService = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    
    if (!reactorProjectService) {
      context.error("ReactorProjectService not found", {}, "CatalogProjectMacro");
      return {
        success: false,
        error: "ReactorProjectService is not available",
        tool: 'catalogProject',
        params: params,
        instructions: `## Catalog Project \u2014 Service Unavailable\n\nThe ReactorProjectService is not registered.`
      };
    }

    context.debug("ReactorProjectService retrieved successfully", {}, "CatalogProjectMacro");
    
    // Prepare project specification
    const projectSpec: Partial<IReactorProject> = {
      name,
      nameSpace,
      version,
      description,
      repoPath,
      repoUrl,
      tags,
      projectStatus: 'ACTIVE' as any,
      created: new Date(),
      updated: new Date()
    };

    // Add organization if provided
    if (organization) {
      projectSpec.organization = organization;
    }

    // Add business unit if provided
    if (businessUnit) {
      projectSpec.businessUnit = businessUnit;
    }

    // Add owner team if provided
    if (ownerTeam) {
      projectSpec.ownerTeam = ownerTeam;
    }

    // Catalog the project
    const catalogedProject = await reactorProjectService.catalogProject(projectSpec);

    // Calculate file summary and strip the huge files array to prevent context / history bloat
    const files = catalogedProject.files || [];
    const filesCount = files.length;
    const fileTypesBreakdown: Record<string, number> = {};
    files.forEach(f => {
      const type = f.type || 'unknown';
      fileTypesBreakdown[type] = (fileTypesBreakdown[type] || 0) + 1;
    });

    const fileSummary = {
      totalFiles: filesCount,
      breakdown: fileTypesBreakdown
    };

    // Create a sanitized project object without the massive files list
    const { files: _, ...sanitizedProject } = catalogedProject;
    const projectWithSummary = {
      ...sanitizedProject,
      fileSummary
    };

    // Store in chat state for AI reference (using sanitized version to prevent history bloat)
    chatState.vars.lastCatalogedProject = projectWithSummary;

    context.info(`Cataloged project`, {
      id: catalogedProject.id,
      name: catalogedProject.name,
      nameSpace: catalogedProject.nameSpace,
      version: catalogedProject.version,
      repoPath: catalogedProject.repoPath,
      repoUrl: catalogedProject.repoUrl
    }, "CatalogProjectMacro");

    let output;
    switch (format) {
      case "markdown":
        output = `
# Project Cataloged: ${catalogedProject.name}

## Cataloged Project Details
- **ID**: ${catalogedProject.id}
- **FQN**: ${catalogedProject.fqn}
- **Name**: ${catalogedProject.name}
- **Namespace**: ${catalogedProject.nameSpace}
- **Version**: ${catalogedProject.version}
- **Description**: ${catalogedProject.description || 'N/A'}
- **Status**: ${catalogedProject.projectStatus || 'N/A'}

## Repository Information
- **Repo Path**: ${catalogedProject.repoPath || 'N/A'}
- **Repo URL**: ${catalogedProject.repoUrl || 'N/A'}
- **Last Sync**: ${catalogedProject.lastSync ? new Date(catalogedProject.lastSync).toLocaleString() : 'N/A'}

## Project Types
${catalogedProject.projectTypes?.map(type => `- ${type}`).join('\n') || '- N/A'}

## Processors
${catalogedProject.processors?.map(proc => `- ${proc.processor}`).join('\n') || '- N/A'}

## Tags
${catalogedProject.tags?.map(tag => `- ${tag}`).join('\n') || '- N/A'}

## File Summary
- **Total Files**: ${fileSummary.totalFiles}
${Object.entries(fileSummary.breakdown).map(([ext, count]) => `- **${ext}**: ${count} files`).join('\n') || '- N/A'}

## Catalog Information
- **Created**: ${catalogedProject.created ? new Date(catalogedProject.created).toLocaleString() : 'N/A'}
- **Updated**: ${catalogedProject.updated ? new Date(catalogedProject.updated).toLocaleString() : 'N/A'}
        `;
        break;
      case "summary":
        output = {
          summary: {
            message: `Project "${catalogedProject.name}" cataloged successfully`,
            action: "cataloged",
            projectId: catalogedProject.id,
            projectName: catalogedProject.name,
            catalogedAt: catalogedProject.updated || catalogedProject.created,
            detectedTypes: catalogedProject.projectTypes?.length || 0,
            detectedProcessors: catalogedProject.processors?.length || 0,
            fileSummary
          },
          project: {
            id: catalogedProject.id,
            name: catalogedProject.name,
            nameSpace: catalogedProject.nameSpace,
            version: catalogedProject.version,
            description: catalogedProject.description,
            projectStatus: catalogedProject.projectStatus,
            repoUrl: catalogedProject.repoUrl,
            repoPath: catalogedProject.repoPath,
            projectTypes: catalogedProject.projectTypes,
            processors: catalogedProject.processors,
            tags: catalogedProject.tags,
            lastSync: catalogedProject.lastSync,
            created: catalogedProject.created,
            updated: catalogedProject.updated,
            fileSummary
          }
        };
        break;
      default: // json
        output = {
          summary: {
            message: `Project "${catalogedProject.name}" cataloged successfully`,
            action: "cataloged",
            projectId: catalogedProject.id,
            projectName: catalogedProject.name,
            catalogedAt: catalogedProject.updated || catalogedProject.created,
            detectedTypes: catalogedProject.projectTypes?.length || 0,
            detectedProcessors: catalogedProject.processors?.length || 0,
            fileSummary
          },
          project: projectWithSummary
        };
    }

    return {
      success: true,
      data: output,
      tool: 'catalogProject',
      params: params,
      format: format,
      instructions: `
## Project Cataloging Results

Successfully cataloged project: "${catalogedProject.name}"

### Project Details:
- **Project ID**: ${catalogedProject.id}
- **FQN**: ${catalogedProject.fqn}
- **Name**: ${catalogedProject.name}
- **Namespace**: ${catalogedProject.nameSpace}
- **Version**: ${catalogedProject.version}
- **Status**: ${catalogedProject.projectStatus || 'N/A'}
- **Description**: ${catalogedProject.description || 'N/A'}

### Repository Information:
- **Repo Path**: ${catalogedProject.repoPath || 'N/A'}
- **Repo URL**: ${catalogedProject.repoUrl || 'N/A'}
- **Last Sync**: ${catalogedProject.lastSync ? new Date(catalogedProject.lastSync).toLocaleString() : 'N/A'}

### Detected Information:
- **Project Types**: ${catalogedProject.projectTypes?.length || 0} types detected
${catalogedProject.projectTypes?.map(type => `  - ${type}`).join('\n') || '  - None detected'}

- **Processors**: ${catalogedProject.processors?.length || 0} processors detected
${catalogedProject.processors?.map(proc => `  - ${proc.processor}`).join('\n') || '  - None detected'}

### File Summary:
- **Total Files**: ${fileSummary.totalFiles} files indexed in the project graph.
- **File Breakdown**:
${Object.entries(fileSummary.breakdown).map(([ext, count]) => `  - **${ext}**: ${count} files`).join('\n') || '  - No files indexed'}

### Tags:
${catalogedProject.tags?.map(tag => `- ${tag}`).join('\n') || '- N/A'}

### Catalog Information:
- **Created**: ${catalogedProject.created ? new Date(catalogedProject.created).toLocaleString() : 'N/A'}
- **Updated**: ${catalogedProject.updated ? new Date(catalogedProject.updated).toLocaleString() : 'N/A'}

### State Variables Available:
- lastCatalogedProject: The cataloged project (sanitized, files omitted to prevent history bloat)

### How to Inspect & Search the Project Graph:
The files and symbols in this project have been cataloged into the Reactor system graph. To explore and inspect the project structure without context bloat, use the following tools:

1. **Search the Graph**:
   Use \`searchGraph\` to find specific files, folders, or code symbols and get their node IDs.
   *Example*: \`searchGraph(term="MyComponent", projectName="${catalogedProject.name}", nameSpace="${catalogedProject.nameSpace}")\`

2. **Get Node Details**:
   Use \`getGraphNode\` with a node ID to retrieve details and incoming/outgoing connections.
   *Example*: \`getGraphNode(id=12345)\`

3. **Explore Children / Directory Structure**:
   Use \`graphChildren\` with a folder or file node ID to expand its contents (folders expand to files, files expand to symbols/methods).
   *Example*: \`graphChildren(id=12345)\`

4. **Walk the Graph Neighborhood**:
   Use \`exploreGraph\` with a root node ID to see a neighborhood of connected nodes (e.g., dependencies, call graph).
   *Example*: \`exploreGraph(rootId=12345, depth=2)\`

5. **List Typed Connections**:
   Use \`graphLinks\` to list all relationships (e.g., DEPENDENCY, CALL, INHERITS) connected to a specific node.
   *Example*: \`graphLinks(id=12345)\`
      `
    };
  } catch (error) {
    context.error("Error cataloging project", { 
      error, 
      params: { name, nameSpace, version, repoPath, repoUrl }
    }, "CatalogProjectMacro");
    
    return {
      success: false,
      error: `Failed to catalog project: ${error?.message || "Unknown error"}`,
      tool: 'catalogProject',
      params: params,
      instructions: `## Catalog Project \u2014 Error\n\n${error?.message || 'Unknown error'}\n\n### Recovery Options:\n- Verify the repository path/URL is accessible\n- Check that name, nameSpace, version are valid`
    };
  }    
};

const CatalogProjectMacroDefinition: MacroComponentDefinition<typeof CatalogProjectMacro> = {
  name: "CatalogProject",
  nameSpace: "zepz-engineer",
  description: `Catalogs a Reactor project by analyzing its repository and detecting project types and processors. Returns structured data for AI analysis.`,
  component: CatalogProjectMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "catalogProject",
  icon: "library_books",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "library_books",
        name: "catalogProject",
        description: "Catalogs a Reactor project by analyzing its repository and detecting project types and processors. Returns structured data for AI analysis.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name of the project to catalog.",
            },
            nameSpace: {
              type: "string",
              description: "The namespace for the project.",
            },
            version: {
              type: "string",
              description: "The version of the project.",
            },
            repoPath: {
              type: "string",
              description: "The local repository path for the project.",
            },
            repoUrl: {
              type: "string",
              description: "The remote repository URL for the project.",
            },
            description: {
              type: "string",
              description: "The description of the project.",
            },
            organization: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The name of the organization."
                }
              },
              description: "The organization for the project.",
            },
            businessUnit: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The name of the business unit."
                }
              },
              description: "The business unit for the project.",
            },
            ownerTeam: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The name of the owner team."
                }
              },
              description: "The owner team for the project.",
            },
            tags: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of tags for the project.",
            },
            format: {
              type: "string",
              enum: ["json", "markdown", "summary"],
              description: "Output format for the results.",
              default: "json"
            }
          },
          required: ["name", "nameSpace", "version"],
        },
      },
    },
  ],
};

export default CatalogProjectMacroDefinition; 