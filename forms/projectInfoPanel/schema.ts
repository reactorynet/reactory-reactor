const schema: Reactory.Schema.AnySchema = {
  type: 'object',
  properties: {
    incidents: {
      type: 'array',
      title: 'Incidents',
      description: 'A count of incidents per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the incident.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of incidents on this date.',
          },
        },
      },           
      readOnly: true,
    },
    errors: {
      type: 'array',
      title: 'Incidents',
      description: 'A count of incidents per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the incident.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of incidents on this date.',
          },
        },
      },
    },
    deployments: {
      type: 'array',
      title: 'Deployments',
      description: 'A count of deployments per day.',
      items: {  
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the deployment.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of deployments on this date.',
          },
        },
      },
      readOnly: true,
    },

    openPullRequests: {
      type: 'array',
      title: 'Open Pull Requests',
      description: 'A count of open pull requests per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the open pull requests.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of open pull requests on this date.',
          },
        },
      },
      readOnly: true,
    },
    closedPullRequests: {
      type: 'array',
      title: 'Closed Pull Requests',
      description: 'A count of closed pull requests per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the open pull requests.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of open pull requests on this date.',
          },
        },
      },
      readOnly: true,
    },  
    activeDeployments: { 
      type: 'array',
      title: 'Active Deployments',
      description: 'A count of active deployments per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the active deployments.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of active deployments on this date.',
          },
        },
      },
      readOnly: true,
    },
    totalBranches: { 
      type: 'array',
      title: 'Total Branches',
      description: 'A count of total branches per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the total branches.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of total branches on this date.',
          },
        },
      },
      readOnly: true,
    },
    activeTasks: { 
      type: 'array',
      title: 'Active Tasks',
      description: 'A count of active tasks per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the active tasks.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of active tasks on this date.',
          },
        },
      },
      readOnly: true,
    },
    closedTasks: { 
      type: 'array',
      title: 'Closed Tasks',
      description: 'A count of closed tasks per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the closed tasks.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of closed tasks on this date.',
          },
        },
      },
      readOnly: true,
    },
    openedTasks: {
      type: 'array',
      title: 'Opened Tasks',
      description: 'A count of opened tasks per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the opened tasks.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of opened tasks on this date.',
          },
        },
      },
      readOnly: true,
    },
    totalTeams: {
      type: 'array',
      title: 'Total Teams',
      description: 'A count of total teams per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the total teams.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of total teams on this date.',
          },
        },
      },
      readOnly: true,
    },
    totalEngineers: {
      type: 'array',
      title: 'Total Engineers',
      description: 'A count of total engineers per day.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            format: 'date-time',
            title: 'Date',
            description: 'The date of the total engineers.',
          },
          count: {
            type: 'number',
            title: 'Count',
            description: 'The number of total engineers on this date.',
          },
        },
      },
      readOnly: true,
    },
    owner: {
      type: 'object',
      title: 'Project Owner',
      description: 'The user who owns the project.',
      properties: {
        id: {
          type: 'string',
          title: 'Owner ID',
          description: 'The unique identifier for the project owner.',
        },
        firstName: {
          type: 'string',
          title: 'First Name',
          description: 'The first name of the project owner.',
        },
        lastName: {
          type: 'string',
          title: 'Last Name',
          description: 'The last name of the project owner.',
        },
        avatar: {
          type: 'string',
          title: 'Avatar',
          default: `${process.env.CDN_ROOT}profiles/default/default.png`,
        }
      },
    },
    ownerTeam: {
      type: 'object',
      title: 'Owner Team',
      description: 'The team that owns the project.',
      properties: {
        id: {
          type: 'string',
          title: 'Team ID',
          description: 'The unique identifier for the team that owns the project.',
        },
        name: {
          type: 'string',
          title: 'Team Name',
          description: 'The name of the team that owns the project.',
        },
        avatar: {
          type: 'string',
          title: 'Team Avatar',
          default: `${process.env.CDN_ROOT}profiles/default/default.png`,
          description: 'The avatar image for the team that owns the project.',
        },
      },
    },    
  },  
}

export default schema;
