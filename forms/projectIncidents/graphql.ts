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
          incidentActive
          incidentCount
          errors {
            message
            stack
            provider
            link
            created
            updated
          }
          alerts {
            id
            alertType
            message
            severity
            priority
            source
            status
            createdBy {
              id
              firstName
              lastName
              avatar
            }
            created
            updated
          }
          projectMetrics {
            date
            incidents
            errors
            activeDeployments
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
      incidentActive: "incidentActive",
      incidentCount: "incidentCount",
      errors: "errors",
      alerts: "alerts",
      projectMetrics: "projectMetrics",
    },
  },
};

export default graphql;
