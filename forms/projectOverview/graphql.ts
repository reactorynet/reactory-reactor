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
          projectStatus
          incidentActive
          businessUnit {
            id
            name
            description
          }
          ownerTeam {
            id
            name
            description
            avatar
          }
          projectTypes
          repoUrl
          tasksUrl
          lastSync
          created
          updated
          owner {
            id
            firstName
            lastName
            email
            avatar
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
        }
      }`,
      variables: { 
        'props.serviceId': 'name',
      },
      resultType: 'object',
      resultMap: { 
        'id': 'id',
        'avatar': 'avatar',
        'name': 'basicInfo.name',
        'nameSpace': 'basicInfo.nameSpace',
        'version': 'basicInfo.version',
        'description': 'basicInfo.description',
        'projectStatus': 'basicInfo.projectStatus',
        'incidentActive': 'basicInfo.incidentActive',
        'businessUnit': 'basicInfo.businessUnit',
        'ownerTeam': 'basicInfo.ownerTeam',
        'projectTypes': 'basicInfo.projectTypes',
        'repoUrl': 'secondaryInfo.repoUrl',
        'tasksUrl': 'secondaryInfo.tasksUrl',
        'lastSync': 'secondaryInfo.lastSync',
        'created': 'secondaryInfo.created',
        'updated': 'secondaryInfo.updated',
        'notes': 'secondaryInfo.notes',
        'owner': 'owner',
      },
    },  
  mutation: {
    edit: {
      name: 'ReactorUpdateProject',
      text: `
        mutation ReactorUpdateProject($projectId: String!, $updates: ReactorProjectInput!) {
          ReactorUpdateProject(projectId: $projectId, updates: $updates) {
            ... on ReactorProjectUpdateSuccess {
              id
              project {
                id
                name
                description
                projectStatus
                incidentActive
                businessUnit {
                  id
                  name
                }
                ownerTeam {
                  id
                  name
                }
                owner {
                  id
                  firstName
                  lastName
                  email
                  avatar
                }
                projectTypes
                repoUrl
                tasksUrl
              }
              message
            }
            ... on ReactorProjectUpdateFailure {
              id
              error
            }
          }
        }`,
      variables: { 
        'formData.id': 'projectId',
        'formData.basicInfo.projectStatus': 'updates.projectStatus',        
        'formData.basicInfo.businessUnit.id': 'updates.businessUnit',
        'formData.basicInfo.ownerTeam.id': 'updates.ownerTeam',
        'formData.owner.id': 'updates.owner',
        'formData.basicInfo.description': 'updates.description',      
      },
      resultType: 'object',
      resultMap: { 
        'id': 'id',
      },
      responseHandlers: {
        ReactorProjectUpdateSuccess: {
          notification: {
            title: 'Project updated successfully',          
            type: 'success',
          },
          resultMap: { 
            'project.id': 'basicInfo.id',
            'project.name': 'basicInfo.name',
            'project.description': 'basicInfo.description',
            'project.projectStatus': 'basicInfo.projectStatus',
            'project.incidentActive': 'basicInfo.incidentActive',
            'project.businessUnit': 'basicInfo.businessUnit',
            'project.ownerTeam': 'basicInfo.ownerTeam',
            'project.owner': 'owner',
          }
        },
        ReactorProjectUpdateFailure: {
          notification: {
            title: 'Error updating project ${formData.name}',          
            type: 'error',
          },          
        }
      },      
    }
  }
  };  

export default graphql; 