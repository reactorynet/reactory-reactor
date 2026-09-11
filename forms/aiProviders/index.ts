import schema from "./schema";
import uiSchema from "./uiSchema";
import graphql from "./graphql";

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
  schema,
  uiSchema,
  graphql,
};

export default AiProvidersGridForm;
