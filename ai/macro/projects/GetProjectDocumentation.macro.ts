import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorProjectService, IReactorProject, ReactorProjectDocumentation } from "@reactory/server-modules/reactory-reactor/types/service.types";

export type GetProjectDocumentationMacroParams = {
  idOrPath: string;
  includeSecondary?: boolean;
  format?: "json" | "markdown" | "summary";
}

const GetProjectDocumentationMacro = async (
  params: GetProjectDocumentationMacroParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    idOrPath,
    includeSecondary = false,
    format = "json",
  } = params;

  if (!idOrPath) {
    return {
      success: false,
      error: "idOrPath parameter is required",
      tool: 'getProjectDocumentation',
      params: params
    };
  }

  try {
    context.debug("Starting GetProjectDocumentationMacro execution", { params }, "GetProjectDocumentationMacro");
    const reactorProjectService = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    
    if (!reactorProjectService) {
      context.error("ReactorProjectService not found", {}, "GetProjectDocumentationMacro");
      return {
        success: false,
        error: "ReactorProjectService is not available",
        tool: 'getProjectDocumentation',
        params: params
      };
    }

    context.debug("ReactorProjectService retrieved successfully", {}, "GetProjectDocumentationMacro");
    
    // First, get the project to verify it exists
    const project = await reactorProjectService.getProject(idOrPath);
    
    if (!project) {
      return {
        success: false,
        error: `Project not found with idOrPath: ${idOrPath}`,
        tool: 'getProjectDocumentation',
        params: params
      };
    }

    context.debug("Project found", { projectId: project.id, projectName: project.name }, "GetProjectDocumentationMacro");
    
    // Get primary documentation
    const primaryDocumentation = await reactorProjectService.getPrimaryDocumentation(project);
    
    // Get secondary documentation if requested
    let secondaryDocumentation: ReactorProjectDocumentation[] = [];
    if (includeSecondary) {
      secondaryDocumentation = await reactorProjectService.getAdditionalDocumentation(project);
    }

    // Store in chat state for AI reference
    chatState.vars.lastProjectDocumentation = primaryDocumentation;
    chatState.vars.lastSecondaryDocumentation = secondaryDocumentation;

    let output;
    switch (format) {
      case "markdown":
        output = `
# Project Documentation: ${project.name}

## Primary Documentation
${primaryDocumentation ? `
- **Title**: ${primaryDocumentation.title}
- **Format**: ${primaryDocumentation.format}
- **Path**: ${primaryDocumentation.path || 'N/A'}
- **URL**: ${primaryDocumentation.url || 'N/A'}
- **Created**: ${primaryDocumentation.created ? new Date(primaryDocumentation.created).toLocaleString() : 'N/A'}
- **Created By**: ${primaryDocumentation.createdBy?.fullName || 'N/A'}

### Content
${primaryDocumentation.content ? `
\`\`\`${primaryDocumentation.format}
${primaryDocumentation.content}
\`\`\`
` : 'No content available'}
` : 'No primary documentation available'}

${includeSecondary && secondaryDocumentation.length > 0 ? `
## Secondary Documentation (${secondaryDocumentation.length} items)

${secondaryDocumentation.map((doc, index) => `
### ${index + 1}. ${doc.title}
- **Format**: ${doc.format}
- **URL**: ${doc.url || 'N/A'}
- **Created**: ${doc.created ? new Date(doc.created).toLocaleString() : 'N/A'}
- **Created By**: ${doc.createdBy?.fullName || 'N/A'}

${doc.content ? `
\`\`\`${doc.format}
${doc.content}
\`\`\`
` : 'No content available'}
`).join('\n')}
` : ''}
        `;
        break;
      case "summary":
        output = {
          summary: {
            message: `Documentation retrieved for project "${project.name}"`,
            projectId: project.id,
            projectName: project.name,
            hasPrimaryDocumentation: !!primaryDocumentation,
            primaryDocumentationTitle: primaryDocumentation?.title || 'N/A',
            primaryDocumentationFormat: primaryDocumentation?.format || 'N/A',
            secondaryDocumentationCount: secondaryDocumentation.length,
            retrievedAt: new Date()
          },
          project: {
            id: project.id,
            name: project.name,
            nameSpace: project.nameSpace,
            version: project.version
          },
          primaryDocumentation: primaryDocumentation ? {
            title: primaryDocumentation.title,
            format: primaryDocumentation.format,
            path: primaryDocumentation.path,
            url: primaryDocumentation.url,
            content: primaryDocumentation.content?.substring(0, 500) + (primaryDocumentation.content && primaryDocumentation.content.length > 500 ? '...' : ''),
            created: primaryDocumentation.created,
            createdBy: primaryDocumentation.createdBy?.fullName
          } : null,
          secondaryDocumentation: includeSecondary ? secondaryDocumentation.map(doc => ({
            title: doc.title,
            format: doc.format,
            url: doc.url,
            content: doc.content?.substring(0, 200) + (doc.content && doc.content.length > 200 ? '...' : ''),
            created: doc.created,
            createdBy: doc.createdBy?.fullName
          })) : []
        };
        break;
      default: // json
        output = {
          summary: {
            message: `Documentation retrieved for project "${project.name}"`,
            projectId: project.id,
            projectName: project.name,
            hasPrimaryDocumentation: !!primaryDocumentation,
            secondaryDocumentationCount: secondaryDocumentation.length,
            retrievedAt: new Date()
          },
          project: {
            id: project.id,
            name: project.name,
            nameSpace: project.nameSpace,
            version: project.version
          },
          primaryDocumentation,
          secondaryDocumentation: includeSecondary ? secondaryDocumentation : []
        };
    }

    return {
      success: true,
      data: output,
      tool: 'getProjectDocumentation',
      params: params,
      format: format,
      instructions: `
## Project Documentation Results

Retrieved documentation for project: "${project.name}"

### Project Details:
- **Project ID**: ${project.id}
- **Name**: ${project.name}
- **Namespace**: ${project.nameSpace}
- **Version**: ${project.version}

### Primary Documentation:
${primaryDocumentation ? `
- **Title**: ${primaryDocumentation.title}
- **Format**: ${primaryDocumentation.format}
- **Path**: ${primaryDocumentation.path || 'N/A'}
- **URL**: ${primaryDocumentation.url || 'N/A'}
- **Created**: ${primaryDocumentation.created ? new Date(primaryDocumentation.created).toLocaleString() : 'N/A'}
- **Created By**: ${primaryDocumentation.createdBy?.fullName || 'N/A'}

**Content Preview**: ${primaryDocumentation.content?.substring(0, 300)}${primaryDocumentation.content && primaryDocumentation.content.length > 300 ? '...' : ''}
` : 'No primary documentation available'}

${includeSecondary ? `
### Secondary Documentation:
- **Count**: ${secondaryDocumentation.length} items
${secondaryDocumentation.length > 0 ? `
${secondaryDocumentation.map((doc, index) => `
**${index + 1}. ${doc.title}**
- Format: ${doc.format}
- URL: ${doc.url || 'N/A'}
- Created: ${doc.created ? new Date(doc.created).toLocaleDateString() : 'N/A'}
- Content Preview: ${doc.content?.substring(0, 150)}${doc.content && doc.content.length > 150 ? '...' : ''}
`).join('\n')}
` : 'No secondary documentation available'}
` : ''}

### State Variables Available:
- lastProjectDocumentation: Primary documentation
- lastSecondaryDocumentation: Secondary documentation (if requested)

Use this documentation for project analysis, understanding project structure, or generating reports.
      `
    };
    
  } catch (error) {
    context.error("Error retrieving project documentation", { error, idOrPath }, "GetProjectDocumentationMacro");
    return {
      success: false,
      error: `Failed to retrieve project documentation: ${error?.message ?? "Unknown error"}`,
      tool: 'getProjectDocumentation',
      params: params
    };
  }
};

const GetProjectDocumentationMacroDefinition: MacroComponentDefinition<typeof GetProjectDocumentationMacro> = {
  name: "GetProjectDocumentation",
  nameSpace: "zepz-engineer",
  description: `Retrieves documentation for a specific Reactor project. Returns structured data for AI analysis.`,
  component: GetProjectDocumentationMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "getProjectDocumentation",
  runat: "server",
  icon: "description",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "description",
        name: "getProjectDocumentation",
        description: "Retrieves documentation for a specific Reactor project. Returns structured data for AI analysis.",
        parameters: {
          type: "object",
          properties: {
            idOrPath: {
              type: "string",
              description: "The project ID, FQN, name, or repo path to get documentation for.",
            },
            includeSecondary: {
              type: "boolean",
              description: "Whether to include secondary documentation in the response.",
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

export default GetProjectDocumentationMacroDefinition; 