const schema: Reactory.Schema.AnySchema = {
  type: 'object',
  properties: {
    incidentActive: {
      type: 'boolean',
      title: 'Active Incident',
      description: 'Whether there is currently an active incident for this project'
    },
    incidentCount: {
      type: 'integer',
      title: 'Total Incidents',
      description: 'Total number of incidents for this project',
      minimum: 0
    },
    errors: {
      type: 'array',
      title: 'Project Errors',
      description: 'Recent errors and incidents for this project',
      items: {
        type: 'object',
        properties: {
          message: { type: 'string', title: 'Error Message' },
          stack: { type: 'string', title: 'Stack Trace' },
          provider: { type: 'string', title: 'Provider' },
          link: { type: 'string', title: 'Error Link', format: 'uri' },
          created: { type: 'string', title: 'Created', format: 'date-time' },
          updated: { type: 'string', title: 'Updated', format: 'date-time' }
        }
      }
    },
    alerts: {
      type: 'array',
      title: 'Project Alerts',
      description: 'Active alerts and notifications for this project',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Alert ID' },
          alertType: { type: 'string', title: 'Alert Type' },
          message: { type: 'string', title: 'Alert Message' },
          severity: { type: 'string', title: 'Severity', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          priority: { type: 'string', title: 'Priority', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
          source: { type: 'string', title: 'Source' },
          status: { type: 'string', title: 'Status', enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] },
          createdBy: {
            type: 'object',
            title: 'Created By',
            properties: {
              id: { type: 'string', title: 'User ID' },
              firstName: { type: 'string', title: 'First Name' },
              lastName: { type: 'string', title: 'Last Name' },
              avatar: { type: 'string', title: 'Avatar URL', format: 'uri' }
            }
          },
          created: { type: 'string', title: 'Created', format: 'date-time' },
          updated: { type: 'string', title: 'Updated', format: 'date-time' }
        }
      }
    },
    projectMetrics: {
      type: 'array',
      title: 'Project Metrics',
      description: 'Historical metrics including incident counts',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', title: 'Date', format: 'date-time' },
          incidents: { type: 'integer', title: 'Incidents Count', minimum: 0 },
          errors: { type: 'integer', title: 'Errors Count', minimum: 0 },
          activeDeployments: { type: 'integer', title: 'Active Deployments', minimum: 0 }
        }
      }
    },
    lastIncidentDate: {
      type: 'string',
      title: 'Last Incident Date',
      description: 'Date of the most recent incident',
      format: 'date-time'
    },
    incidentTrend: {
      type: 'string',
      title: 'Incident Trend',
      description: 'Trend of incidents over time',
      enum: ['DECREASING', 'STABLE', 'INCREASING', 'UNKNOWN']
    },
    mttr: {
      type: 'number',
      title: 'Mean Time to Resolution (hours)',
      description: 'Average time to resolve incidents',
      minimum: 0
    },
    mtta: {
      type: 'number',
      title: 'Mean Time to Acknowledge (hours)',
      description: 'Average time to acknowledge incidents',
      minimum: 0
    }
  }
};

export default schema; 