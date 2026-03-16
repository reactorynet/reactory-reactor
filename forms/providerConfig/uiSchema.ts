const uiSchema = {
  providerId: {
    "ui:widget": "text",
    "ui:disabled": true,
  },
  apiKey: {
    "ui:widget": "password",
    "ui:placeholder": "Enter your API key or token",
  },
  endpoint: {
    "ui:placeholder": "https://api.example.com",
  },
  organization: {
    "ui:placeholder": "org-xxx (optional)",
  },
  deploymentName: {
    "ui:placeholder": "my-gpt4-deployment",
  },
  apiVersion: {
    "ui:placeholder": "2024-02-15-preview",
  },
  setAsAccountDefault: {
    "ui:widget": "checkbox",
  },
  setAsAppDefault: {
    "ui:widget": "checkbox",
  },
};

export default uiSchema;
