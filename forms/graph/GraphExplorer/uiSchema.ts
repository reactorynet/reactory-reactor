

const baseUISchema: Reactory.Schema.IFormUISchema = { 
  'ui:form': {
    showSubmit: false,
    showRefresh: false,
    showHelp: true,
    allowSupportRequest: false,
    toolbarPosition: 'top',
    toolbarStyle: {
      display: 'flex',
      justifyContent: 'flex-end'
    },
    showSchemaSelectorInToolbar: true,
    schemaSelector: {
      variant: 'icon-button',
    }
  },
  'ui:title': null,
  'ui:field': 'GridLayout',
  'ui:grid-layout': [ 
    { nodes: { xs: 12, sm: 12, lg: 12, xl: 12 } },
  ]
}

const MaterialTableUIOptions: Reactory.Client.Components.IMaterialTableWidgetOptions = {
  showLabel: false,
  allowAdd: true,
  allowDelete: true,
  search: true,
  addButtonProps: {
    icon: 'add',
    tooltip: 'support:add_new_ticket',
    onClick: 'reactor.GraphExplorerWorkflow@1.0.0/addNew'
  },
  deleteButtonProps: {
    icon: 'trash',
    tooltip: 'support:delete_ticket',
    onClick: 'reactor.GraphExplorerWorkflow@1.0.0/deleteTicket'
  },
  columns: [
    {
      title: 'Type',
      field: 'type',
    
      propsMap: {
        'rowData.type': 'type',
        'rowData': 'node'
      },
      props: {
        style: {
          alignItems: 'center'
        }
      }
    },
    {
      title: 'Name Space',
      field: 'nameSpace',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.nameSpace}'
          }
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
            format: '${rowData.name}'
          }
        },
      },
    },
    {
      title: 'Version',
      field: 'version',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.version}'
          }
        },
      },
    },
  ],
  remoteData: true,
  query: 'mainDBGraphQuery',
  options: {
    selection: true,
    search: true,
    grouping: true,
    pageSize: 10,
    pageSizeOptions: [10, 20, 50],
    sortFields: [{ field: 'createdDate', direction: 'asc' }]
  },
  refreshEvents: [{ name: "core.SupportTicketDeletedEvent" }],
  actions: [
    {
      key: 'delete',
      icon: 'delete',
      title: 'Delete',
      confirmation: {
        key: 'confirm',
        acceptTitle: 'DELETE ${rowData.reference}',
        cancelTitle: 'CANCEL',
        content: '${reactory.i18n.t("forms:confirm.delete.supportticket")} ${rowData.reference}',
        title: 'Delete ${rowData.reference}?',
      },
      event: {
        name: 'deleteTicket',
        via: 'component',
        component: 'reactor.GraphExplorerWorkflow@1.0.0',
        paramsMap: {
          'rowData': 'nodes[0]'
        }
      }
    },
    {
      key: 'deleteSelected',
      icon: 'delete',
      title: 'Delete ${selected.length} tickets',
      isFreeAction: true,
      confirmation: {
        key: 'confirm',
        acceptTitle: 'DELETE ${selected.length} TICKETS',
        cancelTitle: 'CANCEL',
        content: 'forms:confirm.deleteticketsaction.dialog.content',
        title: 'forms:confirm.deleteticketsaction.dialog.title',
      },
      event: {
        name: 'deleteTicket',
        via: 'component',
        component: 'core.SupportTicketWorkflow@1.0.0',
        paramsMap: {
          'selected': 'tickets'
        }
      }
    }
  ],
  componentMap: {
    // DetailsPanel: "core.SupportTicketInfoPanel@1.0.0"
  },
  detailPanelProps: {
    useCase: 'grid'
  },
  detailPanelPropsMap: {
    'props.rowData': 'ticket',    
  },
  resultMap: {
    'paging.page': 'paging.page',
    'paging.total': 'paging.total',
    'paging.pageSize': 'paging.pageSize',
    'nodes': 'data'
  },
  variables: {
    'query.search': 'term',
    'props.nameSpace': 'nameSpace',
    'props.name': 'name',
    'paging.page': 'paging.page',
    'paging.pageSize': 'paging.pageSize',
    'query.page': 'paging.page',
    'query.pageSize': 'paging.pageSize',
  }
}

const GridUISchema: Reactory.Schema.IUISchema = {
  ...baseUISchema,  
  nodes: {
    'ui:widget': 'MaterialTableWidget',
    'ui:options': MaterialTableUIOptions,
  }
};

export default GridUISchema;