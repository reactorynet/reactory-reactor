


const graphql: Reactory.Forms.IFormGraphDefinition = {
  mutation: {
    edit: {
      name: 'ReactorIndexCatalogNodes',
      text: `
      mutation ReactorIndexCatalogNodes($ids: [Int!]) {
        ReactorIndexCatalogNodes(ids: $ids) {
          ... on ReactorNodeCatalogIndexSuccess {
            nodes {
              id
              index
              type
              nameSpace
              name
              version
              children {
                id
                type
                nameSpace
                name
                key
                attributes {
                  id
                  key
                  value
                }
              }
            }
            message
          } 
          ... on ReactorNodeCatalogIndexFailure {
            errors 
          }
        }
      }
      `,
      variables: {
        'formData.id': 'ids[0]',
      },
      resultType: 'object',
      responseHandlers: {
        ReactorNodeCatalogIndexSuccess: {
          onSuccessMethod: "notification",
          notification: {
            title: "Catalog Indexing",
            type: "success",
          }
        },
        ReactorNodeCatalogIndexError: {
          onSuccessMethod: "notification",
          notification: {
            title: "Catalog Indexing Failed",
            type: "error",
          }
        }
      }
    }
  },  
}

export default graphql;