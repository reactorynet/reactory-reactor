import schema from "./schema";
import uiSchema from "./uiSchema";
import graphql from "./graphql";

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
  schema,
  uiSchema,
  graphql,
};

export default AiModelsGridForm;
