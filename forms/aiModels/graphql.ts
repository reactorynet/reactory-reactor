import Reactory from '@reactorynet/reactory-core';

const modelsQuery: Reactory.Forms.IReactoryFormQuery = {
  name: 'ReactorAiModelsAdmin',
  text: `query ReactorAiModelsAdmin($providerId: String, $searchString: String, $paging: PagingRequest) {
    ReactorAiModelsAdmin(providerId: $providerId, searchString: $searchString, paging: $paging) {
      paging {
        page
        pageSize
        hasNext
        total
      }
      models {
        id
        providerId
        name
        version
        capabilities
        contextLength
        costPerToken
        inputCostPerToken
        outputCostPerToken
        inputCostPerTokenUsdCents
        outputCostPerTokenUsdCents
        rpm
        itpm
        otpm
        maxParallelRequests
        supportsStreaming
        supportedTools
        supportedMediaTypes
      }
    }
  }`,
  variables: {
    'query.search': 'searchString',
    'query.page': 'paging.page',
    'query.pageSize': 'paging.pageSize',
  },
  resultType: 'object',
  resultMap: {
    'paging': 'paging',
    'models': 'data',
  },
};

const graphql: Reactory.Forms.IFormGraphDefinition = {
  query: modelsQuery,
  queries: {
    models: modelsQuery,
  },
  mutation: {
    new: {
      name: 'ReactorCreateAiModel',
      text: `mutation ReactorCreateAiModel($input: ReactorCreateAiModelInput!) {
        ReactorCreateAiModel(input: $input) {
          id
          name
          version
          contextLength
          capabilities
          supportsStreaming
        }
      }`,
      variables: {
        'formData.providerId': 'input.providerId',
        'formData.modelKey': 'input.modelKey',
        'formData.name': 'input.name',
        'formData.version': 'input.version',
        'formData.contextLength': 'input.contextLength',
        'formData.capabilities': 'input.capabilities',
        'formData.supportsStreaming': 'input.supportsStreaming',
        'formData.inputCostPerTokenUsdCents': 'input.inputCostPerTokenUsdCents',
        'formData.outputCostPerTokenUsdCents': 'input.outputCostPerTokenUsdCents',
        'formData.rpm': 'input.rpm',
        'formData.itpm': 'input.itpm',
        'formData.otpm': 'input.otpm',
      },
      resultType: 'object',
      resultMap: {
        id: 'id',
      },
    },
    edit: {
      name: 'ReactorUpdateAiModel',
      text: `mutation ReactorUpdateAiModel($id: String!, $input: ReactorUpdateAiModelInput!, $providerId: String) {
        ReactorUpdateAiModel(id: $id, input: $input, providerId: $providerId) {
          id
          name
          version
          contextLength
          capabilities
          supportsStreaming
        }
      }`,
      variables: {
        'formData.id': 'id',
        'formData.providerId': 'providerId',
        'formData.name': 'input.name',
        'formData.version': 'input.version',
        'formData.contextLength': 'input.contextLength',
        'formData.capabilities': 'input.capabilities',
        'formData.supportsStreaming': 'input.supportsStreaming',
        'formData.inputCostPerTokenUsdCents': 'input.inputCostPerTokenUsdCents',
        'formData.outputCostPerTokenUsdCents': 'input.outputCostPerTokenUsdCents',
        'formData.rpm': 'input.rpm',
        'formData.itpm': 'input.itpm',
        'formData.otpm': 'input.otpm',
      },
      resultType: 'object',
      resultMap: {
        id: 'id',
      },
    },
  },
};

export default graphql;
