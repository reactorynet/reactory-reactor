import schema from "./schema";
import uiSchema from "./uiSchema";
import graphql from "./graphql";
import modules from "./modules";

const AiModelsGridForm: Reactory.Forms.IReactoryForm = {
  id: "reactor.AiModelsGrid@1.0.0",
  uiFramework: "material",
  uiSupport: ["material"],
  title: "AI Models",
  tags: ["reactor", "ai", "models", "admin", "grid"],
  nameSpace: "reactor",
  name: "AiModelsGrid",
  version: "1.0.0",
  registerAsComponent: true,
  description: 'Manage AI models: create, edit, enable/disable and delete models for each provider.',
  schema,
  uiSchema,
  graphql,
  modules,
};

export default AiModelsGridForm;
