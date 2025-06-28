const uiSchema = {
  welcome: {
    "ui:widget": "static-content",
    "ui:options": {
      variant: "h4",
      color: "primary",
      gutterBottom: true
    }
  },
  projects: {
    "ui:widget": "ReactorProjectCard",
    "ui:options": {
      grid: true
    }
  }
};

export default uiSchema;
