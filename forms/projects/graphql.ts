import Reactory from '@reactory/reactory-core';

const graphql: Reactory.Forms.IFormGraphDefinition = {
  queries: {
    openProjects: {
      name: 'ReactorProjects',
      text: `query ReactorProjects($filter: ReactorProjectFilter) {
        ReactorProjects(filter: $filter) {
          paging {
            page
            pageSize
            hasNext
            total
          }
          projects {
            id
            name
            nameSpace
            version
            ownerTeam {
              id
              name
              avatar
            }
            system {
              id
              nameSpace
              name
              version
              description
            }
            owner {
              id
              firstName
              lastName
              email
            }
            businessUnit {
              id
              name
            }
            incidentActive            
          }
        }
      }`,
      resultType: 'object',
      resultMap: {
        'paging': 'paging',
        'projects': 'data',
      },
    },          
  },
};

const metricsGraphql: Reactory.Forms.IFormGraphDefinition = { 
  queries: {
    metrics: {
      name: 'ReactorMetrics',
      text: `query ReactorMetrics($filter: ReactorProjectFilter) {
        ReactorMetrics(filter: $filter) {
          metrics
        }
      }`,
    },
  },
};

export default graphql;
