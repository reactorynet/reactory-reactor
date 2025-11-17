const schema: Reactory.Schema.AnySchema = {
  type: 'object',
  properties: {
    avatar: { 
      type: "string", 
      title: "Avatar URL", 
      format: "uri" 
    },
    basicInfo: {
      type: "object",      
      properties: {
        id: { type: "string", title: "Project ID" },
        name: { type: "string", title: "Project Name" },
        nameSpace: { type: "string", title: "Namespace" },
        version: { type: "string", title: "Version" },
        description: { type: "string", title: "Description", default: "Update your project description" },
        projectStatus: { 
          type: "string", 
          title: "Status",
          enum: ["ACTIVE", "INACTIVE", "ARCHIVED", "DEPRECATED"], 
        },
        incidentActive: { 
          type: "boolean", 
          title: "Incident Status" 
        },
        businessUnit: {
          type: "object",
          title: "Domain",
          properties: {
            id: { type: "string", title: "Id" },
            name: { type: "string", title: "Name" }
          }
        },
        ownerTeam: {
          type: "object",
          title: "Team",
          properties: {
            id: { type: "string", title: "Team ID" },
            name: { type: "string", title: "Team Name" }
          }
        },
        projectTypes: { 
          type: "array", 
          title: "Providers", 
          items: { type: "string" }
        },
      },
    },
    secondaryInfo: {
      type: "object",      
      properties: {
        repoUrl: { type: "string", format: "uri", title: "Repository URL", default: "https://github.com/" },
        tasksUrl: { type: "string", format: "uri", title: "Tasks URL", default: "https://worldremit.atlassian.net/" },
        lastSync: { type: "string", format: "date-time", title: "Last Synced", default: "Never" },
        created: { type: "string", format: "date-time", title: "Created" },
        updated: { type: "string", format: "date-time", title: "Updated" },
        notes: {
          type: "array",
          title: "Notes",
          description: "Additional notes or comments about the project",
          items: { 
            type: "object", 
            properties: {
              id: { type: "string", title: "ID" },
              content: { type: "string", title: "Content" },
              format: { type: "string", title: "Format", enum: ["markdown", "text", "html"] },
              createdBy: { type: "object", title: "Created By", 
                properties: {
                  id: { type: "string", title: "User ID" },
                  firstName: { type: "string", title: "First Name" },
                  lastName: { type: "string", title: "Last Name" },
                  avatar: { type: "string", title: "Avatar URL", format: "uri" }
                }
               },              
              created: { type: "string", format: "date-time", title: "Created" },
            }
          },
        }
      }
    },
    owner: {
      type: "object",
      title: "Project Owner",
      description: "The user who owns the project",
      default: {
        id: null,
        firstName: "Owner not set",
        lastName: "",
        email: "email@missing.com",
        avatar: `${process.env.CDN_ROOT}profiles/default/default.png`
      },
      properties: {
        id: { type: "string", title: "User ID" },
        firstName: { type: "string", title: "First Name" },
        lastName: { type: "string", title: "Last Name" },
        email: { type: "string", title: "Email" },
        avatar: { type: "string", title: "Avatar URL", format: "uri" }
      }
    },
  }
};

export default schema; 