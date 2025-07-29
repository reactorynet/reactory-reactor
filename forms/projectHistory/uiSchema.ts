import Reactory from "@reactory/reactory-core";

const UserSelectQuery: Reactory.Forms.IReactoryFormQuery = {
  name: 'allUsers',
  text: `query ReactoryUsers { 
    allUsers {
      id
      firstName
      lastName
      email
    }
  }`,
  resultMap: {
    '[].id': ['[].key', '[].id', '[].value'],
    '[].firstName': '[].firstName',
    '[].lastName': '[].lastName',
    '[].email': '[].email',
  },
  props: {
    paging: {
      page: 1,
      pageSize: 100,
    }
  },
};

const HistoryTableUIOptions: Reactory.Client.Components.IMaterialTableWidgetOptions = {
  showLabel: false,
  allowAdd: false,
  allowDelete: false,
  search: true,
  dense: true,
  columns: [
    {
      title: 'Type',
      field: 'type',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.type}',
            icon: '${rowData.type === "INCIDENT" ? "warning" : rowData.type === "DEPLOYMENT" ? "cloud_upload" : rowData.type === "TASK" ? "assignment" : rowData.type === "NOTE" ? "note" : rowData.type === "DOCUMENTATION" ? "description" : rowData.type === "SECURITY" ? "security" : rowData.type === "TEAM" ? "people" : rowData.type === "METRICS" ? "bar_chart" : rowData.type === "INFO" ? "info" : rowData.type === "WARNING" ? "warning" : rowData.type === "ERROR" ? "error" : rowData.type === "CRITICAL" ? "error" : rowData.type === "SUCCESS" ? "check_circle" : rowData.type === "ROLLBACK" ? "undo" : "history"}',
            color: '${rowData.type === "INCIDENT" ? "error" : rowData.type === "DEPLOYMENT" ? "primary" : rowData.type === "TASK" ? "info" : rowData.type === "NOTE" ? "default" : rowData.type === "DOCUMENTATION" ? "primary" : rowData.type === "SECURITY" ? "warning" : rowData.type === "TEAM" ? "info" : rowData.type === "METRICS" ? "primary" : rowData.type === "INFO" ? "info" : rowData.type === "WARNING" ? "warning" : rowData.type === "ERROR" ? "error" : rowData.type === "CRITICAL" ? "error" : rowData.type === "SUCCESS" ? "success" : rowData.type === "ROLLBACK" ? "warning" : "default"}',
          },
        },
      },
    },
    {
      title: 'Title',
      field: 'title',
      component: 'LinkFieldWidget',
      props: {
        uiSchema: {
          'ui:options': {
            format: '${rowData.url || "#"}',
            title: '${rowData.title || "No Title"}',
            icon: 'navigate_next',
            showLabel: false,
            sx: {
              textTransform: 'none',
              textAlign: 'left',
            }
          },
        },
      },
    },
    {
      title: 'Description',
      field: 'description',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.description || "No description"}',
            maxLength: 100,
            truncate: true,
          },
        },
      },
    },
    {
      title: 'Status',
      field: 'status',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.status}',
            color: '${rowData.status === "ERROR" ? "error" : rowData.status === "WARNING" ? "warning" : rowData.status === "INFO" ? "info" : rowData.status === "SUCCESS" ? "success" : "default"}',
          },
        },
      },
    },
    {
      title: 'Created By',
      field: 'createdBy',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.createdBy?.firstName || ""} ${rowData.createdBy?.lastName || ""}',
            avatar: '${rowData.createdBy?.avatar}',
          },
        },
      },
    },
    {
      title: 'Created',
      field: 'created',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${reactory.utils.humanDate.relativeTime(rowData.created)}',
          },
        },
      },
    },
  ],
  remoteData: true,
  query: 'projectHistory',
  options: {
    showTitle: false,
    showToolbar: true,
    selection: false,
    search: true,
    grouping: true,
    sortFields: [{ field: 'created', direction: 'desc' }],
  },
  resultMap: {
    'paging.page': 'paging.page',
    'paging.total': 'paging.total',
    'paging.pageSize': 'paging.pageSize',
    'history': 'data',
  },
  variables: {
    'query.search': 'filter.search',
    'query.page': 'filter.paging.page',
    'query.pageSize': 'filter.paging.pageSize',
    'formContext.formData.filters.type': 'filter.type',
    'formContext.formData.filters.status': 'filter.status',
    'formContext.formData.filters.createdBy': 'filter.createdBy',
    'formContext.formData.filters.dateRange.startDate': 'filter.startDate',
    'formContext.formData.filters.dateRange.endDate': 'filter.endDate',
  },
};

const BaseUISchema: Reactory.Schema.IFormUISchema = {
  'ui:form': {
    componentType: 'div',
    showSubmit: false,
    showRefresh: false,
    toolbarPosition: 'top',
    toolbarStyle: {
      display: 'flex',
      justifyContent: 'space-between',
    },
  },
  'ui:title': 'Project History',
  'ui:field': 'GridLayout',
  'ui:grid-layout': [
    {
      filters: { xs: 12, sm: 12, md: 3, lg: 3, xl: 3 },
      history: { xs: 12, sm: 12, md: 9, lg: 9, xl: 9 },
    },
  ],
  filters: {
    "ui:field": "GridLayout",
    "ui:grid-options": {
      container: 'Paper',
      containerProps: {
        elevation: 0,
        square: true,
        variant: 'outlined',
        sx: {
          padding: 0,
          marginTop: 0,
          marginBottom: 0,
          minHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
        },
      },
    },
    "ui:grid-layout": [
      {
        type: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        status: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        createdBy: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        dateRange: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },        
      },
    ],
    type: {
      "ui:widget": "SelectWidget",
      "ui:options": {
        placeholder: 'Filter by type',
        selectOptions: [
          { value: 'INCIDENT', label: 'Incident' },
          { value: 'DEPLOYMENT', label: 'Deployment' },
          { value: 'TASK', label: 'Task' },
          { value: 'NOTE', label: 'Note' },
          { value: 'DOCUMENTATION', label: 'Documentation' },
          { value: 'SECURITY', label: 'Security' },
          { value: 'TEAM', label: 'Team' },
          { value: 'METRICS', label: 'Metrics' },
          { value: 'INFO', label: 'Info' },
          { value: 'WARNING', label: 'Warning' },
          { value: 'ERROR', label: 'Error' },
          { value: 'CRITICAL', label: 'Critical' },
          { value: 'SUCCESS', label: 'Success' },
          { value: 'ROLLBACK', label: 'Rollback' },
          { value: 'ROLLBACK_SUCCESS', label: 'Rollback Success' },
        ],
        remoteData: false,
      },
    },
    status: {
      "ui:widget": "SelectWidget",
      "ui:options": {
        placeholder: 'Filter by status',
        selectOptions: [
          { value: 'ERROR', label: 'Error' },
          { value: 'WARNING', label: 'Warning' },
          { value: 'INFO', label: 'Info' },
          { value: 'SUCCESS', label: 'Success' },
          { value: 'NORMAL', label: 'Normal' },
        ],
        remoteData: false,
      },
    },
    createdBy: {
      "ui:widget": "SelectWithDataWidget",
      "ui:graphql": UserSelectQuery,
      "ui:options": {
        placeholder: 'Filter by user',
        remoteData: true,
        query: 'ReactoryUsers',
        labelFormat: '${option.firstName} ${option.lastName} (${option.email})',
        valueKey: 'id',
        labelKey: 'name',
      },
    },
    dateRange: {
      "ui:field": "GridLayout",
      "ui:grid-layout": [
        {
          startDate: { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 },
          endDate: { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 },
        },
      ],
      startDate: {
        "ui:widget": "DateWidget",
        "ui:options": {
          placeholder: 'Start Date',
          showLabel: false,
        },
      },
      endDate: {
        "ui:widget": "DateWidget",
        "ui:options": {
          placeholder: 'End Date',
          showLabel: false,
        },
      },
    }    
  },
};

export const ProjectHistoryUISchema: Reactory.Schema.IFormUISchema = {
  ...BaseUISchema,
  history: {
    'ui:title': null,
    'ui:widget': 'MaterialTableWidget',
    'ui:options': HistoryTableUIOptions,
  },
};

export default ProjectHistoryUISchema;
