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
      securityContact: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      riskLevel: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      dataClassification: { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 },
      vulnerabilityStatus: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      dependenciesWithKnownVulnerabilities: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      complianceTags: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      encryptionAtRest: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      encryptionInTransit: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      lastSecurityReview: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      securityPoliciesUrl: { xs: 12, sm: 12, md: 6, lg: 6, xl: 6 },
      vulnerabilityReportUrl: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
      securityNotes: { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
    },
  ],
  securityContact: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: '${formData?.firstName || "No "} ${formData?.lastName || "Security Contact"}',
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
          icon: "security",
          onClick: "window.open('/reactor/user/${item?.toLowerCase() || \"security contact missing\"}', '_blank')",
        },
      ],
    },
  },
  riskLevel: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: "Risk Level",
      description: '${formData || "Not Set"}',
      avatar: "${formData === 'LOW' ? '🟢' : formData === 'MEDIUM' ? '🟡' : formData === 'HIGH' ? '🟠' : formData === 'CRITICAL' ? '🔴' : '⚪'}",
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
          border: "2px solid #000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "2rem",
        },
      },
    },
  },
  dataClassification: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: "Data Classification",
      description: '${formData || "Not Set"}',
      avatar: "${formData === 'PUBLIC' ? '📢' : formData === 'INTERNAL' ? '🏢' : formData === 'CONFIDENTIAL' ? '🔒' : formData === 'RESTRICTED' ? '🚫' : formData === 'CLASSIFIED' ? '🛡️' : '❓'}",
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
          border: "2px solid #000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "2rem",
        },
      },
    },
  },
  vulnerabilityStatus: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: "Vulnerability Status",
      description: '${formData || "Unknown"}',
      avatar: "${formData === 'CLEAN' ? '✅' : formData === 'LOW_RISK' ? '🟢' : formData === 'MEDIUM_RISK' ? '🟡' : formData === 'HIGH_RISK' ? '🟠' : formData === 'CRITICAL' ? '🔴' : '❓'}",
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
          border: "2px solid #000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "2rem",
        },
      },
    },
  },
  dependenciesWithKnownVulnerabilities: {
    "ui:widget": "CardWidget",
    "ui:options": {
      title: "Vulnerable Dependencies",
      description: '${formData || 0} dependencies with known vulnerabilities',
      avatar: "${formData > 0 ? '⚠️' : '✅'}",
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
          border: "2px solid #000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "2rem",
        },
      },
    },
  },
  complianceTags: {
    "ui:widget": "ArrayFieldWidget",
    "ui:options": {
      title: "Compliance Standards",
      description: "Select all compliance standards this project adheres to",
      sx: {
        marginTop: "16px",
        marginBottom: "16px",
      },
    },
  },
  encryptionAtRest: {
    "ui:widget": "LabelWidget",
    "ui:options": {
      showLabel: true,
      format: "${formData === true ? '✅ Data encrypted at rest' : '❌ Data not encrypted at rest'}"
    }
  },
  encryptionInTransit: {
    "ui:widget": "LabelWidget",
    "ui:options": {
      showLabel: true,
      format: "${formData === true ? '✅ Data encrypted in transit' : '❌ Data not encrypted in transit'}"
    }
  },
  lastSecurityReview: {
    "ui:widget": "LabelWidget",
    "ui:options": {
      showLabel: true,
      format: "${formData ? reactory.utils.humanDate.relativeTime(reactory.utils.moment(formData)) : 'No security review recorded'}"
    }
  },
  securityPoliciesUrl: {
    "ui:widget": "LinkFieldWidget",
    "ui:options": {
      userouter: false,
      format: "${formData || \"No security policies URL set\"}",
      title: "Security Policies",
      openInNewWindow: true,
      forceShrinkLabel: true,
      sx: {
        textTransform: "none",
        textAlign: "left",
        marginTop: "16px",
        marginBottom: "16px",
      },
    },
  },
  vulnerabilityReportUrl: {
    "ui:widget": "LinkFieldWidget",
    "ui:options": {
      userouter: false,
      format: "${formData || \"No vulnerability report URL set\"}",
      title: "Vulnerability Report",
      openInNewWindow: true,
      forceShrinkLabel: true,
      sx: {
        textTransform: "none",
        textAlign: "left",
        marginTop: "16px",
        marginBottom: "16px",
      },
    },
  },
  securityNotes: {
    "ui:widget": "TextAreaWidget",
    "ui:options": {
      rows: 4,
      placeholder: "Enter security notes, observations, or additional information...",
      sx: {
        marginTop: "16px",
        marginBottom: "16px",
      },
    },
  },
};

export default uiSchema; 