const graphql: Reactory.Forms.IFormGraphDefinition = {
  query: {        
    name: 'ReactorProjectByName',
    text: `
      query ReactorProject($name: String!) {
        ReactorProjectByName(name: $name) {
          id
          owner {
           id
           firstName
           lastName
           avatar
          }
          ownerTeam {
           id
           name
           avatar
          }
          projectMetrics {
           date
           incidents
           errors
           deployments
           openPullRequests
           closedPullRequests
           activeDeployments
           totalBranches
           activeTasks
           closedTasks
           openedTasks
           totalTeams
           totalEngineers
          }
        }
      }`,
      variables: { 
        'props.serviceName': 'name',
      },
      resultType: 'object',
      resultMap: { 
        'id': 'id',
        'owner.id': 'owner.id',
        'owner.firstName': 'owner.firstName',
        'owner.lastName': 'owner.lastName',
        'owner.avatar': 'owner.avatar',
        'ownerTeam.id': 'ownerTeam.id',
        'ownerTeam.name': 'ownerTeam.name',
        'ownerTeam.avatar': 'ownerTeam.avatar',
        'projectMetrics[].date': [
         'incidents[].date',
         'errors[].date',
         'deployments[].date',
         'openPullRequests[].date',
         'closedPullRequests[].date',
         'activeDeployments[].date',
         'activeTasks[].date',
         'closedTasks[].date',
         'openedTasks[].date',
         'totalBranches[].date',
         'totalTeams[].date',
         'totalEngineers[].date',
        ],
        'projectMetrics[].incidents': 'incidents[].value',
        'projectMetrics[].errors': 'errors[].value',
        'projectMetrics[].deployments': 'deployments[].value',
        'projectMetrics[].openPullRequests': 'openPullRequests[].value',
        'projectMetrics[].closedPullRequests': 'closedPullRequests[].value',
        'projectMetrics[].activeDeployments': 'activeDeployments[].value',
        'projectMetrics[].totalBranches': 'totalBranches[].value',
        'projectMetrics[].activeTasks': 'activeTasks[].value',
        'projectMetrics[].closedTasks': 'closedTasks[].value',
        'projectMetrics[].openedTasks': 'openedTasks[].value',
        'projectMetrics[].totalTeams': 'totalTeams[].value',
        'projectMetrics[].totalEngineers': 'totalEngineers[].value',
      },
    },
  };

  export default graphql;