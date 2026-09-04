import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";

/**
 * External graph source macros (Providers Session 07 follow-up): let agents
 * discover, register and sync external sources (Jira sites, database
 * connections) — the agent-facing twin of the ReactorRegisterExternalSource /
 * ReactorExternalSources / ReactorSyncExternalSources GraphQL surface.
 *
 * Security posture:
 *  - registration is NOT auto-executable (a human confirms the tool call),
 *  - credentials are never accepted here — only a `settingKey` naming a
 *    partner setting, validated by the service (invariant P2),
 *  - listing/sync are read-side / idempotent and auto-safe.
 */

const PROJECT_SERVICE = "reactor.ReactorProjectService@1.0.0";

const projectService = (chatState: ChatState): any =>
  chatState.context.getService(PROJECT_SERVICE);

const sourceShape = (p: any) => ({
  id: String(p?._id || p?.id || ""),
  fqn: p?.fqn,
  name: p?.name,
  nameSpace: p?.nameSpace,
  scheme: p?.source?.scheme,
  sourceKey: p?.source?.sourceKey,
  settingKey: p?.source?.settingKey,
  options: p?.source?.options,
  syncSchedule: p?.source?.syncSchedule,
  lastSync: p?.lastSync,
  indexingJobId: p?.indexingJobId,
  projectStatus: p?.projectStatus !== undefined ? String(p.projectStatus) : undefined,
});

// ==================== LIST ====================

const ListExternalSourcesMacro = async (_params: {}, chatState: ChatState) => {
  const svc = projectService(chatState);
  if (!svc?.listExternalSources) {
    return {
      success: false,
      error: `${PROJECT_SERVICE} is not available or does not support external sources`,
      tool: "listExternalSources",
    };
  }
  try {
    const sources = (await svc.listExternalSources()).map(sourceShape);
    const schemes: string[] = svc.listExternalSchemes?.() || [];
    chatState.vars = chatState.vars || {};
    chatState.vars.externalSources = sources;
    return {
      success: true,
      data: { sources, availableSchemes: schemes },
      tool: "listExternalSources",
      instructions: `
## Registered External Sources (${sources.length})

${sources.length === 0 ? "_none registered yet_" : sources
        .map(
          (s: any) =>
            `- **${s.fqn}** [${s.scheme}] → ${s.sourceKey}${s.syncSchedule ? ` (cron: ${s.syncSchedule})` : ""}${s.lastSync ? ` — last sync ${s.lastSync}` : " — never synced"}${s.projectStatus === "ARCHIVED" ? " (ARCHIVED)" : ""}`
        )
        .join("\n")}

**Available schemes**: ${schemes.join(", ") || "none"}

- Register a new source with \`registerExternalSource\` (requires user confirmation).
- Trigger a re-sync with \`syncExternalSource(idOrFqn)\`.
- Their graph content is searchable via \`searchProject\` / the reactor_graph_<nameSpace>_<name> index.
      `,
    };
  } catch (error) {
    return {
      success: false,
      error: `listExternalSources failed: ${(error as Error)?.message || "Unknown error"}`,
      tool: "listExternalSources",
    };
  }
};

// ==================== REGISTER ====================

export interface RegisterExternalSourceParams {
  nameSpace: string;
  name: string;
  version?: string;
  scheme: string;
  sourceKey: string;
  settingKey?: string;
  options?: any;
  syncSchedule?: string;
  sync?: boolean;
}

const RegisterExternalSourceMacro = async (
  params: RegisterExternalSourceParams,
  chatState: ChatState
) => {
  const svc = projectService(chatState);
  if (!svc?.registerExternalSource) {
    return {
      success: false,
      error: `${PROJECT_SERVICE} is not available or does not support external source registration`,
      tool: "registerExternalSource",
      params,
    };
  }
  try {
    let options = params.options;
    if (typeof options === "string" && options.trim().length > 0) {
      try {
        options = JSON.parse(options);
      } catch {
        return {
          success: false,
          error: `options must be a JSON object; could not parse: ${options}`,
          tool: "registerExternalSource",
          params,
        };
      }
    }
    const { sync = true, ...input } = params;
    const project = await svc.registerExternalSource({ ...input, options });

    let jobId: string | undefined;
    if (sync) {
      try {
        const res = await svc.enqueueCatalog(String(project._id || project.id), {});
        jobId = res?.jobId;
      } catch (enqueueErr) {
        chatState.context.warn(
          `registerExternalSource: initial sync enqueue failed: ${(enqueueErr as Error).message}`
        );
      }
    }

    return {
      success: true,
      data: { source: sourceShape(project), jobId },
      tool: "registerExternalSource",
      params,
      instructions: `
## External Source Registered

- **Source**: ${project.fqn} [${params.scheme}] → ${params.sourceKey}
${jobId ? `- **Sync job**: ${jobId} (poll with the catalog job status query)` : "- **Sync**: not enqueued (sync: false)"}
${params.syncSchedule ? `- **Schedule**: ${params.syncSchedule}` : "- **Schedule**: none — sync on demand with syncExternalSource"}

Once the sync completes, the source is browsable in the graph explorer and
searchable via searchProject("${project.name}").
      `,
    };
  } catch (error) {
    return {
      success: false,
      error: `registerExternalSource failed: ${(error as Error)?.message || "Unknown error"}`,
      tool: "registerExternalSource",
      params,
      instructions: `
## Registration Failed

${(error as Error)?.message}

Common causes:
- **Unknown scheme** — call listExternalSources to see available schemes.
- **settingKey does not resolve** — the partner setting must exist first
  (database connections: a settingType 'connection' entry; Jira: a setting
  with data { host?, email, apiToken }). Ask an admin to configure it —
  never pass credentials directly.
- **Invalid syncSchedule** — must be a valid cron expression.
      `,
    };
  }
};

// ==================== SYNC ====================

const SyncExternalSourceMacro = async (
  params: { idOrFqn?: string },
  chatState: ChatState
) => {
  const svc = projectService(chatState);
  if (!svc?.enqueueCatalog) {
    return {
      success: false,
      error: `${PROJECT_SERVICE} is not available`,
      tool: "syncExternalSource",
      params,
    };
  }
  try {
    if (!params.idOrFqn) {
      // No target → sync everything that is due by schedule.
      const { enqueued } = await svc.syncDueExternalSources();
      return {
        success: true,
        data: { enqueued },
        tool: "syncExternalSource",
        params,
        instructions: `Enqueued ${enqueued.length} due external source sync(s)${enqueued.length ? `: ${enqueued.map((e: any) => e.fqn).join(", ")}` : ""}.`,
      };
    }
    const { jobId, message } = await svc.enqueueCatalog(params.idOrFqn, {});
    return {
      success: true,
      data: { jobId },
      tool: "syncExternalSource",
      params,
      instructions: `Sync job ${jobId} enqueued for ${params.idOrFqn}${message ? ` (${message})` : ""}. Idempotent — an already-running job is returned, not duplicated.`,
    };
  } catch (error) {
    return {
      success: false,
      error: `syncExternalSource failed: ${(error as Error)?.message || "Unknown error"}`,
      tool: "syncExternalSource",
      params,
    };
  }
};

// ==================== DEFINITIONS ====================

export const ListExternalSourcesMacroDefinition: MacroComponentDefinition<typeof ListExternalSourcesMacro> = {
  name: "ListExternalSources",
  nameSpace: "reactor-macros",
  alias: "listExternalSources",
  description:
    "Lists registered external graph sources (Jira sites, database connections) with sync state, plus the schemes available for registration.",
  component: ListExternalSourcesMacro,
  version: "1.0.0",
  roles: ["USER"],
  icon: "hub",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      safeForAutoExecution: true,
      function: {
        icon: "hub",
        name: "listExternalSources",
        description:
          "List the external graph sources (jira, db) registered in the system graph, their sync state, and which schemes can be registered.",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
};

export const RegisterExternalSourceMacroDefinition: MacroComponentDefinition<typeof RegisterExternalSourceMacro> = {
  name: "RegisterExternalSource",
  nameSpace: "reactor-macros",
  alias: "registerExternalSource",
  description:
    "Registers an external graph source (a Jira site scope or database connection) and enqueues its first sync. Credentials are never passed here — only a partner settingKey.",
  component: RegisterExternalSourceMacro,
  version: "1.0.0",
  roles: ["USER"],
  icon: "add_link",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      // Registration creates a project and starts remote API traffic — a
      // human confirms the call.
      safeForAutoExecution: false,
      function: {
        icon: "add_link",
        name: "registerExternalSource",
        description:
          "Register a Jira site scope or database connection as a graph source. Requires an existing partner setting for credentials (settingKey) — never pass secrets. Enqueues the first sync by default.",
        parameters: {
          type: "object",
          properties: {
            nameSpace: { type: "string", description: "Project namespace (e.g. 'jira', 'db')." },
            name: { type: "string", description: "Project name — forms the fqn with the namespace." },
            version: { type: "string", description: "Project version (default 1.0.0)." },
            scheme: { type: "string", enum: ["jira", "db"], description: "Source kind." },
            sourceKey: {
              type: "string",
              description:
                "Jira: the site host (your-domain.atlassian.net). Database: the connection setting id.",
            },
            settingKey: {
              type: "string",
              description:
                "Partner setting holding credentials. Validated to resolve; its value is never read into the record.",
            },
            options: {
              type: "object",
              description:
                'Provider scope. Jira: { "projectKeys": ["WR"], "jql"?, "includeBoards"?, "maxIssuesPerProject"? }. Database: { "variant": "postgres|mysql|mssql|databricks", "schemas"?, "includeViews"?, "includeRoutines"? }.',
            },
            syncSchedule: { type: "string", description: "Optional cron expression for scheduled re-sync." },
            sync: { type: "boolean", description: "Enqueue the first sync immediately (default true)." },
          },
          required: ["nameSpace", "name", "scheme", "sourceKey"],
        },
      },
    },
  ],
};

export const SyncExternalSourceMacroDefinition: MacroComponentDefinition<typeof SyncExternalSourceMacro> = {
  name: "SyncExternalSource",
  nameSpace: "reactor-macros",
  alias: "syncExternalSource",
  description:
    "Enqueues a catalog sync for one external source (by id or fqn), or for every source whose cron schedule is due when no target is given. Idempotent.",
  component: SyncExternalSourceMacro,
  version: "1.0.0",
  roles: ["USER"],
  icon: "sync",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      safeForAutoExecution: true,
      function: {
        icon: "sync",
        name: "syncExternalSource",
        description:
          "Trigger a graph re-sync of a registered external source (idOrFqn), or all schedule-due sources when omitted. Idempotent — running jobs are not duplicated.",
        parameters: {
          type: "object",
          properties: {
            idOrFqn: { type: "string", description: "Project id or fqn of the source (optional)." },
          },
        },
      },
    },
  ],
};

export default [
  ListExternalSourcesMacroDefinition,
  RegisterExternalSourceMacroDefinition,
  SyncExternalSourceMacroDefinition,
];
