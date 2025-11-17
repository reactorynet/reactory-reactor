import Reactory from "@reactory/reactory-core";
import { title } from "schema/reflection";

// List UI options for Reactor Projects
// const ProjectListUIOptions: Reactory.Client.Components.IMaterialListWidgetOptions = {
//   primaryText: '${item.name}',
//   secondaryText: '${item.description}',
//   showAvatar: false,
//   showTitle: true,
//   showLabel: false,
//   allowAdd: false,
//   secondaryAction: {
//     action: 'mount',
//     componentFqn: 'reactor.ProjectStatusComponent@1.0.0',
//     propsMap: {
//       'item.incidentActive': 'incidentActive',
//       'item': 'project',
//     },
//     props: {
//       useCase: 'list',
//     },
//   },
//   remoteData: true,
//   query: 'openProjects',
//   options: {},
//   resultMap: {
//     'paging.page': 'paging.page',
//     'paging.total': 'paging.totalCount',
//     'paging.pageSize': 'paging.pageSize',
//     'projects': 'data',
//   },
//   variables: {
//     'search': 'filter.searchString',
//     'paging.page': 'paging.page',
//     'paging.pageSize': 'paging.pageSize',
//   },
//   title: 'Reactor Projects',
//   titleClass: 'title',
//   jss: {
//     root: {
//       display: 'flex',
//       flexDirection: 'column',
//     },
//     title: {
//       fontSize: '20px',
//       fontWeight: 'bold',
//       textAlign: 'center',
//     },
//     list: {
//       minWidth: '70%',
//       margin: 'auto',
//       maxHeight: '80%',
//       minHeight: '80%',
//     },
//   },
// };

// const projectsListUISchema: Reactory.Schema.IUISchema = {
//   'ui:widget': 'MaterialListWidget',
//   'ui:title': null,
//   'ui:options': ProjectListUIOptions as Reactory.Schema.IUISchemaOptions,
// };

const SystemSelectQuery: Reactory.Forms.IReactoryFormQuery = { 
  name: "ReactorSystems",
  text: `query ReactorSystems($paging: PagingRequest, $filter: ReactorSystemFilter) { 
    ReactorSystems(paging: $paging, filter: $filter) { 
      systems {
        id
        nameSpace
        name
        version
        description
      },
    	paging {
        page
        pageSize
        total
        hasNext
      }
    }
  }`,
  props: {
    paging: {
      page: 1,
      pageSize: 100,
    },
    filter: {
      searchString: '',
    },
  },
  variables: {
    'paging.page': 'paging.page',
    'paging.pageSize': 'paging.pageSize',
    'filter.searchString': 'filter.searchString',
  },
  resultMap: {
    'systems[].id': ['[].key', '[].id'],
    'systems[].nameSpace': '[].nameSpace',
    'systems[].name': ['[].label', '[].name'],
    'systems[].version': '[].version',
  },
};

const DomainSelectQuery: Reactory.Forms.IReactoryFormQuery = {
  name: "ReactoryBusinessUnits",
  text: `query ReactoryBusinessUnits($paging: PagingRequest, $filter: ReactoryBusinessUnitFilter) { 
    ReactoryBusinessUnits(query: { paging: $paging, filter: $filter }) {
      ...on ReactoryPagedBusinessUnits {
        businessUnits {
          id
          name
          description
        }
        paging {
          page
          pageSize
          total
          hasNext
        }
      }
      ...on ReactoryBusinessUnitsQueryFailed {
        code
        message
      }
    }
  }`,
  responseHandlers: {
    ReactoryPagedBusinessUnits: {
      resultMap: {
        'businessUnits[].id': ['[].key', '[].id', '[].value'],
        'businessUnits[].name': ['[].label', '[].name'],
        'businessUnits[].description': '[].description',
      },
    },
    ReactoryBusinessUnitsQueryFailed: { 
      notification: {
        type: 'error',        
        title: `reactor:project-grid.domain-select-query.error.title`,
        props: {
          message: `reactor:project-grid.domain-select-query.error.message`,
        },
      }
    },
  },
  resultMap: {
    'businessUnits[].id': ['[].key', '[].id', '[].value'],
    'businessUnits[].name': ['[].label', '[].name'],
    'businessUnits[].description': '[].description',
  },
  props: {
    paging: {
      page: 1,
      pageSize: 100,
    },
    filter: {},
  },
  variables: {
    'paging.page': 'paging.page',
    'paging.pageSize': 'paging.pageSize',
    'filter.searchString': 'filter.searchString',
  },
};

const TeamSelectQuery: Reactory.Forms.IReactoryFormQuery = {
  name: 'ReactoryTeams',
  text: `query ReactoryTeams($paging: PagingRequest, $filter: ReactoryTeamFilter) { 
    ReactoryTeams(paging: $paging, filter: $filter) {
      ...on ReactoryTeamPagedResults {
        teams {
          id
          name
          description
        }
        paging {
          page
          pageSize
          total
          hasNext
        }
      }
      ...on ReactoryTeamsQueryFailed {
        code
        message
      }
    }
  }`,
  responseHandlers: {
    ReactoryTeamPagedResults: {
      resultMap: {
        'teams[].id': ['[].key', '[].id', '[].value'],
        'teams[].name': ['[].label', '[].name'],
        'teams[].description': '[].description',
      },
    },
    ReactoryTeamsQueryFailed: {
      notification: {
        type: 'error',
        title: `reactor:project-grid.team-select-query.error.title`,
        props: {
          message: `reactor:project-grid.team-select-query.error.message`,
        },
      }
    },
  },
  resultMap: {
    'teams[].id': ['[].key', '[].id', '[].value'],
    'teams[].name': '[].name',
    'teams[].description': '[].description',
  },
  props: {
    paging: {
      page: 1,
      pageSize: 100,
    },
    filter: {},
  },
  variables: {
    'paging.page': 'paging.page',
    'paging.pageSize': 'paging.pageSize',
    'filter.searchString': 'filter.searchString',
  },
};

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

const CreateNewProjectButton: Reactory.Schema.UIFieldToolbarButton = {
  id: 'CreateNewProject', 
  buttonProps: {
    title: 'reactor:project-grid.create-new-project-button.title',
  },
  title: 'reactor:project-grid.create-new-project-button.title',
  command: 'nav://reactor/services/new?tab=overview',
  icon: 'add',
  iconOptions: {
    position: 'left',
    style: { marginRight: '8px' },
  },        
  tooltip: 'reactor:project-grid.create-new-project-button.tooltip',
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
    buttons: [
      CreateNewProjectButton
    ],
    showSchemaSelectorInToolbar: true,
    schemaSelector: {
      variant: 'icon-button',
    },
  },
  'ui:title': null,
  'ui:field': 'GridLayout',
  'ui:grid-layout': [
    {
      headerImage: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      welcome: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      metrics: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      filters: { xs: 12, sm: 12, md: 3, lg: 3, xl: 3 },
      projects: { xs: 12, sm: 12, md: 9, lg: 9, xl: 9 },
    },
  ],
  headerImage: {
    "ui:widget": "ImageWidget",
    "ui:options": {
      showLabel: false,
      variant: "img",
      src: `${process.env.CDN_ROOT}images/default/project-header.png`,
      alt: "Project Header Image",
      style: {
        width: "102%",
        height: "120px",
        maxWidth: "102%",
        left: "-1%",
        maxHeight: "180px",
        objectFit: "cover",
        objectPosition: "center",
        overflow: "hidden",
        // fade from left to right
        background:
          "linear-gradient(to right, rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5)),",
      },
    },
  },
  welcome: {
    "ui:widget": "StaticContentWidget",
    "ui:options": {
      showLabel: false,
      defaultContent: "Welcome to the Reactory Projects Portal!",
    },
  },
  filters: {
    "ui:field": "GridLayout",
    "ui:grid-layout": [
      {        
        system: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        domain: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        ownerTeam: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        owner: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        incidentsActive: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        status: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        sx: {
          padding: 2,
          marginTop: 2,
          marginBottom: 2,
          minHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
        }
      },      
    ],
    system: {
        "ui:widget": "SelectWithDataWidget",      
        "ui:graphql": SystemSelectQuery,        
        "ui:options": {
          placeholder: 'Select a system',
          remoteData: true,          
          query: 'ReactorSystems',                    
          labelFormat: '${option.nameSpace}.${option.name}@${option.version}',
          valueKey: 'id',          
        },
    },
    domain: {
      "ui:widget": "SelectWithDataWidget",
      "ui:graphql": DomainSelectQuery,
      "ui:options": {
        placeholder: 'Select a domain',
        remoteData: true,
        query: 'ReactorDomains',
        labelFormat: '${option.name}',
        valueKey: 'id',
        labelKey: 'name',
      }
    },
    ownerTeam: {
      "ui:widget": "SelectWithDataWidget",
      "ui:graphql": TeamSelectQuery,
      "ui:options": {
        placeholder: 'Select a team',
        remoteData: true,
        query: 'ReactoryTeams',
        labelFormat: '${option.name}',
        valueKey: 'id',
        labelKey: 'name',
      }
    },
    owner: {
      "ui:widget": "SelectWithDataWidget",
      "ui:graphql": UserSelectQuery,
      "ui:options": {
        placeholder: 'Select a user',
        remoteData: true,
        query: 'ReactoryUsers',
        labelFormat: '${option.firstName} ${option.lastName} (${option.email})',
        valueKey: 'id',
        labelKey: 'name',
      }
    },
    status: {
      "ui:widget": "SelectWidget",
      "ui:options": {
        placeholder: 'Select a status',
        selectOptions: [
          { value: 'active', label: 'Active' },
          { value: 'archived', label: 'Archived' },
          { value: 'completed', label: 'Completed' },
          { value: 'on_hold', label: 'On Hold' },
          { value: 'cancelled', label: 'Cancelled' },
        ],
        remoteData: false,
      }
    }
  },
};

// export const ProjectListUiSchema: Reactory.Schema.IUISchema = {
//   ...BaseUISchema,  
//   projects: projectsListUISchema,
// };

export const ProjectTableUIOptions: Reactory.Client.Components.IMaterialTableWidgetOptions = {
  showLabel: false,
  allowAdd: false,
  allowDelete: false,
  search: true,
  dense: true,  
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
        uiSchema: {
          'ui:options': {            
            format: '/reactor/service/${rowData?.name?.toLowerCase()}?tab=overview',
            title: '${rowData.name}',
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
      title: 'System',
      field: 'System',      
      component: 'LinkFieldWidget',
      props: {        
        uiSchema: {
          'ui:options': {            
            format: '/reactor/service/${rowData?.name?.toLowerCase()}?tab=system&action=setSystem',
            title: '${rowData?.system?.name || "Assign System"}',
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
      title: 'Status',
      field: 'status',
      component: 'core.LabelComponent@1.0.0',
      props: {
        uiSchema: {
          'ui:options': {
            variant: 'body2',
            format: '${rowData.status || "Unknown"}',
          },
        },
      },
    },
    {
      title: 'Team',
      field: 'ownerTeam',
      component: 'LinkFieldWidget',
      props: {        
        uiSchema: {
          'ui:options': {            
            format: '/reactor/service/${rowData?.name?.toLowerCase()}?tab=team&action=setOwner',
            title: '${cellData?.name || "Not Set"}',
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
      title: 'Domain',
      field: 'businessUnit',
      component: 'LinkFieldWidget',
      props: {        
        uiSchema: {
          'ui:options': {
            format: '/domains/${rowData?.businessUnit?.name}?tab=projects',
            title: '${rowData?.businessUnit?.name || "Not Set"}',
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
    showTitle: false,
    showToolbar: true,
    selection: false,
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
    'props.rowData.name': 'serviceName',
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
    'formContext.formData.filters.system': 'filter.system',
    'formContext.formData.filters.domain': 'filter.businessUnit',
    'formContext.formData.filters.ownerTeam': 'filter.ownerTeam',
    'formContext.formData.filters.status': 'filter.status',
    'formContext.formData.filters.owner': 'filter.owner' 
  },
};

export const ProjectGridUISchema: Reactory.Schema.IFormUISchema = {
  ...BaseUISchema,
  "ui:ai": {
    title: "Reactory Service Catalogue",
    personaId: "ReactoryAIPersona",
    promptKey: "reactor-service-catalogue",
    props: {
      formContext: 'formContext',
      formData: 'formData',
    },
    propsMap: {
      'formContext.formData.filters.system': 'filter.system',
    },
  },
  projects: {
    'ui:title': null,
    'ui:widget': 'MaterialTableWidget',
    'ui:options': ProjectTableUIOptions,
  },
};

export default ProjectGridUISchema