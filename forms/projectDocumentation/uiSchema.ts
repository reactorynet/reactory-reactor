const uiSchema: Reactory.Schema.IFormUISchema = {
  "ui:field": "GridLayout",
  "ui:form": {
   toolbarStyle: {
    display: 'none',
    height: 0,
   },
   showSubmit: false,
   showRefresh: false,
   componentType: "div",
   style: {
    display: "flex",
    flexDirection: "column",    
   }
  },
  "ui:grid-options": {
   container: 'Paper',
   containerProps: {
    elevation: 0,
    square: true,
    variant: 'outlined',
    sx: {
     padding: 2,
     marginTop: 2,
     marginBottom: 2,
     minHeight: '100%',
     display: 'flex',
     flexDirection: 'column',
    },
   },
  },
  "ui:grid-layout": [
    {
      project: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      primaryDocumentation: { xs: 12, sm: 12, md: 8, lg: 9, xl: 10 },
      additionalDocumentation: { xs: 12, sm: 12, md: 4, lg: 3, xl: 2 },
    },
  ],
  project: {
    "ui:widget": "StaticContentWidget", 
    "ui:options": {
      showLabel: false,
      defaultContent:
        "Welcome to the Project Documentation Page. Here you can find all the documentation for the project.",
      variant: "h4",
      color: "primary",
      gutterBottom: true,
      slug: "${formContext?.props?.serviceId}-project-documentation",
      slugSourceProps: {
        basePath: "profiles/zepz-engineer/projects/documentation",
      },
    },
  },
  primaryDocumentation: {
    "ui:options": {
     showLabel: false,
    },
    "ui:field": "GridLayout",
    "ui:grid-layout": [
      {
        content: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },        
      }
    ],
    "ui:grid-options": {
      container: 'Paper',
      containerProps: {
        elevation: 1,              
        sx: {
          padding: 1,
          marginTop: 0,
          marginBottom: 0,
          minHeight: '100%',
          border: 'none'
        },
      },
    },
    content: {
      "ui:widget": "ContentWidget",
      "ui:options": {
       showLabel: false,
       format: "markdown",
      }
    },
  },
  additionalDocumentation: {
    "ui:widget": "MaterialListWidget",
    "ui:title": "Additional Documentation",
    "ui:options": {
      showLabel: true,
      allowAdd: true,
      showEmptyListItem: true,
      emptyListItemText: "No additional documentation available. Click the + button to add new documentation.",
      primaryText: "${item.title}",
      secondaryText: "${item.format} - ${item.created}",
      icon: "description",
      iconPosition: "left",
      showAvatar: true,
      avatarSrcField: "createdBy.avatar",
      avatarAltField: "createdBy.firstName",
      secondaryAction: {
        iconKey: "open_in_new",
        action: "event:documentation.open",
        actionData: {
          url: "${item.url}",
          title: "${item.title}",
          format: "${item.format}"
        },
        link: "/documentation/view/${item.id}",
        props: {
          tooltip: "Open Documentation"
        }
      },
      listProps: {
        dense: true,
        sx: {
          maxHeight: '400px',
          overflow: 'auto',
          padding: 1,
        }
      },
      jss: {
        root: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%'
        },
        list: {
          flex: 1,
          minHeight: '200px'
        }
      }
    },
  },
};

export default uiSchema; 