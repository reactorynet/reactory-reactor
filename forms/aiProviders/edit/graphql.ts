import Reactory from '@reactorynet/reactory-core';

/**
 * GraphQL definition for the AI Provider editor form.
 *
 * The toolbar submits through its custom `onSubmit` handler (which runs
 * `AiProviderWorkflow.saveProvider`) so that create vs. update and the change
 * event are handled explicitly. These definitions remain on the form so the
 * form is self-describing and usable without a custom handler (the ReactoryForm
 * data manager falls back to `mutation.new` / `mutation.edit`).
 */
const graphql: Reactory.Forms.IFormGraphDefinition = {
  mutation: {
    new: {
      name: 'ReactorCreateAiProvider',
      text: `mutation ReactorCreateAiProvider($input: ReactorCreateAiProviderInput!) {
        ReactorCreateAiProvider(input: $input) {
          id
          name
          description
          providerType
          endpointUrl
          apiVersion
          defaultModel
          authComponentFqn
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
        'formData.capabilities': 'input.capabilities',
        'formData.roles': 'input.roles',
        'formData.credentialRequirements': 'input.credentialRequirements',
        'formData.rateLimits': 'input.rateLimits',
        'formData.isEnabled': 'input.isEnabled',
      },
      resultType: 'object',
      resultMap: {
        id: 'id',
        name: 'name',
      },
    },
    edit: {
      name: 'ReactorUpdateAiProvider',
      text: `mutation ReactorUpdateAiProvider($id: String!, $input: ReactorUpdateAiProviderInput!) {
        ReactorUpdateAiProvider(id: $id, input: $input) {
          id
          name
          description
          providerType
          endpointUrl
          apiVersion
          defaultModel
          authComponentFqn
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
        'formData.capabilities': 'input.capabilities',
        'formData.roles': 'input.roles',
        'formData.credentialRequirements': 'input.credentialRequirements',
        'formData.rateLimits': 'input.rateLimits',
        'formData.isEnabled': 'input.isEnabled',
      },
      resultType: 'object',
      resultMap: {
        id: 'id',
        name: 'name',
      },
    },
  },
};

export default graphql;
