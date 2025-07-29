import security from "build/server/reactory/local/app/modules/reactory-reactor/ai/openai/chat/macro/develop/review/specifications/presets/security";
import { content } from "pdfkit/js/page";
import { id } from "schema/reflection";

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

const documentationSchema: Reactory.Schema.AnySchema = { 
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string", title: "Title" },
    content: { type: "string", title: "Content" },
    format: { type: "string", title: "Format", enum: ["markdown", "text", "html"] },
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
    url: { type: "string", title: "URL", format: "uri" },
  }, 
};

const environmentSchema: Reactory.Schema.AnySchema = {
  type: "object",
  properties: {
    id: { type: "string", title: "Environment ID" },
    name: { type: "string", title: "Environment Name" },
    description: { type: "string", title: "Description" },
    status: { type: "string", title: "Status", enum: ["STABLE", "UNSTABLE", "DEPRECATED", "ARCHIVED"] },
    created: { type: "string", format: "date-time", title: "Created" },
    updated: { type: "string", format: "date-time", title: "Updated" },
  }
};

const deploymentSchema: Reactory.Schema.AnySchema = {
  type: "object",
  properties: {
    id: { type: "string", title: "Deployment ID" },
    status: { type: "string", title: "Status", enum: ["PENDING", "DEPLOYING", "SUCCESS", "FAILED", "ROLLBACK"] },
    environment: environmentSchema,
    name: { type: "string", title: "Name" },
    description: { type: "string", title: "Description" },
    url: { type: "string", title: "URL", format: "uri" },
    version: { type: "string", title: "Version" },
    ciProvider: { type: "string", title: "CI Provider" },
    ciPipeline: { type: "string", title: "CI Pipeline" },
    ciBranch: { type: "string", title: "CI Branch" },
    ciBuildId: { type: "string", title: "CI Build ID" },
    ciBuildUrl: { type: "string", title: "CI Build URL", format: "uri" },
    commitHash: { type: "string", title: "Commit Hash" },
    commitMessage: { type: "string", title: "Commit Message" },
    commitAuthor: { type: "string", title: "Commit Author" },
    created: { type: "string", format: "date-time", title: "Created" },
    updated: { type: "string", format: "date-time", title: "Updated" },    
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
      properties: {        
        basicInfo: {
          type: "object",
          properties: {
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
              items: { type: "string" }},
          },
        },
        secondaryInfo: {
          type: "object",
          properties: {
            repoUrl: { type: "string", format: "uri" },
            tasksUrl: { type: "string", format: "uri" },
            lastSync: { type: "string", format: "date-time", title: "Last Synced", default: "Never" },
            created: { type: "string", format: "date-time", title: "Created" },
            updated: { type: "string", format: "date-time", title: "Updated" },
            notes: {
              type: "array",
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
              title: "Notes",
              description: "Additional notes or comments about the project"
            }
          }
        },
        owner: {
          type: "object",
          title: '${formData?.firstName || "No "} ${formData?.lastName || "Owner"}',
          description: '${formData?.email || "Email Missing"}',
          default: {
            id: "",
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
    },
    metrics: {
      type: "object",      
      properties: {
        deployments: { 
          type: "array", title: "Deployments",
          items: {
            type: "object",
            properties: {
              id: { type: "string", title: "Deployment ID" },
              environment: { type: "string", title: "Environment" },
              created: { type: "string", format: "date-time", title: "Created" },
              updated: { type: "string", format: "date-time", title: "Updated" },
              status: { type: "string", title: "Status" }
            }
          } 
        },
        alerts: { 
          type: "array", title: "Alerts",
          items: {
            type: "object",
            properties: {
              id: { type: "string", title: "Alert ID" },
              alertType: { type: "string", title: "Alert Type" },
              status: { type: "string", title: "Status" },
              created: { type: "string", format: "date-time", title: "Created" }
            }
          } 
        },
      }
    },
    deployments: {
      type: "object",
      properties: {
        deployments: { type: "array", items: deploymentSchema, title: "Deployments" }
      }
    },
    documentation: {
      type: "object",      
      properties: {
        primaryDocumentation: documentationSchema,
        secondaryDocumentation: {
          type: "array",
          items: documentationSchema,
          title: "Secondary Documentation"
        }
      }
    },
    team: {
      type: "object",      
      properties: {
        owner: { 
          type: "object", 
          title: "Owner",
          properties: {
            id: { type: "string", title: "User ID" },
            firstName: { type: "string", title: "First Name" },
            lastName: { type: "string", title: "Last Name" },
            avatar: { type: "string", title: "Avatar URL", format: "uri" }
          } 
        },
        ownerTeam: { 
          type: "object", 
          title: "Owner Team",
          properties: {
            id: { type: "string", title: "Team ID" },
            name: { type: "string", title: "Team Name" }
          }
        },        
      }
    },
    incidents: {
      type: "object",
      properties: {
        activeIncidents: { type: "array", items: { type: "string" }, title: "Active Incidents" },
        resolvedIncidents: { type: "array", items: { type: "string" }, title: "Resolved Incidents" },
        incidentHistory: { type: "array", items: { type: "string" }, title: "Incident History" }
      }
    },
    security: {
      type: "object",
      properties: {
        dataClassification: { type: "string", title: "Data Classification" },
        vulnerabilityStatus: { type: "string", title: "Vulnerability Status" },
        lastSecurityReview: { type: "string", format: "date-time", title: "Last Security Review" },
        securityNotes: { type: "string", title: "Security Notes" },
        securityPoliciesUrl: { type: "string", title: "Security Policies URL", format: "uri" },
        encryptionAtRest: { type: "boolean", title: "Encryption At Rest" },
        encryptionInTransit: { type: "boolean", title: "Encryption In Transit" },
        dependenciesWithKnownVulnerabilities: { type: "integer", title: "Dependencies With Known Vulnerabilities" },
        vulnerabilityReportUrl: { type: "string", title: "Vulnerability Report URL", format: "uri" }
      }
    },
    history: {
      type: "object",
      properties: {
        history: { 
          type: "array", 
          items: { 
            type: "object",
            properties: {
              id: { type: "string", title: "ID" },
              title: { type: "string", title: "Title" },
              description: { type: "string", title: "Description" },
              created: { type: "string", format: "date-time", title: "Created" },
              updated: { type: "string", format: "date-time", title: "Updated" },
              createdBy: { type: "object", title: "Created By", 
                properties: {
                  id: { type: "string", title: "User ID" },
                  firstName: { type: "string", title: "First Name" },
                  lastName: { type: "string", title: "Last Name" },
                  avatar: { type: "string", title: "Avatar URL", format: "uri" }
                }
            }
          }
        }
      }
    }
    }
  }
};

export default projectHomeSchema;
