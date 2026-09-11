const schema: Reactory.Forms.IJsonSchema = {
  type: 'object',
  title: 'AI Providers Management',
  properties: {
    providers: {
      type: 'array',
      title: 'AI Providers',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            title: 'Provider ID',
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
            title: 'Type',
            enum: ['openai', 'anthropic', 'google', 'azure-openai', 'ollama', 'bedrock', 'cohere', 'deepseek', 'custom'],
          },
          endpointUrl: {
            type: 'string',
            title: 'Endpoint URL',
          },
          apiVersion: {
            type: 'string',
            title: 'API Version',
          },
          defaultModel: {
            type: 'string',
            title: 'Default Model',
          },
          authComponentFqn: {
            type: 'string',
            title: 'Auth Component FQN',
          },
          isEnabled: {
            type: 'boolean',
            title: 'Enabled',
            default: true,
          },
        },
      },
    },
  },
};

export default schema;
