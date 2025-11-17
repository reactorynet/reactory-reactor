const uiSchema: Reactory.Schema.IFormUISchema = {
  "ui:ai": {
    title: "Project Overview",
    personaId: "ReactorAIPersona",
    props: {},
    propsMap: {
      "formContext.props.serviceId": "projectId",
      "formContext.formData": "projectData",
    },
    display: "button",
  },
  "ui:field": "GridLayout",
  "ui:form": {
    showSubmit: true,
    showRefresh: true,
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
      basicInfo: { xs: 12, sm: 12, md: 8, lg: 8, xl: 8 },
      owner: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      secondaryInfo: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
  ],
  basicInfo: {
    "ui:field": "GridLayout",
    "ui:grid-layout": [
      {
        name: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
        nameSpace: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
        version: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
        description: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
        projectStatus: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
        incidentActive: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
        businessUnit: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
        ownerTeam: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      },
    ],
    "ui:grid-options": {
      container: "Paper",
      containerProps: {
        elevation: 0,
        square: true,
        variant: "outlined",
        sx: {
          border: "none",
        },
      },
    },
    projectStatus: {
      "ui:widget": "SelectWidget",
      "ui:options": {
        placeholder: "Select a status",
        selectOptions: [
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
          { value: "completed", label: "Completed" },
          { value: "on_hold", label: "On Hold" },
          { value: "cancelled", label: "Cancelled" },
        ],
        remoteData: false,
      },
    },
    businessUnit: {
      "ui:widget": "CardWidget",
      "ui:options": {
        title: '${formData?.name || "No business unit assigned"}',
        description: '${formData?.description || "No description available"}',
        avatar: "${formData?.avatar}",
        headerOptions: {
          sx: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
          },
        },
        actions: [
          {
            icon: "navigate_next",
            onClick:
              "window.open('/reactor/businessUnit/${item?.toLowerCase() || \"business unit missing\"}', '_blank')",
          },
        ],
      },
    },
    ownerTeam: {
      "ui:widget": "CardWidget",
      "ui:options": {
        title: '${formData?.name || "No team assigned"}',
        description: '${formData?.description || "No description available"}',
        avatar: "${formData?.avatar}",
        headerOptions: {
          sx: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
          },
        },
        actions: [
          {
            icon: "navigate_next",
            onClick:
              "window.open('/reactor/ownerTeam/${item?.toLowerCase() || \"owner team missing\"}', '_blank')",
          },
        ],
      },
    },
    incidentActive: {
      "ui:widget": "LabelWidget",
      "ui:options": {
        showLabel: true,
        format:
          "${formData === true ? 'Incident is active!' : 'No Incident Active'}",
      },
    },
  },
  secondaryInfo: {
    "ui:field": "GridLayout",
    "ui:grid-layout": [
      {
        repoUrl: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
        tasksUrl: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
        lastSync: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      },
    ],
    "ui:grid-options": {
      container: "Paper",
      containerProps: {
        elevation: 0,
        square: true,
        variant: "outlined",
        sx: {
          border: "none",
        },
      },
    },
    repoUrl: {
      "ui:widget": "LinkFieldWidget",
      "ui:options": {
        userouter: false,
        format: '${formData || "repo missing"}',
        title: "Repository",
        openInNewWindow: true,
        sx: {
          textTransform: "none",
          textAlign: "left",
          marginTop: "16px",
          marginBottom: "16px",
        },
      },
    },
    tasksUrl: {
      "ui:widget": "LinkFieldWidget",
      "ui:options": {
        userouter: false,
        format: '${formData || "tasks missing"}',
        title: "Tasks",
        openInNewWindow: true,
        sx: {
          textTransform: "none",
          textAlign: "left",
          marginTop: "16px",
          marginBottom: "16px",
        },
      },
    },
    lastSync: {
      "ui:widget": "LabelWidget",
      "ui:options": {
        showLabel: true,
        format:
          "${reactory.utils.humanDate.relativeTime(reactory.utils.moment(formData))}",
      },
    },
  },
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
          width: 220,
          height: 220,
          borderRadius: "50%",
          border: "2px solid #000",
          boxShadow: "0 0 10px 0 rgba(0, 0, 0, 0.5)",
        },
      },
      actions: [
        {
          icon: "navigate_next",
          onClick:
            "window.open('/reactor/user/${item?.toLowerCase() || \"team member missing\"}', '_blank')",
        },
      ],
    },
  },
};

export default uiSchema;
