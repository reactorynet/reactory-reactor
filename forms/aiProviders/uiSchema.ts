import Reactory from '@reactorynet/reactory-core';

export const ProviderTableUIOptions: Reactory.Client.Components.IMaterialTableWidgetOptions = {
  showLabel: false,
  allowAdd: true,
  allowDelete: true,
  search: true,
  dense: true,
  addButtonProps: {
    icon: 'add',
    tooltip: 'Add AI Provider',
    onClick: 'reactor.AiProviderWorkflow@1.0.0/addNew',
  },
  deleteButtonProps: {
    icon: 'delete',
    tooltip: 'Delete AI Provider',
    onClick: 'reactor.AiProviderWorkflow@1.0.0/delete',
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
