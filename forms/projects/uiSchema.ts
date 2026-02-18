import Reactory from '@reactorynet/reactory-core';
import metricsGraphql from './graphql';

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
      pageSize: 1000,
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
      headerImage: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
      welcome: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
      metrics: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
      filters: { size: { xs: 12, sm: 12, md: 3, lg: 3, xl: 3 } },
      projects: { size: { xs: 12, sm: 12, md: 9, lg: 9, xl: 9 } },
    },
  ],
  headerImage: {
    "ui:widget": "ImageWidget",
    "ui:options": {
      showLabel: false,
      variant: "img",
      src: `${process.env.CDN_ROOT}images/default/project-header.png`,
      alt: "Project Header Image",
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
        system: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
        domain: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
        ownerTeam: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
        owner: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
        incidentsActive: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
        status: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
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

export const ProjectTableUIOptions: Reactory.Client.Components.IMaterialTableWidgetOptions =
  {
    showLabel: false,
    allowAdd: false,
    allowDelete: false,
    search: true,
    dense: true,
    addButtonProps: {
      icon: "add",
      tooltip: "reactor:project-grid.add-project-button.tooltip",
      onClick: "reactor.ProjectWorkflow@1.0.0/addNew",
    },
    deleteButtonProps: {
      icon: "delete",
      tooltip: "reactor:project-grid.delete-project-button.tooltip",
      onClick: "reactor.ProjectWorkflow@1.0.0/deleteProject",
    },
    columns: [
      {
        title: "Name",
        field: "name",
        component: "LinkFieldWidget",
        props: {
          uiSchema: {
            "ui:options": {
              format:
                "/reactor/service/${rowData?.name?.toLowerCase()}?tab=overview",
              title: "${rowData.name}",
              icon: "navigate_next",
              sx: {
                textTransform: "none",
                textAlign: "left",
              },
            },
          },
        },
      },
      {
        title: "Version",
        field: "version",
        component: "core.LabelComponent@1.0.0",
        props: {
          uiSchema: {
            "ui:options": {
              variant: "body2",
              format: "${rowData.version}",
            },
          },
        },
      },
      {
        title: "System",
        field: "System",
        component: "LinkFieldWidget",
        props: {
          uiSchema: {
            "ui:options": {
              format:
                "/reactor/system/${rowData?.system?.name?.toLowerCase()}?tab=overview",
              title:
                '${rowData?.system?.name || "System Not Set"}',
              icon: "navigate_next",
              sx: {
                textTransform: "none",
                textAlign: "left",
              },
            },
          },
        },
      },
      {
        title: "Status",
        field: "status",
        component: "core.LabelComponent@1.0.0",
        props: {
          uiSchema: {
            "ui:options": {
              variant: "body2",
              format: '${rowData.status || "Unknown"}',
            },
          },
        },
      },
      {
        title: "Team",
        field: "ownerTeam",
        component: "LinkFieldWidget",
        props: {
          uiSchema: {
            "ui:options": {
              format:
                "/reactor/service/${rowData?.name?.toLowerCase()}?tab=team&action=setOwnerTeam",
              title:
                '${rowData?.ownerTeam?.name || "Team Not Set"}',
              icon: "navigate_next",
              sx: {
                textTransform: "none",
                textAlign: "left",
              },
            },
          },
        },
      },
      {
        title: "Incident Active",
        field: "incidentActive",
        component: "core.LabelComponent@1.0.0",
        props: {
          uiSchema: {
            "ui:options": {
              variant: "body2",
              format: '${rowData.incidentActive ? "Yes" : "No"}',
            },
          },
        },
      },
    ],
    remoteData: true,
    query: "openProjects",
    options: {
      showTitle: false,
      showToolbar: true,
      selection: false,
      search: true,
      grouping: true,
      sortFields: [{ field: "name", direction: "asc" }],
    },
    refreshEvents: [{ name: "reactor.ProjectDeletedEvent" }],
    actions: [
      {
        key: "delete",
        icon: "delete",
        title: "Delete",
        confirmation: {
          key: "confirm",
          acceptTitle: "DELETE ${rowData.name}",
          cancelTitle: "CANCEL",
          content: "Are you sure you want to delete project ${rowData.name}?",
          title: "Delete ${rowData.name}?",
        },
        event: {
          name: "deleteProject",
          via: "component",
          component: "reactor.ProjectWorkflow@1.0.0",
          paramsMap: {
            rowData: "projects[0]",
          },
        },
      },
      {
        key: "deleteSelected",
        icon: "delete",
        title: "Delete ${selected.length} projects",
        isFreeAction: true,
        confirmation: {
          key: "confirm",
          acceptTitle: "DELETE ${selected.length} PROJECTS",
          cancelTitle: "CANCEL",
          content: "Are you sure you want to delete the selected projects?",
          title: "Delete Selected Projects?",
        },
        event: {
          name: "deleteProject",
          via: "component",
          component: "reactor.ProjectWorkflow@1.0.0",
          paramsMap: {
            selected: "projects",
          },
        },
      },
    ],
    componentMap: {
      DetailsPanel: "reactor.ProjectInfoPanel@1.0.0",
    },
    detailPanelProps: {
      useCase: "grid",
    },
    detailPanelPropsMap: {
      "props.rowData.name": "serviceName",
    },
    resultMap: {
      "paging.page": "paging.page",
      "paging.total": "paging.total",
      "paging.pageSize": "paging.pageSize",
      projects: "data",
    },
    variables: {
      "query.search": "filter.search",
      "query.page": "filter.paging.page",
      "query.pageSize": "filter.paging.pageSize",
      "formContext.formData.projects.filters.system": "filter.system",
      "formContext.props.domainId": "filter.businessUnit",
      "formContext.formData.projects.filters.ownerTeam": "filter.ownerTeam",
      "formContext.formData.projects.filters.status": "filter.status",
      "formContext.formData.projects.filters.owner": "filter.owner"
    },
  };

const PennyAIConfig: Reactory.Schema.UIAIOptions = { 
  title: "Talk to Penny about Payments",
  personaId: "PaymentsPennyAIPersona",
  promptKey: "domainInfo",
  display: "slide-in",
  slideInProps: {
    direction: "right",
    duration: 1000,
    easing: "ease-in-out",
    container: "Paper",
  },
  props: {
    domainName: "payments",
  },
  propsMap: {
    "formContext.props.domainName": "domainName",
    "formContext.formData": "data",
  },
}

const uiSchema = {
  "ui:field": "GridLayout",
  "ui:form": {
    toolbarStyle: {
      display: "none",
      height: 0,
    },
    showSubmit: false,
    showRefresh: false,
    componentType: "div",
    style: {
      display: "flex",
      flexDirection: "column",
    },
  },
  "ui:grid-options": {
    container: "Paper",
    containerProps: {
      elevation: 0,
      square: true,
      variant: "outlined",
      sx: {
        padding: 2,
        paddingTop: 0,
        marginTop: 0,
        marginBottom: 2,
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
      },
    },
  },
  "ui:grid-layout": [
    {
      headerImage: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
      welcome: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
      metrics: { size: { xs: 12, sm: 12, md: 6, lg: 8, xl: 10 } },
      domainInfo: { size: { xs: 12, sm: 12, md: 6, lg: 4, xl: 2 } },
      projects: { size: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 } },
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
  avatar: {
    "ui:widget": "HiddenWidget",
  },
  metrics: {
    "ui:field": "GridLayout",
    "ui:graphql": metricsGraphql,
    "ui:options": {
      container: "div",
      constainerStyles: {
        display: "flex",
        flexDirection: "column",
        minHeight: "100%",
        margin: 2,
      },
      // containerProps: {
      //   elevation: 0,
      //   square: true,
      //   variant: 'outlined',
      //   sx: {
      //     padding: 2,
      //     marginTop: 2,
      //     marginBottom: 2,
      //     minHeight: '100%',
      //     display: 'flex',
      //     flexDirection: 'column',
      //   },
      // }
    },
    "ui:grid-layout": [
      {
        openPullRequests: {
          size: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
          sx: {
            minHeight: "120px",
          },
        },
        closedPullRequests: {
          size: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
          sx: {
            minHeight: "120px",
          },
        },
        activeProjects: {
          size: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
          sx: {
            minHeight: "120px",
          },
        },
        archivedProjects: {
          size: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
          sx: {
            minHeight: "120px",
          },
        },
        incidentFreeDays: {
          size: { xs: 12, sm: 6, md: 4, lg: 4, xl: 4 },
          sx: {
            minHeight: "120px",
          },
        },
      },
    ],
    openPullRequests: {
      "ui:widget": "LabelWidget",
      "ui:title": "Open Pull Requests",
      "ui:options": {
        showLabel: true,
        showUnit: false,
        containerProps: {
          styles: {
            // backgroundColor: '#fff',
            borderRadius: 2,
            boxShadow:
              "0px 1px 3px rgba(0,0,0,0.2), 0px 1px 1px rgba(0,0,0,0.14), 0px 2px 1px rgba(0,0,0,0.12)",
            padding: 16,
            margin: 8,
            border: "1px solid #e0e0e0",
          },
        },
      },
    },
    closedPullRequests: {
      "ui:widget": "LabelWidget",
      "ui:title": "Closed Pull Requests",
      "ui:options": {
        showLabel: true,
        showUnit: false,
      },
    },
    activeProjects: {
      "ui:widget": "LabelWidget",
      "ui:title": "Active Projects",
      "ui:options": {
        showLabel: true,
        showUnit: false,
      },
    },
    archivedProjects: {
      "ui:widget": "LabelWidget",
      "ui:title": "Archived Projects",
      "ui:options": {
        showLabel: true,
        showUnit: false,
      },
    },
    incidentFreeDays: {
      "ui:widget": "LabelWidget",
      "ui:title": "Incident Free Days",
      "ui:options": {
        showLabel: true,
        showUnit: false,
      },
    },
  },
  welcome: {
    "ui:widget": "StaticContentWidget",
    "ui:options": {
      showLabel: false,
      defaultContent:
        "Welcome to the Reactory Domain Projects Home Page. Here you can find all the projects you are involved in, their status, and other relevant information.",
      variant: "h4",
      color: "primary",
      gutterBottom: true,
      slug: "${formContext?.props?.domainName || 'all'}-domain-review-summary",
      slugSourceProps: {
        basePath: "profiles/zepz-engineer/domains/reviews",
      },
      useExpanded: true,
      expanded: false,      
    },
  },
  domainInfo: {
    "ui:ai": PennyAIConfig,
    "ui:widget": "StaticContentWidget",
    "ui:options": {
      showLabel: false,
      defaultContent:
        "Enter all your important information about the domain here.",
      variant: "h4",
      color: "primary",
      gutterBottom: true,
      slug: "domain-info-${formContext?.props?.domainName || 'all'}",
      slugSourceProps: {
        basePath: "profiles/zepz-engineer/domains/${formContext?.props?.domainName || 'all'}/",
      },
      useExpanded: true,
      expanded: false,
      container: "Paper",
      containerProps: {
        elevation: 1,
        square: false,
        variant: 'outlined',
        sx: {
          padding: 0,
          margin: 0,
        },
      },
    },
  },
  projects: {
    ...BaseUISchema,
    projects: {
      "ui:title": null as any,
      "ui:widget": "MaterialTableWidget",
      "ui:options": ProjectTableUIOptions,
    },
  },
};

export default uiSchema;
