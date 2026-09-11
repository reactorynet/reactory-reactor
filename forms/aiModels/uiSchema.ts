import Reactory from '@reactorynet/reactory-core';

export const ModelTableUIOptions: Reactory.Client.Components.IMaterialTableWidgetOptions = {
  showLabel: false,
  allowAdd: true,
  allowDelete: true,
  search: true,
  dense: true,
  addButtonProps: {
    icon: 'add',
    tooltip: 'Add AI Model',
    onClick: 'reactor.AiModelWorkflow@1.0.0/addNew',
  },
  deleteButtonProps: {
    icon: 'delete',
    tooltip: 'Delete AI Model',
    onClick: 'reactor.AiModelWorkflow@1.0.0/delete',
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
  ],
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
