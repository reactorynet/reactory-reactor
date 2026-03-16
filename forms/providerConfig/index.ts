import schema from "./schema";
import uiSchema from "./uiSchema";

const ProviderConfigForm: Reactory.Forms.IReactoryForm = {
  id: "reactor.ProviderConfig@1.0.0",
  uiFramework: "material",
  uiSupport: ["material"],
  title: "Provider Configuration",
  tags: ["reactor", "provider", "config"],
  nameSpace: "reactor",
  name: "ProviderConfig",
  version: "1.0.0",
  registerAsComponent: true,
  schema,
  uiSchema,
};

export default ProviderConfigForm;
