const documentationSchema: Reactory.Schema.AnySchema = { 
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string", title: "Title" },
    content: { type: "string", title: "Content" },
    format: { type: "string", title: "Format", enum: ["markdown", "text", "html"] },
    path: { type: "string", title: "Path" },
    url: { type: "string", title: "URL", format: "uri" },
    createdBy: {
      type: "object",
      title: "Created By",
      default: {
        id: "",
        firstName: "Owner not set",
        lastName: "",
        avatar: ""
      },
      properties: {
        id: { type: "string", title: "User ID" },
        firstName: { type: "string", title: "First Name" },
        lastName: { type: "string", title: "Last Name" },
        avatar: { type: "string", title: "Avatar URL", format: "uri" }
      }
    },
    created: { type: "string", format: "date-time", title: "Created" },
    updated: { type: "string", format: "date-time", title: "Updated" },
  }, 
};

const schema: Reactory.Schema.AnySchema = {
  type: 'object',
  properties: {
    primaryDocumentation: {
      ...documentationSchema,
      title: "Primary Documentation",
      description: "The main documentation for the project"
    },
    additionalDocumentation: {
      type: "array",
      items: documentationSchema,
      title: "Additional Documentation",
      description: "Additional documentation files for the project"
    },
    project: {
      type: "object",
      title: "Project Information",
      properties: {
        id: { type: "string", title: "Project ID" },
        name: { type: "string", title: "Project Name" },
        nameSpace: { type: "string", title: "Namespace" },
        version: { type: "string", title: "Version" },
        description: { type: "string", title: "Description" },
        repoUrl: { type: "string", title: "Repository URL", format: "uri" },
        docsUrl: { type: "string", title: "Documentation URL", format: "uri" },
      }
    }
  }
};

export default schema; 