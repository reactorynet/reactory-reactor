const schema: Reactory.Schema.AnySchema = {
  type: 'object',
  properties: {
    recentDeployments: {
      type: 'array',
      title: 'Recent Deployments',
      description: 'Recent deployment history for the project',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Deployment ID' },
          version: { type: 'string', title: 'Version' },
          environment: { type: 'string', title: 'Environment' },
          status: { type: 'string', title: 'Status', enum: ['SUCCESS', 'FAILED', 'IN_PROGRESS', 'ROLLED_BACK'] },
          deployedBy: { type: 'string', title: 'Deployed By' },
          deployedAt: { type: 'string', format: 'date-time', title: 'Deployed At' },
          duration: { type: 'number', title: 'Duration (minutes)' },
          commitHash: { type: 'string', title: 'Commit Hash' },
          branch: { type: 'string', title: 'Branch' },
          notes: { type: 'string', title: 'Deployment Notes' }
        }
      },
      readOnly: true,
    },
    deploymentMetrics: {
      type: 'array',
      title: 'Deployment Metrics',
      description: 'Deployment metrics over time',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', format: 'date-time', title: 'Date' },
          successfulDeployments: { type: 'number', title: 'Successful Deployments' },
          failedDeployments: { type: 'number', title: 'Failed Deployments' },
          averageDeploymentTime: { type: 'number', title: 'Average Deployment Time (minutes)' },
          totalDeployments: { type: 'number', title: 'Total Deployments' }
        }
      },
      readOnly: true,
    },
    environments: {
      type: 'array',
      title: 'Environments',
      description: 'Available deployment environments',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Environment ID' },
          name: { type: 'string', title: 'Environment Name' },
          description: { type: 'string', title: 'Environment Description' },
          status: { type: 'string', title: 'Status', enum: ['ACTIVE', 'INACTIVE', 'MAINTENANCE'] },
          currentVersion: { type: 'string', title: 'Current Version' },
          lastDeployment: { type: 'string', format: 'date-time', title: 'Last Deployment' },
          healthStatus: { type: 'string', title: 'Health Status', enum: ['HEALTHY', 'DEGRADED', 'DOWN'] }
        }
      },
      readOnly: true,
    },
    deploymentPipelines: {
      type: 'array',
      title: 'Deployment Pipelines',
      description: 'Available deployment pipelines',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Pipeline ID' },
          name: { type: 'string', title: 'Pipeline Name' },
          description: { type: 'string', title: 'Pipeline Description' },
          stages: {
            type: 'array',
            title: 'Pipeline Stages',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', title: 'Stage Name' },
                status: { type: 'string', title: 'Status', enum: ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED'] },
                duration: { type: 'number', title: 'Duration (minutes)' }
              }
            }
          },
          lastRun: { type: 'string', format: 'date-time', title: 'Last Run' },
          successRate: { type: 'number', title: 'Success Rate (%)' }
        }
      },
      readOnly: true,
    },
    deploymentConfig: {
      type: 'object',
      title: 'Deployment Configuration',
      description: 'Project deployment configuration settings',
      properties: {
        autoDeploy: { type: 'boolean', title: 'Auto Deploy' },
        deploymentStrategy: { type: 'string', title: 'Deployment Strategy', enum: ['BLUE_GREEN', 'ROLLING', 'RECREATE', 'CANARY'] },
        rollbackEnabled: { type: 'boolean', title: 'Rollback Enabled' },
        healthCheckUrl: { type: 'string', title: 'Health Check URL', format: 'uri' },
        deploymentTimeout: { type: 'number', title: 'Deployment Timeout (minutes)' },
        maxReplicas: { type: 'number', title: 'Maximum Replicas' },
        minReplicas: { type: 'number', title: 'Minimum Replicas' }
      },
      readOnly: true,
    },
    deploymentAlerts: {
      type: 'array',
      title: 'Deployment Alerts',
      description: 'Recent deployment alerts and notifications',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Alert ID' },
          type: { type: 'string', title: 'Alert Type', enum: ['DEPLOYMENT_FAILED', 'DEPLOYMENT_SLOW', 'HEALTH_CHECK_FAILED', 'ROLLBACK_TRIGGERED'] },
          severity: { type: 'string', title: 'Severity', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          message: { type: 'string', title: 'Alert Message' },
          createdAt: { type: 'string', format: 'date-time', title: 'Created At' },
          resolvedAt: { type: 'string', format: 'date-time', title: 'Resolved At' },
          status: { type: 'string', title: 'Status', enum: ['ACTIVE', 'RESOLVED', 'ACKNOWLEDGED'] }
        }
      },
      readOnly: true,
    }
  }
};

export default schema; 