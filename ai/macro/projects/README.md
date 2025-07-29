# Reactor Project Macros

This directory contains AI macros that provide access to Reactor project data and services through the ReactorProjectService. These macros follow the same pattern as the request macros and provide structured data for AI analysis.

## Available Macros

### 1. ListProjects
**Tool Name**: `listProjects`
**Description**: Lists all Reactor projects in the system using filters to narrow down results.

**Parameters**:
- `search` (string): Search term to filter projects by name
- `businessUnit` (string): Filter projects by business unit ID
- `ownerTeam` (string): Filter projects by owner team ID
- `owner` (string): Filter projects by owner user ID
- `system` (string): Filter projects by system ID
- `status` (string): Filter projects by status (ACTIVE, INACTIVE, ARCHIVED, DEPRECATED)
- `page` (number): Page number for pagination (default: 1)
- `pageSize` (number): Number of projects per page (default: 10)
- `format` (string): Output format (json, markdown, summary)

**State Variables**:
- `listedProjects`: All retrieved projects
- `projectsByStatus`: Projects grouped by status
- `projectSummary`: Summary statistics and metadata

### 2. GetProject
**Tool Name**: `getProject`
**Description**: Retrieves a specific Reactor project by ID or path.

**Parameters**:
- `idOrPath` (string, required): The project ID, FQN, name, or repo path to retrieve
- `includeDocumentation` (boolean): Whether to include primary documentation (default: false)
- `includeMetrics` (boolean): Whether to include project metrics for the last 14 days (default: false)
- `format` (string): Output format (json, markdown, summary)

**State Variables**:
- `lastRetrievedProject`: The retrieved project
- `lastProjectDocumentation`: Primary documentation (if requested)
- `lastProjectMetrics`: Project metrics (if requested)

### 3. CreateProject
**Tool Name**: `createProject`
**Description**: Creates a new Reactor project or returns an existing one if it already exists.

**Parameters**:
- `name` (string, required): The name of the project to create
- `nameSpace` (string, required): The namespace for the project
- `version` (string, required): The version of the project
- `description` (string): The description of the project
- `repoPath` (string): The local repository path for the project
- `repoUrl` (string): The remote repository URL for the project
- `projectTypes` (string[]): Array of project types
- `organization` (object): The organization for the project
- `businessUnit` (object): The business unit for the project
- `ownerTeam` (object): The owner team for the project
- `owner` (string): The owner user ID for the project
- `tags` (string[]): Array of tags for the project
- `tasksUrl` (string): The URL to the tasks/project management system
- `primarySlackChannel` (object): The primary Slack channel for the project
- `format` (string): Output format (json, markdown, summary)

**State Variables**:
- `lastCreatedProject`: The newly created project
- `lastExistingProject`: The existing project (if found)

### 4. UpdateProject
**Tool Name**: `updateProject`
**Description**: Updates an existing Reactor project with the specified changes.

**Parameters**:
- `idOrPath` (string, required): The project ID, FQN, name, or repo path to update
- `name` (string): The new name for the project
- `nameSpace` (string): The new namespace for the project
- `version` (string): The new version for the project
- `description` (string): The new description for the project
- `repoPath` (string): The new local repository path for the project
- `repoUrl` (string): The new remote repository URL for the project
- `projectTypes` (string[]): Array of new project types
- `projectStatus` (string): The new status for the project
- `tags` (string[]): Array of new tags for the project
- `tasksUrl` (string): The new URL to the tasks/project management system
- `format` (string): Output format (json, markdown, summary)

**State Variables**:
- `lastUpdatedProject`: The updated project

### 5. DeleteProject
**Tool Name**: `deleteProject`
**Description**: Deletes a Reactor project from the system. Requires confirmation.

**Parameters**:
- `idOrPath` (string, required): The project ID, FQN, name, or repo path to delete
- `confirm` (boolean): Confirmation flag. Must be set to true to proceed with deletion (default: false)
- `format` (string): Output format (json, markdown, summary)

**State Variables**:
- `lastDeletedProject`: The deleted project details

### 6. CatalogProject
**Tool Name**: `catalogProject`
**Description**: Catalogs a Reactor project by analyzing its repository and detecting project types and processors.

**Parameters**:
- `name` (string, required): The name of the project to catalog
- `nameSpace` (string, required): The namespace for the project
- `version` (string, required): The version of the project
- `repoPath` (string): The local repository path for the project
- `repoUrl` (string): The remote repository URL for the project
- `description` (string): The description of the project
- `organization` (object): The organization for the project
- `businessUnit` (object): The business unit for the project
- `ownerTeam` (object): The owner team for the project
- `tags` (string[]): Array of tags for the project
- `format` (string): Output format (json, markdown, summary)

**State Variables**:
- `lastCatalogedProject`: The cataloged project

### 7. GetProjectDocumentation
**Tool Name**: `getProjectDocumentation`
**Description**: Retrieves documentation for a specific Reactor project.

**Parameters**:
- `idOrPath` (string, required): The project ID, FQN, name, or repo path to get documentation for
- `includeSecondary` (boolean): Whether to include secondary documentation (default: false)
- `format` (string): Output format (json, markdown, summary)

**State Variables**:
- `lastProjectDocumentation`: Primary documentation
- `lastSecondaryDocumentation`: Secondary documentation (if requested)

### 8. GetProjectMetrics
**Tool Name**: `getProjectMetrics`
**Description**: Retrieves metrics for a specific Reactor project over a specified time period.

**Parameters**:
- `idOrPath` (string, required): The project ID, FQN, name, or repo path to get metrics for
- `startDate` (string): Start date for metrics (ISO string). Defaults to 14 days ago
- `endDate` (string): End date for metrics (ISO string). Defaults to current date
- `format` (string): Output format (json, markdown, summary)

**State Variables**:
- `lastProjectMetrics`: The retrieved project metrics

## Usage Examples

### List all active projects
```json
{
  "tool": "listProjects",
  "params": {
    "status": "ACTIVE",
    "pageSize": 20,
    "format": "summary"
  }
}
```

### Get a specific project with documentation
```json
{
  "tool": "getProject",
  "params": {
    "idOrPath": "my-project",
    "includeDocumentation": true,
    "includeMetrics": true,
    "format": "json"
  }
}
```

### Create a new project
```json
{
  "tool": "createProject",
  "params": {
    "name": "my-new-project",
    "nameSpace": "my-org",
    "version": "1.0.0",
    "description": "A new Reactor project",
    "repoUrl": "https://github.com/my-org/my-new-project.git",
    "projectTypes": ["typescript", "reactjs"],
    "tags": ["frontend", "react"],
    "format": "summary"
  }
}
```

### Catalog a project
```json
{
  "tool": "catalogProject",
  "params": {
    "name": "my-project",
    "nameSpace": "my-org",
    "version": "1.0.0",
    "repoPath": "/path/to/local/repo",
    "description": "A project to be cataloged",
    "format": "markdown"
  }
}
```

## Output Formats

All macros support three output formats:

1. **json**: Full structured data with all details
2. **markdown**: Human-readable markdown format
3. **summary**: Condensed summary with key information

## Error Handling

All macros include comprehensive error handling and will return structured error responses when:
- Required parameters are missing
- The ReactorProjectService is not available
- Projects are not found
- Service operations fail

## State Management

Macros store relevant data in the chat state for AI reference, allowing for context-aware conversations and follow-up operations. 