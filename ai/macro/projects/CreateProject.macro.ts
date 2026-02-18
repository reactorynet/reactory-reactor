import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { ReactorProjectService, IReactorProject, KnownReactorProjectTypes, ReactorProjectStatus, ReactorSlackChannel } from "@reactory/server-modules/reactory-reactor/types/service.types";

export type CreateProjectMacroParams = {
  name: string;
  nameSpace: string;
  version: string;
  description?: string;
  repoPath?: string;
  repoUrl?: string;
  projectTypes?: string[];
  organization?: {
    name: string;
  };
  businessUnit?: {
    name: string;
  };
  ownerTeam?: {
    name: string;
  };
  owner?: string;
  tags?: string[];
  tasksUrl?: string;
  primarySlackChannel?: {
    name: string;
    description?: string;
  };
  format?: "json" | "markdown" | "summary";
  /** Optional template name to pre-fill common project configurations */
  template?: string;
}

/**
 * Built-in project templates.
 * Each template provides defaults for projectTypes, tags, and description.
 * Values from the template are only applied when the caller hasn't provided them.
 */
const PROJECT_TEMPLATES: Record<string, Partial<CreateProjectMacroParams>> = {
  'react-app': {
    projectTypes: ['reactjs', 'typescript', 'pwa'],
    tags: ['frontend', 'react', 'typescript', 'web'],
    description: 'A React + TypeScript web application',
  },
  'node-api': {
    projectTypes: ['nodejs', 'typescript', 'express'],
    tags: ['backend', 'api', 'nodejs', 'typescript'],
    description: 'A Node.js + Express API server',
  },
  'reactory-module': {
    projectTypes: ['reactory', 'typescript', 'nodejs'],
    tags: ['reactory', 'module', 'plugin', 'typescript'],
    description: 'A Reactory server module with routes, services, and models',
  },
  'react-native': {
    projectTypes: ['react-native', 'typescript', 'mobile'],
    tags: ['mobile', 'react-native', 'typescript', 'ios', 'android'],
    description: 'A React Native mobile application',
  },
  'fullstack': {
    projectTypes: ['reactjs', 'nodejs', 'typescript', 'express'],
    tags: ['fullstack', 'react', 'node', 'typescript', 'web'],
    description: 'A full-stack web application with React frontend and Node.js backend',
  },
  'library': {
    projectTypes: ['typescript', 'npm'],
    tags: ['library', 'npm', 'typescript', 'reusable'],
    description: 'A reusable TypeScript library published to npm',
  },
};

/**
 * Apply a template's defaults to the params. Caller-provided values take precedence.
 */
function applyTemplate(params: CreateProjectMacroParams): CreateProjectMacroParams {
  const { template, ...rest } = params;
  if (!template) return params;

  const tmpl = PROJECT_TEMPLATES[template];
  if (!tmpl) return params;

  return {
    ...rest,
    projectTypes: rest.projectTypes?.length ? rest.projectTypes : (tmpl.projectTypes as string[] ?? []),
    tags: rest.tags?.length ? rest.tags : (tmpl.tags ?? []),
    description: rest.description || tmpl.description,
  };
}

const CreateProjectMacro = async (
  params: CreateProjectMacroParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;

  // Apply template defaults if specified
  const resolvedParams = applyTemplate(params);

  const { 
    name,
    nameSpace,
    version,
    description,
    repoPath,
    repoUrl,
    projectTypes = [] as KnownReactorProjectTypes[],
    organization,
    businessUnit,
    ownerTeam,
    owner,
    tags = [],
    tasksUrl,
    primarySlackChannel,
    format = "json",
  } = resolvedParams;

  if (!name || !nameSpace || !version) {
    return {
      success: false,
      error: "Missing required parameters: name, nameSpace, and version are required.",
      tool: 'createProject',
      params: params
    };
  }

  try {
    context.debug("Starting CreateProjectMacro execution", { params }, "CreateProjectMacro");
    const reactorProjectService = context.getService<ReactorProjectService>("reactor.ReactorProjectService@1.0.0");
    
    if (!reactorProjectService) {
      context.error("ReactorProjectService not found", {}, "CreateProjectMacro");
      return {
        success: false,
        error: "ReactorProjectService is not available",
        tool: 'createProject',
        params: params
      };
    }

    context.debug("ReactorProjectService retrieved successfully", {}, "CreateProjectMacro");
    
    // Check if a project with this name already exists
    const existingProject = await reactorProjectService.getProject(name);
    if (existingProject) {
      // Store in chat state for AI reference
      chatState.vars.lastExistingProject = existingProject;

      return {
        success: true,
        data: {
          summary: {
            message: `Project "${name}" already exists`,
            action: "found_existing",
            projectId: existingProject.id,
            foundAt: new Date()
          },
          project: {
            id: existingProject.id,
            name: existingProject.name,
            nameSpace: existingProject.nameSpace,
            version: existingProject.version,
            description: existingProject.description,
            projectStatus: existingProject.projectStatus,
            repoUrl: existingProject.repoUrl,
            repoPath: existingProject.repoPath,
            projectTypes: existingProject.projectTypes
          },
          existing: true
        },
        tool: 'createProject',
        params: params,
        format: 'json',
        instructions: `
## Existing Project Found

A project with the name "${name}" already exists in the system.

### Project Details:
- **Project ID**: ${existingProject.id}
- **Name**: ${existingProject.name}
- **Namespace**: ${existingProject.nameSpace}
- **Version**: ${existingProject.version}
- **Status**: ${existingProject.projectStatus || 'N/A'}
- **Description**: ${existingProject.description || 'N/A'}
- **Repo URL**: ${existingProject.repoUrl || 'N/A'}
- **Repo Path**: ${existingProject.repoPath || 'N/A'}
- **Project Types**: ${existingProject.projectTypes?.join(', ') || 'N/A'}

### State Variables Available:
- lastExistingProject: The existing project that was found

Use this existing project instead of creating a new one, or choose a different name for your new project.
        `
      };
    }
    
    // Prepare project data
    const projectData: Partial<IReactorProject> = {
      name,
      nameSpace,
      version,
      description,
      repoPath,
      repoUrl,
      projectTypes,
      tags,
      tasksUrl,
      projectStatus: ReactorProjectStatus.ACTIVE,
      created: new Date(),
      updated: new Date()
    };

    // Add organization if provided
    if (organization) {
      projectData.organization = organization;
    }

    // Add business unit if provided
    if (businessUnit) {
      projectData.businessUnit = businessUnit;
    }

    // Add owner team if provided
    if (ownerTeam) {
      projectData.ownerTeam = ownerTeam;
    }

    // Add owner if provided
    if (owner) {
      // Note: This would need to be resolved to a user object in the service
      projectData.owner = owner as any;
    }

    // Add primary slack channel if provided
    if (primarySlackChannel) {
      projectData.primarySlackChannel = {
        id: primarySlackChannel.name,
        name: primarySlackChannel.name,
        description: primarySlackChannel.description
      } as ReactorSlackChannel;
    }

    // Create the new project
    const newProject = await reactorProjectService.createProject(projectData);

    // Store in chat state for AI reference
    chatState.vars.lastCreatedProject = newProject;

    context.info(`Created new project`, {
      id: newProject.id,
      name: newProject.name,
      nameSpace: newProject.nameSpace,
      version: newProject.version
    }, "CreateProjectMacro");

    let output;
    switch (format) {
      case "markdown":
        output = `
# New Project Created: ${newProject.name}

## Project Details
- **ID**: ${newProject.id}
- **FQN**: ${newProject.fqn}
- **Namespace**: ${newProject.nameSpace}
- **Version**: ${newProject.version}
- **Description**: ${newProject.description || 'N/A'}
- **Status**: ${newProject.projectStatus || 'ACTIVE'}

## Repository Information
- **Repo Path**: ${newProject.repoPath || 'N/A'}
- **Repo URL**: ${newProject.repoUrl || 'N/A'}

## Project Types
${newProject.projectTypes?.map(type => `- ${type}`).join('\n') || '- N/A'}

## Tags
${newProject.tags?.map(tag => `- ${tag}`).join('\n') || '- N/A'}

## Created
- **Created At**: ${newProject.created ? new Date(newProject.created).toLocaleString() : 'N/A'}
- **Updated At**: ${newProject.updated ? new Date(newProject.updated).toLocaleString() : 'N/A'}
        `;
        break;
      case "summary":
        output = {
          summary: {
            message: `New project created successfully`,
            action: "created",
            projectId: newProject.id,
            projectName: newProject.name,
            createdAt: newProject.created
          },
          project: {
            id: newProject.id,
            name: newProject.name,
            nameSpace: newProject.nameSpace,
            version: newProject.version,
            description: newProject.description,
            projectStatus: newProject.projectStatus,
            repoUrl: newProject.repoUrl,
            repoPath: newProject.repoPath,
            projectTypes: newProject.projectTypes,
            tags: newProject.tags,
            created: newProject.created,
            updated: newProject.updated
          },
          existing: false
        };
        break;
      default: // json
        output = {
          summary: {
            message: `New project created successfully`,
            action: "created",
            projectId: newProject.id,
            projectName: newProject.name,
            createdAt: newProject.created
          },
          project: newProject,
          existing: false
        };
    }

    return {
      success: true,
      data: output,
      tool: 'createProject',
      params: params,
      format: format,
      instructions: `
## New Project Creation Results

Successfully created a new project: "${newProject.name}"

### Project Details:
- **Project ID**: ${newProject.id}
- **FQN**: ${newProject.fqn}
- **Name**: ${newProject.name}
- **Namespace**: ${newProject.nameSpace}
- **Version**: ${newProject.version}
- **Status**: ${newProject.projectStatus || 'ACTIVE'}
- **Description**: ${newProject.description || 'N/A'}

### Repository Information:
- **Repo Path**: ${newProject.repoPath || 'N/A'}
- **Repo URL**: ${newProject.repoUrl || 'N/A'}

### Project Types:
${newProject.projectTypes?.map(type => `- ${type}`).join('\n') || '- N/A'}

### Tags:
${newProject.tags?.map(tag => `- ${tag}`).join('\n') || '- N/A'}

### Created:
- **Created At**: ${newProject.created ? new Date(newProject.created).toLocaleString() : 'N/A'}
- **Updated At**: ${newProject.updated ? new Date(newProject.updated).toLocaleString() : 'N/A'}

### State Variables Available:
- lastCreatedProject: The newly created project

The project has been created and is ready for further configuration or processing.
      `
    };
  } catch (error) {
    context.error("Error creating new project", { 
      error, 
      params: { name, nameSpace, version }
    }, "CreateProjectMacro");
    
    return {
      success: false,
      error: `Failed to create new project: ${error?.message || "Unknown error"}`,
      tool: 'createProject',
      params: params
    };
  }    
};

const CreateProjectMacroDefinition: MacroComponentDefinition<typeof CreateProjectMacro> = {
  name: "CreateProject",
  nameSpace: "zepz-engineer",
  description: `Creates a new Reactor project with the specified details. Returns structured data for AI analysis.`,
  component: CreateProjectMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "createProject",
  icon: "add_circle",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "add_circle",
        name: "createProject",
        description: "Creates a new Reactor project or returns an existing one if it already exists. Returns structured data for AI analysis.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name of the project to create.",
            },
            nameSpace: {
              type: "string",
              description: "The namespace for the project.",
            },
            version: {
              type: "string",
              description: "The version of the project.",
            },
            description: {
              type: "string",
              description: "The description of the project.",
            },
            repoPath: {
              type: "string",
              description: "The local repository path for the project.",
            },
            repoUrl: {
              type: "string",
              description: "The remote repository URL for the project.",
            },
            projectTypes: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of project types (e.g., ['typescript', 'reactjs', 'nodejs']).",
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
            owner: {
              type: "string",
              description: "The owner user ID for the project.",
            },
            tags: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of tags for the project.",
            },
            tasksUrl: {
              type: "string",
              description: "The URL to the tasks/project management system.",
            },
            primarySlackChannel: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The name of the primary Slack channel."
                },
                description: {
                  type: "string",
                  description: "The description of the primary Slack channel."
                }
              },
              description: "The primary Slack channel for the project.",
            },
            format: {
              type: "string",
              enum: ["json", "markdown", "summary"],
              description: "Output format for the results.",
              default: "json"
            },
            template: {
              type: "string",
              enum: ["react-app", "node-api", "reactory-module", "react-native", "fullstack", "library"],
              description: "Optional project template to pre-fill projectTypes, tags, and description. Caller-provided values override template defaults."
            }
          },
          required: ["name", "nameSpace", "version"],
        },
      },
    },
  ],
};

export default CreateProjectMacroDefinition; 