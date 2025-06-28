const schema = {
  title: "Reactory Projects Home",
  description: "Welcome to the Reactory Projects Home Page.",
  type: "object",
  properties: {
    welcome: {
      type: "string",
      title: "Welcome",
      default: "Welcome to the Reactory Projects Portal!"
    },
    projects: {
      type: "array",
      title: "Projects",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          nameSpace: { type: "string" },
          version: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          repoUrl: { type: "string" },
          docsUrl: { type: "string" },
        }
      }
    }
  }
};

export default schema;
