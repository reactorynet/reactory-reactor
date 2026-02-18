import Reactory from '@reactorynet/reactory-core';

export const HistoryItemSchema: Reactory.Schema.ISchema = {
  type: 'object',
  properties: {
    id: {
      type: 'number',
      title: 'ID',
    },
    type: {
      type: 'string',
      title: 'Type',
      enum: [
        'INCIDENT',
        'DEPLOYMENT',
        'TASK',
        'NOTE',
        'DOCUMENTATION',
        'SECURITY',
        'TEAM',
        'METRICS',
        'INFO',
        'WARNING',
        'ERROR',
        'CRITICAL',
        'SUCCESS',
        'ROLLBACK',
        'ROLLBACK_SUCCESS'
      ],
    },
    title: {
      type: 'string',
      title: 'Title',
    },
    description: {
      type: 'string',
      title: 'Description',
    },
    status: {
      type: 'string',
      title: 'Status',
      enum: ['ERROR', 'WARNING', 'INFO', 'SUCCESS', 'NORMAL'],
    },
    url: {
      type: 'string',
      title: 'URL',
      format: 'uri',
    },
    data: {
      type: 'object',
      title: 'Data',
    },
    createdBy: {
      type: 'object',
      title: 'Created By',
      properties: {
        id: { type: 'string', title: 'User ID' },
        firstName: { type: 'string', title: 'First Name' },
        lastName: { type: 'string', title: 'Last Name' },
        email: { type: 'string', title: 'Email' },
        avatar: { type: 'string', title: 'Avatar URL', format: 'uri' }
      }
    },
    created: {
      type: 'string',
      format: 'date-time',
      title: 'Created',
    },
    updated: {
      type: 'string',
      format: 'date-time',
      title: 'Updated',
    },
  },
};

export const ProjectHistoryTableSchema: Reactory.Schema.ISchema = {
  type: 'object',
  properties: {
    filters: {
      type: 'object',
      title: 'Filters',
      properties: {
        type: {
          type: 'string',
          title: 'Type',
          description: 'Filter by history item type',
          enum: [
            'INCIDENT',
            'DEPLOYMENT',
            'TASK',
            'NOTE',
            'DOCUMENTATION',
            'SECURITY',
            'TEAM',
            'METRICS',
            'INFO',
            'WARNING',
            'ERROR',
            'CRITICAL',
            'SUCCESS',
            'ROLLBACK',
            'ROLLBACK_SUCCESS'
          ],
        },
        status: {
          type: 'string',
          title: 'Status',
          description: 'Filter by status',
          enum: ['ERROR', 'WARNING', 'INFO', 'SUCCESS', 'NORMAL'],
        },
        createdBy: {
          type: 'string',
          title: 'Created By',
          description: 'Filter by user who created the item',
        },
        dateRange: {
          type: 'object',
          title: 'Date Range',
          description: 'Filter by date range',
          properties: {
            startDate: {
              type: 'string',
              format: 'date',
              title: 'Start Date',
            },
            endDate: {
              type: 'string',
              format: 'date',
              title: 'End Date',
            },
          },
        },
        search: {
          type: 'string',
          title: 'Search',
          description: 'Search in title and description',
        },
      },
    },
    history: {
      type: 'array',
      title: 'History',
      description: 'Project history items',
      items: HistoryItemSchema,
    },
    paging: {
      type: 'object',
      title: 'Paging',
      properties: {
        page: { type: 'number', title: 'Page' },
        pageSize: { type: 'number', title: 'Page Size' },
        total: { type: 'number', title: 'Total' },
        hasNext: { type: 'boolean', title: 'Has Next' },
      },
    },
  },
};

const ReactorProjectHistorySchemaResolver: Reactory.Schema.TServerSchemaResolver = async (
  form: Reactory.Forms.IReactoryForm,
  args: any,
  context: Reactory.Server.IReactoryContext,
  info: any
): Promise<Reactory.Schema.AnySchema> => {
  const { i18n, user } = context;
  return ProjectHistoryTableSchema;
};

export default ReactorProjectHistorySchemaResolver;
