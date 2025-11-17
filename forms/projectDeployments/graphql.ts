const graphql: Reactory.Forms.IFormGraphDefinition = {
  query: {
    name: "ReactorProjectByName",
    text: `
      query ReactorProject($name: String!) {
        ReactorProjectByName(name: $name) {
          id
          name
          nameSpace
          version
          recentDeployments {
            id
            version
            environment
            status
            deployedBy
            deployedAt
            duration
            commitHash
            branch
            notes
          }
          deploymentMetrics {
            date
            successfulDeployments
            failedDeployments
            averageDeploymentTime
            totalDeployments
          }
          environments {
            id
            name
            description
            status
            currentVersion
            lastDeployment
            healthStatus
          }
          deploymentPipelines {
            id
            name
            description
            stages {
              name
              status
              duration
            }
            lastRun
            successRate
          }
          deploymentConfig {
            autoDeploy
            deploymentStrategy
            rollbackEnabled
            healthCheckUrl
            deploymentTimeout
            maxReplicas
            minReplicas
          }
          deploymentAlerts {
            id
            type
            severity
            message
            createdAt
            resolvedAt
            status
          }
        }
      }`,
    variables: {
      "props.serviceId": "name",
    },
    resultType: "object",
    resultMap: {
      id: "id",
      name: "name",
      nameSpace: "nameSpace",
      version: "version",
      recentDeployments: "recentDeployments",
      deploymentMetrics: "deploymentMetrics",
      environments: "environments",
      deploymentPipelines: "deploymentPipelines",
      deploymentConfig: "deploymentConfig",
      deploymentAlerts: "deploymentAlerts",
    },
  },
};

export default graphql; 