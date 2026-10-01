import Reactory from '@reactorynet/reactory-core';

/**
 * Schema for the AI Model editor.
 *
 * Two static schemas (create vs edit) rather than one options-driven resolver,
 * because the client caches the resolved form definition per form id - see
 * ../../aiProviders/edit/schema.ts for the full rationale.
 *
 * `providerId` and `modelKey` are immutable once a model exists: they form the
 * model's identity and the (providerId, modelKey) uniqueness key.
 */
const buildSchema = (isEdit: boolean): Reactory.Schema.AnySchema => ({
  type: 'object',
  title: isEdit ? 'Edit AI Model' : 'New AI Model',
  required: isEdit ? ['name'] : ['providerId', 'modelKey', 'name'],
  properties: {
    providerId: {
      type: 'string',
      title: 'Provider ID',
      readOnly: isEdit,
      description: `Owning provider id, e.g. openai, anthropic.${isEdit ? ' Immutable.' : ''}`,
    },
    modelKey: {
      type: 'string',
      title: 'Model Key',
      readOnly: isEdit,
      description: `API model identifier, e.g. gpt-4o.${isEdit ? ' Immutable.' : ''}`,
    },
    name: {
      type: 'string',
      title: 'Model Name',
    },
    version: {
      type: 'string',
      title: 'Version',
    },
    contextLength: {
      type: 'integer',
      title: 'Context Window (tokens)',
    },
    maxOutputTokens: {
      type: 'integer',
      title: 'Max Output Tokens',
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
          'vision',
          'function-calling',
          'structured-output',
          'streaming',
          'embeddings',
          'image-generation',
          'audio',
          'transcription',
          'code-completion',
        ],
      },
    },
    supportsStreaming: {
      type: 'boolean',
      title: 'Supports Streaming',
      default: true,
    },
    supportedTools: {
      type: 'array',
      title: 'Supported Tools',
      uniqueItems: true,
      items: {
        type: 'string',
        enum: ['function-calling', 'code-interpreter', 'web-search', 'file-search', 'computer-use'],
      },
    },
    supportedMediaTypes: {
      type: 'array',
      title: 'Supported Media Types',
      uniqueItems: true,
      items: {
        type: 'string',
        enum: ['text', 'image', 'audio', 'video', 'pdf'],
      },
    },
    inputCostPerTokenUsdCents: {
      type: 'number',
      title: 'Input Cost (USD cents / token)',
    },
    outputCostPerTokenUsdCents: {
      type: 'number',
      title: 'Output Cost (USD cents / token)',
    },
    costPerToken: {
      type: 'number',
      title: 'Cost / token (legacy)',
    },
    rpm: {
      type: 'integer',
      title: 'Requests per minute',
    },
    itpm: {
      type: 'integer',
      title: 'Input tokens per minute',
    },
    otpm: {
      type: 'integer',
      title: 'Output tokens per minute',
    },
    maxParallelRequests: {
      type: 'integer',
      title: 'Max parallel requests',
    },
    sampling: {
      type: 'object',
      title: 'Sampling Support',
      properties: {
        temperature: { type: 'boolean', title: 'Temperature' },
        topP: { type: 'boolean', title: 'Top P' },
        topK: { type: 'boolean', title: 'Top K' },
      },
    },
    thinking: {
      type: 'object',
      title: 'Thinking Support',
      properties: {
        mode: {
          type: 'string',
          title: 'Mode',
          enum: ['adaptive', 'budget', 'none'],
        },
        effort: {
          type: 'string',
          title: 'Effort',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        display: {
          type: 'string',
          title: 'Display',
          enum: ['summarized', 'omitted'],
        },
      },
    },
    isEnabled: {
      type: 'boolean',
      title: 'Enabled',
      default: true,
    },
    sortOrder: {
      type: 'integer',
      title: 'Sort Order',
      default: 0,
    },
  },
});

/** Edit schema - provider id and model key are read-only. */
export const AiModelEditSchema = buildSchema(true);

/** Create schema - provider id and model key are required and editable. */
export const AiModelCreateSchema = buildSchema(false);

export default AiModelEditSchema;
