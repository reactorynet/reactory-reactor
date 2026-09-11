const schema: Reactory.Forms.IJsonSchema = {
  type: 'object',
  title: 'AI Models Management',
  properties: {
    models: {
      type: 'array',
      title: 'AI Models',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            title: 'Model Key',
          },
          providerId: {
            type: 'string',
            title: 'Provider ID',
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
            title: 'Context Window (Tokens)',
          },
          supportsStreaming: {
            type: 'boolean',
            title: 'Streaming',
            default: true,
          },
          rpm: {
            type: 'integer',
            title: 'RPM',
          },
          itpm: {
            type: 'integer',
            title: 'ITPM',
          },
          otpm: {
            type: 'integer',
            title: 'OTPM',
          },
          inputCostPerTokenUsdCents: {
            type: 'number',
            title: 'Input Cost (USD Cents)',
          },
          outputCostPerTokenUsdCents: {
            type: 'number',
            title: 'Output Cost (USD Cents)',
          },
        },
      },
    },
  },
};

export default schema;
