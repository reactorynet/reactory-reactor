import Reactory from '@reactory/reactory-core';

const graphql: Reactory.Forms.IFormGraphDefinition = {
  query: {        
    name: 'ReactorProjectByName',
    text: `
      query ReactorProject($name: String!) {
        ReactorProjectByName(name: $name) {
          id
          avatar
          name
          nameSpace
          version
          description
          owner {
            id
            firstName
            lastName
            email
            avatar
          }
          businessUnit {
            id
            name
          }
          ownerTeam {
            id
            name
            description
            avatar
          }
          incidentActive
          projectStatus
          repoPath
          repoUrl
          projectTypes
          lastSync
          primaryDocumentation {
            id
            title
            path
            url
            format
            content
          }
          additionalDocumentation {
            id
            title
            path
            url
            format
            content
          }
          deployments {
            id
            environment {
              id
              name
              description
              status
              created
              updated
            }
            created
            updated
            status
          }
          environments {
            id
            name
            description
            status
            created
            updated
          }
          alerts {
            id
            alertType
            status
            created
          }
          notes {
            id
            title
            content
            format
            createdBy {
              id
              firstName
              lastName
              avatar
            }
            created
          }
          primarySlack {            
            channelId
            channel
          }
          secondarySlack {            
            channelId
            channel
          }
          tasksUrl
          tasks {
            id
            reference
            title
            description
            status
            priority
            assignedTo { 
              id
              firstName
              lastName
              email
              avatar
            }
            created
            updated
          }
          created
          updated
        }
      }`,
      variables: { 
        'props.serviceId': 'name',
      },
      resultType: 'object',
      resultMap: { 
        'id': 'overview.id',
        'name': 'overview.basicInfo.name',
        'nameSpace': 'overview.basicInfo.nameSpace',
        'version': 'overview.basicInfo.version',
        'status': 'overview.basicInfo.status',
        'notes': 'overview.secondaryInfo.notes',
        'description': 'overview.basicInfo.description',
        'repoPath': 'overview.repoPath',
        'businessUnit': 'overview.basicInfo.businessUnit',
        'repoUrl': 'overview.secondaryInfo.repoUrl',
        'tasksUrl': 'overview.secondaryInfo.tasksUrl',
        'incidentActive': 'overview.incidentActive',
        'projectTypes': 'overview.basicInfo.projectTypes',
        'projectStatus': 'overview.basicInfo.projectStatus',
        'primarySlack.id': 'overview.secondaryInfo.primarySlack.id',
        'primarySlack.channelId': 'overview.secondaryInfo.primarySlack.channelId',
        'primarySlack.channelName': 'overview.secondaryInfo.primarySlack.channelName',
        'secondarySlack[].id': 'overview.secondarySlack[].id',
        'secondarySlack[].channelId': 'overview.secondarySlack[].channelId',
        'secondarySlack[].channelName': 'overview.secondarySlack[].channelName',
        'lastSync': 'overview.secondaryInfo.lastSync',
        'primaryDocumentation': 'documentation.primaryDocumentation',
        'secondaryDocumentation': 'documentation.secondaryDocumentation',
        'ownerTeam': [{ key: 'overview.basicInfo.ownerTeam' }, {key: 'team.ownerTeam' }],
        'owner': [{ key: 'overview.owner' }, { key: 'team.owner' }],
      },      
    },
  };

export default graphql;
