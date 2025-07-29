const uiSchema: Reactory.Schema.IFormUISchema = {
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
        border: "none",
        padding: 0,
        marginTop: 0,
        marginBottom: 0,
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
      },
    },
  },
  "ui:grid-layout": [
    {
      owner: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      ownerTeam: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      businessUnit: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      organization: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      teams: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      engineers: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
  ],
  owner: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: '${formData?.firstName || "No "} ${formData?.lastName || "Owner"}',
      description: '${formData?.email || "Email Missing"}',
      avatar: '${formData?.avatar || "No Avatar"}',
      headerOptions: {
        sx: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          marginTop: "16px",
          marginBottom: "16px",
        },
      },
      imageOptions: {
        sx: {
          width: 120,
          height: 120,
          borderRadius: "50%",
          border: "2px solid #1976d2",
          boxShadow: "0 0 10px 0 rgba(25, 118, 210, 0.3)",
        },
      },
      actions: [
        {
          icon: "person",
          onClick: "window.open('/reactor/user/${item?.toLowerCase() || \"owner missing\"}', '_blank')",
        },
      ],
    },
  },
  ownerTeam: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: '${formData?.name || "No Team Assigned"}',
      description: '${formData?.description || "No description available"}',
      avatar: '${formData?.avatar || "No Avatar"}',
      headerOptions: {
        sx: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          marginTop: "16px",
          marginBottom: "16px",
        },
      },
      imageOptions: {
        sx: {
          width: 120,
          height: 120,
          borderRadius: "50%",
          border: "2px solid #4caf50",
          boxShadow: "0 0 10px 0 rgba(76, 175, 80, 0.3)",
        },
      },
      actions: [
        {
          icon: "group",
          onClick: "window.open('/reactor/team/${item?.toLowerCase() || \"team missing\"}', '_blank')",
        },
      ],
    },
  },
  businessUnit: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: '${formData?.name || "No Business Unit"}',
      description: '${formData?.description || "No description available"}',
      avatar: "🏢",
      headerOptions: {
        sx: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          marginTop: "16px",
          marginBottom: "16px",
        },
      },
      imageOptions: {
        sx: {
          width: 80,
          height: 80,
          borderRadius: "50%",
          border: "2px solid #ff9800",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "2rem",
          backgroundColor: "#fff3e0",
        },
      },
      actions: [
        {
          icon: "business",
          onClick: "window.open('/reactor/businessUnit/${item?.toLowerCase() || \"business unit missing\"}', '_blank')",
        },
      ],
    },
  },
  organization: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: '${formData?.name || "No Organization"}',
      description: '${formData?.description || "No description available"}',
      avatar: "🏛️",
      headerOptions: {
        sx: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          marginTop: "16px",
          marginBottom: "16px",
        },
      },
      imageOptions: {
        sx: {
          width: 80,
          height: 80,
          borderRadius: "50%",
          border: "2px solid #9c27b0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "2rem",
          backgroundColor: "#f3e5f5",
        },
      },
      actions: [
        {
          icon: "account_balance",
          onClick: "window.open('/reactor/organization/${item?.toLowerCase() || \"organization missing\"}', '_blank')",
        },
      ],
    },
  },
  teams: {
    "ui:widget": "ArrayFieldWidget",
    "ui:options": {
      title: "Project Teams",
      description: "All teams associated with this project",
      sx: {
        marginTop: "16px",
        marginBottom: "16px",
      },
      itemWidget: "CardWidget",
      itemOptions: {
        title: '${formData?.name || "Unnamed Team"}',
        description: '${formData?.description || "No description"}',
        avatar: '${formData?.avatar || "👥"}',
        headerOptions: {
          sx: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            marginTop: "8px",
            marginBottom: "8px",
          },
        },
        imageOptions: {
          sx: {
            width: 60,
            height: 60,
            borderRadius: "50%",
            border: "2px solid #4caf50",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.5rem",
          },
        },
        actions: [
          {
            icon: "group",
            onClick: "window.open('/reactor/team/${item?.toLowerCase() || \"team missing\"}', '_blank')",
          },
        ],
      },
    },
  },
  engineers: {
    "ui:widget": "ArrayFieldWidget",
    "ui:options": {
      title: "Project Engineers",
      description: "Engineers working on this project",
      sx: {
        marginTop: "16px",
        marginBottom: "16px",
      },
      itemWidget: "CardWidget",
      itemOptions: {
        title: '${formData?.firstName || ""} ${formData?.lastName || "Unknown Engineer"}',
        description: '${formData?.email || "Email Missing"}',
        avatar: '${formData?.avatar || "👨‍💻"}',
        headerOptions: {
          sx: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            marginTop: "8px",
            marginBottom: "8px",
          },
        },
        imageOptions: {
          sx: {
            width: 60,
            height: 60,
            borderRadius: "50%",
            border: "2px solid #2196f3",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.5rem",
          },
        },
        actions: [
          {
            icon: "person",
            onClick: "window.open('/reactor/user/${item?.toLowerCase() || \"engineer missing\"}', '_blank')",
          },
        ],
      },
    },
  },
};

export default uiSchema; 