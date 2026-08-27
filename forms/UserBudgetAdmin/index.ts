import schema from "./schema";
import uiSchema from "./uiSchema";
import graphql from "./graphql";

const UserBudgetAdminForm: Reactory.Forms.IReactoryForm = {
  id: "reactor.UserBudgetAdminForm@1.0.0",
  uiFramework: "material",
  uiSupport: ["material"],
  title: "AI Usage Budgets",
  tags: ["reactor", "ai", "budget", "limits", "admin"],
  nameSpace: "reactor",
  name: "UserBudgetAdminForm",
  version: "1.0.0",
  registerAsComponent: true,
  schema,
  uiSchema,
  graphql,
};

export default UserBudgetAdminForm;
