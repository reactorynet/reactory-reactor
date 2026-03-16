const schema = {
  type: "object",
  title: "Provider Configuration",
  required: ["providerId", "apiKey"],
  properties: {
    providerId: {
      type: "string",
      title: "Provider",
      readOnly: true,
    },
    apiKey: {
      type: "string",
      title: "API Key",
    },
    endpoint: {
      type: "string",
      title: "Endpoint URL",
      format: "uri",
    },
    organization: {
      type: "string",
      title: "Organization",
    },
    deploymentName: {
      type: "string",
      title: "Deployment Name",
      description: "Required for Azure OpenAI deployments",
    },
    apiVersion: {
      type: "string",
      title: "API Version",
    },
    setAsAccountDefault: {
      type: "boolean",
      title: "Set as account default",
      default: true,
    },
    setAsAppDefault: {
      type: "boolean",
      title: "Set as application default (ADMIN only)",
      default: false,
    },
  },
};

export default schema;
