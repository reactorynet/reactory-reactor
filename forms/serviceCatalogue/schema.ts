import Reactory from '@reactory/reactory-core';

const ProjectItemSchema: Reactory.Schema.ISchema = {
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

const ProjectsTableSchema: Reactory.Schema.ISchema = { 
  type: 'object',  
  properties: {
    projects: {
      type: 'array',
      title: 'Projects',
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