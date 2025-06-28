import Reactory from "@reactory/reactory-core";
import { title } from "schema/reflection";

// List UI options for Reactor Projects
const ProjectListUIOptions: Reactory.Client.Components.IMaterialListWidgetOptions = {
  primaryText: '${item.name}',
  secondaryText: '${item.description}',
  showAvatar: false,
  showTitle: true,
  showLabel: false,
  allowAdd: false,
  secondaryAction: {
    action: 'mount',
    componentFqn: 'reactor.ProjectStatusComponent@1.0.0',
    propsMap: {
      'item.incidentActive': 'incidentActive',
      'item': 'project',
    },
    props: {
      useCase: 'list',
    },
  },
  remoteData: true,
  query: 'openProjects',
  options: {},
  resultMap: {
    'paging.page': 'paging.page',
    'paging.total': 'paging.totalCount',
    'paging.pageSize': 'paging.pageSize',
    'projects': 'data',
  },
  variables: {
    'search': 'filter.searchString',
    'paging.page': 'paging.page',
    'paging.pageSize': 'paging.pageSize',
  },
  title: 'Reactor Projects',
  titleClass: 'title',
  jss: {
    root: {
      display: 'flex',
      flexDirection: 'column',
    },
    title: {
      fontSize: '20px',
      fontWeight: 'bold',
      textAlign: 'center',
    },
    list: {
      minWidth: '70%',
      margin: 'auto',
      maxHeight: '80%',
      minHeight: '80%',
    },
  },
};

const projectsListUISchema: Reactory.Schema.IUISchema = {
  'ui:widget': 'MaterialListWidget',
  'ui:title': null,
  'ui:options': ProjectListUIOptions as Reactory.Schema.IUISchemaOptions,
};

const BaseUISchema: Reactory.Schema.IFormUISchema = {
  'ui:form': {
    componentType: 'div',
    showSubmit: false,
    showRefresh: false,
    toolbarPosition: 'top',
    toolbarStyle: {
      display: 'flex',
      justifyContent: 'flex-end',
    },
    // showSchemaSelectorInToolbar: true,
    // schemaSelector: {
    //   variant: 'icon-button',
    // },
  },
  'ui:title': null,
  'ui:field': 'GridLayout',
  'ui:grid-layout': [
    {
      projects: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
  ],
};

export const ProjectListUiSchema: Reactory.Schema.IUISchema = {
  ...BaseUISchema,
  projects: projectsListUISchema,
};

const ProjectTableUIOptions: Reactory.Client.Components.IMaterialTableWidgetOptions = {
  showLabel: false,
  allowAdd: false,
  allowDelete: false,
  search: true,
  addButtonProps: {
    icon: 'add',
    tooltip: 'reactor:project-grid.add-project-button.tooltip',
    onClick: 'reactor.ProjectWorkflow@1.0.0/addNew',
  },
  deleteButtonProps: {
    icon: 'delete',
    tooltip: 'reactor:project-grid.delete-project-button.tooltip',
    onClick: 'reactor.ProjectWorkflow@1.0.0/deleteProject',
  },
  columns: [    
    {
      title: 'Name',
      field: 'name',
      component: 'LinkFieldWidget',
      props: {
        link: '/reactor/service/${rowData?.name?.toLowerCase() || "project name missing"}',
        uiSchema: {
          'ui:options': {            
            format: '/reactor/service/${rowData?.name?.toLowerCase() || "project name missing"}',
            title: '${rowData.name}',
            icon: 'navigate_next',
          },
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
            format: '${rowData.version}',
          },
        },
      },
    },
    {
      title: 'Owner',
      field: 'owner',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData?.owner?.firstName} ${rowData?.owner?.lastName}',
          },
        },
      },
    },
    {
      title: 'Domain',
      field: 'businessUnit',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.businessUnit}',
          },
        },
      },
    },
    {
      title: 'Incident Active',
      field: 'incidentActive',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.incidentActive ? "Yes" : "No"}',
          },
        },
      },
    },        
  ],
  remoteData: true,
  query: 'openProjects',
  options: {
    selection: true,
    search: true,
    grouping: true,
    sortFields: [{ field: 'name', direction: 'asc' }],
  },
  refreshEvents: [{ name: 'reactor.ProjectDeletedEvent' }],
  actions: [
    {
      key: 'delete',
      icon: 'delete',
      title: 'Delete',
      confirmation: {
        key: 'confirm',
        acceptTitle: 'DELETE ${rowData.name}',
        cancelTitle: 'CANCEL',
        content: 'Are you sure you want to delete project ${rowData.name}?',
        title: 'Delete ${rowData.name}?',
      },
      event: {
        name: 'deleteProject',
        via: 'component',
        component: 'reactor.ProjectWorkflow@1.0.0',
        paramsMap: {
          rowData: 'projects[0]',
        },
      },
    },
    {
      key: 'deleteSelected',
      icon: 'delete',
      title: 'Delete ${selected.length} projects',
      isFreeAction: true,
      confirmation: {
        key: 'confirm',
        acceptTitle: 'DELETE ${selected.length} PROJECTS',
        cancelTitle: 'CANCEL',
        content: 'Are you sure you want to delete the selected projects?',
        title: 'Delete Selected Projects?',
      },
      event: {
        name: 'deleteProject',
        via: 'component',
        component: 'reactor.ProjectWorkflow@1.0.0',
        paramsMap: {
          selected: 'projects',
        },
      },
    },
  ],
  componentMap: {
    DetailsPanel: 'reactor.ProjectInfoPanel@1.0.0',
  },
  detailPanelProps: {
    useCase: 'grid',
  },
  detailPanelPropsMap: {
    'props.rowData': 'project',
  },
  resultMap: {
    'paging.page': 'paging.page',
    'paging.total': 'paging.total',
    'paging.pageSize': 'paging.pageSize',
    'projects': 'data',
  },
  variables: {
    'query.search': 'filter.search',
    'query.page': 'filter.paging.page',
    'query.pageSize': 'filter.paging.pageSize',
  },
};

export const ProjectGridUISchema: Reactory.Schema.IFormUISchema = {
  ...BaseUISchema,
  projects: {
    'ui:title': null,
    'ui:widget': 'MaterialTableWidget',
    'ui:options': ProjectTableUIOptions,
  },
};

export default ProjectGridUISchema