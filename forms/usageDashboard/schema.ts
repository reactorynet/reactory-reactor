import Reactory from '@reactorynet/reactory-core';

const schema: Reactory.Schema.ISchema = {
  type: 'object',
  properties: {
    userId: {
      type: 'string',
      title: 'User',
    },
    dashboard: {
      type: 'object',
      title: '',
      properties: {},
    },
  },
};

export default schema;
