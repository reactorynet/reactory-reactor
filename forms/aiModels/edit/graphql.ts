import Reactory from '@reactorynet/reactory-core';

/**
 * GraphQL definition for the AI Model editor form.
 *
 * The toolbar submits through its custom `onSubmit` handler
 * (AiModelWorkflow.saveModel) so create vs. update and the change event are
 * handled explicitly. These definitions remain so the form is self-describing
 * and usable without a custom handler.
 */
const graphql: Reactory.Forms.IFormGraphDefinition = {
  mutation: {
    new: {
      name: 'ReactorCreateAiModel',
      text: `mutation ReactorCreateAiModel($input: ReactorCreateAiModelInput!) {
        ReactorCreateAiModel(input: $input) {
          id
          providerId
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
        'formData.maxOutputTokens': 'input.maxOutputTokens',
        'formData.capabilities': 'input.capabilities',
        'formData.supportsStreaming': 'input.supportsStreaming',
        'formData.supportedTools': 'input.supportedTools',
        'formData.supportedMediaTypes': 'input.supportedMediaTypes',
        'formData.inputCostPerTokenUsdCents': 'input.inputCostPerTokenUsdCents',
        'formData.outputCostPerTokenUsdCents': 'input.outputCostPerTokenUsdCents',
        'formData.costPerToken': 'input.costPerToken',
        'formData.rpm': 'input.rpm',
        'formData.itpm': 'input.itpm',
        'formData.otpm': 'input.otpm',
        'formData.maxParallelRequests': 'input.maxParallelRequests',
        'formData.sampling': 'input.sampling',
        'formData.thinking': 'input.thinking',
        'formData.isEnabled': 'input.isEnabled',
        'formData.sortOrder': 'input.sortOrder',
      },
      resultType: 'object',
      resultMap: {
        id: 'id',
        name: 'name',
      },
    },
    edit: {
      name: 'ReactorUpdateAiModel',
      text: `mutation ReactorUpdateAiModel($id: String!, $input: ReactorUpdateAiModelInput!, $providerId: String) {
        ReactorUpdateAiModel(id: $id, input: $input, providerId: $providerId) {
          id
          providerId
          name
          version
          contextLength
          capabilities
          supportsStreaming
        }
      }`,
      variables: {
        'formData.modelKey': 'id',
        'formData.providerId': 'providerId',
        'formData.name': 'input.name',
        'formData.version': 'input.version',
        'formData.contextLength': 'input.contextLength',
        'formData.maxOutputTokens': 'input.maxOutputTokens',
        'formData.capabilities': 'input.capabilities',
        'formData.supportsStreaming': 'input.supportsStreaming',
        'formData.supportedTools': 'input.supportedTools',
        'formData.supportedMediaTypes': 'input.supportedMediaTypes',
        'formData.inputCostPerTokenUsdCents': 'input.inputCostPerTokenUsdCents',
        'formData.outputCostPerTokenUsdCents': 'input.outputCostPerTokenUsdCents',
        'formData.costPerToken': 'input.costPerToken',
        'formData.rpm': 'input.rpm',
        'formData.itpm': 'input.itpm',
        'formData.otpm': 'input.otpm',
        'formData.maxParallelRequests': 'input.maxParallelRequests',
        'formData.sampling': 'input.sampling',
        'formData.thinking': 'input.thinking',
        'formData.isEnabled': 'input.isEnabled',
        'formData.sortOrder': 'input.sortOrder',
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
