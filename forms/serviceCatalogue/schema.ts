import Reactory from '@reactory/reactory-core';

export const ProjectItemSchema: Reactory.Schema.ISchema = {
  type: 'object', 
  properties: {
    name: {
      type: 'string',
      title: 'Project Name',
    },
    nameSpace: {
      type: 'string',
      title: 'Namespace',
    },
    version: {
      type: 'string',
      title: 'Version',
    },
    system: {
      type: 'object',
      title: 'System',
      properties: {
        id: {
          type: 'string',
          title: 'System ID', 
        },
        name: {
          type: 'string',
          title: 'System Name',
        },
        description: {
          type: 'string',
          title: 'System Description',
        },
      }
    },
    owner: {
      type: 'string',
      title: 'Owner',
    },
    businessUnit: {
      type: 'string',
      title: 'Domain',
    },
    incidentActive: {
      type: 'boolean',
      title: 'Incident Active',
    },
    description: {
      type: 'string',
      title: 'Description',
    },
  },
};

export const ProjectsTableSchema: Reactory.Schema.ISchema = { 
  type: 'object',  
  properties: {
    welcome: {
      type: "string",
      title: "Welcome",
      default: "Welcome to the Reactory Projects Portal!"
    },
    avatar: { 
      type: "string",
      title: "Avatar URL",
      format: "uri",
      default: `${process.env.CDN_ROOT}profiles/default/default.png`
    },
    headerImage: {
      type: "string",
      title: "Header Image URL",
      format: "uri",
      default: `${process.env.CDN_ROOT}profiles/reactor/projects/banner.jpg`
    },
    filters: {
      type: 'object',
      title: 'Filters',
      properties: {        
        system: {
          type: 'string',
          title: 'System',
          description: 'Filter by system',                    
        },          
        domain: {
          type: 'string',
          title: 'Domain',
          description: 'Filter by domain',
        },
        ownerTeam: { 
          type: "string",
          title: 'Owner Team',
          description: 'Filter by owner team'
        },
        owner: {
          type: 'string',
          title: 'Owner',
          description: 'Filter by owner'
        },
        status: {
          type: 'string',
          title: 'Status',
          enum: ['active', 'inactive', 'archived'],          
          description: 'Filter by status'
        },
        indicidentsActive: {
          type: 'boolean',
          title: 'Incidents Active',
          description: 'Filter by active incidents'
        },
      }
    },
    projects: {
      type: 'array',      
      items: ProjectItemSchema
    }
  }
}

const ReactorProjectSchemaResolver: Reactory.Schema.TServerSchemaResolver = async (
  form: Reactory.Forms.IReactoryForm,
  args: any,
  context: Reactory.Server.IReactoryContext,
  info: any
): Promise<Reactory.Schema.AnySchema> => {
  const { i18n, user } = context;
  return ProjectsTableSchema;
};

export default ReactorProjectSchemaResolver;