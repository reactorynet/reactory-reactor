import Reactory from '@reactorynet/reactory-core';

export const ModelTableUIOptions: Reactory.Client.Components.IMaterialTableWidgetOptions = {
  showLabel: false,
  allowAdd: true,
  allowDelete: true,
  search: false,
  dense: true,
  remoteData: true,
  query: 'models',
  resultMap: {
    'paging.page': 'paging.page',
    'paging.total': 'paging.total',
    'paging.pageSize': 'paging.pageSize',
    'models': 'data',
  },
  variables: {
    'query.search': 'searchString',
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
    tooltip: 'Add AI Model',
    onClick: 'reactor.AiModelWorkflow@1.0.0/addNew',
  },
  deleteButtonProps: {
    icon: 'delete',
    tooltip: 'Delete selected AI models',
    onClick: 'reactor.AiModelWorkflow@1.0.0/delete',
    // The grid passes the full page (rows) plus per-row state; the workflow
    // narrows this to the selected rows.
    onClickPropsMap: {
      rows: 'rows',
      rowsState: 'rowsState',
    },
  },
  columns: [
    {
      title: 'Model',
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
      title: 'Provider',
      field: 'providerId',
      width: '120px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.providerId}',
          },
        },
      },
    },
    {
      title: 'Version',
      field: 'version',
      width: '100px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'caption',
            format: '${rowData.version || "-"}',
          },
        },
      },
    },
    {
      title: 'Context Window',
      field: 'contextLength',
      width: '130px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.contextLength ? (rowData.contextLength / 1024).toFixed(0) + "K tokens" : "Dynamic"}',
          },
        },
      },
    },
    {
      title: 'Streaming',
      field: 'supportsStreaming',
      width: '100px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'caption',
            format: '${rowData.supportsStreaming ? "Yes" : "No"}',
          },
        },
      },
    },
    {
      title: 'Input Cost / 1K',
      field: 'inputCostPerTokenUsdCents',
      width: '130px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'caption',
            format: '${rowData.inputCostPerTokenUsdCents ? "$" + (rowData.inputCostPerTokenUsdCents * 10).toFixed(4) : "-"}',
          },
        },
      },
    },
    {
      title: 'Output Cost / 1K',
      field: 'outputCostPerTokenUsdCents',
      width: '130px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'caption',
            format: '${rowData.outputCostPerTokenUsdCents ? "$" + (rowData.outputCostPerTokenUsdCents * 10).toFixed(4) : "-"}',
          },
        },
      },
    },
    {
      title: 'RPM',
      field: 'rpm',
      width: '90px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'caption',
            format: '${rowData.rpm || "-"}',
          },
        },
      },
    },
    {
      title: 'Enabled',
      field: 'isEnabled',
      width: '90px',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'caption',
            format: '${rowData.isEnabled !== false ? "Enabled" : "Disabled"}',
          },
        },
      },
    },
  ],
  componentMap: {
    DetailsPanel: 'reactor.AiModelDetailPanel@1.0.0',
    Toolbar: 'reactor.AiModelsToolbar@1.0.0',
  },
  detailPanelProps: {
    useCase: 'grid',
  },
  detailPanelPropsMap: {
    'props.rowData': 'model',
  },
  /**
   * Re-run the query whenever the models workflow publishes a change, so an
   * add/edit/delete performed anywhere (toolbar, detail panel) refreshes the
   * grid without a page reload.
   */
  refreshEvents: [{ name: 'reactor.AiModelChanged' }],
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
  models: {
    'ui:widget': 'MaterialTableWidget',
    'ui:options': ModelTableUIOptions,
  },
};

export default uiSchema;
