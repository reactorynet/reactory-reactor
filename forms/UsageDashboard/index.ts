import schema from "./schema";
import uiSchema from "./uiSchema";
import graphql from "./graphql";

const UsageDashboardForm: Reactory.Forms.IReactoryForm = {
  id: "reactor.UsageDashboardForm@1.0.0",
  uiFramework: "material",
  uiSupport: ["material"],
  title: "AI Usage Dashboard",
  tags: ["reactor", "ai", "usage", "telemetry", "tokens", "dashboard"],
  nameSpace: "reactor",
  name: "UsageDashboardForm",
  version: "1.0.0",
  registerAsComponent: true,
  schema,
  uiSchema,
  graphql,
};

export default UsageDashboardForm;
