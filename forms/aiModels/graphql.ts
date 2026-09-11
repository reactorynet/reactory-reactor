import Reactory from '@reactorynet/reactory-core';

const graphql: Reactory.Forms.IFormGraphDefinition = {
  queries: {
    models: {
      name: 'ReactorAiProvidersAdmin',
      text: `query ReactorAiProvidersAdmin($filter: ReactorAiProviderFilterInput) {
        ReactorAiProvidersAdmin(filter: $filter) {
          id
          name
          models {
            id
            providerId
            name
            version
            contextLength
            maxParallelRequests
            supportsStreaming
            capabilities
            costPerToken
            inputCostPerTokenUsdCents
            outputCostPerTokenUsdCents
            rpm
            itpm
            otpm
            sampling {
              temperature
              topP
              topK
            }
            thinking {
              mode
              effort
              display
            }
          }
        }
      }`,
      resultType: 'array',
      resultMap: {
        '': 'providers',
      },
    },
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
