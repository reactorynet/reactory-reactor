import schema from "./schema";
import uiSchema from "./uiSchema";

/**
 * Registration form for external graph sources (Providers Session 07).
 * Submits to the ReactorRegisterExternalSource mutation; list + sync state
 * come from the ReactorExternalSources query.
 */
const ExternalSourcesForm: Reactory.Forms.IReactoryForm = {
  id: "reactor.ExternalSources@1.0.0",
  uiFramework: "material",
  uiSupport: ["material"],
  title: "External Graph Sources",
  tags: ["reactor", "graph", "external-sources", "jira", "database"],
  nameSpace: "reactor",
  name: "ExternalSources",
  version: "1.0.0",
  registerAsComponent: true,
  schema,
  uiSchema,
  graphql: {
    mutation: {
      new: {
        name: "ReactorRegisterExternalSource",
        text: `mutation ReactorRegisterExternalSource($input: ReactorExternalSourceInput!) {
          ReactorRegisterExternalSource(input: $input) {
            source { id fqn scheme sourceKey syncSchedule lastSync }
            jobId
            message
          }
        }`,
        variables: {
          "formData.nameSpace": "input.nameSpace",
          "formData.name": "input.name",
          "formData.version": "input.version",
          "formData.scheme": "input.scheme",
          "formData.sourceKey": "input.sourceKey",
          "formData.settingKey": "input.settingKey",
          "formData.options": "input.options",
          "formData.syncSchedule": "input.syncSchedule",
          "formData.sync": "input.sync",
        },
        resultMap: {},
        resultType: "object",
      },
    },
  } as any,
};

export default ExternalSourcesForm;
