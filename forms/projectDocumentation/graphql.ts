const graphql: Reactory.Forms.IFormGraphDefinition = {
  query: {        
    name: 'ReactorProjectByName',
    text: `
      query ReactorProject($name: String!) {
        ReactorProjectByName(name: $name) {
          id
          name
          nameSpace
          version
          repoPath
          primaryDocumentation {
            id
            title
            path
            url
            format
            content
            createdBy {
              id
              firstName
              lastName
              avatar
            }
            created
            updated
          }
          additionalDocumentation {
            id
            title
            path
            url
            format
            content
            createdBy {
              id
              firstName
              lastName
              avatar
            }
            created
            updated
          }
        }
      }`,
      variables: { 
        'props.serviceId': 'name',
      },
      resultType: 'object',
      resultMap: { 
        'id': 'project.id',
        'name': 'project.name',
        'nameSpace': 'project.nameSpace',
        'version': 'project.version',
        'description': 'project.description',
        'repoUrl': 'project.repoUrl',
        'docsUrl': 'project.docsUrl',
        'primaryDocumentation': 'primaryDocumentation',
        'additionalDocumentation': 'additionalDocumentation',
      },
    },
    mutation: {
      edit: {
        name: 'ReactorUpdateProjectDocumentation',
        text: `
          mutation ReactorUpdateProjectDocumentation($projectId: String!, $additionalDocumentation: [ReactorProjectDocumentationInput!]!) {
            ReactorUpdateProjectDocumentation(projectId: $projectId, additionalDocumentation: $additionalDocumentation) {
              ... on ReactorProjectDocumentationUpdateSuccess {
                project {
                  id
                  name
                  additionalDocumentation {
                    id
                    title
                    path
                    url
                    format
                    content
                    createdBy {
                      id
                      firstName
                      lastName
                      avatar
                    }
                    created
                    updated
                  }
                }
                message
              }
              ... on ReactorProjectDocumentationUpdateFailure {
                error
              }
            }
          }`,
        variables: {
          'project.id': 'projectId',
          'additionalDocumentation': 'additionalDocumentation'
        },
        resultType: 'object',
        resultMap: {
          'project.additionalDocumentation': 'additionalDocumentation'
        },
        onSuccessMethod: 'notification',
        notification: {
          inAppNotification: true,
          title: 'Documentation Updated',
          type: 'success',
          props: {
            timeOut: 3000,
            canDismiss: true,
          }
        }
      }
    }
  };

export default graphql; 