export default {
  type: 'object',
  title: 'Node: ${formData.name} #${formData.id}',
  properties: { 
    id: { type: 'string', title: 'ID' },
    index: { type: 'number', title: 'Index' },
    name: { type: 'string', title: 'Name' },
    nameSpace: { type: 'string', title: 'Name Space' },
    version: { type: 'string', title: 'Version' },
    description: { type: 'string', title: 'Description' },
    type: { type: 'string', title: 'Type' },
    metrics: {
      title: 'Metrics',
      type: 'array',
      items: {
        properties: {
          id: { type: 'string', title: 'ID' },
          type: { type: 'string', title: 'Type' },
          value: { type: 'string', title: 'Value' },
        }
      }
    }

  }
};