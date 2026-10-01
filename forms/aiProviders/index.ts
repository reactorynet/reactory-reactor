import schema from "./schema";
import uiSchema from "./uiSchema";
import graphql from "./graphql";
import modules from "./modules";

const AiProvidersGridForm: Reactory.Forms.IReactoryForm = {
  id: "reactor.AiProvidersGrid@1.0.0",
  uiFramework: "material",
  uiSupport: ["material"],
  title: "AI Providers",
  tags: ["reactor", "ai", "providers", "admin", "grid"],
  nameSpace: "reactor",
  name: "AiProvidersGrid",
  version: "1.0.0",
  registerAsComponent: true,
  description: 'Manage AI providers: create, edit, enable/disable, test and delete.',
  schema,
  uiSchema,
  graphql,
  modules,
};

export default AiProvidersGridForm;
