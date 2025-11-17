const schema: Reactory.Schema.AnySchema = {
  type: 'object',
  properties: {
    owner: {
      type: 'object',
      title: 'Project Owner',
      description: 'The primary owner of the project',
      properties: {
        id: { type: 'string', title: 'User ID' },
        firstName: { type: 'string', title: 'First Name' },
        lastName: { type: 'string', title: 'Last Name' },
        email: { type: 'string', title: 'Email' },
        avatar: { type: 'string', title: 'Avatar URL', format: 'uri' }
      }
    },
    ownerTeam: {
      type: 'object',
      title: 'Owner Team',
      description: 'The primary team responsible for this project',
      properties: {
        id: { type: 'string', title: 'Team ID' },
        name: { type: 'string', title: 'Team Name' },
        description: { type: 'string', title: 'Team Description' },
        avatar: { type: 'string', title: 'Team Avatar', format: 'uri' }
      }
    },
    teams: {
      type: 'array',
      title: 'Project Teams',
      description: 'All teams associated with this project',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Team ID' },
          name: { type: 'string', title: 'Team Name' },
          description: { type: 'string', title: 'Team Description' },
          avatar: { type: 'string', title: 'Team Avatar', format: 'uri' }
        }
      }
    },
    engineers: {
      type: 'array',
      title: 'Project Engineers',
      description: 'Engineers working on this project',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'User ID' },
          firstName: { type: 'string', title: 'First Name' },
          lastName: { type: 'string', title: 'Last Name' },
          email: { type: 'string', title: 'Email' },
          avatar: { type: 'string', title: 'Avatar URL', format: 'uri' }
        }
      }
    },
    businessUnit: {
      type: 'object',
      title: 'Business Unit',
      description: 'The business unit this project belongs to',
      properties: {
        id: { type: 'string', title: 'Business Unit ID' },
        name: { type: 'string', title: 'Business Unit Name' },
        description: { type: 'string', title: 'Business Unit Description' }
      }
    },
    organization: {
      type: 'object',
      title: 'Organization',
      description: 'The organization this project belongs to',
      properties: {
        id: { type: 'string', title: 'Organization ID' },
        name: { type: 'string', title: 'Organization Name' },
        description: { type: 'string', title: 'Organization Description' }
      }
    }
  }
};

export default schema; 