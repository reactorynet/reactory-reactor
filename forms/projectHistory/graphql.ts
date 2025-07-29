import Reactory from '@reactory/reactory-core';

const graphql: Reactory.Forms.IFormGraphDefinition = {
  queries: {
    projectHistory: {
      name: 'ReactorProjectByName',
      text: `query ReactorProject($name: String!, $paging: PagingRequest, $filter: ReactorProjectHistoryFilter) {
        ReactorProjectByName(name: $name) {
          id
          name
          nameSpace
          version
          history(paging: $paging, filter: $filter) {
            paging {
              page
              pageSize
              hasNext
              total
            }
            history {
              id
              type
              title
              description
              url
              status
              data
              createdBy {
                id
                firstName
                lastName
                email
                avatar
              }
              created
              updated
            }
          }
        }
      }`,
      resultType: 'object',
      resultMap: {
        'id': 'id',
        'name': 'name',
        'nameSpace': 'nameSpace',
        'version': 'version',
        'history.paging': 'paging',
        'history.history': 'data',
      },
      variables: {
        'props.serviceId': 'name',
        'paging.page': 'filter.paging.page',
        'paging.pageSize': 'filter.paging.pageSize',
        'filter.search': 'filter.search',
        'filter.type': 'filter.type',
        'filter.status': 'filter.status',
        'filter.createdBy': 'filter.createdBy',
        'filter.startDate': 'filter.startDate',
        'filter.endDate': 'filter.endDate',
      },
    },
  },
};

export default graphql;
