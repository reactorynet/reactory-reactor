const uiSchema = {
  "ui:order": [
    "scheme",
    "nameSpace",
    "name",
    "version",
    "sourceKey",
    "settingKey",
    "options",
    "syncSchedule",
    "sync",
  ],
  options: {
    "ui:widget": "textarea",
    "ui:options": { rows: 4 },
  },
  version: {
    "ui:widget": "hidden",
  },
};

export default uiSchema;
