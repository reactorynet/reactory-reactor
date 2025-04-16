const chatMessageSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Unique identifier for the message',
    },
    text: {
      type: 'string',
      description: 'The content of the message',
    },
    sender: {
      type: 'string',
      enum: ['user', 'bot'],
      description: 'Who sent the message',
    },
    timestamp: {
      type: 'string',
      format: 'date-time',
      description: 'When the message was sent',
    }
  },
  required: ['id', 'text', 'sender', 'timestamp'],
  additionalProperties: false,
};

const aiModelSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Unique identifier for the AI model',
    },
    name: {
      type: 'string',
      description: 'Display name of the AI model',
    },
    description: {
      type: 'string',
      description: 'Optional description of the AI model',
    }
  },
  required: ['id', 'name'],
  additionalProperties: false,
};

const chatSchema : Reactory.Schema.IObjectSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      format: 'uuid',
      description: 'The ID of the chat',
    },
    name: {
      type: 'string',
      description: 'The name of the chat',
    },
    description: {
      type: 'string',
      description: 'The description of the chat',
    },
    members: {
      type: 'array',
      items: {
        type: 'string',
        format: 'uuid',
        description: 'The ID of the user in the chat',
      },
    },
    messages: {
      type: 'array',
      items: {
        $ref: '#/definitions/chatMessage',
      },
      description: 'The messages in the chat',
    },
    selectedModel: {
      $ref: '#/definitions/aiModel',
      description: 'The currently selected AI model',
    },
    availableModels: {
      type: 'array',
      items: {
        $ref: '#/definitions/aiModel',
      },
      description: 'Available AI models that can be selected',
    },
  },
  required: ['id', 'name', 'messages', 'selectedModel', 'availableModels'],  
  definitions: {
    chatMessage: chatMessageSchema,
    aiModel: aiModelSchema,
  }
};

export default chatSchema;
export { chatMessageSchema, aiModelSchema };