import Reactory from '@reactorynet/reactory-core';

/**
 * Schema for the AI Provider editor.
 *
 * Two *static* schemas (rather than one mode-dependent resolver) because the
 * client caches the server-resolved form definition per form id
 * (ReactoryApi.form() only re-queries while __complete__ is false). A single
 * form id with an options-driven resolver would keep whichever schema was
 * resolved first. Registering distinct form ids - reactor.AiProviderEdit and
 * reactor.AiProviderCreate - keeps create and edit schemas deterministic.
 */
const buildSchema = (isEdit: boolean): Reactory.Schema.AnySchema => ({
  type: 'object',
  title: isEdit ? 'Edit AI Provider' : 'New AI Provider',
  required: isEdit ? ['name'] : ['id', 'name'],
  properties: {
    id: {
      type: 'string',
      title: 'Provider ID',
      readOnly: isEdit,
      description: isEdit
        ? 'The provider id is immutable.'
        : 'Unique key, e.g. openai, anthropic, azure-openai.',
    },
    name: {
      type: 'string',
      title: 'Name',
    },
    description: {
      type: 'string',
      title: 'Description',
    },
    providerType: {
      type: 'string',
      title: 'Provider Type',
      enum: [
        'openai',
        'anthropic',
        'google',
        'azure-openai',
        'ollama',
        'bedrock',
        'cohere',
        'deepseek',
        'custom',
      ],
      default: 'custom',
    },
    endpointUrl: {
      type: 'string',
      title: 'Endpoint URL',
    },
    apiVersion: {
      type: 'string',
      title: 'API Version',
    },
    authComponentFqn: {
      type: 'string',
      title: 'Auth Component FQN',
    },
    defaultModel: {
      type: 'string',
      title: 'Default Model',
    },
    capabilities: {
      type: 'array',
      title: 'Capabilities',
      uniqueItems: true,
      items: {
        type: 'string',
        enum: [
          'text-generation',
          'chat',
          'reasoning',
          'embeddings',
          'vision',
          'image-generation',
          'audio',
          'transcription',
          'function-calling',
          'structured-output',
          'streaming',
          'code-completion',
        ],
      },
    },
    roles: {
      type: 'array',
      title: 'Roles',
      uniqueItems: true,
      default: ['USER'],
      items: {
        type: 'string',
        enum: ['USER', 'ADMIN'],
      },
    },
    credentialRequirements: {
      type: 'array',
      title: 'Credential Requirements',
      uniqueItems: true,
      items: {
        type: 'string',
        enum: ['apiKey', 'endpoint', 'apiVersion', 'organization', 'deploymentName'],
      },
    },
    rateLimits: {
      type: 'object',
      title: 'Rate Limits',
      properties: {
        requestsPerMinute: { type: 'integer', title: 'Requests / minute' },
        tokensPerMinute: { type: 'integer', title: 'Tokens / minute' },
        concurrentRequests: { type: 'integer', title: 'Concurrent requests' },
      },
    },
    isEnabled: {
      type: 'boolean',
      title: 'Enabled',
      default: true,
    },
  },
});

/** Edit schema - provider id is read-only. */
export const AiProviderEditSchema = buildSchema(true);

/** Create schema - provider id is required and editable. */
export const AiProviderCreateSchema = buildSchema(false);

export default AiProviderEditSchema;
