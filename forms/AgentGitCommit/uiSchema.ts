import Reactory from "@reactorynet/reactory-core";

const uiSchema: Reactory.Schema.IFormUISchema = {
  "ui:form": {
    showSubmit: true,
    componentType: 'div',
    showRefresh: false,
    showHelp: true,
    allowSupportRequest: false,
    submitProps: { 
      titleText: 'Submit Commit Request',
      variant: 'contained',
      color: 'primary',
      icon: 'send',
    }
  },
  "ui:field": "GridLayout",
  "ui:grid-layout": [
    {
      workdir: { md: 12 },
      personaId: { md: 12 },
      hint: { md: 12 },
      sessionId: { md: 12 },
    },
  ],
  workdir: {
    "ui:widget": "TextWidget",
    "ui:options": {
      placeholder: "e.g. /Users/wweber/Source/reactory/reactory-express-server",
    },
  },
  personaId: {
    "ui:widget": "TextWidget",
  },
  hint: {
    "ui:widget": "TextAreaWidget",
    "ui:options": {
      rows: 4,
      placeholder: "e.g. Added unit tests for the payment module",
    },
  },
  sessionId: {
    "ui:widget": "TextWidget",
  },
};

export default uiSchema;
