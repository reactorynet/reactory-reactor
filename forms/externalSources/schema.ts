const schema = {
  type: "object",
  title: "External Graph Source",
  description:
    "Registers an external source (a Jira site scope, a database connection) as a graph project. Credentials stay in partner settings — only the setting key is stored.",
  required: ["nameSpace", "name", "scheme", "sourceKey"],
  properties: {
    nameSpace: {
      type: "string",
      title: "Namespace",
      description: "Project namespace (e.g. 'jira', 'db', or your org key).",
    },
    name: {
      type: "string",
      title: "Name",
      description: "Project name — with the namespace it forms the source's fqn.",
    },
    version: {
      type: "string",
      title: "Version",
      default: "1.0.0",
    },
    scheme: {
      type: "string",
      title: "Source Type",
      enum: ["jira", "db"],
      enumNames: ["Jira (tickets & boards)", "Database (schema structure)"],
    },
    sourceKey: {
      type: "string",
      title: "Source Key",
      description:
        "Jira: the site host (your-domain.atlassian.net). Database: the connection setting id.",
    },
    settingKey: {
      type: "string",
      title: "Credential Setting Key",
      description:
        "Partner setting holding credentials/connection config. Validated at registration; the value itself is never stored on the project.",
    },
    options: {
      type: "string",
      title: "Options (JSON)",
      description:
        'Provider scope, e.g. {"projectKeys":["WR"],"maxIssuesPerProject":1000} or {"variant":"postgres","schemas":["public"]}.',
    },
    syncSchedule: {
      type: "string",
      title: "Sync Schedule (cron)",
      description: "Optional cron expression for scheduled re-sync, e.g. '0 * * * *' (hourly).",
    },
    sync: {
      type: "boolean",
      title: "Sync immediately after registration",
      default: true,
    },
  },
};

export default schema;
