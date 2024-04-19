

const mainDBGraphQuery: Reactory.Forms.IReactoryFormQuery = { 
  name: 'ReactorNodesByNameAndNameSpace',
  text: `
    query GraphNode ($nameSpace: String!, $name: String!, $term: String, $paging: PagingRequest ) {
      ReactorNodesByNameAndNameSpace(term: $term, name: $name, nameSpace: $nameSpace, paging: $paging) {
        paging {
          total
          page
          hasNext
          pageSize
        }
        nodes {
          id
          index
          type
          name
          nameSpace
          version
          children {
            id
            index
            name
          }
        }    
      }
    }
  `,
  resultType: 'object',
  props: {
    nameSpace: 'zepz',
    name: 'maindb',
  },
  variables: {
    'props.nameSpace': 'nameSpace',
    'props.name': 'name',
    'formContext.formData.search': 'term',
    'paging.page': 'paging.page',
    'paging.pageSize': 'paging.pageSize',
  },
  throttle: 1000,
  debounce: 1000,
  onError: {
    componentRef: 'reactor.GraphExplorerWorkflow@1.0.0',
    method: 'handleError' 
  },
  resultMap: {
    'paging.page': 'paging.page',
    'paging.total': 'paging.totalCount',
    'paging.pageSize': 'paging.pageSize',
    'nodes': 'data',
    'paging': 'paging',
  },
}

const catalogsQuery: Reactory.Forms.IReactoryFormQuery = { 
  name: 'ReactorCatalogNodes',
  text: `
  query ReactorCatalogNodes {
    ReactorCatalogNodes {
      nodes {
        id
        index
        type
        nameSpace
        name
        version
        providerId
        attributes {
          id
          key
          value
        }
      }
    }
  }
  `,
  resultType: 'object',
  resultMap: {
    'nodes[].id': '[].id',
    'nodes[].index': '[].index',
    'nodes[].type': '[].type',
    'nodes[].nameSpace': '[].nameSpace',
    'nodes[].name': '[].name',
    'nodes[].version': '[].version',
    'nodes[].children': '[].children',
    'nodes[].providerId': '[].providerId',
    'nodes[].attributes': '[].attributes',
  }
}

const ReactorNodeChildrenQuery: Reactory.Forms.IReactoryFormQuery = { 
  name: 'ReactorNode',
  text: `
  query ReactorNode($id: Int!) {
    ReactorNode(id: $id) {    
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
  }
  `,
  variables: {
    'node.id': 'id',
  },
  resultType: 'object',
  resultMap: {
    'id': 'id',
    'index': 'index',
    'type': 'type',
    'nameSpace': 'nameSpace',
    'name': 'name',
    'version': 'version',
    'children': 'children',    
  }

}


const categoriesQuery: Reactory.Forms.IReactoryFormQuery = {
  name: 'ReactorNodeCategories',
  text: `
    query ReactorNodeCategories {
      ReactorNodeCategories {
        id
        name
        description
        children {
          id
          name
          description
        }
      }
    }
  `,
  resultType: 'array',
  resultKey: 'ReactorNodeCategories',
  resultMap: {
    'id': 'id',
    'name': 'name',
    'description': 'description',
    'children': 'children',
  }
};

const graphql: Reactory.Forms.IFormGraphDefinition = {
  mutation: {},
  query: mainDBGraphQuery,
  queries: {
    mainDBGraphQuery,
    categoriesQuery,
    catalogsQuery,
    nodeChildrenQuery: ReactorNodeChildrenQuery,
  }
}

export default graphql;