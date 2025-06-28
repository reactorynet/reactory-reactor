const projectSchemaBase = {
  title: "Project",  
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    nameSpace: { type: "string" },
    version: { type: "string" },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    repoUrl: { type: "string" },
    docsUrl: { type: "string" },
  }
};


// the project home schema defines a layout for grouping 
// project related information and actions in a structured way
// it is used to render the project home page in the UI
const projectHomeSchema: Reactory.Schema.ISchema = {
  title: "Project Home",
  type: "object",
  properties: {
    overview: {
      type: "object",
      title: "Overview",
      properties: {
        name: { type: "string", title: "Project Name" },
        nameSpace: { type: "string", title: "Namespace" },
        version: { type: "string", title: "Version" },
        description: { type: "string", title: "Description" },
        projectStatus: { type: "string", title: "Status" },
        tags: { type: "array", items: { type: "string" }, title: "Tags" },
        repoUrl: { type: "string", title: "Repository URL", format: "uri" },
        tasksUrl: { type: "string", title: "Tasks URL", format: "uri" },
        lastSync: { type: "string", format: "date-time", title: "Last Synced" },
        created: { type: "string", format: "date-time", title: "Created" },
        updated: { type: "string", format: "date-time", title: "Updated" },
      }
    },
    metrics: {
      type: "object",
      title: "Key Metrics",
      properties: {
        deployments: { type: "integer", title: "Deployments" },
        dashboards: { type: "integer", title: "Dashboards" },
        engineers: { type: "integer", title: "Engineers" },
        branches: { type: "integer", title: "Branches" },
        errors: { type: "integer", title: "Errors" },
        notes: { type: "integer", title: "Notes" },
      }
    },
    documentation: {
      type: "object",
      title: "Documentation",
      properties: {
        primaryDocumentation: { type: "string", title: "Primary Documentation" },
        secondaryDocumentation: {
          type: "array",
          items: { type: "string" },
          title: "Secondary Documentation"
        }
      }
    },
    team: {
      type: "object",
      title: "Team",
      properties: {
        owner: { type: "string", title: "Owner" },
        ownerTeam: { type: "string", title: "Owner Team" },
        teams: { type: "array", items: { type: "string" }, title: "Teams" },
        engineers: { type: "array", items: { type: "string" }, title: "Engineers" },
      }
    }
  },
  required: ["overview", "metrics", "documentation", "team"]
};

export default projectSchemaBase;
