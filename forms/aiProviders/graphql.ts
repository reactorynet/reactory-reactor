import Reactory from '@reactorynet/reactory-core';

const graphql: Reactory.Forms.IFormGraphDefinition = {
  queries: {
    providers: {
      name: 'ReactorAiProvidersAdmin',
      text: `query ReactorAiProvidersAdmin($filter: ReactorAiProviderFilterInput) {
        ReactorAiProvidersAdmin(filter: $filter) {
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
      }`,
      resultType: 'array',
      resultMap: {
        '': 'providers',
      },
    },
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
