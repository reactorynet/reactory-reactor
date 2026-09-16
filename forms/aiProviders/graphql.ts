import Reactory from '@reactorynet/reactory-core';

const providersQuery: Reactory.Forms.IReactoryFormQuery = {
  name: 'ReactorAiProvidersAdmin',
  text: `query ReactorAiProvidersAdmin($filter: ReactorAiProviderFilterInput, $paging: PagingRequest) {
    ReactorAiProvidersAdmin(filter: $filter, paging: $paging) {
      paging {
        page
        pageSize
        hasNext
        total
      }
      providers {
        id
        name
        description
        providerType
        endpointUrl
        apiVersion
        defaultModel
        authComponentFqn
        isEnabled
        capabilities
        roles
        status {
          available
          lastChecked
          uptime
          responseTime
          errorRate
          quotaRemaining
        }
        models {
          id
          name
          version
          contextLength
          supportsStreaming
          capabilities
        }
      }
    }
  }`,
  variables: {
    'query.search': 'filter.searchString',
    'query.page': 'paging.page',
    'query.pageSize': 'paging.pageSize',
  },
  resultType: 'object',
  resultMap: {
    'paging': 'paging',
    'providers': 'data',
  },
};

const graphql: Reactory.Forms.IFormGraphDefinition = {
  query: providersQuery,
  queries: {
    providers: providersQuery,
  },
  mutation: {
    new: {
      name: 'ReactorCreateAiProvider',
      text: `mutation ReactorCreateAiProvider($input: ReactorCreateAiProviderInput!) {
        ReactorCreateAiProvider(input: $input) {
          id
          name
          endpointUrl
          apiVersion
          defaultModel
          isEnabled
        }
      }`,
      variables: {
        'formData.id': 'input.id',
        'formData.name': 'input.name',
        'formData.description': 'input.description',
        'formData.providerType': 'input.providerType',
        'formData.endpointUrl': 'input.endpointUrl',
        'formData.apiVersion': 'input.apiVersion',
        'formData.defaultModel': 'input.defaultModelId',
        'formData.authComponentFqn': 'input.authComponentFqn',
        'formData.isEnabled': 'input.isEnabled',
      },
      resultType: 'object',
      resultMap: {
        id: 'id',
      },
    },
    edit: {
      name: 'ReactorUpdateAiProvider',
      text: `mutation ReactorUpdateAiProvider($id: String!, $input: ReactorUpdateAiProviderInput!) {
        ReactorUpdateAiProvider(id: $id, input: $input) {
          id
          name
          endpointUrl
          apiVersion
          defaultModel
          isEnabled
        }
      }`,
      variables: {
        'formData.id': 'id',
        'formData.name': 'input.name',
        'formData.description': 'input.description',
        'formData.providerType': 'input.providerType',
        'formData.endpointUrl': 'input.endpointUrl',
        'formData.apiVersion': 'input.apiVersion',
        'formData.defaultModel': 'input.defaultModelId',
        'formData.authComponentFqn': 'input.authComponentFqn',
        'formData.isEnabled': 'input.isEnabled',
      },
      resultType: 'object',
      resultMap: {
        id: 'id',
      },
    },
  },
};

export default graphql;
