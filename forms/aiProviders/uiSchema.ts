import Reactory from '@reactorynet/reactory-core';

export const ProviderTableUIOptions: Reactory.Client.Components.IMaterialTableWidgetOptions = {
  showLabel: false,
  allowAdd: true,
  allowDelete: true,
  search: false,
  dense: true,
  remoteData: true,
  query: 'providers',
  resultMap: {
    'paging.page': 'paging.page',
    'paging.total': 'paging.total',
    'paging.pageSize': 'paging.pageSize',
    'providers': 'data',
  },
  variables: {
    'query.search': 'filter.searchString',
    'query.isEnabled': 'filter.isEnabled',
    'query.providerType': 'filter.providerType',
    'query.page': 'paging.page',
    'query.pageSize': 'paging.pageSize',
  },
  options: {
    search: true,
    pageSize: 20,
    pageSizeOptions: [10, 20, 50],
  },
  addButtonProps: {
    icon: 'add',
    tooltip: 'Add AI Provider',
    onClick: 'reactor.AiProviderWorkflow@1.0.0/addNew',
  },
  deleteButtonProps: {
    icon: 'delete',
    tooltip: 'Delete selected AI providers',
    onClick: 'reactor.AiProviderWorkflow@1.0.0/delete',
    // The grid passes the full page (rows) plus per-row state; the workflow
    // narrows this to the selected rows.
    onClickPropsMap: {
      rows: 'rows',
      rowsState: 'rowsState',
    },
  },
  columns: [
    {
      title: 'Status',
      field: 'status',
      width: '100px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'caption',
            format: '${rowData?.status?.available ? "🟢 Online" : "🔴 Offline"}',
          },
        },
      },
    },
    {
      title: 'Name',
      field: 'name',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '<strong>${rowData.name}</strong> (${rowData.id})',
          },
        },
      },
    },
    {
      title: 'Type',
      field: 'providerType',
      width: '130px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.providerType || rowData.id}',
          },
        },
      },
    },
    {
      title: 'Endpoint',
      field: 'endpointUrl',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'caption',
            format: '${rowData.endpointUrl || "Default Provider API"}',
          },
        },
      },
    },
    {
      title: 'Default Model',
      field: 'defaultModel',
      width: '150px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.defaultModel || "None"}',
          },
        },
      },
    },
    {
      title: 'Models',
      field: 'models',
      width: '90px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData?.models?.length || 0} models',
          },
        },
      },
    },
    {
      title: 'Active',
      field: 'isEnabled',
      width: '80px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'caption',
            format: '${rowData.isEnabled !== false ? "Active" : "Disabled"}',
          },
        },
      },
    },
  ],
  componentMap: {
    DetailsPanel: 'reactor.AiProviderDetailPanel@1.0.0',
    Toolbar: 'reactor.AiProvidersToolbar@1.0.0',
  },
  detailPanelProps: {
    useCase: 'grid',
  },
  detailPanelPropsMap: {
    'props.rowData': 'provider',
  },
  /**
   * Re-run the query whenever the providers workflow publishes a change, so an
   * add/edit/delete/test performed anywhere (toolbar, detail panel) refreshes
   * the grid without a page reload.
   */
  refreshEvents: [{ name: 'reactor.AiProviderChanged' }],
  conditionalRowStyling: [
    {
      field: 'isEnabled',
      condition: 'false',
      style: { opacity: 0.6 },
    },
  ],
  headerStyle: {
    fontWeight: 600,
    fontSize: '0.875rem',
  },
};

const uiSchema: any = {
  'ui:options': {
    componentType: 'div',
    containerType: 'form',
    showSubmit: false,
    showHelp: false,
  },
  providers: {
    'ui:widget': 'MaterialTableWidget',
    'ui:options': ProviderTableUIOptions,
  },
};

export default uiSchema;
